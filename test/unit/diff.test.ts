import { describe, expect, it } from "vitest";
import {
  computeLineDiff,
  hunkAnchorLine,
  normalizeDiffText,
  normalizeFormatText,
} from "../../src/diff/compute";

describe("diff 文本规范化", () => {
  it("统一 CRLF 与 BOM，并补齐末尾换行", () => {
    expect(normalizeDiffText("\uFEFFa\r\nb\r\n")).toBe("a\nb\n");
    expect(normalizeDiffText("a\nb")).toBe("a\nb\n");
    expect(normalizeDiffText("")).toBe("");
  });

  it("CRLF 与 LF 的同一内容不产生改动", () => {
    const diff = computeLineDiff("# 标题\r\n\r\n正文\r\n", "# 标题\n\n正文\n");
    expect(diff.hunks).toHaveLength(0);
    expect(diff.stats).toEqual({ added: 0, removed: 0, changed: 0 });
  });
});

describe("行级 diff", () => {
  it("新增整行", () => {
    const diff = computeLineDiff("a\nb\n", "a\nb\nc\n");
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]).toMatchObject({ kind: "add", newStart: 3, newCount: 1 });
    expect(diff.newLineKinds.get(3)).toBe("add");
    expect(diff.stats).toEqual({ added: 1, removed: 0, changed: 0 });
  });

  it("删除整行并记录锚点", () => {
    const diff = computeLineDiff("a\nb\nc\n", "a\nc\n");
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]).toMatchObject({ kind: "delete", oldStart: 2, oldCount: 1, newStart: 2 });
    expect(diff.deletionsAt.get(2)).toBe(1);
    expect(diff.stats).toEqual({ added: 0, removed: 1, changed: 0 });
  });

  it("修改一行归并为 change 并生成词级片段", () => {
    const diff = computeLineDiff("hello world\nnext\n", "hello panda\nnext\n");
    expect(diff.hunks).toHaveLength(1);
    const hunk = diff.hunks[0]!;
    expect(hunk.kind).toBe("change");
    expect(hunk.newStart).toBe(1);
    const ins = (hunk.words ?? []).filter((segment) => segment.kind === "ins").map((s) => s.text).join("");
    const del = (hunk.words ?? []).filter((segment) => segment.kind === "del").map((s) => s.text).join("");
    expect(ins).toContain("panda");
    expect(del).toContain("world");
    expect(diff.newLineKinds.get(1)).toBe("change");
    expect(diff.stats).toEqual({ added: 0, removed: 1, changed: 1 });
  });

  it("新文件视为全文新增", () => {
    const diff = computeLineDiff("", "a\nb\n");
    expect(diff.hunks[0]).toMatchObject({ kind: "add", newStart: 1, newCount: 2 });
    expect(diff.stats).toEqual({ added: 2, removed: 0, changed: 0 });
  });

  it("末尾删除的导航锚点回退到末行", () => {
    const diff = computeLineDiff("a\nb\n", "a\n");
    const anchor = hunkAnchorLine(diff.hunks[0]!, 1);
    expect(anchor).toBe(1);
  });
});

describe("Git 忽略参数", () => {
  it("-w 忽略行内空白，但 hunk 保留原始空白", () => {
    const oldText = "const  a = 1;\n";
    const newText = "const a = 1;\n";
    expect(computeLineDiff(oldText, newText).hunks).toHaveLength(1);
    expect(computeLineDiff(oldText, newText, { ignoreWhitespace: true }).hunks).toHaveLength(0);

    const changed = computeLineDiff("const  a = 1;\n", "const  a = 2;\n", {
      ignoreWhitespace: true,
    });
    expect(changed.hunks).toHaveLength(1);
    expect(changed.hunks[0]?.oldText).toBe("const  a = 1;\n");
  });

  it("--ignore-blank-lines 忽略纯空行变化", () => {
    const oldText = "a\n\nb\n";
    const newText = "a\nb\n";
    expect(computeLineDiff(oldText, newText).hunks.length).toBeGreaterThan(0);
    expect(computeLineDiff(oldText, newText, { ignoreBlankLines: true }).hunks).toHaveLength(0);
  });

  it("--ignore-cr-at-eol 控制行尾 CR 是否计入差异", () => {
    const oldText = "a\r\nb\r\n";
    const newText = "a\nb\n";
    expect(computeLineDiff(oldText, newText).hunks).toHaveLength(0);
    expect(computeLineDiff(oldText, newText, { ignoreCrAtEol: false }).hunks.length).toBeGreaterThan(
      0,
    );
  });
});

describe("格式变化识别", () => {
  it("空白、缩进、列表与强调标记变化可识别为仅格式变化", () => {
    expect(normalizeFormatText("-  项目\n\n**重点**\n")).toBe(
      normalizeFormatText("* 项目\n\n_重点_\n"),
    );
    expect(normalizeFormatText("- 旧内容\n")).not.toBe(normalizeFormatText("- 新内容\n"));
  });
});
