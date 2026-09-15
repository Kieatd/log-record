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
  const onClearNetwork = () => {
    treeData.value = [];
    requests.value = {};
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
