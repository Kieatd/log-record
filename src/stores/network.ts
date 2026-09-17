import { SearchFilterType } from '@/types/global';
import { addUrlToTree } from '@/utils/network';
import { TreeProps } from 'ant-design-vue';
import { acceptHMRUpdate, defineStore } from 'pinia';
import { ref } from 'vue';

export type NetworkViewMode = 'tree' | 'flat';

const useNetworkStore = defineStore('network', () => {
  const treeData = ref<TreeProps['treeData']>([]);
  const requests = ref<Record<string, any>>({});
  const selectedRequest = ref<Record<string, any>>({});
  // 左侧列表展示模式：tree = 按路径分组，flat = 平铺列表
  // 默认用平铺（每条接口一行，帶到达序号），更贴近日常看流量
  const viewMode = ref<NetworkViewMode>('flat');
  const searchFilter = ref<SearchFilterType>({
    text: '',
    isCaseSensitive: false,
  });

  const setViewMode = (mode: NetworkViewMode) => {
    viewMode.value = mode;
  };

  const toggleViewMode = () => {
    viewMode.value = viewMode.value === 'tree' ? 'flat' : 'tree';
  };

  const updateTreeData = (msg: any) => {
    let id = msg.requestId;
    try {
      if (!msg.requestId) {
        requests.value[msg.id] = {
          id: msg.id,
          url: msg.url,
          method: msg.method,
          reqHeaders: msg.headers,
          reqBody: msg.body,
          createTime: msg.createTime,
          loading: true,
          isResponseError: msg.isResponseError ?? false,
        };
        id = msg.id;
      } else if (msg.isResponseError) {
        Object.assign(requests.value[msg.requestId], {
          isResponseError: true,
          loading: false,
        });
      } else if (msg.isTimeout) {
        Object.assign(requests.value[msg.requestId], {
          isTimeout: true,
          loading: false,
        });
      } else if (msg.requestId) {
        if (typeof requests.value[msg.requestId] === 'object') {
          Object.assign(requests.value[msg.requestId], {
            resHeaders: msg.headers,
            resBody: msg.body,
            statusCode: msg.statusCode,
            endTime: msg.endTime,
            loading: false,
          });
        }
      } else {
        return;
      }
      const { statusCode, loading, url } = requests.value[id] ?? {};
      treeData.value = addUrlToTree(treeData.value, {
        statusCode,
        loading,
        id,
        url,
      });
    } catch (error) {
      console.warn('在整理网络数据的地方出现了错误', error);
    }
  };
  /**
   * 标记（右键接口 → 标记）。
   *
   * 标记存在的意义：抓包时噪声很多，把关心的几条标起来，
   * 清除时它们不会被清掉，可以一直留在列表里对照。
   */
  const markedIds = ref<Record<string, boolean>>({});

  /**
   * 清除后让树视图重新展开的信号。
   *
   * 重建 treeData 时目录节点的 key 是 `${part}-${Date.now()}`，
   * 每次都不一样，组件里存的 expandedKeys 就对不上了 —— 树会自动收起来，
   * 看着像「数据全被清掉了」，其实保留的标记项还在里面。所以清完发个信号
   * 让组件把树展开。
   */
  const treeExpandToken = ref(0);

  const isMarked = (id: string | number) => !!markedIds.value[String(id)];

  const toggleMarked = (id: string | number) => {
    const key = String(id);
    if (markedIds.value[key]) {
      delete markedIds.value[key];
    } else {
      markedIds.value[key] = true;
    }
  };

  /**
   * 清除列表。
   *
   * 默认只清「没标记」的，标记的留下来；
   * includeMarked = true 连标记一起清（界面上是「快速双击清除按钮」）。
   */
  const onClearNetwork = (includeMarked = false) => {
    if (includeMarked) {
      markedIds.value = {};
      treeData.value = [];
      requests.value = {};
      selectedRequest.value = {};
      return;
    }
    const kept: Record<string, any> = {};
    Object.entries(requests.value).forEach(([id, item]) => {
      if (markedIds.value[id]) {
        kept[id] = item;
      }
    });
    requests.value = kept;
    // 树要跟着重建，否则上面还挂着已经被清掉的分支
    treeData.value = Object.entries(kept).reduce(
      (tree, [id, item]: [string, any]) =>
        addUrlToTree(tree, {
          statusCode: item.statusCode,
          loading: item.loading,
          id,
          url: item.url,
        }),
      [] as TreeProps['treeData'],
    );
    treeExpandToken.value += 1;
    // 选中的那条被清掉了，详情面板也一起清空，免得显示一条已经不在列表里的数据
    if (
      selectedRequest.value?.id &&
      !markedIds.value[String(selectedRequest.value.id)]
    ) {
      selectedRequest.value = {};
    }
  };
  const select = (selectedKeys: string) => {
    selectedRequest.value = requests.value[selectedKeys[0]];
  };
  const setSearchFilter = (filter: Partial<SearchFilterType>) => {
    Object.assign(searchFilter.value, filter);
  };
  return {
    updateTreeData,
    onClearNetwork,
    markedIds,
    isMarked,
    toggleMarked,
    treeExpandToken,
    treeData,
    selectedRequest,
    select,
    searchFilter,
    setSearchFilter,
    requests,
    viewMode,
    setViewMode,
    toggleViewMode,
  };
});

export default useNetworkStore;

// 开发期热更新：没有这段，Vite HMR 后渲染进程仍持有旧 store 实例，
// 新加的字段/方法取不到，会导致页面渲染报错（例：undefined.get）。
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useNetworkStore, import.meta.hot));
}
