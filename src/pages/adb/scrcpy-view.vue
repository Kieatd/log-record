<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  DesktopOutlined,
  LoadingOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons-vue';
import {
  BitmapVideoFrameRenderer,
  WebCodecsVideoDecoder,
  WebGLVideoFrameRenderer,
} from '@yume-chan/scrcpy-decoder-webcodecs';

const props = defineProps<{ serial: string }>();
const emit = defineEmits<{
  (e: 'log', text: string): void;
  (e: 'running', value: boolean): void;
  (e: 'starting', value: boolean): void;
}>();

const i18n = useI18n();
const api = (window as any).electronAPI;

const canvasRef = ref<HTMLCanvasElement | null>(null);
const running = ref(false);
const starting = ref(false);
const errorText = ref('');
const meta = ref<{ width: number; height: number } | null>(null);
const fps = ref(0);
const packetKb = ref(0);
/** 手机屏幕是否亮着。息屏时投出来是纯黑，得说清楚，不然以为投屏坏了 */
const screenAwake = ref<boolean | null>(null);
let awakeTimer: ReturnType<typeof setInterval> | null = null;

let decoder: any = null;
let writer: any = null;
/** 解码器还没建好时，先把包排队 */
const pending: any[] = [];
let frameCount = 0;
let byteCount = 0;
let statTimer: ReturnType<typeof setInterval> | null = null;
let pressed = false;
let pressWatchdog: ReturnType<typeof setTimeout> | null = null;
/** 最后一次已知的手指位置：补发 UP 时要用它，合成事件里没有坐标 */
let lastPoint = { x: 0, y: 0 };
/** 最后一次真正发出去的位置：用来判断松手时要不要补 MOVE */
let sentPoint = { x: 0, y: 0 };
/** 鼠标当前的目标位置。mousemove 只更新它，真正发出去的是 sampleTick 重采样出来的点 */
let targetPoint = { x: 0, y: 0 };
/** 按下时的位置（整段拖动的起点，用来判断拖动方向） */
let dragStart = { x: 0, y: 0 };
/** 鼠标自己的速度（视频坐标 / 毫秒），由最近两个 mousemove 算出来 */
let mouseSpeed = 0;
/** 最后一次 mousemove 的时间与位置（算速度用，performance 时间戳） */
let lastMoveEvent = { t: 0, x: 0, y: 0 };
/** 重采样定时器（按下时开，松手时停） */
let sampleTimer: ReturnType<typeof setInterval> | null = null;
/** 按着超过这么久没有任何移动，就强制松开（防止松手事件丢了手指一直按着） */
const PRESS_WATCHDOG_MS = 8000;
let lastMoveSentAt = 0;

/**
 * 重采样间隔（毫秒）。
 *
 * 为什么不能直接把 mousemove 转发给手机：
 * 桌面翻页靠 VelocityTracker 算「甩」的速度，采样太稀就算不出来，松手会弹回原页。
 * 实测（同一条路径、每个形状各跑 3~5 遍，HONOR BND-AL10 / Android 7 / EMUI）：
 *   4 个点、间隔 35ms（真实鼠标拖动原来被 32ms 抽稀后的样子）→ 0/3 次能翻
 *   3 个点、间隔 35ms                                  → 0/3 次能翻
 *   1 个点、间隔 140ms                                 → 3/3 次能翻
 *   20 个点、间隔 7ms                                  → 3/3 次能翻
 *   40 个点、间隔 3.5ms                                → 3/3 次能翻
 *   Android 原生 input swipe（约 5ms 一个点）            → 每次都能翻
 * 结论：间隔 30~40ms 的稀采样几乎必失败，密到 7ms 左右就必成功。
 * 原来那套「32ms 以内直接丢掉」的抽稀正好落在必失败的区间里。
 */
const SAMPLE_MS = 7;
/** 每个采样点至少朝目标推进「鼠标速度 × SAMPLE_MS × 这个系数」 */
const MIN_STEP_FACTOR = 1.2;
/** 补的那个采样至少走这么远（视频像素），保证速度足够被桌面当成甩动 */
const FLING_ASSIST_MIN_PX = 40;
/**
 * 松手时「终点 MOVE」和「UP」之间至少隔这么久。
 *
 * 手机侧的时间戳是 scrcpy 服务端**收到消息的那一刻**打的 —— 两条消息要是落在同一毫秒，
 * Android 的 VelocityTracker 遇到 dt=0 会直接中断速度计算，速度算成 0，页面就弹回。
 * 所以这两条必须真的隔开（实测 7ms 太紧，给 12ms）。
 */
