/**
 * 查找替换的纯逻辑：构词、匹配与文本替换。
 * 编辑器侧（ProseMirror / CodeMirror）只负责把结果映射到文档位置。见 doc/design.md §11.5。
 */

export interface SearchOptions {
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
}

/** 查找面板模式：仅查找，或展开替换行。 */
export type SearchMode = "find" | "replace";

/** 一次查找/替换请求；token 递增用于重复按快捷键时重新聚焦。 */
export interface SearchRequest {
  mode: SearchMode;
  token: number;
}

export interface MatchRange {
  start: number;
  end: number;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 构造全局匹配器；正则模式由用户负责转义。
 * `wholeWord` 使用 Unicode 边界断言，避免把中文/下划线相邻字符误判为词边界。
 */
export function buildSearchRegex(query: string, options: SearchOptions): RegExp | null {
  if (!query) return null;
  const body = options.regex ? query : escapeRegExp(query);
  const wrapped = options.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])` : body;
  try {
    return new RegExp(wrapped, options.caseSensitive ? "gu" : "giu");
  } catch {
    return null;
  }
}

export function findMatches(text: string, query: string, options: SearchOptions): MatchRange[] {
  const regex = buildSearchRegex(query, options);
  if (!regex) return [];
  const matches: MatchRange[] = [];
  for (const match of text.matchAll(regex)) {
    const value = match[0];
    if (value.length === 0) {
      // 零宽匹配：推进 lastIndex，避免死循环。
      regex.lastIndex += 1;
      continue;
    }
    matches.push({ start: match.index ?? 0, end: (match.index ?? 0) + value.length });
  }
  return matches;
}

/**
 * 从 `from`（字节偏移）开始找下一个/上一个匹配；`wrap` 决定是否循环。
 * 返回 -1 表示没有匹配。
 */
export function findIndexFrom(
  matches: readonly MatchRange[],
  offset: number,
  direction: 1 | -1,
  wrap = true,
): number {
  if (matches.length === 0) return -1;
  if (direction === 1) {
    const next = matches.findIndex((match) => match.start >= offset);
    return next === -1 ? (wrap ? 0 : -1) : next;
  }
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    if (match && match.end <= offset) return index;
  }
  return wrap ? matches.length - 1 : -1;
}

/** 批量替换：正则模式支持 `$1` 捕获组引用，普通模式按字面量替换。 */
export function replaceAllInText(
  text: string,
  query: string,
  options: SearchOptions,
  replacement: string,
): { text: string; count: number } {
  const regex = buildSearchRegex(query, options);
  if (!regex) return { text, count: 0 };
  const count = findMatches(text, query, options).length;
  return { text: text.replace(regex, replacement), count };
}
