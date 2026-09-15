import { TreeProps } from 'ant-design-vue';
import { parseUrl } from './strings';
import type { SearchFilterType } from '@/types/global';
import { DataNode } from 'ant-design-vue/es/tree';

export function getStatusColor(statusCode?: number) {
  let statusCodeKey = 'default';

  if (!statusCode) {
    statusCodeKey = 'default';
  }
  // 2 开头的显示绿色
  else if (String(statusCode).startsWith('2')) {
    statusCodeKey = 'success';
  }
  // 5 开头的显示红色
  else if (String(statusCode).startsWith('5')) {
    statusCodeKey = 'error';
  }

  // 4 开头的显示黄色
  else if (String(statusCode).startsWith('4')) {
    statusCodeKey = 'warning';
  }

  return statusCodeKey;
}

export function addUrlToTree(
  treeData: TreeProps['treeData'],
  request: Record<string, any> = {},
): TreeProps['treeData'] {
  if (!request.url) {
    return treeData;
  }
  const urlParts = parseUrl(request.url);

  function generateNode(part: string, isLeaf: boolean) {
    return {
      title: part,
      key: isLeaf ? request.id : `${part}-${Date.now()}`, // 生成唯一的 key,
      children: [] as TreeProps['treeData'],
      isLeaf,
      selectable: isLeaf,
      statusCode: request.statusCode,
      statusCodeKey: request.loading
        ? 'processing'
        : getStatusColor(request.statusCode),
    };
  }

  function insertNode(
    nodes: TreeProps['treeData'],
    parts: string[],
    currentDepth = 0,
  ): void {
    const currentPart = parts[currentDepth];

    if (!currentPart) return;

    let existingNode = nodes.find((node) => node.title === currentPart);
    if (currentDepth === parts.length - 1) {
      const requestExist = nodes.find((node) => node.key === request.id);
      if (!requestExist) {
        existingNode = generateNode(currentPart, true);
        nodes.push(existingNode);
      } else {
        Object.assign(requestExist, {
          statusCode: request.statusCode,
          statusCodeKey: getStatusColor(request.statusCode),
          loading: request.loading ?? false,
        });
      }
    } else if (!existingNode) {
      existingNode = generateNode(currentPart, false);
      nodes.push(existingNode);
    }

    if (!existingNode.children) {
      existingNode.children = [];
    }

    if (existingNode.children) {
      insertNode(existingNode.children, parts, currentDepth + 1);
    }
  }

  insertNode(treeData, urlParts);
  return [...treeData];
}

export function filterDataNodes(
  nodes: TreeProps['treeData'],
  filter: SearchFilterType,
): DataNode[] {
  // 递归函数来处理节点及其子节点
  function filterNode(node: DataNode): DataNode | null {
    // 转换标题和搜索文本为字符串
    let nodeTitle = String(node.title || '');
    let searchText = filter.text;

    // 如果不区分大小写，将标题和搜索文本转换为小写
    if (!filter.isCaseSensitive) {
      searchText = searchText.toLowerCase();
      nodeTitle = nodeTitle.toLowerCase();
    }

    // 检查标题是否包含搜索文本
    if (nodeTitle.includes(searchText)) {
      // 如果匹配，返回节点的浅拷贝（不包括子节点）
      return node;
    }

    // 如果有子节点，递归过滤子节点
    if (node.children && node.children.length > 0) {
      const filteredChildren = node.children
        .map(filterNode)
        .filter((child): child is DataNode => child !== null);

      // 如果有匹配的子节点，返回带有过滤后子节点的新节点
      if (filteredChildren.length > 0) {
        return { ...node, children: filteredChildren };
      }
    }

    // 如果没有匹配，返回 null
    return null;
  }

  // 使用 map 和 filter 来处理顶层节点
  return nodes
    .map(filterNode)
    .filter((node): node is DataNode => node !== null);
}

