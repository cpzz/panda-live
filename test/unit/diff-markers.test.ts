import { describe, expect, it } from "vitest";
import { computeLineDiff } from "../../src/diff/compute";
import { newLineMarkers, oldLineMarkers } from "../../src/diff/markers";

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
