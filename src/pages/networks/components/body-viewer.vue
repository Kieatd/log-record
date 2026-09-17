<script setup lang="ts">
/**
 * 请求体 / 响应体 / 重新请求结果 通用查看器。
 *
 * 这三处原本各写了一份「搜索 + 只看匹配 + 展开折叠 + 复制 + 双击节点复制」，
 * 重新请求结果漏了这些功能，所以抽成组件共用，避免以后再漏。
 */
import { computed, h, ref, watch } from 'vue';
import type { Ref } from 'vue';
import VueJsonPretty from 'vue-json-pretty';
import 'vue-json-pretty/lib/styles.css';
import { message } from 'ant-design-vue';
import {
  CopyOutlined,
  MinusSquareOutlined,
  PlusSquareOutlined,
} from '@ant-design/icons-vue';
import { useI18n } from 'vue-i18n';
import get from 'lodash/get';
import {
  countMatchesInValue,
  highlightHtml,
  pruneByKeyword,
  splitByKeyword,
} from '@/utils/highlight';

const props = withDefaults(
  defineProps<{
    /** 原始内容，字符串会尝试按 JSON 解析，失败则按纯文本展示 */
    raw: any;
    /** 搜索框提示语，请求体/响应体文案不同 */
    searchPlaceholder?: string;
  }>(),
  { searchPlaceholder: '搜索响应体' },
);

const [messageApi, contextHolder] = message.useMessage();
const i18n = useI18n();

const data = computed(() => {
  const raw = props.raw;
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
});

// 把任意值整理成可读的纯文本：字符串若为 JSON 则美化，对象则美化输出
const formatForCopy = (raw: any): string => {
  if (raw === undefined || raw === null) {
    return '';
  }
  if (typeof raw === 'string') {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }
  if (typeof raw === 'object') {
    try {
      return JSON.stringify(raw, null, 2);
    } catch {
      return String(raw);
    }
  }
  return String(raw);
};

const copyText = async (text: any) => {
  try {
    await navigator.clipboard.writeText(formatForCopy(text));
    messageApi.info(i18n.t('复制成功'));
  } catch (err) {
    messageApi.warning(i18n.t('复制失败'));
    console.error('无法复制文本: ', err);
  }
};

// 双击节点复制该节点内容
const onDoubleNodeClick = (root: any) => {
  let n = 0;
  let timer: NodeJS.Timeout | null = null;
  return (node: any) => {
    n += 1;
    if (n >= 2) {
      const path = node.path.substring(1);
      copyText(get(root, path));
    }
    if (timer !== null) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      n = 0;
    }, 500);
  };
};

const onNodeClick = computed(() => onDoubleNodeClick(data.value));

/* ---------------- 内容内部搜索 ---------------- */

const search = ref('');
// 「只看匹配」：把无关节点裁掉，匹配项就全部可见了
const onlyMatch = ref(false);
// 「展开层级」由 deep 控制（vue-json-pretty 内部 watch 了 deep，
// 改它就会重算折叠状态，不需要重新挂载组件）。
//   DEEP_ALL   全部展开（默认值：进来就能直接看到全部内容）
//   DEEP_NONE  全部折叠：只有顶层字段可见，里面的对象/数组都收成 {...}
// 注意：deep 必须是真值才会被应用，所以「全折叠」用 1 而不是 0。
const DEEP_ALL = 99;
const DEEP_NONE = 1;
const deep = ref(DEEP_ALL);
const isExpanded = computed(() => deep.value === DEEP_ALL);
const toggleDeep = () => {
  deep.value = isExpanded.value ? DEEP_NONE : DEEP_ALL;
};

// 开始搜索时（从「没搜索」变成「有搜索」）自动做两件事：
//   1. 全部展开 —— 否则命中项可能藏在折叠的节点里看不见
//   2. 勾上「只看匹配」 —— 搜完直接看结果，不用再点一下
// 只在开始搜索那一刻处理，后续继续输入不会覆盖你手动取消的勾选
watch(search, (val, oldVal) => {
  if (val && !oldVal) {
    deep.value = DEEP_ALL;
    onlyMatch.value = true;
  }
});

// 内容换了（切到另一条接口、重新请求拿到新结果）就重置回默认状态
watch(
  () => props.raw,
  () => {
    search.value = '';
    onlyMatch.value = false;
    deep.value = DEEP_ALL;
  },
);

const matchCount = computed(() => countMatchesInValue(data.value, search.value));

// 开启「只看匹配」时渲染裁剪后的数据；返回 undefined 表示无匹配
const shown = computed(() => {
  if (!onlyMatch.value || !search.value) {
    return data.value;
  }
  return pruneByKeyword(data.value, search.value);
});

/**
 * 给 vue-json-pretty 用的自定义渲染：把命中关键词的片段包成 <mark>。
 *
 * 用渲染函数而不是拼 HTML 再 v-html，文本节点由 Vue 管理，
 * 请求/响应体里的外部内容不会被当成 HTML 注入。
 * defaultValue 对对象/数组是 VNode（形如 {...} 的预览），那种直接原样返回。
 */
const makeRenderer =
  (field: 'defaultKey' | 'defaultValue') => (opt: Record<string, any>) => {
    const text = opt[field];
    const keyword = search.value;
    if (!keyword || typeof text !== 'string') {
      return text;
    }
    return splitByKeyword(text, keyword).map((part) =>
      part.hit ? h('mark', null, part.text) : part.text,
    );
  };

