/**
 * scrcpy 投屏 + 操控（主进程侧）。
 *
 * 用 Tango 的 TypeScript 实现（@yume-chan/adb + @yume-chan/adb-scrcpy）：
 *   - 它连的是本机 adb server 的 5037 端口，复用已经在跑的 adb
 *   - 它负责把 scrcpy-server 推到手机、起进程、建立 socket
 *   - 视频流是 H.264 裸流，交给渲染进程用 WebCodecs 解码
 *   - 控制消息（触摸/按键/滑动）由 controller 写回去
 *
 * 这个文件刻意不 import electron，路径都由调用方传进来，
 * 这样能脱离 Electron 直接用 node 跑测试。
 */
import fs from 'fs';
import { AdbServerClient } from '@yume-chan/adb';
import type { Adb } from '@yume-chan/adb';
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp';
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from '@yume-chan/adb-scrcpy';

/** scrcpy-server 在手机上的落点。这个路径是 server 内部写死的，必须一致 */
const SERVER_DEVICE_PATH = '/data/local/tmp/scrcpy-server.jar';

export interface ScrcpyVideoMeta {
  /** H.264 = 0x68323634，见 ScrcpyVideoCodecId */
  codec: number;
  width: number;
  height: number;
}

export interface ScrcpyPacket {
  type: 'configuration' | 'data';
  /** 只有 data 包有 */
  keyframe?: boolean;
  /** 只有 data 包有 */
  pts?: string;
  data: Uint8Array;
}

export interface ScrcpyStartOptions {
  /** 手机序列号，不传就用第一台可用的 */
  serial?: string;
  /** 本地 scrcpy-server 文件路径 */
  serverFile: string;
  /** 最长边限制，越小越省流量、越流畅 */
  maxSize?: number;
  maxFps?: number;
  videoBitRate?: number;
  /** 要不要投声音（Android 11+ 才支持） */
  audio?: boolean;
  onMeta: (meta: ScrcpyVideoMeta) => void;
  onPacket: (packet: ScrcpyPacket) => void;
  onLog?: (line: string) => void;
  onError?: (message: string) => void;
  onClose?: (reason: string) => void;
}

interface Session {
  adb: Adb;
  client: AdbScrcpyClient<any>;
  serial: string;
  /** 视频原始尺寸，注入触摸坐标时要带上 */
  videoWidth: number;
  videoHeight: number;
  stopRequested: boolean;
}

let session: Session | null = null;

export function isScrcpyRunning(): boolean {
  return session !== null;
}

/** 连本机的 adb server（5037）。adb 客户端和 server 是两回事，这里只做客户端 */
function createServerClient() {
  return new AdbServerClient(
    new AdbServerNodeTcpConnector({ host: '127.0.0.1', port: 5037 }),
  );
}

/** 把一段 Buffer 变成 pushServer 需要的 ReadableStream */
function bufferToStream(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}

/**
 * 开始投屏。
 * 同一个时间只允许一个会话，重复调用会先停掉上一个。
 */
export async function startScrcpy(options: ScrcpyStartOptions): Promise<{
  ok: boolean;
  message: string;
  meta?: ScrcpyVideoMeta;
}> {
  if (session) {
    await stopScrcpy();
  }
  if (!fs.existsSync(options.serverFile)) {
    return { ok: false, message: `找不到 scrcpy-server：${options.serverFile}` };
  }

  let adb: Adb | null = null;
  try {
    const serverClient = createServerClient();
    const devices = await serverClient.getDevices();
    const usable = devices.filter((d) => (d as any).state === 'device');
    const target = options.serial
      ? usable.find((d) => (d as any).serial === options.serial)
      : usable[0];
    if (!target) {
      return {
        ok: false,
        message: '没有可用的设备（状态必须是 device）',
      };
    }

    adb = await serverClient.createAdb({ serial: (target as any).serial } as any);
    const serial = (target as any).serial as string;

    // 推 server：88KB 左右，每次都推，省得判断手机上那份是不是同版本
    options.onLog?.(`推送 scrcpy-server 到 ${SERVER_DEVICE_PATH}…`);
    const serverBuf = fs.readFileSync(options.serverFile);
    await AdbScrcpyClient.pushServer(adb, bufferToStream(serverBuf));

    options.onLog?.('启动手机上的 scrcpy 服务…');
    const client = await AdbScrcpyClient.start(
      adb,
      SERVER_DEVICE_PATH,
      new AdbScrcpyOptionsLatest({
        video: true,
        audio: !!options.audio,
        control: true,
        // false = 用反向隧道（官方推荐）
        tunnelForward: false,
        // 带上帧元数据，解码器要用来判断关键帧
        sendFrameMeta: true,
        maxSize: options.maxSize ?? 1024,
        maxFps: options.maxFps ?? 30,
        videoBitRate: options.videoBitRate ?? 4_000_000,
        // 连上时把屏幕点亮，调试场景基本都要
        powerOn: true,
        clipboardAutosync: false,
      } as any),
    );

    // 服务端 stdout，出问题时的日志都在这里
    client.output
      .pipeTo(
        new WritableStream<string>({
          write: (line) => options.onLog?.(line.trimEnd()),
        }),
      )
      .catch(() => {
        /* 关掉时正常会抛 */
      });

    const videoStream = await client.videoStream;
    if (!videoStream) {
      await client.close();
      return { ok: false, message: '没拿到视频流（可能手机上拒绝了录制权限）' };
    }

    const meta: ScrcpyVideoMeta = {
      codec: videoStream.metadata.codec as unknown as number,
      width: videoStream.metadata.width,
      height: videoStream.metadata.height,
    };

    session = {
      adb,
      client,
      serial,
      videoWidth: meta.width,
      videoHeight: meta.height,
      stopRequested: false,
    };

    const current = session;
    options.onMeta(meta);
    options.onLog?.(
      `投屏已开始：${meta.width}x${meta.height}，编码 ${meta.codec}`,
    );

    // 持续把视频包转给渲染进程
    videoStream.stream
      .pipeTo(
        new WritableStream<any>({
          write: (packet) => {
            if (packet.type === 'configuration') {
              options.onPacket({
                type: 'configuration',
                data: packet.data as Uint8Array,
              });
              return;
            }
            options.onPacket({
              type: 'data',
              keyframe: packet.keyframe,
              pts: packet.pts === undefined ? undefined : String(packet.pts),
              data: packet.data as Uint8Array,
            });
          },
        }),
      )
      .then(() => {
        if (!current.stopRequested) {
          options.onClose?.('投屏流已结束');
        }
      })
      .catch((err: unknown) => {
        if (!current.stopRequested) {
          options.onError?.(err instanceof Error ? err.message : String(err));
        }
      });

    return { ok: true, message: '投屏已开始', meta };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      if (adb) await adb.close();
    } catch {
      /* ignore */
    }
    session = null;
    return { ok: false, message: `启动投屏失败：${message}` };
  }
}