/** 平铺列表中用于搜索的文本：方法 + url + 状态码 */
export function getRequestSearchText(request: Record<string, any> = {}): string {
  return [request.method, request.url, request.statusCode]
    .filter((part) => part !== undefined && part !== null && part !== '')
    .join(' ');
}

/**
 * 平铺列表的搜索过滤（树模式走 filterDataNodes，平铺模式走后这个）。
 * 保持与树模式一致的“忽略大小写”语义。
 */
export function filterFlatRequests(
  requests: Record<string, any>[],
  filter: SearchFilterType,
): Record<string, any>[] {
  const searchText = filter?.text ?? '';
  if (!searchText) {
    return requests;
  }
  const keyword = filter.isCaseSensitive
    ? searchText
    : searchText.toLowerCase();
  return requests.filter((request) => {
    const text = getRequestSearchText(request);
    return (filter.isCaseSensitive ? text : text.toLowerCase()).includes(
      keyword,
    );
  });
}

export type PathSegmentNode = {
  title: string;
  key: string;
  /** 经过该路径段的请求数 */
  count: number;
  children?: PathSegmentNode[];
};

/** 把 url 拆成「可配置的路径层级」：去掉最后一段（接口名），查询串总是挂在最后一段上所以也被排除 */
export function getConfigurableUrlParts(url = ''): string[] {
  const parts = parseUrl(url);
  if (parts.length <= 1) {
    return [];
  }
  return parts.slice(0, -1);
}

/**
 * 构建「路径显示设置」用的层级树。
 * 只包含可配置的路径层级，最后一段（接口名）不可配置，所以直接不展示，避免占地方。
 */
export function buildPathSettingTree(
  requests: Record<string, any>[],
): PathSegmentNode[] {
  const root: PathSegmentNode[] = [];

  requests.forEach((request) => {
    const parts = getConfigurableUrlParts(request.url ?? '');
    let nodes = root;
    let prefix = '';

    parts.forEach((part) => {
      prefix = prefix ? `${prefix}/${part}` : part;

      let node = nodes.find((item) => item.key === prefix);
      if (!node) {
        node = {
          title: part,
          key: prefix,
          count: 0,
          children: [],
        };
        nodes.push(node);
      }
      node.count += 1;
      if (!node.children) {
        node.children = [];
      }
      nodes = node.children;
    });
  });

  return root;
}

/** 收集树里所有可勾选的路径 key */
export function collectPathKeys(nodes: PathSegmentNode[]): string[] {
  const keys: string[] = [];
  nodes.forEach((node) => {
    keys.push(node.key);
    if (node.children?.length) {
      keys.push(...collectPathKeys(node.children));
    }
  });
  return keys;
}

/**
 * 按「到达顺序」（旧 -> 新）返回请求列表。
 *
 * 关键：不要用 id 排序。客户端上报的 id 是 base36 字符串
 * （形如 "0mu0pgpz2be779e2h1wa"），`Number(id)` 会得到 NaN，
 * 比较器失效后数组会原样返回，结果就是「最新的排在最后」。
 * 而 requests 的 key 插入顺序天然就是到达顺序，可靠且与 id 格式无关。
 */
export function getRequestsByArrival(
  requests: Record<string, any>,
): Record<string, any>[] {
  return Object.keys(requests).map((id) => requests[id]);
}

/**
 * 「请求 id → 到达序号」映射：第一个收到的 = 1，第二个 = 2 ……
 * 平铺列表和树模式共用这个映射，保证同一条请求在两种模式下编号一致。
 */
export function buildArrivalNumberMap(
  requests: Record<string, any>,
): Map<string, number> {
  const map = new Map<string, number>();
  getRequestsByArrival(requests).forEach((item, index) => {
    map.set(String(item.id), index + 1);
  });
  return map;
}

