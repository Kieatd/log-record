export type HighlightPart = { text: string; hit: boolean };

/**
 * 把文本按关键词切成若干片段，命中的片段 hit = true。
 *
 * 组件里据此渲染 <mark>（而不是拼 HTML 字符串再 v-html），
 * 这样文本节点由 Vue 管理，不会被外部数据注入。
 */
export function splitByKeyword(
  text: string,
  keyword: string,
  caseSensitive = false,
): HighlightPart[] {
  if (!keyword) {
    return [{ text, hit: false }];
  }
  const source = caseSensitive ? text : text.toLowerCase();
  const target = caseSensitive ? keyword : keyword.toLowerCase();

  const parts: HighlightPart[] = [];
  let from = 0;
  let at = source.indexOf(target, from);
  while (at !== -1) {
    if (at > from) {
      parts.push({ text: text.slice(from, at), hit: false });
    }
    parts.push({ text: text.slice(at, at + keyword.length), hit: true });
    from = at + keyword.length;
    at = source.indexOf(target, from);
  }
  if (from < text.length) {
    parts.push({ text: text.slice(from), hit: false });
  }

  return parts.length ? parts : [{ text, hit: false }];
}

/** 关键词在文本里出现的次数（不重叠计数） */
export function countInText(
  text: string,
  keyword: string,
  caseSensitive = false,
): number {
  if (!keyword) {
    return 0;
  }
  const source = caseSensitive ? text : text.toLowerCase();
  const target = caseSensitive ? keyword : keyword.toLowerCase();
  let count = 0;
  let at = source.indexOf(target);
  while (at !== -1) {
    count += 1;
    at = source.indexOf(target, at + target.length);
  }
  return count;
}

/**
 * 统计关键词在整份数据里出现的次数。
 * 与 JSON 树展示的内容保持一致：**键名 + 基础类型的值**都算，
 * 对象/数组本身不计（它们在树上只显示 {...}/{...} 预览）。
 */
export function countMatchesInValue(
  value: unknown,
  keyword: string,
  caseSensitive = false,
): number {
  if (!keyword) {
    return 0;
  }
  const walk = (val: unknown): number => {
    if (val === null || val === undefined) {
      return 0;
    }
    if (Array.isArray(val)) {
      return val.reduce<number>((sum, item) => sum + walk(item), 0);
    }
    if (typeof val === 'object') {
      return Object.entries(val as Record<string, unknown>).reduce<number>(
        (sum, [key, item]) =>
          sum + countInText(key, keyword, caseSensitive) + walk(item),
        0,
      );
    }
    return countInText(String(val), keyword, caseSensitive);
  };
  return walk(value);
}

/**
 * 按关键词裁剪数据，只保留命中关键词的部分。
 *
 * 规则：
 * - 键名命中 → 整个字段保留（用户往往是在找某个字段）
 * - 值的子节点有命中 → 保留该层，保住路径上下文
 * - 数组里没有命中的元素会被丢掉
 *
 * 返回 undefined 表示整份数据都没有命中。
 *
 * 用途：大响应体里把无关节点裁掉，匹配项就全部可见了，
 * 不用在展开后的长列表里翻找。
 */
export function pruneByKeyword(
  value: unknown,
  keyword: string,
  caseSensitive = false,
): unknown {
  if (!keyword) {
    return value;
  }
  const hit = (text: string) => countInText(text, keyword, caseSensitive) > 0;

  const walk = (val: unknown): { keep: boolean; value: unknown } => {
    if (val === null || val === undefined) {
      return { keep: false, value: val };
    }
    if (Array.isArray(val)) {
      const items = val
        .map(walk)
        .filter((item) => item.keep)
        .map((item) => item.value);
      return { keep: items.length > 0, value: items };
    }
    if (typeof val === 'object') {
      const kept: Record<string, unknown> = {};
      let any = false;
      Object.entries(val as Record<string, unknown>).forEach(([key, item]) => {
        if (hit(key)) {
          kept[key] = item; // 键名命中：整段保留
          any = true;
          return;
        }
        const result = walk(item);
        if (result.keep) {
          kept[key] = result.value;
          any = true;
        }
      });
      return { keep: any, value: kept };
    }
    return { keep: hit(String(val)), value: val };
  };

  const result = walk(value);
  return result.keep ? result.value : undefined;
}

/** 转义 HTML。请求体/响应体是外部上报的数据，直接 v-html 会有注入风险 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 纯文本请求/响应体（走 <pre> 分支）的高亮 HTML。
 * 先转义再包 <mark>，所以既能高亮又不会被内容注入。
 */
export function highlightHtml(
  text: string,
  keyword: string,
  caseSensitive = false,
): string {
  return splitByKeyword(text, keyword, caseSensitive)
    .map((part) =>
      part.hit ? `<mark>${escapeHtml(part.text)}</mark>` : escapeHtml(part.text),
    )
    .join('');
}

