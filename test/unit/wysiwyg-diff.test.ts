// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { computeLineDiff } from "../../src/diff/compute";
import { buildWysiwygDiff } from "../../src/diff/wysiwyg";
import { wysiwygDiffKey } from "../../src/editor/plugins/diff";
import { createWysiwygState } from "../../src/editor/state";
import { parseMarkdown } from "../../src/formats/markdown/parse";

describe("WYSIWYG 差异模型", () => {
  const oldText = "# Hello world\n\n保留段落\n\n删除段落\n";
  const newText = "# Hello panda\n\n保留段落\n";

  it("映射块级、词级与删除幽灵块", async () => {
    const { doc } = parseMarkdown(newText);
    const diff = computeLineDiff(oldText, newText);

    const model = await buildWysiwygDiff({ docJson: doc, newText, oldText, diff });

    expect(model).not.toBeNull();
    expect(model?.blocks.some((block) => block.kind === "change")).toBe(true);
    const inline = model?.inline[0];
    expect(inline?.segments.some((segment) => segment.kind === "ins" && segment.text.includes("panda"))).toBe(true);
    expect(inline?.segments.some((segment) => segment.kind === "del" && segment.text.includes("world"))).toBe(true);
    expect(model?.ghosts[0]?.html).toContain("删除段落");
  });

  it("列表项与表格单元格生成行内标记", async () => {
    const oldText = "- 甲\n- 乙\n\n| 名称 | 数值 |\n| --- | --- |\n| 甲 | 1 |\n";
    const newText = "- 甲\n- 乙改\n\n| 名称 | 数值 |\n| --- | --- |\n| 甲 | 9 |\n";
    const { doc } = parseMarkdown(newText);
    const diff = computeLineDiff(oldText, newText);

    const model = await buildWysiwygDiff({ docJson: doc, newText, oldText, diff });

    expect(model).not.toBeNull();
    const listMark = model?.inline.find((mark) => mark.path.length === 3);
    expect(
      listMark?.segments.some((segment) => segment.kind === "ins" && segment.text.includes("改")),
    ).toBe(true);
    const cellMark = model?.inline.find((mark) => mark.path.length === 4);
    expect(
      cellMark?.segments.some((segment) => segment.kind === "ins" && segment.text.includes("9")),
    ).toBe(true);
  });

  it("代码块生成逐行标记", async () => {
    const oldText = "```ts\nconst a = 1;\nconst b = 2;\n```\n";
    const newText = "```ts\nconst a = 1;\nconst c = 3;\n```\n";
    const { doc } = parseMarkdown(newText);
    const diff = computeLineDiff(oldText, newText);

    const model = await buildWysiwygDiff({ docJson: doc, newText, oldText, diff });

    const lines = model?.code[0]?.lines ?? [];
    expect(lines.some((line) => line.kind === "add" && line.text.includes("const c = 3;"))).toBe(true);
    expect(lines.some((line) => line.kind === "del" && line.text.includes("const b = 2;"))).toBe(true);

    const state = createWysiwygState(doc);
    const next = state.apply(state.tr.setMeta(wysiwygDiffKey, model));
    const decorations = wysiwygDiffKey.getState(next)!;
    const classes = decorations
      .find(0, next.doc.content.size)
      .map(
        (decoration) =>
          (decoration as unknown as { type?: { attrs?: Record<string, string> } }).type?.attrs
            ?.class ?? "",
      );
    expect(classes.some((name) => name.includes("pm-diff-code-add"))).toBe(true);
  });

  it("ProseMirror 插件生成装饰", async () => {
    const { doc } = parseMarkdown(newText);
    const diff = computeLineDiff(oldText, newText);
    const model = await buildWysiwygDiff({ docJson: doc, newText, oldText, diff });
    expect(model).not.toBeNull();

    const state = createWysiwygState(doc);
    const next = state.apply(state.tr.setMeta(wysiwygDiffKey, model));
    const decorations = wysiwygDiffKey.getState(next);
    expect(decorations).toBeDefined();
    expect(decorations?.find(1, next.doc.content.size).length ?? 0).toBeGreaterThan(0);
  });
});