const keyRenderer = makeRenderer('defaultKey');
const valueRenderer = makeRenderer('defaultValue');
</script>

<template>
  <div class="body-box">
    <contextHolder />
    <div class="body-toolbar">
      <a-input
        v-model:value="search"
        class="body-search"
        size="small"
        :placeholder="$t(searchPlaceholder)"
        allow-clear
      />
      <span v-if="search" class="match-count">
        {{
          matchCount
            ? $t('匹配 {count} 处', { count: matchCount })
            : $t('无匹配')
        }}
      </span>
      <a-checkbox
        v-if="search && typeof data === 'object'"
        v-model:checked="onlyMatch"
        class="only-match"
      >
        {{ $t('只看匹配') }}
      </a-checkbox>
      <a-tooltip>
        <template #title>
          {{ isExpanded ? $t('折叠全部') : $t('展开全部') }}
        </template>
        <a-button
          class="fold-btn"
          type="text"
          size="small"
          @click="toggleDeep"
        >
          <template #icon>
            <MinusSquareOutlined v-if="isExpanded" />
            <PlusSquareOutlined v-else />
          </template>
        </a-button>
      </a-tooltip>
      <a-tooltip>
        <template #title>{{ $t('复制响应体完整内容') }}</template>
        <a-button
          class="copy-btn"
          type="text"
          size="small"
          @click="copyText(data)"
        >
          <template #icon><CopyOutlined /></template>
          {{ $t('复制') }}
        </a-button>
      </a-tooltip>
    </div>
    <!-- 纯文本内容：先转义再高亮，避免外部内容被当成 HTML 注入 -->
    <pre
      v-if="typeof data === 'string'"
      v-html="highlightHtml(String(data), search)"
    />
    <template v-else-if="data">
      <vue-json-pretty
        v-if="shown !== undefined"
        :data="shown"
        root-path=""
        :deep="deep"
        :render-node-key="keyRenderer"
        :render-node-value="valueRenderer"
        :show-double-quotes="true"
        showLength
        show-icon
        :collapsed-on-click-brackets="false"
        :virtual="true"
        class="vue-json-pretty"
        @node-click="onNodeClick"
      />
      <span v-else class="match-count">{{ $t('无匹配') }}</span>
    </template>
  </div>
</template>

<style scoped>
.body-box {
  width: 100%;
  /* 关键：flex 子项的 min-width 默认是 auto，不会收缩到内容最小宽度以下。
     而响应体里的长字符串（如 templateAddress）是 nowrap 的，
     内容最小宽度能到 700+px，于是 body-box 拒绝收缩、
     把 strip（label 130 + gap 10 + body-box）整个撑爆，
     溢出再一路传到最外层 → 整个右侧面板出现横向滚动条，
     一旦横向滑动，标签和表头就会错位、内容被裁掉。
     设成 0 才能收缩，让 JSON 树（它本身 overflow:auto）内部滚动。 */
  min-width: 0;
  border: 1px solid var(--color-scroll);
  border-radius: var(--border-radius-large);
  padding: 10px;
}

/* 请求/响应体是普通文本时走 <pre> 分支。
   pre 默认 nowrap，同样会溢出，所以也让它自己内部滚动 */
.body-box > pre {
  min-width: 0;
  overflow: auto;
}

.body-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-bottom: 6px;
}

.body-search {
  flex: 1;
  min-width: 110px;
  max-width: 200px;
}

.only-match {
  flex-shrink: 0;
  font-size: 12px;
  white-space: nowrap;
}

.only-match :deep(span) {
  font-size: 12px;
}

.body-search :deep(.ant-input) {
  background-color: var(--color-background);
  color: var(--color-text);
  font-size: 12px;
}

.body-search :deep(.ant-input::placeholder) {
  color: var(--color-border);
}

.match-count {
  font-size: 12px;
  white-space: nowrap;
  opacity: 0.6;
}

/* 搜索命中高亮。半透明黄：明/暗主题下都看得清，
   color 继承原样式（JSON 里字符串/数字各有自己的颜色）。
   必须用 :deep —— <mark> 由渲染函数或 v-html 产生，
   拿不到本组件的 scoped 属性。 */
.body-box :deep(mark) {
  padding: 0 1px;
  border-radius: 2px;
  color: inherit;
  background-color: rgba(250, 173, 20, 0.45);
}

.fold-btn {
  flex-shrink: 0;
  height: 24px;
  padding: 0 6px;
  font-size: 13px;
  color: var(--color-main);
}

.fold-btn:hover {
  background-color: rgba(51, 102, 102, 0.1);
  color: var(--color-main);
}

.copy-btn {
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
  color: var(--color-main);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.copy-btn:hover {
  background-color: rgba(51, 102, 102, 0.1);
  color: var(--color-main);
}

/* 允许在请求体/响应体里用鼠标拖选文本（虚拟滚动下仅能选中已渲染部分，
   需要全量请使用上方“复制”按钮） */
.body-box,
.body-box :deep(.vjs-tree) {
  user-select: text;
}


.vue-json-pretty::-webkit-scrollbar {
  height: 5px;
  width: 5px;
}

.vue-json-pretty::-webkit-scrollbar-thumb {
  background-color: var(--color-scroll);
  border-radius: var(--border-radius-default);
}

.vue-json-pretty::-webkit-scrollbar-thumb:hover {
  background-color: var(--color-main);
}
</style>
