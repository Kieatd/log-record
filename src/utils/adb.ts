/**
 * adb 调用工具。
 *
 * 这里刻意不 import electron：所有跟主进程相关的东西（userData 路径、
 * 打包后的 resources 路径）都由调用方传进来，这样这个模块可以脱离
 * Electron 直接用 node 跑测试。
 */
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** adb 是从哪找到的 */
export type AdbSource = 'custom' | 'bundled' | 'env' | 'sdk' | 'path' | 'none';

export interface AdbCandidate {
  file: string;
  source: AdbSource;
  /** 界面上显示的来源说明 */
  sourceText: string;
}

export interface AdbInfo {
  found: boolean;
  /** adb 可执行文件完整路径 */
  file: string;
  /** 形如 37.0.1；取不到就是空串 */
  version: string;
  source: AdbSource;
  sourceText: string;
  /** 找不到 / 不可用时的一句话原因 */
  error?: string;
}

export interface AdbDevice {
  serial: string;
  /** device / unauthorized / offline / bootloader … */
  state: string;
  model: string;
  product: string;
  device: string;
  connection: 'usb' | 'wifi' | 'unknown';
  /** 下面这些要额外跑一次 getprop，未授权或离线时拿不到 */
  brand?: string;
  androidVersion?: string;
  sdkVersion?: string;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** 超时被杀掉了 */
  timedOut: boolean;
}

const EXE = process.platform === 'win32' ? 'adb.exe' : 'adb';

/* ------------------------------------------------------------------ */
/* 查找 adb                                                            */
/* ------------------------------------------------------------------ */

/** Android SDK 的常见根目录（adb 在 <root>/platform-tools/adb） */
function sdkRoots(): string[] {
  const roots: string[] = [];
  if (process.env.ANDROID_HOME) roots.push(process.env.ANDROID_HOME);
  if (process.env.ANDROID_SDK_ROOT) roots.push(process.env.ANDROID_SDK_ROOT);
  const home = os.homedir();
  if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Android', 'sdk'));
  } else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    roots.push(path.join(local, 'Android', 'Sdk'));
  } else {
    roots.push(path.join(home, 'Android', 'Sdk'));
    roots.push(path.join(home, 'Android', 'sdk'));
  }
  return roots;
}

/** PATH 里的所有 adb */
function pathCandidates(): string[] {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return dirs.map((d) => path.join(d, EXE));
}

/**
 * 按优先级列出所有候选位置。
 * @param customPath 用户在界面上手动指定的路径（优先级最高）
 * @param bundledDir 应用内置 adb 的目录（打包后才有）
 */
