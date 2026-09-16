<script setup lang="ts">
import dayjs from 'dayjs';
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

const [messageApi, contextHolder] = message.useMessage();
const i18n = useI18n();
const props = defineProps(['csn']);

const reqBody = computed(() => {
  try {
    if (!props.csn.reqBody) {
      return null;
    }
    return JSON.parse(props.csn.reqBody);
  } catch (error) {
    console.warn('解析响应体失败', error, props.csn.reqBody);
    return props.csn.reqBody;
  }
});

const resBody = computed(() => {
  try {
    return JSON.parse(props.csn.resBody);
  } catch (error) {
    console.warn('解析响应体失败', error);
    return props.csn?.resBody ?? null;
  }
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

// 一键复制整段请求体 / 响应体（虚拟滚动下无法手动全选，故提供按钮）
const copyBody = (raw: any) => {
  const text = formatForCopy(raw);
  if (!text) {
    return;
  }
  copyText(text);
};

/**
 * 复制请求参数：请求地址 + 空行 + 请求体。
 * 请求体为空时只复制地址。
 */
const copyRequestParams = () => {
  const url = String(props.csn?.url ?? '');
  if (!url) {
    return;
  }
  const body = formatForCopy(props.csn?.reqBody);
  if (!body) {
    copyText(url);
    return;
  }
  copyText(`${url}\n\n${body}`);
};

const onDoubleNodeClick = (root: any) => {
  let n = 0;
  let timer: NodeJS.Timeout | null = null;
  return (node: any) => {
    n += 1;
    if (n >= 2) {
      const path = node.path.substring(1);
      console.log(path, root);
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

const onReqNodeClick = computed(() => {
  return onDoubleNodeClick(reqBody.value);
});
const onResNodeClick = computed(() => {
  return onDoubleNodeClick(resBody.value);
});

/* ---------------- 请求体 / 响应体 内部搜索 ---------------- */

const reqSearch = ref('');
const resSearch = ref('');
// 「只看匹配」：把无关节点裁掉，匹配项就全部可见了
const reqOnlyMatch = ref(false);
const resOnlyMatch = ref(false);
// 「展开层级」由 deep 控制（vue-json-pretty 内部 watch 了 deep，
// 改它就会重算折叠状态，不需要重新挂载组件）。
//   DEEP_ALL   全部展开（默认值：进来就能直接看到全部内容）
//   DEEP_NONE  全部折叠：只有顶层字段可见，里面的对象/数组都收成 {...}
// 注意：deep 必须是真值才会被应用，所以「全折叠」用 1 而不是 0。
const DEEP_ALL = 99;
const DEEP_NONE = 1;
const reqDeep = ref(DEEP_ALL);
const resDeep = ref(DEEP_ALL);

// 单个按钮切换：未全展开 → 展开全部；已全展开 → 折叠全部（嵌套内容全收起）
const isReqExpanded = computed(() => reqDeep.value === DEEP_ALL);
const isResExpanded = computed(() => resDeep.value === DEEP_ALL);
const toggleReqDeep = () => {
  reqDeep.value = isReqExpanded.value ? DEEP_NONE : DEEP_ALL;
};
const toggleResDeep = () => {
  resDeep.value = isResExpanded.value ? DEEP_NONE : DEEP_ALL;
};

// 每次切到另一条请求（进入详情），都回到「全部展开」的默认状态
watch(
  () => props.csn?.id,
  () => {
    reqDeep.value = DEEP_ALL;
    resDeep.value = DEEP_ALL;
  },
);

// 开始搜索时（从「没搜索」变成「有搜索」）自动做两件事：
//   1. 全部展开 —— 否则命中项可能藏在折叠的节点里看不见
//   2. 勾上「只看匹配」 —— 搜完直接看结果，不用再点一下
// 只在开始搜索那一刻处理，后续继续输入不会覆盖你手动取消的勾选
watch(reqSearch, (val, oldVal) => {
  if (val && !oldVal) {
    reqDeep.value = DEEP_ALL;
    reqOnlyMatch.value = true;
  }
});
watch(resSearch, (val, oldVal) => {
  if (val && !oldVal) {
    resDeep.value = DEEP_ALL;
    resOnlyMatch.value = true;
  }
});

const reqMatchCount = computed(() =>
  countMatchesInValue(reqBody.value, reqSearch.value),
);
const resMatchCount = computed(() =>
  countMatchesInValue(resBody.value, resSearch.value),
);

// 开启「只看匹配」时渲染裁剪后的数据；返回 undefined 表示无匹配
const reqBodyShown = computed(() => {
  if (!reqOnlyMatch.value || !reqSearch.value) {
    return reqBody.value;
  }
  return pruneByKeyword(reqBody.value, reqSearch.value);
});
const resBodyShown = computed(() => {
  if (!resOnlyMatch.value || !resSearch.value) {
    return resBody.value;
  }
  return pruneByKeyword(resBody.value, resSearch.value);
});

/**
 * 给 vue-json-pretty 用的自定义渲染：把命中关键词的片段包成 <mark>。
 *
 * 用渲染函数而不是拼 HTML 再 v-html，文本节点由 Vue 管理，
 * 请求/响应体里的外部内容不会被当成 HTML 注入。
 * defaultValue 对对象/数组是 VNode（形如 {...} 的预览），那种直接原样返回。
 */
const makeRenderer =
  (search: Ref<string>, field: 'defaultKey' | 'defaultValue') =>
  (opt: Record<string, any>) => {
    const text = opt[field];
    const keyword = search.value;
    if (!keyword || typeof text !== 'string') {
      return text;
    }
    return splitByKeyword(text, keyword).map((part) =>
      part.hit ? h('mark', null, part.text) : part.text,
    );
  };

const reqKeyRenderer = makeRenderer(reqSearch, 'defaultKey');
const reqValueRenderer = makeRenderer(reqSearch, 'defaultValue');
const resKeyRenderer = makeRenderer(resSearch, 'defaultKey');
const resValueRenderer = makeRenderer(resSearch, 'defaultValue');
</script>

<template v-if="csn.url">
  <div class="format-text">
    <contextHolder />
    <div class="content-box">
      <!-- 复制按钮：在框内、请求地址上方（靠右） -->
      <div class="detail-toolbar">
        <a-tooltip>
          <template #title>
            {{ $t('复制请求地址和请求体，中间空行隔开') }}
          </template>
          <a-button
            class="copy-params-btn"
            type="text"
            size="small"
            @click="copyRequestParams"
          >
            <template #icon><CopyOutlined /></template>
            {{ $t('复制请求参数') }}
          </a-button>
        </a-tooltip>
      </div>
      <div class="strip">
        <span class="label-item">{{ $t('请求地址：') }}</span>
        <span class="req-url">{{ csn.url }}</span>
      </div>
      <div class="strip">
        <span class="label-item">{{ $t('请求方法：') }}</span>
        <span class="req-url">{{ csn.method }}</span>
      </div>
      <div class="strip">
        <span class="label-item">{{ $t('请求时间：') }}</span>
        <span>
          {{ dayjs(csn.createTime).format('YYYY-MM-DD HH:mm:ss') }}
        </span>
      </div>
      <div class="strip">
        <span class="label-item">{{ $t('请求头：') }}</span>
        <div
          class="headers-container"
          v-if="Object.keys(csn.reqHeaders ?? {}).length !== 0"
        >
          <div
            class="row-container"
            v-for="(value, key) in csn.reqHeaders"
          >
            <span class="column-text">{{ key }}</span>
            <span class="column-value-text">{{ value }}</span>
          </div>
        </div>
        <span v-else>{{ $t('空') }}</span>
      </div>
      <div class="strip">
        <span class="label-item">{{ $t('请求体：') }}</span>
        <div
          class="body-box"
          v-if="csn.reqBody"
        >
          <div class="body-toolbar">
            <a-input
              v-model:value="reqSearch"
              class="body-search"
              size="small"
              :placeholder="$t('搜索请求体')"
              allow-clear
            />
            <span v-if="reqSearch" class="match-count">
              {{
                reqMatchCount
                  ? $t('匹配 {count} 处', { count: reqMatchCount })
                  : $t('无匹配')
              }}
            </span>
            <a-checkbox
              v-if="reqSearch && typeof reqBody === 'object'"
              v-model:checked="reqOnlyMatch"
              class="only-match"
            >
              {{ $t('只看匹配') }}
            </a-checkbox>
            <a-tooltip>
              <template #title>
                {{ isReqExpanded ? $t('折叠全部') : $t('展开全部') }}
              </template>
              <a-button
                class="fold-btn"
                type="text"
                size="small"
                @click="toggleReqDeep"
              >
                <template #icon>
                  <MinusSquareOutlined v-if="isReqExpanded" />
                  <PlusSquareOutlined v-else />
                </template>
              </a-button>
            </a-tooltip>
            <a-tooltip>
              <template #title>{{ $t('复制请求体完整内容') }}</template>
              <a-button
                class="copy-btn"
                type="text"
                size="small"
                @click="copyBody(csn.reqBody)"
              >
                <template #icon>
                  <CopyOutlined />
                </template>
                {{ $t('复制') }}
              </a-button>
            </a-tooltip>
          </div>
          <!-- 纯文本请求体：先转义再高亮，避免外部内容被当成 HTML 注入 -->
          <pre
            v-if="typeof reqBody === 'string'"
            v-html="highlightHtml(String(reqBody), reqSearch)"
          />
          <template v-else-if="csn.reqBody">
            <vue-json-pretty
              v-if="reqBodyShown !== undefined"
              :data="reqBodyShown"
              :deep="reqDeep"
              :render-node-key="reqKeyRenderer"
              :render-node-value="reqValueRenderer"
              :show-double-quotes="true"
              showLength
              show-icon
              :collapsed-on-click-brackets="false"
              :key="csn.id + 'requestBody'"
              :virtual="true"
              class="vue-json-pretty"
              @node-click="onReqNodeClick"
            />
            <span v-else class="match-count">{{ $t('无匹配') }}</span>
          </template>
        </div>
        <span v-else>{{ $t('空') }}</span>
      </div>
    </div>
    <div
      class="content-box"
      v-if="typeof csn.statusCode === 'number'"
    >
      <template v-if="typeof csn.statusCode === 'number'">
        <div class="strip">
          <span class="label-item">{{ $t('响应时间：') }}</span>
          <span>
            {{ dayjs(csn.endTime).format('YYYY-MM-DD HH:mm:ss') }}
          </span>
        </div>
        <div class="strip">
          <span class="label-item">{{ $t('响应状态：') }}</span>
          <span>{{ csn.statusCode }}</span>
        </div>
        <div class="strip">
          <span class="label-item">{{ $t('响应头：') }}</span>
          <div
            class="headers-container"
            v-if="Object.keys(csn.resHeaders ?? {}).length !== 0"
          >
            <div
              class="row-container"
              v-for="(value, key) in csn.resHeaders"
            >
              <span class="column-text">{{ key }}</span>
              <span class="column-value-text">{{ value }}</span>
            </div>
          </div>
          <span v-else>{{ $t('空') }}</span>
        </div>
        <div class="strip">
          <span class="label-item">{{ $t('响应体：') }}</span>
          <div
            class="body-box"
            v-if="resBody"
          >
            <div class="body-toolbar">
              <a-input
                v-model:value="resSearch"
                class="body-search"
                size="small"
                :placeholder="$t('搜索响应体')"
                allow-clear
              />
              <span v-if="resSearch" class="match-count">
                  {{
                    resMatchCount
                      ? $t('匹配 {count} 处', { count: resMatchCount })
                      : $t('无匹配')
                  }}
                </span>
                <a-checkbox
                  v-if="resSearch && typeof resBody === 'object'"
                  v-model:checked="resOnlyMatch"
                  class="only-match"
                >
                  {{ $t('只看匹配') }}
                </a-checkbox>
                <a-tooltip>
                  <template #title>
                    {{ isResExpanded ? $t('折叠全部') : $t('展开全部') }}
                  </template>
                  <a-button
                    class="fold-btn"
                    type="text"
                    size="small"
                    @click="toggleResDeep"
                  >
                    <template #icon>
                      <MinusSquareOutlined v-if="isResExpanded" />
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
                  @click="copyBody(csn.resBody)"
                >
                  <template #icon>
                    <CopyOutlined />
                  </template>
                  {{ $t('复制') }}
                </a-button>
              </a-tooltip>
            </div>
            <!-- 纯文本响应体：先转义再高亮 -->
            <pre
              v-if="typeof resBody === 'string'"
              v-html="highlightHtml(String(resBody), resSearch)"
            />
            <template v-else-if="csn.resBody">
              <vue-json-pretty
                v-if="resBodyShown !== undefined"
                :data="resBodyShown"
                root-path=""
                :deep="resDeep"
                :render-node-key="resKeyRenderer"
                :render-node-value="resValueRenderer"
                :show-double-quotes="true"
                showLength
                show-icon
                :collapsed-on-click-brackets="false"
                :key="csn.id + 'responseBody'"
                :virtual="true"
                class="vue-json-pretty"
                @node-click="onResNodeClick"
              />
              <span v-else class="match-count">{{ $t('无匹配') }}</span>
            </template>
          </div>
          <span v-else>空</span>
        </div>
      </template>
    </div>
  </div>
</template>
<style scoped>
.format-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 15px;
}

/* 框内顶部的操作行（靠右）。它在 content-box 内部、有 15px padding，
   所以不会超出外框 */
.detail-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  /* 抵消 content-box 的 10px gap，让按钮贴近请求地址 */
  margin-bottom: -4px;
}

.copy-params-btn {
  flex-shrink: 0;
  height: 22px;
  padding: 0 8px;
  font-size: 12px;
  color: var(--color-main);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.copy-params-btn:hover {
  background-color: rgba(51, 102, 102, 0.1);
  color: var(--color-main);
}

.content-box {
  gap: 10px;
  display: flex;
  flex-direction: column;
  background-color: var(--color-background);
  padding: 15px;
  border-radius: var(--border-radius-large);
}

.strip {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  position: relative;
  gap: 10px;
}

.label-item {
  width: 130px;
  flex-shrink: 0;
}

.headers-container {
  display: flex;
  flex-direction: column;
  width: 100%;
  border: 1px solid var(--color-scroll);
  border-radius: var(--border-radius-large);
}

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

.row-container {
  display: flex;
  flex-direction: row;
  align-items: center;
  border-bottom: 1px solid var(--color-scroll);
}

.row-container:nth-last-child(1) {
  border-bottom-width: 0px;
}

.column-text {
  border-right: 1px solid var(--color-scroll);
  padding: 8px 10px;
  align-self: stretch;
  flex: 3;
  font-weight: 500;
  flex-shrink: 0;
}

.column-value-text {
  padding: 8px 10px;
  flex: 7;
  word-wrap: break-word;
  word-break: break-all;
}

.br {
  width: 100%;
  height: 1px;
  background-color: var(--color-scroll);
}

.highlight {
  flex: 1;
  border-radius: var(--border-radius-default);
}

.copy {
  position: absolute;
  right: 10px;
  top: 10px;
  cursor: pointer;
}

.req-url {
  word-wrap: break-word;
  word-break: break-all;
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
