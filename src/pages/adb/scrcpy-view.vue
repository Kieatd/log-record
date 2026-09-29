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
/** 按着超过这么久没有任何移动，就强制松开（防止松手事件丢了手指一直按着） */
const PRESS_WATCHDOG_MS = 8000;
let lastMoveSentAt = 0;

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

function onPacket(packet: { type: string; keyframe?: boolean; pts?: string; data: Uint8Array }) {
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

async function start() {
  if (running.value || starting.value) return;
  starting.value = true;
  errorText.value = '';
  meta.value = null;
  decoder = null;
  writer = null;
  pending.length = 0;
  frameCount = 0;
  byteCount = 0;
  try {
    const res = await api.scrcpyStart(props.serial || undefined, 1024, 30);
    if (!res.ok) {
      errorText.value = res.message;
      starting.value = false;
      return;
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
  } catch (err: any) {
    errorText.value = err?.message || String(err);
  } finally {
    starting.value = false;
  }
}

async function stop() {
  errorText.value = '';
  meta.value = null;
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
  api.scrcpyTouch({ action: 'down', x, y }).then(reportTouchFail).catch(() => {});
}

function detachMouse() {
  window.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('mouseup', onMouseUp);
  window.removeEventListener('blur', onMouseUpForced);
  document.removeEventListener('visibilitychange', onVisibilityChange);
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
  // 别把每个 mousemove 都发过去，30/s 够了
  const now = Date.now();
  if (now - lastMoveSentAt < 32) return;
  lastMoveSentAt = now;
  const { x, y } = toVideo(e);
  lastPoint = { x, y };
  sentPoint = { x, y };
  api.scrcpyTouch({ action: 'move', x, y }).then(reportTouchFail).catch(() => {});
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
function releaseTouch(x: number, y: number) {
  if (!pressed) return;
  pressed = false;
  const moved = x !== sentPoint.x || y !== sentPoint.y;
  if (moved && Date.now() - lastMoveSentAt > 32) {
    api.scrcpyTouch({ action: 'move', x, y }).then(reportTouchFail).catch(() => {});
  }
  api.scrcpyTouch({ action: 'up', x, y }).then(reportTouchFail).catch(() => {});
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
  api.scrcpyScroll({ x, y, scrollX: -e.deltaX / 100, scrollY: -e.deltaY / 100 });
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
      <span v-if="meta" class="sv-meta">{{ meta.width }}×{{ meta.height }}</span>
      <span v-if="running" class="sv-fps">{{ fps }} fps · {{ packetKb }} KB/s</span>
      <a-tooltip v-if="running" :title="$t('重新连接')">
        <ReloadOutlined class="sv-icon" @click="stop().then(start)" />
      </a-tooltip>
      <a-tooltip v-else-if="!starting && !errorText" :title="$t('开始投屏')">
        <PlayCircleOutlined class="sv-icon" @click="start" />
      </a-tooltip>
      <!-- 停止：只停投屏，面板留在原位，回到待机状态 -->
      <a-tooltip v-if="running || starting" :title="$t('停止投屏')">
        <StopOutlined class="sv-icon sv-icon-stop" @click="stop()" />
      </a-tooltip>
    </div>

    <div class="sv-body">
      <div v-if="starting" class="sv-tip">
        <LoadingOutlined spin />
        {{ $t('正在启动投屏…') }}
      </div>
      <div v-else-if="errorText" class="sv-tip sv-tip-error">
        <div>{{ errorText }}</div>
        <a-button size="small" type="primary" @click="start">
          <PlayCircleOutlined />
          {{ $t('重试') }}
        </a-button>
      </div>
      <!-- 待机：面板在，但还没开始投 -->
      <div v-else-if="!running" class="sv-tip sv-idle">
        <DesktopOutlined class="sv-idle-icon" />
        <div class="sv-idle-title">{{ $t('还没开始投屏') }}</div>
        <a-button type="primary" @click="start">
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
      <div v-if="running && !meta" class="sv-tip">{{ $t('等待画面…') }}</div>

      <!-- 息屏时投出来是全黑的，给个明确的解释和按钮 -->
      <div v-if="running && meta && screenAwake === false" class="sv-black">
        <div class="sv-black-text">{{ $t('手机屏幕是黑的（息屏了），投出来就是全黑') }}</div>
        <a-button size="small" type="primary" @click="wakeScreen">
          {{ $t('唤醒屏幕') }}
        </a-button>
      </div>
    </div>

    <div v-if="running" class="sv-foot">
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