export function listAdbCandidates(
  customPath?: string,
  bundledDir?: string,
): AdbCandidate[] {
  const out: AdbCandidate[] = [];
  const push = (file: string, source: AdbSource, sourceText: string) => {
    if (file) out.push({ file, source, sourceText });
  };

  push(customPath || '', 'custom', '手动指定');
  if (bundledDir) push(path.join(bundledDir, EXE), 'bundled', '应用内置');
  for (const root of sdkRoots()) {
    const isEnv = root === process.env.ANDROID_HOME || root === process.env.ANDROID_SDK_ROOT;
    push(
      path.join(root, 'platform-tools', EXE),
      isEnv ? 'env' : 'sdk',
      isEnv ? 'ANDROID_HOME' : 'Android SDK 默认位置',
    );
  }
  for (const file of pathCandidates()) push(file, 'path', 'PATH 环境变量');
  return out;
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 从 `adb version` 的输出里抠出版本号 */
export function parseAdbVersion(output: string): string {
  // 新版本：Version 37.0.1-15733141
  const modern = output.match(/Version\s+(\d+\.\d+\.\d+)/);
  if (modern) return modern[1];
  // 老版本只有：Android Debug Bridge version 1.0.41
  const legacy = output.match(/Android Debug Bridge version\s+([\d.]+)/);
  return legacy ? legacy[1] : '';
}

/**
 * 找到第一个可用的 adb 并读出它的版本。
 * 找不到时 found=false，error 里带原因。
 */
export function resolveAdb(options: {
  customPath?: string;
  bundledDir?: string;
  /** 跳过版本探测（测试用） */
  skipVersion?: boolean;
} = {}): AdbInfo {
  const candidates = listAdbCandidates(options.customPath, options.bundledDir);
  const none: AdbInfo = {
    found: false,
    file: '',
    version: '',
    source: 'none',
    sourceText: '',
  };

  if (!candidates.length) {
    return { ...none, error: '没有任何候选位置' };
  }

  // 用户手动指定的路径是「说了算」的：它坏了就直接报错，
  // 不要偷偷回退去用别的 adb —— 那样用户会以为自己的设置生效了
  if (options.customPath) {
    const custom = candidates.find((c) => c.source === 'custom')!;
    if (!isExecutable(custom.file)) {
      return {
        ...none,
        error: `指定的文件不可用（不存在或没有执行权限）：${custom.file}`,
      };
    }
    if (options.skipVersion) return { ...custom, found: true, version: '' };
    const res = runAdbSync(custom.file, ['version'], 8000);
    if (res.code !== 0) {
      return {
        ...none,
        error: `指定的文件不是可用的 adb：${custom.file}`,
      };
    }
    return { ...custom, found: true, version: parseAdbVersion(res.stdout + res.stderr) };
  }

  for (const c of candidates) {
    if (!isExecutable(c.file)) continue;
    if (options.skipVersion) {
      return { ...c, found: true, version: '' };
    }
    const res = runAdbSync(c.file, ['version'], 8000);
    if (res.code === 0) {
      return {
        ...c,
        found: true,
        version: parseAdbVersion(res.stdout + res.stderr),
      };
    }
  }

  return {
    ...none,
    error: '没找到 adb，可以手动指定它的位置',
  };
}

/* ------------------------------------------------------------------ */
/* 执行 adb                                                            */
/* ------------------------------------------------------------------ */

function spawnAdb(file: string, args: string[], timeout = 20000) {
  return spawn(file, args, {
    windowsHide: true,
    // 不加 shell：参数原样传给 adb，避免空格/特殊字符被 shell 解释
    shell: false,
  });
}

/** 同步跑一条 adb 命令（只在探测版本时用，会阻塞） */
export function runAdbSync(file: string, args: string[], timeout = 8000): RunResult {
  try {
    const stdout = execFileSync(file, args, {
      timeout,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout: stdout || '', stderr: '', timedOut: false };
  } catch (err: any) {
    if (err.killed || err.signal === 'SIGTERM') {
      return { code: null, stdout: '', stderr: '', timedOut: true };
    }
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : err.message || '',
      timedOut: false,
    };
  }
}

/** 跑一条 adb 命令并等它结束 */
export function runAdb(
  file: string,
  args: string[],
  options: { timeout?: number } = {},
): Promise<RunResult> {
  const timeout = options.timeout ?? 20000;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child: ReturnType<typeof spawnAdb>;
    try {
      child = spawnAdb(file, args);
    } catch (err: any) {
      resolve({ code: 1, stdout: '', stderr: err.message || String(err), timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);

    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr + (err.message || ''), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** 拿二进制输出（截图用）。exec-out 是二进制安全的，不能用 shell 版。 */
export function runAdbBuffer(
  file: string,
  args: string[],
  options: { timeout?: number } = {},
): Promise<{ code: number | null; buffer: Buffer; stderr: string }> {
  const timeout = options.timeout ?? 30000;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let stderr = '';
    const child = spawnAdb(file, args);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout?.on('data', (d: Buffer) => chunks.push(d));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, buffer: Buffer.concat(chunks), stderr: stderr + err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, buffer: Buffer.concat(chunks), stderr });
    });
  });
}

/** 流式跑 adb（安装、logcat 这种要边跑边看输出的） */
export function spawnAdbStream(
  file: string,
  args: string[],
  handlers: {
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    onClose?: (code: number | null) => void;
  },
) {
  const child = spawnAdb(file, args);
  child.stdout?.on('data', (d) => handlers.onStdout?.(d.toString()));
  child.stderr?.on('data', (d) => handlers.onStderr?.(d.toString()));
  child.on('error', (err) => handlers.onStderr?.(err.message || String(err)));
  child.on('close', (code) => handlers.onClose?.(code));
  return child;
}

/* ------------------------------------------------------------------ */
/* 设备                                                                */
/* ------------------------------------------------------------------ */

