import type { Node as PMNode } from "prosemirror-model";
import { Plugin } from "prosemirror-state";

let counter = 0;

function nextId(): string {
  counter += 1;
  return `n${counter}`;
}

function hasNodeId(node: PMNode): boolean {
  const specAttrs = node.type.spec.attrs;
  return Boolean(specAttrs && "nodeId" in specAttrs);
}

/**
 * 为顶层块补齐稳定 `nodeId`；已存在的 ID 随节点 attrs 在事务中自然保留。
 * 见 doc/design.md §8.1、§11.2。
 */
export function nodeIdPlugin(): Plugin {
  return new Plugin({
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((transaction) => transaction.docChanged)) return null;
      const tr = newState.tr;
      let changed = false;
      newState.doc.forEach((node, offset) => {
        if (!hasNodeId(node) || node.attrs.nodeId) return;
        tr.setNodeMarkup(offset, undefined, { ...node.attrs, nodeId: nextId() });
        changed = true;
      });
      return changed ? tr : null;
    },
  });
}
