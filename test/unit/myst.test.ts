import { describe, expect, it } from "vitest";
import { markdownSchema } from "../../src/editor/schema";
import { parseMarkdown } from "../../src/formats/markdown/parse";
import { serializeMarkdown } from "../../src/formats/markdown/serialize";

function assertIdempotent(source: string): string {
  const first = parseMarkdown(source);
  expect(first.diagnostics).toEqual([]);
  expect(() => markdownSchema.nodeFromJSON(first.doc)).not.toThrow();
  const markdown = serializeMarkdown(first.doc);
  const second = parseMarkdown(markdown);
  expect(second.diagnostics).toEqual([]);
  expect(serializeMarkdown(second.doc)).toBe(markdown);
  return markdown;
}

describe("MyST 指令", () => {
  it("tab-set 解析为 tab_set / tab_item，并可按需扩展围栏长度往返", () => {
    const source = [
      "````{tab-set}",
      "",
      "```{tab-item} 安装",
      "npm install",
      "```",
      "",
      "```{tab-item} 使用",
      "npm run dev",
      "```",
      "````",
      "",
    ].join("\n");

    const { doc } = parseMarkdown(source);
    const block = (doc.content ?? [])[0];
    expect(block?.type).toBe("tab_set");
    expect((block?.content ?? []).map((item) => item.attrs?.label)).toEqual(["安装", "使用"]);

    const markdown = assertIdempotent(source);
    // 内部围栏为 3，外层必须至少为 4。
    expect(markdown).toContain("````{tab-set}");
    expect(markdown).toContain("```{tab-item} 安装");
  });

  it("grid 读取 columns 与 outline 选项并往返", () => {
    const source = [
      "````{grid}",
      ":columns: 3",
      ":outline:",
      "",
      "```{grid-item}",
      "一",
      "```",
      "",
      "```{grid-item}",
      "二",
      "```",
      "````",
      "",
    ].join("\n");

    const { doc } = parseMarkdown(source);
    const block = (doc.content ?? [])[0];
    expect(block?.type).toBe("grid");
    expect(block?.attrs?.columns).toBe(3);
    expect(block?.attrs?.outline).toBe(true);

    const markdown = assertIdempotent(source);
    expect(markdown).toContain(":columns: 3");
    expect(markdown).toContain(":outline:");
  });

  it("支持 tab-set 内嵌 tab-set", () => {
    const source = [
      "``````{tab-set}",
      "",
      "`````{tab-item} 外层",
      "",
      "````{tab-set}",
      "",
      "```{tab-item} 内层",
      "内容",
      "```",
      "````",
      "",
      "`````",
      "",
      "``````",
      "",
    ].join("\n");

    const { doc } = parseMarkdown(source);
    const outer = (doc.content ?? [])[0];
    expect(outer?.type).toBe("tab_set");
    const nested = (outer?.content ?? [])[0]?.content?.find((child) => child.type === "tab_set");
    expect(nested?.type).toBe("tab_set");

    const markdown = assertIdempotent(source);
    expect(markdown).toContain("`````{tab-set}");
  });

  it("未闭合容器的空指令退化为单个空页签", () => {
    const { doc } = parseMarkdown("```{tab-set}\n```\n");
    const block = (doc.content ?? [])[0];
    expect(block?.type).toBe("tab_set");
    expect(block?.content).toHaveLength(1);
  });
});