/**
 * 展示层排序：把每一层的「接口（叶子）」按到达序号倒序排列，
 * 目录保持原有相对顺序并统一排在叶子前面。
 *
 * 刻意放在展示层做，而不是依赖树构建时的插入顺序：
 * 这样无论 treeData 是按什么顺序攒出来的，接口那一层显示出来一定是「最新在最上」。
 * （也顺便修正了「路径互为前缀」时目录被挤到叶子后面造成的位置混乱。）
 */
export function sortTreeLeavesByRecency(
  nodes: Record<string, any>[],
  arrivalNumbers: Map<string, number>,
): Record<string, any>[] {
  const dirs: Record<string, any>[] = [];
  const leaves: Record<string, any>[] = [];

  nodes.forEach((node) => {
    const children = node.children as Record<string, any>[] | undefined;
    if (children?.length) {
      // 有子节点就按目录处理（路径互为前缀的节点可能同时带 isLeaf）
      dirs.push({
        ...node,
        children: sortTreeLeavesByRecency(children, arrivalNumbers),
      });
    } else if (node.isLeaf) {
      leaves.push(node);
    } else {
      dirs.push(node);
    }
  });

  const noOf = (node: Record<string, any>) =>
    arrivalNumbers.get(String(node.key)) ?? -1;
  leaves.sort((a, b) => noOf(b) - noOf(a));

  return [...dirs, ...leaves];
}

/** 默认隐藏的路径：前两级（第 1 级 = 域名，第 2 级 = 第一段路径，例：api） */
export function getDefaultHiddenPathKeys(nodes: PathSegmentNode[]): string[] {
  const keys: string[] = [];
  nodes.forEach((level1) => {
    keys.push(level1.key);
    level1.children?.forEach((level2) => keys.push(level2.key));
  });
  return keys;
}

/**
 * 把「绝对路径 key」转成「相对域名」的形式，用于持久化。
 *
 * 例：['https://host', 'https://host/api'] + roots=['https://host']
 *     => ['', '/api']
 *
 * 好处：换环境（域名变了）设置仍然能沿用，不会因为域名不同而全部失效。
 */
export function toRelativePathKeys(
  keys: Iterable<string>,
  roots: string[],
): string[] {
  const result: string[] = [];
  for (const key of keys) {
    // 域名后的 '/' 一起匹配，避免 'https://a.com' 误匹配 'https://a.com.cn/api'
    const root = roots.find(
      (item) => key === item || key.startsWith(`${item}/`),
    );
    if (root === undefined) {
      continue; // 不属于任何已知域名（历史数据），跳过
    }
    result.push(key.slice(root.length)); // 域名自身 -> ''
  }
  return result;
}

/** 把「相对域名」的 key 还原到当前域名下。设置对所有域名都生效 */
export function fromRelativePathKeys(
  relatives: string[],
  roots: string[],
): string[] {
  const result: string[] = [];
  roots.forEach((root) => {
    relatives.forEach((rel) => {
      result.push(`${root}${rel}`); // rel 为空串时就是域名自身
    });
  });
  return result;
}

/**
 * 根据被隐藏的路径段拼出展示用的短链接。
 * - 未隐藏的路径段原样保留
 * - 最后一段（接口名 + 查询串）永远保留
 * - 域名也被隐藏时会补一个前导 `/`
 */
export function formatShortUrl(
  url: string,
  hiddenKeys: Set<string>,
): string {
  const parts = parseUrl(url);
  if (parts.length <= 1) {
    return url;
  }

  const leaf = parts[parts.length - 1];
  const kept: string[] = [];
  let firstKeptIndex = -1;
  let prefix = '';

  for (let i = 0; i < parts.length - 1; i++) {
    prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
    if (!hiddenKeys.has(prefix)) {
      kept.push(parts[i]);
      if (firstKeptIndex === -1) {
        firstKeptIndex = i;
      }
    }
  }

  const head = firstKeptIndex === 0 ? '' : '/';
  return `${head}${[...kept, leaf].join('/')}`;
}
