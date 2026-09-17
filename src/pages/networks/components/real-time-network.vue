<script setup lang="ts">
import SplitPane from '@/pages/components/split-pane.vue';
import ContentArea from './content-area.vue';
import ClearIcon from '@/assets/images/clear-icon.vue';
import useNetworkStore from '@/stores/network';
import { computed, ref, watch } from 'vue';
import {
  buildArrivalNumberMap,
  buildPathSettingTree,
  collectPathKeys,
  filterDataNodes,
  filterFlatRequests,
  formatShortUrl,
  fromRelativePathKeys,
  getDefaultHiddenPathKeys,
  getRequestsByArrival,
  getStatusColor,
  sortTreeLeavesByRecency,
  toRelativePathKeys,
} from '@/utils/network';
import {
  firstMatchedRule,
  hexToRgba,
  normalizeIgnoreRules,
  normalizeKeywordRules,
  splitByKeywordRules,
} from '@/utils/highlight';
import {
  ApartmentOutlined,
  ClockCircleOutlined,
  CloseOutlined,
  EyeInvisibleOutlined,
  HighlightOutlined,
  PlusOutlined,
  SettingOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons-vue';
import { TreeProps } from 'ant-design-vue';
import type { SearchFilterType } from '@/types/global';

const networkStore = useNetworkStore();
const expandedKeys = ref<(string | number)[]>([]);

// 搜索输入做 300ms 防抖，避免大数据量下每次按键都全量重算
const debouncedFilter = ref<SearchFilterType>({
  text: networkStore.searchFilter.text,
  isCaseSensitive: networkStore.searchFilter.isCaseSensitive,
});
let timer: NodeJS.Timeout | null = null;

watch(
  () => networkStore.searchFilter,
  () => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      debouncedFilter.value = {
        text: networkStore.searchFilter.text,
        isCaseSensitive: networkStore.searchFilter.isCaseSensitive,
      };
    }, 300);
  },
  { deep: true },
);

const findKey = (arr: TreeProps['treeData']) => {
  const tempArr: (string | number)[] = [];
  arr.forEach((tree) => {
    tempArr.push(tree.key);
    if (Array.isArray(tree.children)) {
      tempArr.push(...findKey(tree.children));
    }
  });
  return tempArr;
};

// 请求 id → 到达序号（第 1 个收到的 = 1，第 2 个 = 2 ……）。
// 放在组件内部派生而不挂到 store 上：它是纯展示数据，
// 且 store 在 HMR 下可能是陈旧实例，新增字段取不到会让画面报错。
const arrivalNumbers = computed(() =>
  buildArrivalNumberMap(networkStore.requests),
);

// 所有接口按「最新在最上方」排序（到达顺序倒过来）。
// 不用 id 排序——id 是 base36 字符串，Number() 会得到 NaN。
const allRequestsNewestFirst = computed(() =>
  getRequestsByArrival(networkStore.requests).reverse(),
);

// 树模式的过滤结果。
// 接口那一层（叶子）在这里统一按序号倒序排：不依赖 store 里树的构建顺序，
// 路径层级（目录）的相对顺序保持不变。
const filterTreeData = computed(() => {
  const tree = debouncedFilter.value.text
    ? filterDataNodes(networkStore.treeData, debouncedFilter.value)
    : networkStore.treeData;
  return sortTreeLeavesByRecency(tree ?? [], arrivalNumbers.value);
});

/* ---------------- 路径显示设置（只影响链接文本，不过滤列表） ---------------- */

// 被隐藏的路径段 key（勾选的路径 = 未在 hiddenKeys 里）
const hiddenKeys = ref<Set<string>>(new Set());
const pathTree = computed(() => buildPathSettingTree(allRequestsNewestFirst.value));
const pathExpandedKeys = ref<(string | number)[]>([]);