export async function stopScrcpy(): Promise<void> {
  const current = session;
  session = null;
  if (!current) return;
  current.stopRequested = true;
  try {
    await current.client.close();
  } catch {
    /* ignore */
  }
  try {
    await current.adb.close();
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* 操控                                                                */
/* ------------------------------------------------------------------ */

const ACTION_DOWN = 0;
const ACTION_UP = 1;
const ACTION_MOVE = 2;

/**
 * 注入触摸。
 * x / y 用视频坐标系（0 ~ videoWidth/Height），由渲染进程从画布坐标换算好。
 */
export async function injectTouch(payload: {
  action: 'down' | 'up' | 'move';
  x: number;
  y: number;
  /** 0~1 */
  pressure?: number;
}): Promise<{ ok: boolean; message?: string }> {
  const current = session;
  const writer = current?.client.controller;
  if (!current || !writer) return { ok: false, message: '投屏没在跑' };

  const action =
    payload.action === 'down'
      ? ACTION_DOWN
      : payload.action === 'up'
        ? ACTION_UP
        : ACTION_MOVE;
  const pressed = payload.action !== 'up';

  try {
    // 注意字段名是 pointerX / pointerY，不是 x / y。
    // 之前写成 x/y 并用 as any 屏蔽了类型检查，结果序列化出来全是 0，
    // 每次触摸都点在左上角，看起来就是「操控没反应」。
    await writer.injectTouch({
      action,
      pointerId: 1n,
      pointerX: Math.max(0, Math.round(payload.x)),
      pointerY: Math.max(0, Math.round(payload.y)),
      videoWidth: current.videoWidth,
      videoHeight: current.videoHeight,
      pressure: pressed ? (payload.pressure ?? 1) : 0,
      actionButton: pressed ? 1 : 0,
      buttons: pressed ? 1 : 0,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** 注入滑动（滚轮） */
export async function injectScroll(payload: {
  x: number;
  y: number;
  scrollX: number;
  scrollY: number;
}): Promise<{ ok: boolean; message?: string }> {
  const current = session;
  const writer = current?.client.controller;
  if (!current || !writer) return { ok: false, message: '投屏没在跑' };
  try {
    await writer.injectScroll({
      pointerX: Math.round(payload.x),
      pointerY: Math.round(payload.y),
      videoWidth: current.videoWidth,
      videoHeight: current.videoHeight,
      scrollX: payload.scrollX,
      scrollY: payload.scrollY,
      buttons: 0,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** 注入按键（Android keycode） */
export async function injectKey(payload: {
  keyCode: number;
  /** 默认按下+抬起 */
  action?: 'down' | 'up' | 'both';
}): Promise<{ ok: boolean; message?: string }> {
  const current = session;
  const writer = current?.client.controller;
  if (!current || !writer) return { ok: false, message: '投屏没在跑' };
  const mode = payload.action ?? 'both';
  try {
    if (mode === 'both') {
      await writer.injectKeyCode({
        action: ACTION_DOWN,
        keyCode: payload.keyCode,
        repeat: 0,
        metaState: 0,
      });
      await writer.injectKeyCode({
        action: ACTION_UP,
        keyCode: payload.keyCode,
        repeat: 0,
        metaState: 0,
      });
    } else {
      await writer.injectKeyCode({
        action: mode === 'down' ? ACTION_DOWN : ACTION_UP,
        keyCode: payload.keyCode,
        repeat: 0,
        metaState: 0,
      });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** 注入文本（只支持 ASCII，中文得走剪贴板） */
export async function injectText(text: string): Promise<{ ok: boolean; message?: string }> {
  const writer = session?.client.controller;
  if (!writer) return { ok: false, message: '投屏没在跑' };
  try {
    await writer.injectText(text);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** 按下电源键 / 点亮屏幕之类 */
export async function setScreenPower(on: boolean): Promise<{ ok: boolean; message?: string }> {
  const writer = session?.client.controller;
  if (!writer) return { ok: false, message: '投屏没在跑' };
  try {
    // 0 = off, 2 = normal
    await writer.setScreenPowerMode((on ? 2 : 0) as any);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