const FINAL_GAP_MS = 12;
/**
 * 相邻两次注入之间至少隔这么久（渲染层串行排队发）。
 * 也是为了不让多条控制消息挤在同一毫秒里被服务端当成同时发生。
 */
const MIN_SEND_GAP_MS = 5;

/**
 * 串行发送队列。
 * 投屏的触摸是「一帧一个点」的流，顺序和间隔都很重要；
 * 所有注入都从这里排队发出，避免乱序或挤在一起。
 */
let sendChain: Promise<void> = Promise.resolve();
let lastSendAt = 0;

function sendTouch(payload: {
  action: 'down' | 'up' | 'move';
  x: number;
  y: number;
}): Promise<void> {
  sendChain = sendChain
    .then(async () => {
      const wait = MIN_SEND_GAP_MS - (Date.now() - lastSendAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastSendAt = Date.now();
      try {
        const res = await api.scrcpyTouch(payload);
        reportTouchFail(res);
      } catch {
        /* 网络断了就算了，下一次会重新报 */
      }
    })
    // 链条必须保持「已结算」：任何一步抛错都不能让后面的注入永远发不出去
    .catch(() => {});
  return sendChain;
}

/** 画布坐标 → 视频坐标（注入触摸要用视频坐标系） */
function toVideo(e: MouseEvent) {
  const canvas = canvasRef.value;
  if (!canvas) return { x: 0, y: 0 };
  const rect = canvas.getBoundingClientRect();
  // 优先用画布的当前尺寸：手机转屏时视频尺寸会变，
  // meta 是启动时拿的，用它会算错（画面转过去，点击还按旧比例算）
  const w = canvas.width || meta.value?.width || 1;
  const h = canvas.height || meta.value?.height || 1;
  return {
    x: Math.max(0, Math.min(w, ((e.clientX - rect.left) / rect.width) * w)),
    y: Math.max(0, Math.min(h, ((e.clientY - rect.top) / rect.height) * h)),
  };
}

function ensureDecoder(codec: number) {
  if (decoder) return;
  const canvas = canvasRef.value;
  if (!canvas) return;
  // WebGL 快一点，不支持就退回位图绘制
  // enableCapture = true 允许把画布内容读出来（截图功能要用，也方便验证）
  const renderer = WebGLVideoFrameRenderer.isSupported
    ? new WebGLVideoFrameRenderer(canvas, true)
    : new BitmapVideoFrameRenderer(canvas);
  decoder = new WebCodecsVideoDecoder({ codec, renderer } as any);
  writer = decoder.writable.getWriter();
  // 补写排队期间攒下的包
  for (const p of pending.splice(0)) {
    writer.write(p).catch(() => {});
  }
}

function onPacket(packet: {
  type: string;
  keyframe?: boolean;
  pts?: string;
  data: Uint8Array;
}) {
  frameCount += 1;
  byteCount += packet.data?.length || 0;
  if (!decoder) {
    pending.push({
      type: packet.type,
      keyframe: packet.keyframe,
      pts: packet.pts === undefined ? undefined : Number(packet.pts),
      data: packet.data,
    });
    if (pending.length > 200) pending.shift();
    return;
  }
  writer
    ?.write({
      type: packet.type,
      keyframe: packet.keyframe,
      pts: packet.pts === undefined ? undefined : Number(packet.pts),
      data: packet.data,
    })
    .catch(() => {});
}

async function start(): Promise<boolean> {
  // 已经在跑（或正在起）就交给它，不当失败
  if (running.value || starting.value) return true;
  starting.value = true;
  errorText.value = '';
  meta.value = null;
  decoder = null;
  writer = null;
  pending.length = 0;
  frameCount = 0;
  byteCount = 0;
  try {
    /**
     * 无线设备自动降档。
     *
     * 实测（这台 HONOR 连 2.4GHz）：链路可用吞吐只有 ~10.6 Mbps，
     * 而投屏画面一有变化就要 ~6.5 Mbps —— 等于把链路吃满，鼠标/触摸事件只能排队，
     * 手感就是"好卡好卡"。降到 720p/20fps/2Mbps 后链路留出余量，输入立刻跟手。
     * （判定方式：无线设备的 serial 形如 192.168.1.5:5555）
     */
    const wireless = /:\d+$/.test(props.serial || '');
    const maxSize = wireless ? 720 : 1024;
    const maxFps = wireless ? 20 : 30;
    const videoBitRate = wireless ? 2_000_000 : 4_000_000;
    if (wireless) {
      emit(
        'log',
        `无线设备：自动用省流模式 ${maxSize}p / ${maxFps}fps / ${videoBitRate / 1_000_000}Mbps（避免投屏把链路吃满）`,
      );
    }
    const res = await api.scrcpyStart(
      props.serial || undefined,
      maxSize,
      maxFps,
      videoBitRate,
    );
    if (!res.ok) {
      errorText.value = res.message;
      starting.value = false;
      return false;
    }
    running.value = true;
    emit('running', true);
    statTimer = setInterval(() => {
      fps.value = frameCount;
      packetKb.value = Math.round(byteCount / 1024);
      frameCount = 0;
      byteCount = 0;
    }, 1000);
    checkScreenAwake();
    awakeTimer = setInterval(checkScreenAwake, 3000);
    return true;
  } catch (err: any) {
    errorText.value = err?.message || String(err);
    return false;
  } finally {
    starting.value = false;
  }
}

async function stop() {
  errorText.value = '';
  meta.value = null;
  stopSampling();
  pressed = false;
  if (statTimer) {
    clearInterval(statTimer);
    statTimer = null;
  }
  if (awakeTimer) {
    clearInterval(awakeTimer);
    awakeTimer = null;
  }
  try {
    await api.scrcpyStop();
  } catch {
    /* ignore */
  }
  running.value = false;
  starting.value = false;
  emit('running', false);
  fps.value = 0;
  try {
    await writer?.close();
  } catch {
    /* ignore */
  }
  try {
    decoder?.dispose?.();
  } catch {
    /* ignore */
  }
  decoder = null;
  writer = null;
  pending.length = 0;
}

async function checkScreenAwake() {
  if (!running.value) return;
  try {
    const res = await api.adbStayAwake(props.serial || undefined);
    screenAwake.value = res?.state?.awake ?? null;
  } catch {
    screenAwake.value = null;
  }
}

async function wakeScreen() {
  const res = await api.adbWakeup(props.serial || undefined);
  emit('log', res?.message || '');
  setTimeout(checkScreenAwake, 800);
}

/* ---------------- 鼠标操作 → 触摸注入 ---------------- */

/**
 * 触摸失败时要说出来。
 *
 * 原来这些调用是「发出去就不管了」：投屏会话已经断了（比如应用重启过、
 * 或者手机上服务被杀），injectTouch 会返回「投屏没在跑」，但界面完全没反应 ——
 * 画布还留着最后一帧，看起来像活的，用户就会觉得「拖动没反应」。
 * 这里把失败报出来，3 秒最多提示一次，别刷屏。
 */
let lastTouchFailAt = 0;
function reportTouchFail(res: { ok: boolean; message?: string }) {
  if (res.ok) return;
  const now = Date.now();
  if (now - lastTouchFailAt < 3000) return;
  lastTouchFailAt = now;
  console.warn('投屏触摸失败: ', res.message);
  message.warning(i18n.t('投屏没在跑（可能被重启过），请点「开始投屏」重新连'));
}

function onMouseDown(e: MouseEvent) {
  if (!running.value) return;
  e.preventDefault();
  canvasRef.value?.focus();
  pressed = true;
  lastMoveSentAt = 0;
  // 移动和松手挂到 window 上，而不是画布上。
  // 原来挂在画布上，还额外绑了 mouseleave → onMouseUp：
  // 横向往边缘拖的时候鼠标一离开画布，就当成松手发了个 UP，
  // 触摸中途断掉，后面拖的全丢了 —— 桌面（launcher）只收到半截滑动，
  // 松手后自己弹回原来那一页。这就是「向右拖动松手又回原页」的原因。
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  // 松手可能收不到 —— 见 detachMouse 上面的注释
  window.addEventListener('blur', onMouseUpForced);
  document.addEventListener('visibilitychange', onVisibilityChange);
  armWatchdog();
  const { x, y } = toVideo(e);
  lastPoint = { x, y };
  sentPoint = { x, y };
  targetPoint = { x, y };
  dragStart = { x, y };
  mouseSpeed = 0;
  lastMoveEvent = { t: performance.now(), x, y };
  startSampling();
  sendTouch({ action: 'down', x, y });
}

function startSampling() {
  if (sampleTimer !== null) return;
  sampleTimer = setInterval(sampleTick, SAMPLE_MS);
}

function stopSampling() {
  if (sampleTimer === null) return;
  clearInterval(sampleTimer);
  sampleTimer = null;
}

/**
 * 一个采样点：把上次真正发出去的位置朝鼠标目标推进。
 *
 * 两件事很重要：
 * 1). 每一步至少走「鼠标速度 × SAMPLE_MS × MIN_STEP_FACTOR」—— 不能只是逐步逼近目标。
 *     只逼近的话，尾巴会是一串越来越小的位移（实测这种「减速尾巴」 5 次全失败，
 *     一个都没翻）；保留住尾巴上的速度和位移，桌面才算得出甩力。
 * 2). 位置没变就不发 —— 绝不能发「原地不动」的样本，那会把速度算成 0。
 */
function sampleTick() {
  if (!pressed) {
    stopSampling();
    return;
  }
  const dx = targetPoint.x - sentPoint.x;
  const dy = targetPoint.y - sentPoint.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return;
  const floorStep = mouseSpeed * SAMPLE_MS * MIN_STEP_FACTOR;
  const step = Math.min(dist, Math.max(dist * 0.5, floorStep));
  const x = sentPoint.x + (dx / dist) * step;
  const y = sentPoint.y + (dy / dist) * step;
  sentPoint = { x, y };
  lastMoveSentAt = Date.now();
  sendTouch({ action: 'move', x, y });
}

function detachMouse() {
  window.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('mouseup', onMouseUp);
  window.removeEventListener('blur', onMouseUpForced);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  stopSampling();
  if (pressWatchdog !== null) {
    clearTimeout(pressWatchdog);
    pressWatchdog = null;
  }
}

/**
 * 松手事件的保险。
 *
 * 只靠 window 的 mouseup 还不够：窗口失焦、鼠标在窗口外松开、或者事件丢了，
 * mouseup 就永远收不到 —— 手机上那根"手指"会一直按着不放。
 * 桌面（launcher）按久了就进入"长按拖图标"状态，此后**应用页怎么滑都滑不动**
 * （但"应用建议"那种独立页面还能滑，因为不走工作区）。
 * 实测就是这样：卡住之后连 adb 原生滑动都翻不了页，按一下返回 / 点空白才恢复。
 *
 * 所以窗口失焦、页面被隐藏、或者按着超过 8 秒没任何移动，都强制补一个 UP。
 */
function onMouseUpForced() {
  if (!pressed) return;
  // 用最后已知位置，别用合成事件里的 (0,0) —— 那会让手指先跳到左上角再松开
  releaseTouch(lastPoint.x, lastPoint.y);
}
function onVisibilityChange() {
  if (document.hidden) onMouseUpForced();
}

function armWatchdog() {
  if (pressWatchdog !== null) clearTimeout(pressWatchdog);
  pressWatchdog = setTimeout(() => {
    pressWatchdog = null;
    if (pressed) onMouseUpForced();
  }, PRESS_WATCHDOG_MS);
}

function onMouseMove(e: MouseEvent) {
  if (!running.value || !pressed) return;
  armWatchdog();
  // 这里只记录目标位置（不直接发）：真正发给手机的是 sampleTick 按 SAMPLE_MS 重采样出来的点
  const { x, y } = toVideo(e);
  const now = performance.now();
  const dt = now - lastMoveEvent.t;
  if (dt > 0) {
    // 浏览器事件的 timeStamp 和 performance.now() 同一个时基，可以直接相减
    const v = Math.hypot(x - lastMoveEvent.x, y - lastMoveEvent.y) / dt;
    // 平滑一下，别让单个抖动样本把速度带偏
    mouseSpeed = mouseSpeed === 0 ? v : mouseSpeed * 0.5 + v * 0.5;
    lastMoveEvent = { t: now, x, y };
  }
  lastPoint = { x, y };
  targetPoint = { x, y };
}

/**
 * 松手。
 *
 * 注意：绝对不能在位置没变的时候补 MOVE。
 * 之前这里写的是「只要距上次发送超过 32ms 就补一个终点 MOVE」，
 * 结果松手瞬间常常补出一条**和上一条完全相同位置**的 MOVE ——
 * 手机的 VelocityTracker 把这个"原地不动"的样本当成最后一段位移，
 * 算出来的速度≈0，于是没有甩力，桌面松手就吸附回原来那一页。
 * （现象就是：页面跟着手指拖得好好的，一松手弹回去。）
 * 实测日志：02.553 move x=3 → 02.627 move x=3 → up，后两条坐标一模一样。
 *
 * 所以只在**位置真的变了**的时候才补。
 */
/**
 * 松手。
 *
 * 手机桌面（EMUI）松手时**只看速度**：拖动本身会让页面跟手，但最终「翻页还是弹回」
 * 取决于松手瞬间的速度。鼠标用户是「拖到位 → 停一下 → 松手」，停顿时速度已经归零，
 * 所以会弹回 —— 跟拖了多远无关。（用户实测的旁证：拖到一半按一下右键再松手
 * 就不会弹回 —— 因为那等于在「还在动」的时候松手。）
 *
 * 所以拖动结束时，总是补一次「手指还在朝前动」的采样：
 *     MOVE(松手位置) → 12ms → UP(再往前一步的位置)
 * 让最后一对采样带着真实位移和速度。
 *
 * 三点很关键：
 * 1). 最后一对采样必须真的隔开（≥ 12ms）—— 服务端把两条消息挤在同一毫秒时，
 *     VelocityTracker 遇到 dt=0 会直接中断计算，速度算成 0（这也是「同一段流
 *     用独立探针注入能翻、从应用里注入却翻不了」的根因）。
 * 2). 绝不能补「和上一条完全相同位置」的样本（同 dt=0 的坑，见 37ab7d1）。
 * 3). 已经在屏幕边缘（前进方向出界）时，改成「先往回退一步，再在松手位置抬起」——
 *     最后一对采样依然是朝前的。
 */
/**
 * 兜底翻页（方案 B）。
 *
 * 我们注入的触摸是经 adb 控制通道送到手机的，事件时间戳由 scrcpy 服务端
 * 「收到消息那一刻」生成；一旦几条消息落在同一毫秒，手机侧算速度会直接中断
 * （VelocityTracker 遇到 dt=0），桌面就按「速度=0」吸附回原页。
 *
 * 所以松手时再用「手机本地注入」补一次同方向的滑动：input swipe 是手机本地
 * 生成事件，时间戳天然连续，桌面一定认。
 * 只在「桌面（launcher） + 大范围水平拖动」时补，不影响 App 内部的拖动。
 */
function releaseTouch(x: number, y: number) {
  if (!pressed) return;
  pressed = false;
  stopSampling();
  const canvas = canvasRef.value;
  const vw = canvas?.width || meta.value?.width || 1;
  const vh = canvas?.height || meta.value?.height || 1;
  const moved = x !== sentPoint.x || y !== sentPoint.y;
  const dragDist = Math.hypot(x - dragStart.x, y - dragStart.y);
  // 真正的「拖动」才补；轻触照旧（别把点击弄坏）
  const isDrag = dragDist > vw * 0.05;

  const dxAll = x - dragStart.x;
  const dyAll = y - dragStart.y;

  if (isDrag) {
    // 方向取整段拖动的方向：比用最后一个样本稳（鼠标手抖不会把方向带偏）
    const dx = x - dragStart.x;
    const dy = y - dragStart.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const step = Math.max(
      FLING_ASSIST_MIN_PX,
      Math.max(mouseSpeed, 0.5) * FINAL_GAP_MS * MIN_STEP_FACTOR,
    );
    const aheadX = x + ux * step;
    const aheadY = y + uy * step;
    if (aheadX >= 0 && aheadX <= vw && aheadY >= 0 && aheadY <= vh) {
      // 先把手指放到松手位置，再往前一步抬起（最后一对采样 = 朝前的一步）
      sendTouch({ action: 'move', x, y });
      setTimeout(() => {
        sendTouch({ action: 'up', x: aheadX, y: aheadY });
      }, FINAL_GAP_MS);
    } else {
      // 已经到屏幕边缘，没法再往前 → 先往回退一步，再在松手位置抬起
      // （这样最后一对采样依然是朝前的）
      const backX = Math.max(0, Math.min(vw, x - ux * step));
      const backY = Math.max(0, Math.min(vh, y - uy * step));
      sendTouch({ action: 'move', x: backX, y: backY });
      setTimeout(() => {
        sendTouch({ action: 'up', x, y });
      }, FINAL_GAP_MS);
    }
    return;
  }

  if (moved) {
    sendTouch({ action: 'move', x, y });
  }
  sendTouch({ action: 'up', x, y });
}

function onMouseUp(e: MouseEvent) {
  detachMouse();
  if (!running.value || !pressed) return;
  const { x, y } = toVideo(e);
  releaseTouch(x, y);
}

function onWheel(e: WheelEvent) {
  if (!running.value) return;
  e.preventDefault();
  const { x, y } = toVideo(e);
  // Chrome 一个滚轮格 deltaY 约为 ±100，换算成 scrcpy 的 ±1
  api.scrcpyScroll({
    x,
    y,
    scrollX: -e.deltaX / 100,
    scrollY: -e.deltaY / 100,
  });
}

/* ---------------- 键盘 → keycode ---------------- */

const KEY_MAP: Record<string, number> = {
  Enter: 66,
  Backspace: 67,
  Escape: 111,
  Tab: 61,
  ' ': 62,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Home: 3,
  Delete: 112,
  F5: 26,
};

function onKeyDown(e: KeyboardEvent) {
  if (!running.value) return;
  const code = KEY_MAP[e.key];
  if (code !== undefined) {
    e.preventDefault();
    api.scrcpyKey(code);
    return;
  }
  // 可打印字符直接注入文本
  if (e.key.length === 1) {
    e.preventDefault();
    api.scrcpyText(e.key);
  }
}

/* ---------------- 生命周期 ---------------- */

let offPacket: (() => void) | null = null;

// 把「正在启动」也告诉父组件，磁贴的开关要显示 loading
watch(starting, (v) => emit('starting', v));

onMounted(() => {
  if (api.onScrcpyMeta) {
    api.onScrcpyMeta((m: any) => {
      meta.value = { width: m.width, height: m.height };
      ensureDecoder(m.codec);
      emit('log', `投屏画面 ${m.width}x${m.height}`);
    });
  }
  if (api.onScrcpyPacket) {
    api.onScrcpyPacket((p: any) => onPacket(p));
  }
  if (api.onScrcpyLog) {
    api.onScrcpyLog((line: string) => emit('log', line));
  }
  if (api.onScrcpyError) {
    api.onScrcpyError((msg: string) => {
      errorText.value = msg;
      emit('log', `投屏错误：${msg}`);
    });
  }
  if (api.onScrcpyClosed) {
    api.onScrcpyClosed((reason: string) => {
      running.value = false;
      emit('running', false);
      emit('log', `投屏结束：${reason}`);
    });
  }
  // 这里刻意不自动 start()：面板默认就在，但要不要投由用户点
});

onUnmounted(() => {
  detachMouse();
  offPacket?.();
  stop();
});

defineExpose({ stop, start });
</script>

<template>
  <div class="scrcpy-view">
    <div class="sv-head">
      <span class="sv-title">{{ $t('投屏操控') }}</span>
      <span
        v-if="meta"
        class="sv-meta"
      >
        {{ meta.width }}×{{ meta.height }}
      </span>
      <span
        v-if="running"
        class="sv-fps"
      >
        {{ fps }} fps · {{ packetKb }} KB/s
      </span>
      <a-tooltip
        v-if="running"
        :title="$t('重新连接')"
      >
        <ReloadOutlined
          class="sv-icon"
          @click="stop().then(start)"
        />
      </a-tooltip>
      <a-tooltip
        v-else-if="!starting && !errorText"
        :title="$t('开始投屏')"
      >
        <PlayCircleOutlined
          class="sv-icon"
          @click="start"
        />
      </a-tooltip>
      <!-- 停止：只停投屏，面板留在原位，回到待机状态 -->
      <a-tooltip
        v-if="running || starting"
        :title="$t('停止投屏')"
      >
        <StopOutlined
          class="sv-icon sv-icon-stop"
          @click="stop()"
        />
      </a-tooltip>
    </div>

    <div class="sv-body">
      <div
        v-if="starting"
        class="sv-tip"
      >
        <LoadingOutlined spin />
        {{ $t('正在启动投屏…') }}
      </div>
      <div
        v-else-if="errorText"
        class="sv-tip sv-tip-error"
      >
        <div>{{ errorText }}</div>
        <a-button
          size="small"
          type="primary"
          @click="start"
        >
          <PlayCircleOutlined />
          {{ $t('重试') }}
        </a-button>
      </div>
      <!-- 待机：面板在，但还没开始投 -->
      <div
        v-else-if="!running"
        class="sv-tip sv-idle"
      >
        <DesktopOutlined class="sv-idle-icon" />
        <div class="sv-idle-title">{{ $t('还没开始投屏') }}</div>
        <a-button
          type="primary"
          @click="start"
        >
          <PlayCircleOutlined />
          {{ $t('开始投屏') }}
        </a-button>
        <div class="sv-idle-hint">
          {{ $t('投屏会在手机上启动一个服务，需要时再开') }}
        </div>
      </div>
      <!-- 画布一直留着，解码器直接往里画 -->
      <canvas
        ref="canvasRef"
        class="sv-canvas"
        :class="{ 'sv-canvas-hidden': !running && !starting }"
        tabindex="0"
        @mousedown="onMouseDown"
        @wheel="onWheel"
        @keydown="onKeyDown"
        @contextmenu.prevent
      />
      <div
        v-if="running && !meta"
        class="sv-tip"
      >
        {{ $t('等待画面…') }}
      </div>

      <!-- 息屏时投出来是全黑的，给个明确的解释和按钮 -->
      <div
        v-if="running && meta && screenAwake === false"
        class="sv-black"
      >
        <div class="sv-black-text">
          {{ $t('手机屏幕是黑的（息屏了），投出来就是全黑') }}
        </div>
        <a-button
          size="small"
          type="primary"
          @click="wakeScreen"
        >
          {{ $t('唤醒屏幕') }}
        </a-button>
      </div>
    </div>

    <div
      v-if="running"
      class="sv-foot"
    >
      {{ $t('点一下=轻触，拖动=滑动，滚轮=滚动，方向键/回车可用') }}
    </div>
  </div>
</template>

<style scoped>
.scrcpy-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  background-color: #1e1e1e;
  overflow: hidden;
}
.sv-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background-color: #2a2a2a;
  color: #ddd;
  font-size: 12px;
  flex-shrink: 0;
}
.sv-title {
  font-weight: 600;
}
.sv-meta,
.sv-fps {
  color: #888;
  font-size: 11px;
}
.sv-icon {
  cursor: pointer;
  margin-left: auto;
  color: #aaa;
}
.sv-icon:hover {
  color: #fff;
}
.sv-icon + .sv-icon {
  margin-left: 0;
}
.sv-icon-stop {
  color: #f48771;
}
.sv-icon-stop:hover {
  color: #ff7875;
}
.sv-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.sv-canvas {
  max-width: 100%;
  max-height: 100%;
  outline: none;
  cursor: crosshair;
}
.sv-canvas-hidden {
  visibility: hidden;
}
.sv-tip {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 6px;
  color: #999;
  font-size: 12px;
  padding: 12px;
  text-align: center;
}
.sv-tip-error {
  color: #f48771;
  flex-direction: column;
}
.sv-idle {
  flex-direction: column;
  gap: 10px;
}
.sv-idle-icon {
  font-size: 34px;
  color: #555;
}
.sv-idle-title {
  color: #aaa;
  font-size: 13px;
}
.sv-idle-hint {
  color: #666;
  font-size: 11px;
  text-align: center;
  max-width: 200px;
}
.sv-black {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background-color: #000000cc;
  color: #ddd;
  z-index: 2;
}
.sv-black-text {
  font-size: 12px;
  max-width: 240px;
  text-align: center;
}
.sv-foot {
  flex-shrink: 0;
  padding: 5px 10px;
  background-color: #2a2a2a;
  color: #777;
  font-size: 11px;
}
</style>