// 平铺模式的过滤结果（与搜索共用同一套条件）
// 序号按「到达顺序」编号：最早收到 = 1，最新收到 = 最大；搜索过滤时不重新编号
const flatList = computed(() =>
  filterFlatRequests(allRequestsNewestFirst.value, debouncedFilter.value)
    .map((item) => ({
      ...item,
      no: arrivalNumbers.value.get(String(item.id)) ?? 0,
      shortUrl: formatShortUrl(item.url ?? '', hiddenKeys.value),
    }))
    // 忽略规则放在最后：先按搜索过滤，再把命中忽略关键词的整条去掉
    .filter((item) => !isIgnoredUrl(item.shortUrl)),
);

// 被忽略规则隐藏掉的条数（列表底部提示用，免得以为数据丢了）
const ignoredCount = computed(() => {
  if (!activeIgnoreKeywords.value.length) {
    return 0;
  }
  return filterFlatRequests(
    allRequestsNewestFirst.value,
    debouncedFilter.value,
  ).filter((item) =>
    isIgnoredUrl(formatShortUrl(item.url ?? '', hiddenKeys.value)),
  ).length;
});

// 树模式：叶子节点的 key 就是请求 id，用同一份映射取序号
const arrivalNoOf = (key: string | number) =>
  arrivalNumbers.value.get(String(key)) ?? '';

/* ---------------- 接口列表关键词高亮 ---------------- */

const KEYWORDS_STORAGE_KEY = 'Log Record$$highlightKeywords';
// 预设色板：antd 4.2.6 没有 ColorPicker 组件，新建时先给一个好看的默认色，
// 想要别的颜色点色块用系统取色器改
const KEYWORD_COLORS = [
  '#fa541c',
  '#faad14',
  '#52c41a',
  '#13c2c2',
  '#1677ff',
  '#722ed1',
  '#eb2f96',
  '#8c8c8c',
];

type KeywordItem = {
  id: string;
  text: string;
  color: string;
  /** 取消勾选后这条规则不参与匹配（但配置保留） */
  enabled: boolean;
};

