<template>
  <div class="split-pane" ref="paneRef">
    <div class="pane" :style="{ width: leftWidth + 'px' }">
      <slot name="left"></slot>
    </div>
    <div class="divider" @mousedown="onMouseDown"></div>
    <div class="pane" :style="{ width: `calc(100% - ${leftWidth}px)` }">
      <slot name="right"></slot>
    </div>
  </div>
</template>

<script>
import { onBeforeUnmount, onMounted, ref } from 'vue';

// 存档用项目里已有的 'Log Record$$xxx' 命名约定
const STORAGE_PREFIX = 'Log Record$$splitPaneWidth:';
// 右侧面板至少保留这么宽，避免把右边挤没
const MIN_RIGHT_WIDTH = 240;

export default {
  name: 'SplitPane',
  props: {
    initialLeftWidth: {
      type: Number,
      default: 200,
    },
    minWidth: {
      type: Number,
      default: 100,
    },
    /** 传入后会把宽度存到本地，下次打开沿用（不传则不持久化） */
    storageKey: {
      type: String,
      default: '',
    },
  },
  setup(props) {
    const paneRef = ref(null);
    const isDragging = ref(false);

    const readSavedWidth = () => {
      if (!props.storageKey) {
        return null;
      }
      try {
        const raw = localStorage.getItem(STORAGE_PREFIX + props.storageKey);
        const width = Number(raw);
        return Number.isFinite(width) && width > 0 ? width : null;
      } catch (err) {
        console.warn('读取面板宽度失败', err);
        return null;
      }
    };

    const saveWidth = () => {
      if (!props.storageKey) {
        return;
      }
      try {
        localStorage.setItem(
          STORAGE_PREFIX + props.storageKey,
          String(Math.round(leftWidth.value)),
        );
      } catch (err) {
        console.warn('保存面板宽度失败', err);
      }
    };

    /** 当前允许的最大左宽：容器宽度 - 分隔线 - 右侧最小宽度 */
    const getMaxWidth = () => {
      const total = paneRef.value?.clientWidth ?? 0;
      if (!total) {
        return Number.MAX_SAFE_INTEGER;
      }
      return Math.max(total - MIN_RIGHT_WIDTH, props.minWidth);
    };

    const clampWidth = (width) =>
      Math.min(Math.max(width, props.minWidth), getMaxWidth());

    // 优先用存档；存档宽度在当前窗口放不下时会被收敛到上限
    const leftWidth = ref(
      clampWidth(readSavedWidth() ?? props.initialLeftWidth),
    );

    const startX = ref(0);
    const startWidth = ref(0);

    const onMouseMove = (e) => {
      if (!isDragging.value) {
        return;
      }
      leftWidth.value = clampWidth(startWidth.value + (e.clientX - startX.value));
    };

    const onMouseUp = () => {
      if (!isDragging.value) {
        return;
      }
      isDragging.value = false;
      document.body.style.cursor = 'default';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      // 拖完才写，避免拖动过程中频繁写 localStorage
      saveWidth();
    };

    const onMouseDown = (e) => {
      isDragging.value = true;
      startX.value = e.clientX;
      startWidth.value = leftWidth.value;
      document.body.style.cursor = 'col-resize';
      // 挂在 document 上：鼠标拖出面板范围也能继续拖动，
      // 而且松手一定收得到（否则会把拖拽状态卡住）
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    let observer = null;
    onMounted(() => {
      const el = paneRef.value;
      if (!el || typeof ResizeObserver === 'undefined') {
        return;
      }
      // 窗口变小后，存档的宽度可能已经超过容器，这里收敛掉，
      // 否则右侧面板会被挤成负宽度
      observer = new ResizeObserver(() => {
        const next = clampWidth(leftWidth.value);
        if (next !== leftWidth.value) {
          leftWidth.value = next;
          saveWidth();
        }
      });
      observer.observe(el);
    });

    onBeforeUnmount(() => {
      observer?.disconnect();
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    });

    return {
      paneRef,
      leftWidth,
      onMouseDown,
      onMouseUp,
      onMouseMove,
    };
  },
};
</script>

<style scoped>
.split-pane {
  display: flex;
  width: 100%;
  height: 100%;
}

.pane {
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: var(--color-background-mute);
}

.divider {
  width: 4px;
  background-color: var(--color-scroll);
  cursor: col-resize;
  flex-shrink: 0;
}
</style>
