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
  getRequestsByArrival,
  getStatusColor,
  sortTreeLeavesByRecency,
} from '@/utils/network';
import {
  ApartmentOutlined,
  ClockCircleOutlined,
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
  filterFlatRequests(allRequestsNewestFirst.value, debouncedFilter.value).map(
    (item) => ({
      ...item,
      no: arrivalNumbers.value.get(String(item.id)) ?? 0,
      shortUrl: formatShortUrl(item.url ?? '', hiddenKeys.value),
    }),
  ),
);

// 树模式：叶子节点的 key 就是请求 id，用同一份映射取序号
const arrivalNoOf = (key: string | number) =>
  arrivalNumbers.value.get(String(key)) ?? '';

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

// 默认隐藏「前两级」路径：域名 + 第一段路径（例：https://xxx 与 api）。
// 这两级基本不用看，隐藏后链接会短很多，这也是日常最常用的设置。
// 只在第一次拿到路径树时应用一次，之后完全交给用户自己勾选。
const defaultPathHiddenApplied = ref(false);
watch(
  pathTree,
  () => {
    if (defaultPathHiddenApplied.value || !pathTree.value.length) {
      return;
    }
    const keys: string[] = [];
    pathTree.value.forEach((level1) => {
      keys.push(level1.key);
      level1.children?.forEach((level2) => keys.push(level2.key));
    });
    hiddenKeys.value = new Set(keys);
    defaultPathHiddenApplied.value = true;
  },
  { immediate: true },
);

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
    <SplitPane :initial-left-width="460" :min-width="200">
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
                  {{ item.shortUrl }}
                </span>
              </div>
              <div v-if="flatList.length === 0" class="flat-empty">
                {{ $t('空') }}
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
              <span class="view-toggle" :title="$t('路径显示设置')">
                <SettingOutlined />
              </span>
            </a-popover>
            <ClearIcon class="clear" @click="networkStore.onClearNetwork" />
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