const readKeywords = (): KeywordItem[] => {
  try {
    const raw = localStorage.getItem(KEYWORDS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    // 迁移与校验交给纯函数（旧存档没有 enabled 字段 → 默认启用）
    return normalizeKeywordRules(parsed, KEYWORD_COLORS).map((item, index) => ({
      ...item,
      id: `kw-${index}-${item.text}`,
    }));
  } catch (err) {
    console.warn('读取关键词高亮配置失败', err);
    return [];
  }
};

const highlightKeywords = ref<KeywordItem[]>(readKeywords());

// 存的时候不带 id（id 只是运行期用于 v-for 的 key）
watch(
  highlightKeywords,
  () => {
    try {
      localStorage.setItem(
        KEYWORDS_STORAGE_KEY,
        JSON.stringify(
          highlightKeywords.value.map(({ text, color, enabled }) => ({
            text,
            color,
            enabled,
          })),
        ),
      );
    } catch (err) {
      console.warn('保存关键词高亮配置失败', err);
    }
  },
  { deep: true },
);

const addKeyword = () => {
  highlightKeywords.value = [
    ...highlightKeywords.value,
    {
      id: `kw-${Date.now().toString(36)}`,
      text: '',
      color:
        KEYWORD_COLORS[highlightKeywords.value.length % KEYWORD_COLORS.length],
      enabled: true,
    },
  ];
};

const removeKeyword = (id: string) => {
  highlightKeywords.value = highlightKeywords.value.filter(
    (item) => item.id !== id,
  );
};

// 参与匹配的规则：取消勾选的、以及还没填内容的都不计入
const activeKeywordRules = computed(() =>
  highlightKeywords.value.filter((item) => item.enabled && item.text.trim()),
);

/**
 * 按关键词把「展示出来的链接」切成带颜色的片段。
 *
 * 注意传的是 shortUrl：它已经按「路径显示设置」隐藏过层级，
 * 所以被隐藏的路径不参与匹配 —— 这正是需求要的行为。
 */
const splitFlatUrl = (shortUrl: string) =>
  splitByKeywordRules(shortUrl, activeKeywordRules.value);

/** 整行高亮：左侧色条 + 淡底色（选中行不加底色，避免和选中态冲突） */
const flatItemStyle = (item: Record<string, any>) => {
  const rule = firstMatchedRule(item.shortUrl ?? '', activeKeywordRules.value);
  if (!rule) {
    return undefined;
  }
  const isSelected = networkStore.selectedRequest?.id === item.id;
  return {
    borderLeftColor: rule.color,
    backgroundColor: isSelected ? undefined : hexToRgba(rule.color, 0.1),
  };
};

/* ---------------- 忽略规则：命中关键词的接口直接从列表隐藏 ---------------- */

const IGNORE_STORAGE_KEY = 'Log Record$$ignoreKeywords';

type IgnoreItem = {
  id: string;
  text: string;
  /** 取消勾选后这条规则不生效（但配置保留） */
  enabled: boolean;
};

const readIgnoreKeywords = (): IgnoreItem[] => {
  try {
    const raw = localStorage.getItem(IGNORE_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    // 兼容旧版（纯字符串数组）与新版的逻辑在纯函数里，并有单元测试覆盖
    return normalizeIgnoreRules(parsed).map((item, index) => ({
      ...item,
      id: `ig-${index}-${item.text}`,
    }));
  } catch (err) {
    console.warn('读取忽略规则失败', err);
    return [];
  }
};

const ignoreKeywords = ref<IgnoreItem[]>(readIgnoreKeywords());

watch(
  ignoreKeywords,
  () => {
    try {
      localStorage.setItem(
        IGNORE_STORAGE_KEY,
        JSON.stringify(
          ignoreKeywords.value
            .filter((item) => item.text.trim())
            .map(({ text, enabled }) => ({ text, enabled })),
        ),
      );
    } catch (err) {
      console.warn('保存忽略规则失败', err);
    }
  },
  { deep: true },
);

const addIgnoreKeyword = () => {
  ignoreKeywords.value = [
    ...ignoreKeywords.value,
    { id: `ig-${Date.now().toString(36)}`, text: '', enabled: true },
  ];
};

const removeIgnoreKeyword = (id: string) => {
  ignoreKeywords.value = ignoreKeywords.value.filter((item) => item.id !== id);
};

// 只有勾选了、且填了内容的规则才生效
const activeIgnoreKeywords = computed(() =>
  ignoreKeywords.value
    .filter((item) => item.enabled)
    .map((item) => item.text.trim())
    .filter(Boolean),
);

/**
 * 该不该隐藏。和关键词高亮一样只匹配「列表里显示出来的链接」，
 * 已被路径设置隐藏的层级不参与匹配。
 */
const isIgnoredUrl = (shortUrl: string) => {
  const target = shortUrl.toLowerCase();
  return activeIgnoreKeywords.value.some((keyword) =>
    target.includes(keyword.toLowerCase()),
  );
};

// 受控的勾选状态：以 hiddenKeys 为准，新出现的路径默认可见
const pathCheckedKeys = computed(() => ({
  checked: collectPathKeys(pathTree.value).filter(
    (key) => !hiddenKeys.value.has(key),
  ),
  halfChecked: [] as string[],
}));

const onPathCheck = (keys: any) => {
  const checked = new Set<string>(
    (Array.isArray(keys) ? keys : keys?.checked ?? []).map((key: any) =>
      String(key),
    ),
  );
  hiddenKeys.value = new Set(
    collectPathKeys(pathTree.value).filter((key) => !checked.has(key)),
  );
};

const onSelectAllPaths = () => {
  hiddenKeys.value = new Set();
};

const onClearAllPaths = () => {
  hiddenKeys.value = new Set(collectPathKeys(pathTree.value));
};

// 新出现的路径默认展开（不覆盖用户手动折叠的节点）
watch(
  pathTree,
  () => {
    const current = new Set(pathExpandedKeys.value.map(String));
    const merged = [...pathExpandedKeys.value];
    collectPathKeys(pathTree.value).forEach((key) => {
      if (!current.has(key)) {
        current.add(key);
        merged.push(key);
      }
    });
    if (merged.length !== pathExpandedKeys.value.length) {
      pathExpandedKeys.value = merged;
    }
  },
  { immediate: true },
);

/* ---- 路径勾选的持久化：下次打开沿用上次的设置 ---- */

// localStorage 的 key，沿用项目已有的 'Log Record$$xxx' 命名
const PATH_SETTING_STORAGE_KEY = 'Log Record$$hiddenPathSegments';

// 存的是「相对域名」的形式（例：['', '/api']），所以换环境、域名变了也还能用
const readSavedRelativeKeys = (): string[] | null => {
  try {
    const raw = localStorage.getItem(PATH_SETTING_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item) => typeof item === 'string')
      : null;
  } catch (err) {
    console.warn('读取路径显示设置失败，将使用默认值', err);
    return null;
  }
};

const savedRelativeKeys = readSavedRelativeKeys();
// 标记「设置已就绪」：就绪前不写回 localStorage，避免用空数据覆盖存档
const pathSettingReady = ref(false);

// 拿到路径树后初始化一次：优先用存档，没有存档才用默认值（隐藏前两级）
watch(
  pathTree,
  () => {
    if (pathSettingReady.value || !pathTree.value.length) {
      return;
    }
    const roots = pathTree.value.map((node) => node.key);
    hiddenKeys.value = new Set(
      savedRelativeKeys
        ? fromRelativePathKeys(savedRelativeKeys, roots)
        : getDefaultHiddenPathKeys(pathTree.value),
    );
    pathSettingReady.value = true;
  },
  { immediate: true },
);

// 用户每次勾选都存下来，下次启动沿用
watch(hiddenKeys, () => {
  if (!pathSettingReady.value || !pathTree.value.length) {
    return;
  }
  try {
    const roots = pathTree.value.map((node) => node.key);
    localStorage.setItem(
      PATH_SETTING_STORAGE_KEY,
      JSON.stringify(toRelativePathKeys(hiddenKeys.value, roots)),
    );
  } catch (err) {
    console.warn('保存路径显示设置失败', err);
  }
});

// 树模式搜索时自动展开命中的分支
watch(filterTreeData, () => {
  if (!debouncedFilter.value.text) {
    return;
  }
  expandedKeys.value = findKey(filterTreeData.value);
});

const getStatusCodeKey = (item: Record<string, any>) =>
  getStatusColor(item.statusCode);
</script>

<template>
  <div class="network-container">
    <!-- storage-key：把拖动后的宽度存到本地，下次打开沿用 -->
    <SplitPane
      :initial-left-width="380"
      :min-width="200"
      storage-key="network"
    >
      <template #left>
        <div class="content content-left">
          <div class="network-record">
            <a-directory-tree
              v-if="networkStore.viewMode === 'tree'"
              v-model:expandedKeys="expandedKeys"
              @select="networkStore.select"
              class="tree-box"
              :tree-data="filterTreeData"
            >
              <template #title="{ title, isLeaf, statusCodeKey, statusCode, key }">
                <span v-if="isLeaf">
                  <span class="tree-index">{{ arrivalNoOf(key) }}</span>
                  <a-tag v-if="statusCodeKey === 'processing'">
                    <clock-circle-outlined :spin="true" />
                  </a-tag>
                  <a-tag v-else :color="statusCodeKey">
                    {{ statusCode }}
                  </a-tag>
                  <span>{{ title }}</span>
                </span>
                <span v-else>{{ title }}</span>
              </template>
            </a-directory-tree>
            <div v-else class="flat-list">
              <div
                v-for="item in flatList"
                :key="item.id"
                :class="[
                  'flat-item',
                  {
                    'flat-item-selected':
                      networkStore.selectedRequest?.id === item.id,
                  },
                ]"
                :style="flatItemStyle(item)"
                @click="networkStore.select([item.id])"
              >
                <span class="flat-index">{{ item.no }}</span>
                <a-tag v-if="item.loading" class="flat-tag">
                  <clock-circle-outlined :spin="true" />
                </a-tag>
                <a-tag v-else class="flat-tag" :color="getStatusCodeKey(item)">
                  {{ item.statusCode ?? '-' }}
                </a-tag>
                <span class="flat-method">{{ item.method }}</span>
                <span class="flat-url" :title="item.url">
                  <!-- 按关键词给命中的片段上色（用的 shortUrl，
                       已隐藏的路径不参与匹配） -->
                  <template
                    v-for="(seg, segIndex) in splitFlatUrl(item.shortUrl)"
                    :key="segIndex"
                  >
                    <span
                      v-if="seg.color"
                      :style="{ color: seg.color, fontWeight: 600 }"
                    >{{ seg.text }}</span>
                    <template v-else>{{ seg.text }}</template>
                  </template>
                </span>
              </div>
              <div v-if="flatList.length === 0" class="flat-empty">
                {{ $t('空') }}
              </div>
              <div v-if="ignoredCount > 0" class="flat-ignored">
                {{ $t('已按忽略规则隐藏 {count} 条', { count: ignoredCount }) }}
              </div>
            </div>
          </div>
          <div class="tool-box">
            <a-tooltip>
              <template #title>
                {{
                  networkStore.viewMode === 'tree'
                    ? $t('切换为平铺列表')
                    : $t('切换为路径分组')
                }}
              </template>
              <span class="view-toggle" @click="networkStore.toggleViewMode">
                <ApartmentOutlined v-if="networkStore.viewMode === 'flat'" />
                <UnorderedListOutlined v-else />
              </span>
            </a-tooltip>
            <a-popover
              v-if="networkStore.viewMode === 'flat'"
              trigger="click"
              placement="topRight"
              :overlay-style="{ width: '420px' }"
            >
              <template #title>
                <div class="path-setting-header">
                  <span>{{ $t('路径显示设置') }}</span>
                  <span class="path-setting-actions">
                    <a-button
                      type="link"
                      size="small"
                      @click="onSelectAllPaths"
                    >
                      {{ $t('全选') }}
                    </a-button>
                    <a-button
                      type="link"
                      size="small"
                      @click="onClearAllPaths"
                    >
                      {{ $t('全不选') }}
                    </a-button>
                  </span>
                </div>
              </template>
              <template #content>
                <div class="path-setting-body">
                  <div class="path-setting-tip">
                    {{
                      $t(
                        '取消勾选的路径段会从链接中隐藏，最后一段接口名始终保留',
                      )
                    }}
                  </div>
                  <!-- 固定高度的滚动区：内容再多也只在这里内部滚动，不会把弹层撑大 -->
                  <div class="path-setting-scroll">
                    <a-tree
                      v-if="pathTree.length"
                      class="path-setting-tree"
                      checkable
                      check-strictly
                      block-node
                      :selectable="false"
                      :tree-data="pathTree"
                      :checked-keys="pathCheckedKeys"
                      v-model:expandedKeys="pathExpandedKeys"
                      @check="onPathCheck"
                    >
                      <template #title="{ title, count }">
                        <span :title="title">
                          {{ title }}
                          <span class="path-count">({{ count }})</span>
                        </span>
                      </template>
                    </a-tree>
                    <div v-else class="path-setting-empty">{{ $t('空') }}</div>
                  </div>
                </div>
              </template>
              <a-tooltip>
                <template #title>{{ $t('路径显示设置') }}</template>
                <span class="view-toggle">
                  <SettingOutlined />
                </span>
              </a-tooltip>
            </a-popover>
            <a-popover
              v-if="networkStore.viewMode === 'flat'"
              trigger="click"
              placement="topRight"
              :overlay-style="{ width: '400px' }"
            >
              <template #title>
                <div class="kw-header">
                  <span>{{ $t('接口关键词高亮') }}</span>
                  <a-button type="link" size="small" @click="addKeyword">
                    <template #icon><PlusOutlined /></template>
                    {{ $t('新增关键词') }}
                  </a-button>
                </div>
              </template>
              <template #content>
                <div class="kw-tip">
                  {{
                    $t(
                      '命中关键词的接口会高亮。只匹配列表里显示出来的链接，已隐藏的路径不参与匹配',
                    )
                  }}
                </div>
                <div v-if="!highlightKeywords.length" class="kw-empty">
                  {{ $t('还没有关键词，点右上角新增') }}
                </div>
                <div
                  v-for="kw in highlightKeywords"
                  :key="kw.id"
                  :class="['kw-row', { 'kw-row-off': !kw.enabled }]"
                >
                  <a-tooltip>
                    <template #title>{{ $t('勾选后这条规则生效') }}</template>
                    <a-checkbox
                      v-model:checked="kw.enabled"
                      class="kw-enabled"
                    />
                  </a-tooltip>
                  <input
                    class="kw-color"
                    type="color"
                    v-model="kw.color"
                    :title="$t('点击换颜色')"
                  />
                  <a-input
                    v-model:value="kw.text"
                    class="kw-input"
                    size="small"
                    :placeholder="$t('关键词，如 dm')"
                    allow-clear
                  />
                  <a-button
                    class="kw-del"
                    type="text"
                    size="small"
                    @click="removeKeyword(kw.id)"
                  >
                    <template #icon><CloseOutlined /></template>
                  </a-button>
                </div>
              </template>
              <a-tooltip>
                <template #title>{{ $t('接口关键词高亮') }}</template>
                <span class="view-toggle">
                  <HighlightOutlined />
                </span>
              </a-tooltip>
            </a-popover>
            <a-popover
              v-if="networkStore.viewMode === 'flat'"
              trigger="click"
              placement="topRight"
              :overlay-style="{ width: '380px' }"
            >
              <template #title>
                <div class="kw-header">
                  <span>{{ $t('忽略规则') }}</span>
                  <a-button type="link" size="small" @click="addIgnoreKeyword">
                    <template #icon><PlusOutlined /></template>
                    {{ $t('新增规则') }}
                  </a-button>
                </div>
              </template>
              <template #content>
                <div class="kw-tip">
                  {{
                    $t(
                      '链接里出现这些关键词的接口会从列表隐藏。同样只匹配显示出来的链接，已隐藏的路径不参与匹配',
                    )
                  }}
                </div>
                <div v-if="!ignoreKeywords.length" class="kw-empty">
                  {{ $t('还没有规则，点右上角新增') }}
                </div>
                <div
                  v-for="ignoreKeyword in ignoreKeywords"
                  :key="ignoreKeyword.id"
                  :class="['kw-row', { 'kw-row-off': !ignoreKeyword.enabled }]"
                >
                  <a-tooltip>
                    <template #title>{{ $t('勾选后这条规则生效') }}</template>
                    <a-checkbox
                      v-model:checked="ignoreKeyword.enabled"
                      class="kw-enabled"
                    />
                  </a-tooltip>
                  <a-input
                    v-model:value="ignoreKeyword.text"
                    class="kw-input"
                    size="small"
                    :placeholder="$t('关键词，如 generate_204')"
                    allow-clear
                  />
                  <a-button
                    class="kw-del"
                    type="text"
                    size="small"
                    @click="removeIgnoreKeyword(ignoreKeyword.id)"
                  >
                    <template #icon><CloseOutlined /></template>
                  </a-button>
                </div>
              </template>
              <a-tooltip>
                <template #title>{{ $t('忽略规则') }}</template>
                <span class="view-toggle">
                  <EyeInvisibleOutlined />
                </span>
              </a-tooltip>
            </a-popover>
            <a-tooltip>
              <template #title>{{ $t('会把当前列表的接口清除') }}</template>
              <ClearIcon class="clear" @click="networkStore.onClearNetwork" />
            </a-tooltip>
          </div>
        </div>
      </template>
      <template #right>
        <div class="content">
          <ContentArea :csn="networkStore.selectedRequest" />
        </div>
      </template>
    </SplitPane>
  </div>