/* ---------------- 接口列表的关键词高亮 ---------------- */

export type KeywordRule = { text: string; color: string };
export type ColoredSegment = { text: string; color?: string };

/** 找出所有命中区间，带上它属于第几条规则（用于决定优先级） */
function collectRanges(
  text: string,
  rules: KeywordRule[],
  caseSensitive: boolean,
): { start: number; end: number; color: string; order: number }[] {
  const source = caseSensitive ? text : text.toLowerCase();
  const ranges: {
    start: number;
    end: number;
    color: string;
    order: number;
  }[] = [];

  rules.forEach((rule, order) => {
    const keyword = rule.text;
    if (!keyword) {
      return;
    }
    const target = caseSensitive ? keyword : keyword.toLowerCase();
    let at = source.indexOf(target);
    while (at !== -1) {
      ranges.push({
        start: at,
        end: at + keyword.length,
        color: rule.color,
        order,
      });
      at = source.indexOf(target, at + keyword.length);
    }
  });

  // 位置优先；同一位置时排在前面的规则优先
  ranges.sort((a, b) => a.start - b.start || a.order - b.order);
  return ranges;
}

/**
 * 按关键词规则把文本切成带颜色的片段。
 *
 * 规则按配置顺序生效：先命中的颜色优先，已被染色（区间重叠）的部分
 * 不会被后面的规则覆盖。所以一个链接里可以同时出现多种关键词颜色。
 */
export function splitByKeywordRules(
  text: string,
  rules: KeywordRule[],
  caseSensitive = false,
): ColoredSegment[] {
  const ranges = collectRanges(text, rules, caseSensitive);
  if (ranges.length === 0) {
    return [{ text }];
  }

  const segments: ColoredSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) {
      continue; // 和已染色的区间重叠，跳过
    }
    if (range.start > cursor) {
      segments.push({ text: text.slice(cursor, range.start) });
    }
    segments.push({
      text: text.slice(range.start, range.end),
      color: range.color,
    });
    cursor = range.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor) });
  }
  return segments;
}

/** 命中的第一条规则；没有命中返回 null（用于给整行加底色/色条） */
export function firstMatchedRule(
  text: string,
  rules: KeywordRule[],
  caseSensitive = false,
): KeywordRule | null {
  const source = caseSensitive ? text : text.toLowerCase();
  const hit = rules.find((rule) => {
    if (!rule.text) {
      return false;
    }
    return source.includes(caseSensitive ? rule.text : rule.text.toLowerCase());
  });
  return hit ?? null;
}

/** #rgb / #rrggbb -> rgba(r, g, b, alpha)，用于把关键词颜色调成淡底色 */
export function hexToRgba(hex: string, alpha: number): string {
  const value = (hex ?? '').replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((char) => char + char)
          .join('')
      : value;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) {
    return `rgba(0, 0, 0, ${alpha})`;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* ---------------- 规则存档的读取/迁移 ---------------- */

export type StoredKeywordRule = {
  text: string;
  color: string;
  enabled: boolean;
};

export type StoredIgnoreRule = {
  text: string;
  enabled: boolean;
};

/**
 * 解析「关键词高亮」的本地存档。
 *
 * 兼容两种情况：
 * - 旧版：`[{ text, color }]`（没有 enabled 字段 → 默认启用）
 * - 当前：`[{ text, color, enabled }]`
 *
 * 内容不合法的条目会被丢掉（不会因为一条坏数据导致整份配置读不出来）。
 */
export function normalizeKeywordRules(
  raw: unknown,
  fallbackColors: string[],
): StoredKeywordRule[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item: any, index: number): StoredKeywordRule | null => {
      if (!item || typeof item.text !== 'string') {
        return null;
      }
      return {
        text: item.text,
        color:
          typeof item.color === 'string' && item.color
            ? item.color
            : fallbackColors[index % fallbackColors.length],
        enabled: item.enabled !== false,
      };
    })
    .filter((item): item is StoredKeywordRule => item !== null);
}

/**
 * 解析「忽略规则」的本地存档。
 *
 * 兼容两种情况：
 * - 旧版：`['generate_204', ...]`（纯字符串数组 → 默认启用）
 * - 当前：`[{ text, enabled }]`
 */
export function normalizeIgnoreRules(raw: unknown): StoredIgnoreRule[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item: any): StoredIgnoreRule | null => {
      if (typeof item === 'string') {
        return { text: item, enabled: true };
      }
      if (item && typeof item.text === 'string') {
        return { text: item.text, enabled: item.enabled !== false };
      }
      return null;
    })
    .filter((item): item is StoredIgnoreRule => item !== null);
}
