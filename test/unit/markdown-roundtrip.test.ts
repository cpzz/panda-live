import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { markdownSchema } from "../../src/editor/schema";
import { parseMarkdown } from "../../src/formats/markdown/parse";
import { serializeMarkdown } from "../../src/formats/markdown/serialize";

const fixtureDir = fileURLToPath(new URL("../fixtures/markdown", import.meta.url));
const fixtures = readdirSync(fixtureDir).filter((file) => file.endsWith(".md"));

describe("Markdown 往返语料库", () => {
  for (const fixture of fixtures) {
    it(`${fixture} 第二次序列化结果与第一次一致`, () => {
      const source = readFileSync(join(fixtureDir, fixture), "utf8");

      const first = serializeMarkdown(parseMarkdown(source).doc);
      const reparse = parseMarkdown(first);
      expect(reparse.diagnostics).toEqual([]);
      expect(() => markdownSchema.nodeFromJSON(reparse.doc)).not.toThrow();

      const second = serializeMarkdown(reparse.doc);
      expect(second).toBe(first);
    });
  }

  it("顶层块均分配 nodeId", () => {
    const { doc } = parseMarkdown("# 标题\n\n段落\n\n- 项目\n");
    const ids = (doc.content ?? []).map((block) => block.attrs?.nodeId);
    expect(ids).toEqual(["b1", "b2", "b3"]);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  });

  it("frontmatter 序列化后仍位于文档开头", () => {
    const markdown = serializeMarkdown({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "正文" }] },
        { type: "frontmatter", attrs: { raw: "title: x" } },
      ],
    });
    expect(markdown.startsWith("---\ntitle: x\n---\n")).toBe(true);
  });

  it("图表围栏按 plantuml 与 mermaid 规范化", () => {
    const { doc } = parseMarkdown("```puml\nA -> B\n```\n\n```mmd\ngraph TD\nA --> B\n```\n");
    const markdown = serializeMarkdown(doc);
    expect(markdown).toContain("```plantuml");
    expect(markdown).toContain("```mermaid");
  });

  it("代码围栏保留语言与 meta 信息", () => {
    const source = '```js title="demo"\nconst a = 1\n```\n';
    const { doc } = parseMarkdown(source);
    const markdown = serializeMarkdown(doc);
    expect(markdown).toContain('```js title="demo"');
    expect(markdown).toContain("const a = 1");
    expect(serializeMarkdown(parseMarkdown(markdown).doc)).toBe(markdown);
  });

  it("引用式链接与图片保留标签写法", () => {
    const source = "[链接][ref] 与 ![图][img]\n\n[ref]: https://example.com\n[img]: ./a.png\n";
    const markdown = serializeMarkdown(parseMarkdown(source).doc);
    expect(markdown).toContain("[链接][ref]");
    expect(markdown).toContain("![图][img]");
    expect(serializeMarkdown(parseMarkdown(markdown).doc)).toBe(markdown);
  });

  it("脚注引用保留原文而不被转义", () => {
    const source = "引用[^1]\n\n[^1]: 脚注内容\n";
    const markdown = serializeMarkdown(parseMarkdown(source).doc);
    expect(markdown).toContain("引用[^1]");
    expect(markdown).not.toContain("\\[^1]");
  });
});