</template>

<style scoped>
/* 只作用于左侧主列表树，避免 :deep 泄漏到其他 a-tree（例如路径设置弹层） */
.tree-box :deep(.ant-tree-node-content-wrapper) {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  width: 200px;
}

:deep(.tree-box) {
  flex: 1;
}

:deep(.ant-tree-treenode-selected) {
  background: var(--color-main);
}

:deep(.ant-tree-treenode-selected::before) {
  background: none !important;
}

:deep(.ant-tag) {
  font-size: 10px;
  padding-inline: 4px;
  line-height: 14px;
}

.network-container {
  height: 100%;
  width: 100%;
}

.content {
  margin: 10px;
  height: 100%;
  border-radius: var(--border-radius-large);

  overflow: auto;
  display: flex;
  flex-direction: column;
}

.content::-webkit-scrollbar {
  height: 5px;
  width: 5px;
}

.content::-webkit-scrollbar-thumb {
  background-color: var(--color-scroll);
  border-radius: var(--border-radius-default);
}

.content::-webkit-scrollbar-thumb:hover {
  background-color: var(--color-main);
}

.content-left {
  gap: 10px;
  padding: 15px;
  background-color: var(--color-background);
}

.network-record {
  flex: 1;
  overflow: auto;
}

.network-record::-webkit-scrollbar {
  height: 5px;
  width: 5px;
}

