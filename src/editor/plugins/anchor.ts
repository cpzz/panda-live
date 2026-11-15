import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

/**
 * 页内跳转目标高亮：用 Decoration 而不是直接改 DOM class，
 * 否则 ProseMirror 的属性变更观察会把外部修改还原。见 doc/design.md §15.1。
 */
export const anchorHighlightKey = new PluginKey<number | null>("anchor-highlight");

export function anchorHighlightPlugin(): Plugin<number | null> {
  return new Plugin<number | null>({
    key: anchorHighlightKey,
    state: {
      init: () => null,
      apply(transaction, value) {
        const next = transaction.getMeta(anchorHighlightKey);
        if (next !== undefined) return next as number | null;
        // 文档变化后位置可能失效，直接清除，避免高亮落到别的节点上。
        return transaction.docChanged ? null : value;
      },
    },
    props: {
      decorations(state) {
        const pos = anchorHighlightKey.getState(state);
        if (pos == null) return null;
        const node = state.doc.nodeAt(pos);
        if (!node) return null;
        return DecorationSet.create(state.doc, [
          Decoration.node(pos, pos + node.nodeSize, { class: "anchor-target" }),
        ]);
      },
    },
  });
}
