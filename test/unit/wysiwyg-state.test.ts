import { undo } from "prosemirror-history";
import { describe, expect, it } from "vitest";
import type { PMJson } from "../../src/editor/schema";
import { createWysiwygState } from "../../src/editor/state";
import { parseMarkdown } from "../../src/formats/markdown/parse";
import { serializeMarkdown } from "../../src/formats/markdown/serialize";

function createState(markdown: string) {
  return createWysiwygState(parseMarkdown(markdown).doc);
}

describe("WYSIWYG 编辑器状态", () => {
  it("输入事务可序列化回 Markdown", () => {
    const state = createState("# 标题\n\n正文\n");
    const next = state.apply(state.tr.insertText("新增", 1));
    expect(next.doc.textContent).toContain("新增");
    expect(serializeMarkdown(next.doc.toJSON() as PMJson)).toContain("# 新增标题");
  });

  it("撤销可恢复到上一步", () => {
    const state = createState("# 标题\n\n正文\n");
    const before = serializeMarkdown(state.doc.toJSON() as PMJson);
    const edited = state.apply(state.tr.insertText("新增", 1));

    let undone: ReturnType<typeof state.apply> | null = null;
    const applied = undo(edited, (transaction) => {
      undone = edited.apply(transaction);
    });

    expect(applied).toBe(true);
    expect(undone).not.toBeNull();
    expect(serializeMarkdown(undone!.doc.toJSON() as PMJson)).toBe(before);
  });

  it("事务后顶层块仍带 nodeId", () => {
    const state = createState("# 标题\n\n正文\n");
    const next = state.apply(state.tr.insertText("新增", 1));
    next.doc.forEach((node) => {
      expect(typeof node.attrs.nodeId).toBe("string");
    });
  });
});