.network-record::-webkit-scrollbar-thumb {
  background-color: var(--color-scroll);
  border-radius: var(--border-radius-default);
}

.network-record::-webkit-scrollbar-thumb:hover {
  background-color: var(--color-main);
}

.clear {
  width: 20px;
  color: var(--color-main);
  height: 20px;
  padding: 5px;
  border-radius: var(--border-radius-default);
  box-sizing: content-box;
  cursor: pointer;
}

.clear:hover {
  background-color: var(--color-main);
  color: var(--color-background);
}

.view-toggle {
  width: 20px;
  height: 20px;
  padding: 5px;
  font-size: 20px;
  box-sizing: content-box;
  color: var(--color-main);
  border-radius: var(--border-radius-default);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.view-toggle:hover {
  background-color: var(--color-main);
  color: var(--color-background);
}

/* 平铺列表：每条接口一行，最新在最上方 */
.flat-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.flat-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  /* 命中关键词时这个左边框会染成关键词色（默认透明，避免宽度跳动） */
  border-left: 3px solid transparent;
  border-radius: var(--border-radius-default);
  cursor: pointer;
  min-width: 0;
}

.flat-item:hover {
  background-color: rgba(51, 102, 102, 0.12);
}

.flat-item-selected,
.flat-item-selected:hover {
  background-color: var(--color-main);
  color: var(--color-background);
}

