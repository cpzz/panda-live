import { describe, expect, it } from "vitest";
import { computeLineDiff } from "../../src/diff/compute";
import { newInlineMarks, newLineMarkers, oldInlineMarks, oldLineMarkers } from "../../src/diff/markers";

describe("源码差异行标记", () => {
  it("修改行在两侧都标记为 change", () => {
    const diff = computeLineDiff("a\nb\nc\n", "a\nB\nc\n");
    expect(oldLineMarkers(diff)).toEqual([{ line: 2, kind: "change" }]);
    expect(newLineMarkers(diff)).toEqual([{ line: 2, kind: "change" }]);
  });

  it("新增行只出现在新文本一侧", () => {
    const diff = computeLineDiff("a\nb\n", "a\nb\nc\n");
    expect(oldLineMarkers(diff)).toEqual([]);
    expect(newLineMarkers(diff)).toEqual([{ line: 3, kind: "add" }]);
  });

  it("删除行只出现在旧文本一侧", () => {
    const diff = computeLineDiff("a\nb\nc\n", "a\nc\n");
    expect(oldLineMarkers(diff)).toEqual([{ line: 2, kind: "delete" }]);
    expect(newLineMarkers(diff)).toEqual([]);
  });

  it("多行改动逐行标注，且忽略空白后不产生标记", () => {
    const diff = computeLineDiff("a\nb\nc\n", "a\nd\ne\n");
    expect(oldLineMarkers(diff)).toEqual([
      { line: 2, kind: "change" },
      { line: 3, kind: "change" },
    ]);
    expect(newLineMarkers(diff)).toEqual([
      { line: 2, kind: "change" },
      { line: 3, kind: "change" },
    ]);

    const ignored = computeLineDiff("a  b\n", "a b\n", { ignoreWhitespace: true });
    expect(oldLineMarkers(ignored)).toEqual([]);
    expect(newLineMarkers(ignored)).toEqual([]);
  });
});

describe("对比视图行内字符标记", () => {
  it("修改行只标记具体变化的字符区间", () => {
    const diff = computeLineDiff("Hello world\n", "Hello panda\n");
    expect(oldInlineMarks(diff)).toEqual([{ line: 1, from: 6, to: 11, kind: "del" }]);
    expect(newInlineMarks(diff)).toEqual([{ line: 1, from: 6, to: 11, kind: "add" }]);
  });

  it("多行修改逐行计算字符区间", () => {
    const diff = computeLineDiff("a\nfoo bar\nc\n", "a\nfoo baz\nc\n");
    expect(oldInlineMarks(diff)).toEqual([{ line: 2, from: 4, to: 7, kind: "del" }]);
    expect(newInlineMarks(diff)).toEqual([{ line: 2, from: 4, to: 7, kind: "add" }]);
  });

  it("纯新增与纯删除行不做行内标记", () => {
    const added = computeLineDiff("a\n", "a\nb\n");
    expect(oldInlineMarks(added)).toEqual([]);
    expect(newInlineMarks(added)).toEqual([]);
    const deleted = computeLineDiff("a\nb\n", "a\n");
    expect(oldInlineMarks(deleted)).toEqual([]);
    expect(newInlineMarks(deleted)).toEqual([]);
  });
});
