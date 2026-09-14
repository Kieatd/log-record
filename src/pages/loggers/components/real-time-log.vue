<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import useLogStore from '@/stores/log';
import dayjs from 'dayjs'
import VueJsonPretty from 'vue-json-pretty'
import 'vue-json-pretty/lib/styles.css'
// @ts-ignore
import { RecycleScroller as RecycleScrollerType } from 'vue-virtual-scroller'
const divRef = ref<RecycleScrollerType | null>(null);
const logStore = useLogStore();
const props = defineProps<{ tabId: string }>()

const finallyLoggers = computed(() => {
  const list = logStore.currentFilterResults[props.tabId] ?? [];
  // vue-virtual-scroller 的 DynamicScroller 用 item.id 作为「每条高度」的缓存 key，
  // 而 key-field 在库内部硬编码成 "id"，外层传 key-field 没用。
  // 上报的日志 id 会大量重复（实测 9267 条里 8403 条重复，
  // 比如 id=1682 连续出现几百次），重复后几千条日志共用同一个高度槽位、
  // 高度互相覆盖，表现就是：条目错位、每一条之间出现巨大空隙、
  // 滚动条长度膨胀（实测 40 万像素）。
  // 所以这里按位置重新编号，保证 key 唯一。列表只追加，位置是稳定的。
  return list.map((item, index) => ({ ...item, id: `log-${index}` }));
})

const scrollToBottom = () => {
  if (divRef.value && logStore.isScrollToBottom) {
    divRef.value.scrollToItem(finallyLoggers.value.length - 1)
  }
};

watch(finallyLoggers, () => {
  nextTick(scrollToBottom);
});

watch(() => logStore.isScrollToBottom, () => {
  nextTick(scrollToBottom);
});

const scroll = () => {
};
const wheel = () => {
  logStore.setTabIsScrollToBottomByTabId(false);
};


const parseText = (text: string) => {
  try {
    return JSON.parse(text);
  } catch (error) {
    return text;
  }
}
</script>

<template>
  <!-- min-item-size 是「未测量条目」的估算高度，直接决定滚动条长度，
       实测每条就是 38px（a-tag 22px + .item-box 上下 padding 8px×2），
       原来写 54 会让总高度虚高约 42%，列表越长滚动条越偏 → 改成实测值 38 -->
  <DynamicScroller :items="finallyLoggers" type-field="level" :min-item-size="38" class="log-container" ref="divRef"
    @scroll="scroll" @wheel="wheel">
    <template v-slot="{ item, active }">
      <DynamicScrollerItem :item="item" :active="active" :size-dependencies="[
        item.formatData,
      ]" :data-index="`${item.createTime}_${item.id}`" class="item-box">
        <div :class="`log-level-sign ${item.level}`" />
        <a-tag class="tag-box">{{ dayjs(item.createTime).format("HH:mm:ss.SSS") }}</a-tag>

        <div class="msg-text">
          <vue-json-pretty v-for="text in item.formatData" :data="parseText(text)" :deep="1" :show-double-quotes="true"
            showLength :collapsedNodeLength="1"
            :showIcon="!['string', 'number', 'null', 'undefined', 'boolean'].includes(typeof text)"
            :collapsed-on-click-brackets="true" :key="text + item.createTime" />
        </div>
      </DynamicScrollerItem>
    </template>
  </DynamicScroller>
</template>

<style scoped>
.log-container {
  overflow-y: auto;
  margin-bottom: 10px;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.log-container::-webkit-scrollbar {
  height: 1px;
  width: 8px;
}

.log-container::-webkit-scrollbar-thumb {
  background-color: var(--color-scroll);
  border-radius: var(--border-radius-default);
}

.log-container::-webkit-scrollbar-thumb:hover {
  background-color: var(--color-main);
}


.list-item:hover {
  background-color: #f5f5f5;
  cursor: pointer;
}

.select-back {
  background-color: #3366661a;
}

.log-level-sign {
  height: 22px;
  width: 2px;
  margin-right: 5px;
  flex-shrink: 0;
}

.tag-box {
  align-self: flex-start;
}

.warn {
  background-color: var(--color-warn);
}

.error {
  background-color: var(--color-error);
}

.header-text {
  overflow-x: scroll;
  cursor: auto;
  margin-right: auto;
}

.item-box {
  display: flex;
  flex-direction: row;
  padding: 8px 0;
}

.msg-text {
  margin-right: auto;
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  align-self: center;
  gap: 10px;
  flex-wrap: wrap;
}
</style>