.flat-index {
  flex-shrink: 0;
  min-width: 30px;
  text-align: right;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  opacity: 0.45;
}

.flat-item-selected .flat-index {
  opacity: 0.85;
}

/* 树模式下叶子（接口）最前面的序号 */
.tree-index {
  display: inline-block;
  min-width: 26px;
  margin-right: 4px;
  text-align: right;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  opacity: 0.45;
}

.flat-tag {
  flex-shrink: 0;
  font-size: 10px;
  padding-inline: 4px;
  line-height: 14px;
  margin-inline-end: 0;
}

.flat-method {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  opacity: 0.85;
}

.flat-url {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

/* 接口关键词高亮弹层 */
.kw-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.kw-header :deep(.ant-btn-link) {
  height: 22px;
  padding: 0 4px;
  font-size: 12px;
  color: var(--color-main);
}

.kw-tip {
  margin-bottom: 8px;
  font-size: 12px;
  line-height: 1.5;
  opacity: 0.65;
}

.kw-empty {
  padding: 6px 0;
  font-size: 12px;
  opacity: 0.6;
}

.kw-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

/* 未勾选（不生效）的规则整行变淡，一眼能区分 */
.kw-row-off :deep(.ant-input),
.kw-row-off .kw-color {
  opacity: 0.45;
}

.kw-enabled {
  flex-shrink: 0;
  margin-right: 2px;
}

.kw-color {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  padding: 0;
  border: 1px solid var(--color-scroll);
  border-radius: 4px;
  background: none;
  cursor: pointer;
}

.kw-input {
  flex: 1;
  min-width: 0;
}

.kw-input :deep(.ant-input) {
  background-color: var(--color-background);
  color: var(--color-text);
  font-size: 12px;
}

.kw-del {
  flex-shrink: 0;
  color: var(--color-main);
}

.flat-ignored {
  padding: 6px;
  font-size: 12px;
  opacity: 0.5;
}

.flat-empty {
  padding: 8px 6px;
  opacity: 0.6;
  font-size: 12px;
}

/* 路径显示设置弹层 */
.path-setting-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.path-setting-actions {
  display: flex;
  align-items: center;
}

.path-setting-actions :deep(.ant-btn-link) {
  height: 22px;
  padding: 0 4px;
  font-size: 12px;
  color: var(--color-main);
}

.path-setting-body {
  display: flex;
  flex-direction: column;
  /* 内容不往弹层外面溢，保证弹层尺寸固定 */
  overflow: hidden;
}

.path-setting-tip {
  flex-shrink: 0;
  margin-bottom: 8px;
  font-size: 12px;
  line-height: 1.5;
  opacity: 0.65;
}

/* 固定高度的滚动区：显示不下的部分在这里滚动（纵向为主，横向兜底） */
.path-setting-scroll {
  height: 300px;
  overflow: auto;
}

.path-setting-scroll::-webkit-scrollbar {
  height: 5px;
  width: 5px;
}

.path-setting-scroll::-webkit-scrollbar-thumb {
  background-color: var(--color-scroll);
  border-radius: var(--border-radius-default);
}

.path-setting-scroll::-webkit-scrollbar-thumb:hover {
  background-color: var(--color-main);
}

.path-setting-empty {
  font-size: 12px;
  opacity: 0.65;
}

.path-setting-tree {
  font-size: 12px;
}

.path-setting-tree :deep(.ant-tree-title) {
  font-size: 12px;
}

/* 长域名/长路径用省略号截断，避免把弹层横向撑开（悬浮看完整内容）。
   这里只负责截断，flex 交给 a-tree 的 block-node 模式（antd 自带：
   行容器 align-items:stretch + 标题 flex:auto），否则标题会被压成 0 宽。 */
.path-setting-scroll :deep(.ant-tree-node-content-wrapper) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.path-count {
  margin-left: 4px;
  font-size: 11px;
  opacity: 0.5;
}

.tool-box {
  background-color: rgba(51, 102, 102, 0.1);
  display: flex;
  flex-direction: row;
  align-items: center;
  border-radius: var(--border-radius-default);
  align-self: flex-end;
}

.status-normal {
  text-align: center;
  vertical-align: middle;
  margin: 0 2px;
}

.status-success {
  color: #00ff00;
}

.status-error {
  color: #ff0000;
}

.status-warning {
  color: #ffff00;
}
</style>
