<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import {
  CloseOutlined,
  PushpinFilled,
  PushpinOutlined,
} from '@ant-design/icons-vue';
import ScrcpyView from './scrcpy-view.vue';

/**
 * 独立投屏浮窗（真窗口）。
 *
 * 主窗口点「浮窗」时开这个窗口：无边框 + 置顶，能拖到桌面任何地方，
 * 也能盖在别的软件上面（应用内的浮层做不到这点）。
 *
 * 它是同一个渲染入口，用 hash 路由区分：#/float?serial=xxx
 * 视频包由主进程发到「当前宿主窗口」——这个窗口一开，包就发到这里。
 */
const api = (window as any).electronAPI;

const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
const serial = params.get('serial') || '';

const mirrorRef = ref<{
  start: () => Promise<boolean>;
  stop: () => Promise<void>;
} | null>(null);

const pinned = ref(true);

function closeWindow() {
  api.closeMirrorWindow?.();
}

async function togglePin() {
  pinned.value = !pinned.value;
  await api.setMirrorAlwaysOnTop?.(pinned.value);
}

/** 投屏起停回报给主进程：召回时主窗口据此决定要不要自动接着投 */
function onRunning(v: boolean) {
  api.setMirrorWindowRunning?.(v);
}

/** 浮窗里的 scrcpy 日志转发回主窗口的输出面板，免得日志断掉 */
function relayLog(text: string) {
  api.relayMirrorLog?.(text);
}

onMounted(async () => {
  await api.setMirrorAlwaysOnTop?.(true);
  // 等一帧让 canvas 有尺寸再开投屏（scrcpy 要推 server + 起流，急不得）
  await new Promise((r) => setTimeout(r, 150));
  await mirrorRef.value?.start();
});

onUnmounted(() => {
  api.setMirrorWindowRunning?.(false);
});
</script>

<template>
  <div class="mirror-win">
    <!-- 整条都能拖窗口（按钮要 no-drag，否则点不动） -->
    <div class="mw-bar">
      <span class="mw-title">{{ $t('投屏浮窗') }}</span>
      <a-tooltip :title="pinned ? $t('取消置顶') : $t('置顶')">
        <span
          class="mw-btn"
          @click="togglePin"
        >
          <PushpinFilled v-if="pinned" />
          <PushpinOutlined v-else />
        </span>
      </a-tooltip>
      <a-tooltip :title="$t('还原到主窗口')">
        <span
          class="mw-btn"
          @click="closeWindow"
        >
          <CloseOutlined />
        </span>
      </a-tooltip>
    </div>
    <ScrcpyView
      ref="mirrorRef"
      class="mw-view"
      :serial="serial"
      :float="true"
      @float="closeWindow"
      @log="relayLog"
      @running="onRunning"
    />
  </div>
</template>

<style scoped>
.mirror-win {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #1e1e1e;
}

.mw-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 4px 8px;
  background: #2a2a2a;
  color: #ccc;
  font-size: 12px;
  -webkit-app-region: drag;
}

.mw-title {
  flex: 1;
}

.mw-btn {
  display: inline-flex;
  align-items: center;
  padding: 2px 4px;
  border-radius: 3px;
  color: #aaa;
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.mw-btn:hover {
  color: #fff;
  background: rgb(255 255 255 / 10%);
}

.mw-view {
  flex: 1;
  min-height: 0;
  border: 0;
  border-radius: 0;
}
</style>