/** 解析 `adb devices -l` 的输出 */
export function parseDevices(output: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // 跳过 "* daemon started successfully *" 这类提示
    if (line.startsWith('*')) continue;
    if (line.startsWith('List of devices')) continue;
    // 跳过 "adb server version (41) doesn't match this client (40)" 之类
    if (!/^[\w.:\-]+/.test(line)) continue;

    const parts = line.split(/\s+/);
    const serial = parts[0];
    const state = parts[1] || 'unknown';
    if (!serial || !state) continue;
    // 只认已知状态，避免把提示文字当设备
    if (!/^(device|unauthorized|offline|bootloader|recovery|sideload|no permissions)/.test(state)) {
      continue;
    }

    const extras: Record<string, string> = {};
    for (const p of parts.slice(2)) {
      const idx = p.indexOf(':');
      if (idx > 0) extras[p.slice(0, idx)] = p.slice(idx + 1);
    }

    let connection: AdbDevice['connection'] = 'unknown';
    if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial)) connection = 'wifi';
    else if (extras.usb) connection = 'usb';

    devices.push({
      serial,
      state,
      model: extras.model || '',
      product: extras.product || '',
      device: extras.device || '',
      connection,
    });
  }
  return devices;
}

/** 解析 getprop 输出：`[ro.product.brand]: [samsung]` */
export function parseGetProp(output: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^\[([^\]]+)\]:\s*\[(.*)\]$/);
    if (m) props[m[1]] = m[2];
  }
  return props;
}

/** 列出设备，并补上品牌 / Android 版本（每个设备跑一次 getprop） */
export async function listDevices(file: string): Promise<AdbDevice[]> {
  const res = await runAdb(file, ['devices', '-l'], { timeout: 15000 });
  const devices = parseDevices(res.stdout + '\n' + res.stderr);

  await Promise.all(
    devices.map(async (d) => {
      if (d.state !== 'device') return;
      const prop = await runAdb(file, ['-s', d.serial, 'shell', 'getprop'], {
        timeout: 15000,
      });
      if (prop.code !== 0) return;
      const p = parseGetProp(prop.stdout);
      d.brand = p['ro.product.brand'] || p['ro.product.manufacturer'] || '';
      d.androidVersion = p['ro.build.version.release'] || '';
      d.sdkVersion = p['ro.build.version.sdk'] || '';
      if (!d.model) d.model = p['ro.product.model'] || '';
    }),
  );

  return devices;
}

/* ------------------------------------------------------------------ */
/* 具体动作                                                            */
/* ------------------------------------------------------------------ */

/** 安装 APK。返回给用户看的结果文案（成功/失败都尽量说人话） */
export async function installApk(
  file: string,
  apkPath: string,
  options: {
    serial?: string;
    /** 边跑边回调输出 */
    onOutput?: (line: string) => void;
  } = {},
): Promise<{ ok: boolean; message: string; raw: string }> {
  if (!fs.existsSync(apkPath)) {
    return { ok: false, message: `安装包不存在：${apkPath}`, raw: '' };
  }
  const args = ['install', '-r', '-d', '-g'];
  if (options.serial) args.unshift('-s', options.serial);
  args.push(apkPath);

  const raw = await new Promise<string>((resolve) => {
    let acc = '';
    spawnAdbStream(file, args, {
      onStdout: (c) => {
        acc += c;
        options.onOutput?.(c);
      },
      onStderr: (c) => {
        acc += c;
        options.onOutput?.(c);
      },
      onClose: () => resolve(acc),
    });
  });

  return { ...judgeInstall(raw), raw };
}

