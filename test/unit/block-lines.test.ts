import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../src/formats/markdown/parse";
import { blockLineRanges, serializeMarkdown } from "../../src/formats/markdown/serialize";

function lineSlice(text: string, start: number, end: number): string {
  return text
    .split("\n")
    .slice(start - 1, end)
    .join("\n");
}

describe("顶层块行号映射", () => {
  const source = [
    "# 标题",
    "",
    "第一段",
    "第二行",
    "",
    "- 项目一",
    "- 项目二",
    "",
    "```ts",
    "const a = 1;",
    "```",
    "",
    "| 列一 | 列二 |",
    "| --- | --- |",
    "| a | b |",
    "",
    "尾段",
  ].join("\n");

  it("块数量、行范围与序列化文本一致", () => {
    const { doc } = parseMarkdown(source);
    const map = blockLineRanges(doc);
    const text = serializeMarkdown(doc).replace(/\n$/, "");
    expect(map.ranges).toHaveLength(doc.content?.length ?? 0);
    expect(map.totalLines).toBe(text.split("\n").length);
    expect(lineSlice(text, map.ranges[0]!.start, map.ranges[0]!.end)).toBe("# 标题");
    expect(lineSlice(text, map.ranges[2]!.start, map.ranges[2]!.end)).toContain("- 项目一");
    expect(lineSlice(text, map.ranges[3]!.start, map.ranges[3]!.end)).toContain("const a = 1;");
    expect(lineSlice(text, map.ranges[4]!.start, map.ranges[4]!.end)).toContain("| 列一 |");
    expect(map.ranges[4]!.end).toBeLessThanOrEqual(map.ranges[5]!.start - 2);
  });
});
