import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { findMatches, type MatchRange, type SearchOptions } from "../services/search";

export interface SearchQuery {
  term: string;
  options: SearchOptions;
}

export interface SearchPluginState {
  query: SearchQuery;
  ranges: MatchRange[];
  active: number;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  caseSensitive: false,
  regex: false,
  wholeWord: false,
};

const EMPTY_QUERY: SearchQuery = { term: "", options: DEFAULT_SEARCH_OPTIONS };

type SearchAction =
  | { type: "set"; query: SearchQuery; active?: number }
  | { type: "select"; active: number }
  | { type: "clear" };

export const SEARCH_PLUGIN_KEY = new PluginKey<SearchPluginState>("panda-search");

/** 统计文档内所有匹配；匹配只发生在单个文本节点内。 */
export function collectMatches(doc: PMNode, query: SearchQuery): MatchRange[] {
  const ranges: MatchRange[] = [];
  if (!query.term) return ranges;
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    for (const match of findMatches(node.text, query.term, query.options)) {
      ranges.push({ start: pos + match.start, end: pos + match.end });
    }
  });
  return ranges;
}

function activeForOffset(ranges: readonly MatchRange[], offset: number): number {
  const index = ranges.findIndex((range) => range.start >= offset);
  return index === -1 ? Math.max(0, ranges.length - 1) : index;
}

/** 查找高亮插件：装饰由插件状态派生，替换全部仍是一个事务。见 doc/design.md §11.5。 */
export function searchPlugin(): Plugin<SearchPluginState> {
  return new Plugin<SearchPluginState>({
    key: SEARCH_PLUGIN_KEY,
    state: {
      init: () => ({ query: EMPTY_QUERY, ranges: [], active: 0 }),
      apply(transaction, previous) {
        const action = transaction.getMeta(SEARCH_PLUGIN_KEY) as SearchAction | undefined;
        if (action?.type === "clear") {
          return { query: EMPTY_QUERY, ranges: [], active: 0 };
        }
        if (action?.type === "select") {
          return { ...previous, active: action.active };
        }
        if (action?.type === "set") {
          const ranges = collectMatches(transaction.doc, action.query);
          return {
            query: action.query,
            ranges,
            active: ranges.length > 0 ? Math.min(action.active ?? 0, ranges.length - 1) : 0,
          };
        }
        if (transaction.docChanged && previous.query.term) {
          const ranges = collectMatches(transaction.doc, previous.query);
          if (ranges.length === 0) return { ...previous, ranges, active: 0 };
          return {
            ...previous,
            ranges,
            active: activeForOffset(ranges, transaction.selection.head),
          };
        }
        return previous;
      },
    },
    props: {
      decorations(state) {
        const current = SEARCH_PLUGIN_KEY.getState(state);
        if (!current || current.ranges.length === 0) return null;
        const decorations = current.ranges.map((range, index) =>
          Decoration.inline(range.start, range.end, {
            class: index === current.active ? "search-match search-match-active" : "search-match",
          }),
        );
        return DecorationSet.create(state.doc, decorations);
      },
    },
  });
}

export function getSearchState(view: EditorView): SearchPluginState | undefined {
  return SEARCH_PLUGIN_KEY.getState(view.state);
}

export function setSearch(view: EditorView, term: string, options: SearchOptions): SearchPluginState {
  const transaction = view.state.tr.setMeta(SEARCH_PLUGIN_KEY, {
    type: "set",
    query: { term, options },
    active: 0,
  } satisfies SearchAction);
  view.dispatch(transaction);
  return getSearchState(view) ?? { query: EMPTY_QUERY, ranges: [], active: 0 };
}

export function clearSearch(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(SEARCH_PLUGIN_KEY, { type: "clear" } satisfies SearchAction));
}

function goToMatch(view: EditorView, index: number): void {
  const current = getSearchState(view);
  const range = current?.ranges[index];
  if (!current || !range) return;
  const transaction = view.state.tr
    .setSelection(TextSelection.create(view.state.doc, range.start, range.end))
    .setMeta(SEARCH_PLUGIN_KEY, { type: "select", active: index } satisfies SearchAction)
    .scrollIntoView();
  view.dispatch(transaction);
}

/** 从当前选中位置按方向查找下一个匹配；返回目标索引，-1 表示无匹配。 */
export function findNextMatch(view: EditorView, direction: 1 | -1): number {
  const current = getSearchState(view);
  if (!current || current.ranges.length === 0) return -1;
  const head = view.state.selection.head;
  const ranges = current.ranges;
  let index = -1;
  if (direction === 1) {
    index = ranges.findIndex((range) => range.start >= head);
    if (index === -1) index = current.active;
    if (index >= ranges.length) index = 0;
  } else {
    for (let cursor = ranges.length - 1; cursor >= 0; cursor -= 1) {
      const range = ranges[cursor];
      if (range && range.end <= head) {
        index = cursor;
        break;
      }
    }
    if (index === -1) index = ranges.length - 1;
  }
  goToMatch(view, index);
  return index;
}

export function replaceCurrentMatch(view: EditorView, replacement: string): number {
  const current = getSearchState(view);
  const range = current?.ranges[current.active];
  if (!range) return 0;
  const transaction = view.state.tr;
  if (replacement) {
    transaction.insertText(replacement, range.start, range.end);
  } else {
    transaction.delete(range.start, range.end);
  }
  view.dispatch(transaction);
  return 1;
}

/** 替换全部：自后向前在同一事务内完成，保证一次撤销。 */
export function replaceAllMatches(view: EditorView, replacement: string): number {
  const current = getSearchState(view);
  if (!current || current.ranges.length === 0) return 0;
  const transaction = view.state.tr;
  for (let index = current.ranges.length - 1; index >= 0; index -= 1) {
    const range = current.ranges[index];
    if (!range) continue;
    if (replacement) {
      transaction.insertText(replacement, range.start, range.end);
    } else {
      transaction.delete(range.start, range.end);
    }
  }
  view.dispatch(transaction);
  return current.ranges.length;
}