/** 把 adb install 的失败信息翻译成人话 */
export function judgeInstall(raw: string): { ok: boolean; message: string } {
  const text = raw.trim();
  if (/\bSuccess\b/i.test(text)) return { ok: true, message: '安装成功' };

  const known: [RegExp, string][] = [
    [/INSTALL_FAILED_UPDATE_INCOMPATIBLE/, '签名不一致，手机上已装的版本签名不同，需要先卸载'],
    [/INSTALL_FAILED_VERSION_DOWNGRADE/, '手机上已装的版本更高，已加 -d 仍失败'],
    [/INSTALL_FAILED_OLDER_SDK/, '安装包的 minSdkVersion 比手机系统还高，装不上'],
    [/INSTALL_FAILED_INSUFFICIENT_STORAGE/, '手机存储空间不足'],
    [/INSTALL_FAILED_INVALID_APK/, '安装包损坏或不是合法的 APK'],
    [/INSTALL_PARSE_FAILED/, '解析安装包失败，文件可能不完整'],
    [/INSTALL_FAILED_USER_RESTRICTED/, '手机系统限制了安装（小米/华为需要在开发者选项里关掉「USB 安装限制」）'],
    [/INSTALL_FAILED_TEST_ONLY/, '这是 test-only 的包'],
    [/no devices|device .* not found/, '设备断开了，重新插一下线'],
    [/failed to stat/i, '读取安装包失败，检查文件路径'],
  ];
  for (const [re, msg] of known) {
    if (re.test(text)) return { ok: false, message: msg };
  }
  if (!text) return { ok: false, message: '安装失败，没有任何输出' };
  return { ok: false, message: text.split(/\r?\n/).filter(Boolean).pop() || '安装失败' };
}

/** 截图，返回 PNG 的 Buffer */
export async function screencap(
  file: string,
  serial?: string,
): Promise<{ ok: boolean; buffer: Buffer; message: string }> {
  const args = ['exec-out', 'screencap', '-p'];
  if (serial) args.unshift('-s', serial);
  const res = await runAdbBuffer(file, args, { timeout: 30000 });

  // PNG 头是 89 50 4E 47。有些老设备/Windows 上会混进 CR，检查一下
  const isPng =
    res.buffer.length > 8 &&
    res.buffer[0] === 0x89 &&
    res.buffer[1] === 0x50 &&
    res.buffer[2] === 0x4e &&
    res.buffer[3] === 0x47;
  if (!isPng) {
    const hint = res.stderr.trim() || '截图失败';
    return { ok: false, buffer: res.buffer, message: hint };
  }
  return { ok: true, buffer: res.buffer, message: '截图成功' };
}

/** 屏幕是不是亮着。息屏时 screencap 截出来是全黑的，要提前告诉用户。 */
export async function isScreenAwake(
  file: string,
  serial?: string,
): Promise<boolean | null> {
  const args = ['shell', 'dumpsys', 'power'];
  if (serial) args.unshift('-s', serial);
  const res = await runAdb(file, args, { timeout: 15000 });
  const out = res.stdout + res.stderr;
  if (res.code !== 0 || !out.trim()) return null;
  // Android 5+：mWakefulness=Awake / Asleep / Dreaming
  const w = out.match(/mWakefulness=(\w+)/);
  if (w) return w[1] === 'Awake';
  // 老设备：Display Power: state=ON / OFF
  const d = out.match(/Display Power:\s*state=(\w+)/);
  if (d) return d[1].toUpperCase() === 'ON';
  return null;
}

/** 点亮屏幕（等价于按一下电源键，不会解锁） */
export async function wakeUp(
  file: string,
  serial?: string,
): Promise<{ ok: boolean; message: string }> {
  const args = ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'];
  if (serial) args.unshift('-s', serial);
  const res = await runAdb(file, args, { timeout: 15000 });
  const ok = res.code === 0;
  return { ok, message: ok ? '已发送唤醒指令' : (res.stderr || '唤醒失败').trim() };
}

/* 屏幕常亮（stay_on_while_plugged_in）是个位掩码 */
export const STAY_ON_BITS = { ac: 1, usb: 2, wireless: 4 } as const;

export interface StayAwakeState {
  /** 原始位掩码：0=从不，1=AC，2=USB，4=无线，7=全部 */
  value: number;
  /** 开关是否打开 */
  on: boolean;
  /** 打开时覆盖哪些充电方式 */
  modes: string[];
  /** 系统当前实际有没有在保持常亮（mStayOn）。开关开了但没插电时这里是 false */
  effective: boolean | null;
  /** 屏幕当前是否亮着 */
  awake: boolean | null;
}

