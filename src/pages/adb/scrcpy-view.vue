<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { CloseOutlined, LoadingOutlined, ReloadOutlined } from '@ant-design/icons-vue';
import {
  BitmapVideoFrameRenderer,
  WebCodecsVideoDecoder,
  WebGLVideoFrameRenderer,
} from '@yume-chan/scrcpy-decoder-webcodecs';

const props = defineProps<{ serial: string }>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'log', text: string): void;
  (e: 'running', value: boolean): void;
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

function onMouseDown(e: MouseEvent) {
  if (!running.value) return;
  e.preventDefault();
  canvasRef.value?.focus();
  pressed = true;
  const { x, y } = toVideo(e);
  api.scrcpyTouch({ action: 'down', x, y });
}

function onMouseMove(e: MouseEvent) {
  if (!running.value || !pressed) return;
  // 别把每个 mousemove 都发过去，30/s 够了
  const now = Date.now();
  if (now - lastMoveSentAt < 32) return;
  lastMoveSentAt = now;
  const { x, y } = toVideo(e);
  api.scrcpyTouch({ action: 'move', x, y });
}

function onMouseUp(e: MouseEvent) {
  if (!running.value || !pressed) return;
  pressed = false;
  const { x, y } = toVideo(e);
  api.scrcpyTouch({ action: 'up', x, y });
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
  start();
});

onUnmounted(() => {
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
      <a-tooltip :title="$t('关闭投屏')">
        <CloseOutlined class="sv-icon" @click="stop().then(() => emit('close'))" />
      </a-tooltip>
    </div>

    <div class="sv-body">
      <div v-if="starting" class="sv-tip">
        <LoadingOutlined spin />
        {{ $t('正在启动投屏…') }}
      </div>
      <div v-else-if="errorText" class="sv-tip sv-tip-error">
        {{ errorText }}
      </div>
      <!-- 画布一直留着，解码器直接往里画 -->
      <canvas
        ref="canvasRef"
        class="sv-canvas"
        :class="{ 'sv-canvas-hidden': !running && !starting }"
        tabindex="0"
        @mousedown="onMouseDown"
        @mousemove="onMouseMove"
        @mouseup="onMouseUp"
        @mouseleave="onMouseUp"
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