/** 把位掩码翻译成人话 */
export function parseStayOnValue(value: number): { on: boolean; modes: string[] } {
  const on = value > 0;
  const modes: string[] = [];
  if (value & STAY_ON_BITS.ac) modes.push('充电器');
  if (value & STAY_ON_BITS.usb) modes.push('USB');
  if (value & STAY_ON_BITS.wireless) modes.push('无线充电');
  return { on, modes };
}

/** 读屏幕常亮状态 */
export async function getStayAwake(
  file: string,
  serial?: string,
): Promise<StayAwakeState> {
  const base = serial ? ['-s', serial] : [];
  const [setting, power] = await Promise.all([
    runAdb(file, [...base, 'shell', 'settings', 'get', 'global', 'stay_on_while_plugged_in'], { timeout: 15000 }),
    runAdb(file, [...base, 'shell', 'dumpsys', 'power'], { timeout: 15000 }),
  ]);

  const raw = (setting.stdout + setting.stderr).trim();
  const value = /^\d+$/.test(raw) ? parseInt(raw, 10) : 0;
  const { on, modes } = parseStayOnValue(value);

  const powerText = power.stdout + power.stderr;
  const stayOn = powerText.match(/mStayOn=(true|false)/);
  const wake = powerText.match(/mWakefulness=(\w+)/);

  return {
    value,
    on,
    modes,
    effective: stayOn ? stayOn[1] === 'true' : null,
    awake: wake ? wake[1] === 'Awake' : null,
  };
}

/**
 * 开关屏幕常亮。
 * 注意 svc power stayon 只管「插电时不熄灭」，不会点亮已经黑掉的屏幕，
 * 所以打开的时候顺便唤醒一次，否则用户以为没生效。
 */
export async function setStayAwake(
  file: string,
  on: boolean,
  serial?: string,
): Promise<{ ok: boolean; message: string; raw: string; state: StayAwakeState }> {
  const base = serial ? ['-s', serial] : [];
  const res = await runAdb(
    file,
    [...base, 'shell', 'svc', 'power', 'stayon', on ? 'true' : 'false'],
    { timeout: 15000 },
  );
  const raw = (res.stdout + res.stderr).trim();
  if (on) {
    // 顺便点亮屏幕
    await runAdb(file, [...base, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], {
      timeout: 15000,
    });
  }
  const state = await getStayAwake(file, serial);
  const ok = on ? state.on : !state.on;
  return {
    ok,
    message: ok
      ? on
        ? `已开启屏幕常亮（${state.modes.join('、') || '插电时'}不熄灭）`
        : '已关闭屏幕常亮'
      : raw || '设置失败',
    raw,
    state,
  };
}

/** 打开无线调试：让手机在 5555 端口监听，之后就能拔线了 */
export async function enableTcpip(
  file: string,
  serial?: string,
  port = 5555,
): Promise<{ ok: boolean; message: string; raw: string }> {
  const args = ['tcpip', String(port)];
  if (serial) args.unshift('-s', serial);
  const res = await runAdb(file, args, { timeout: 20000 });
  const raw = (res.stdout + res.stderr).trim();
  const ok = res.code === 0 && /restarting in TCP mode|already in TCP mode/i.test(raw);
  return { ok, message: ok ? `已开启无线调试（端口 ${port}）` : raw || '开启失败', raw };
}

/** 连接无线设备 */
export async function connectWifi(
  file: string,
  address: string,
  port = 5555,
): Promise<{ ok: boolean; message: string; raw: string }> {
  const target = address.includes(':') ? address : `${address}:${port}`;
  const res = await runAdb(file, ['connect', target], { timeout: 20000 });
  const raw = (res.stdout + res.stderr).trim();
  const ok = /connected to/i.test(raw) && !/failed|refused|unable/i.test(raw);
  return {
    ok,
    message: ok ? `已连接到 ${target}` : raw || `连接 ${target} 失败`,
    raw,
  };
}

/* ------------------------------------------------------------------ */
/* 手动指定的路径持久化                                                */
/* ------------------------------------------------------------------ */

export function loadCustomAdbPath(file: string): string {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof data?.path === 'string' ? data.path : '';
  } catch {
    return '';
  }
}

export function saveCustomAdbPath(file: string, adbPath: string) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ path: adbPath }, null, 2), 'utf8');
  } catch (err) {
    console.warn('保存 adb 路径失败', err);
  }
}
