import { describe, expect, it } from "vitest";
import { parseKatexMacros, renderKatex } from "../../src/render/math/katex";
import { parseMarkdown } from "../../src/formats/markdown/parse";
import { serializeMarkdown } from "../../src/formats/markdown/serialize";
import { settingsStore } from "../../src/services/settings-store";
import { DEFAULT_SETTINGS } from "../../src/shared/settings";
import type { PMJson } from "../../src/editor/schema";

function topBlockTypes(doc: PMJson): string[] {
  return (doc.content ?? []).map((block) => block.type);
}

describe("数学公式", () => {
  it("行内与块级公式映射为 math 节点并可往返", () => {
    const { doc, diagnostics } = parseMarkdown("行内 $x^2$ 公式\n\n$$\ny=ax+b\n$$\n");
    expect(diagnostics).toEqual([]);
    const paragraph = doc.content?.[0];
    expect(paragraph?.content?.some((child) => child.type === "math_inline")).toBe(true);
    expect(topBlockTypes(doc)).toContain("math_block");

    const markdown = serializeMarkdown(doc);
    expect(markdown).toContain("$x^2$");
    expect(markdown).toContain("$$");
    expect(serializeMarkdown(parseMarkdown(markdown).doc)).toBe(markdown);
  });

  it("完整 MathML 块映射为 mathml_block，内嵌 MathML 映射为 mathml_inline", () => {
    const block = "<math display=\"block\"><mi>x</mi></math>";
    const { doc } = parseMarkdown(`段落含 <math><mi>y</mi></math> 公式\n\n${block}\n`);
    expect(topBlockTypes(doc)).toContain("mathml_block");
    const paragraph = doc.content?.[0];
    expect(paragraph?.content?.some((child) => child.type === "mathml_inline")).toBe(true);

    const markdown = serializeMarkdown(doc);
    expect(markdown).toContain("<math");
    expect(serializeMarkdown(parseMarkdown(markdown).doc)).toBe(markdown);
  });

  it("KaTeX 渲染输出包含 MathML 语义（可访问性）", () => {
    const result = renderKatex("x^2", false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.html).toContain("katex");
      expect(result.html).toContain("<math");
    }
  });

  it("非法公式返回错误而不抛异常", () => {
    const result = renderKatex("\\badcommand{", false);
    expect(result.ok).toBe(false);
  });

  it("宏文本解析：等号/冒号分隔，忽略空行与注释，非法行跳过", () => {
    const macros = parseKatexMacros(
      [
        "% 注释行",
        "# 另一种注释",
        "",
        "\\RR = \\mathbb{R}",
        "\\NN : \\mathbb{N}",
        "没有反斜杠 = 1",
        "\\x", // 无定义
      ].join("\n"),
    );
    expect(macros).toEqual({ "\\RR": "\\mathbb{R}", "\\NN": "\\mathbb{N}" });
    expect(parseKatexMacros("")).toEqual({});
  });

  it("自定义宏参与渲染：未定义时报错，定义后成功且缓存键区分", () => {
    expect(renderKatex("\\RR", false).ok).toBe(false);
    const withMacro = renderKatex("\\RR", false, { macros: parseKatexMacros("\\RR = \\mathbb{R}") });
    expect(withMacro.ok).toBe(true);
    // 同宏重复命中缓存成功；改回无宏后仍报错（缓存键区分宏）。
    expect(renderKatex("\\RR", false, { macros: parseKatexMacros("\\RR = \\mathbb{R}") }).ok).toBe(true);
    expect(renderKatex("\\RR", false).ok).toBe(false);
  });

  it("设置生效：关闭单美元后 $…$ 不再解析，$$ 与宏仍可用", async () => {
    try {
      await settingsStore.update({
        math: { singleDollar: false, macros: "\\RR = \\mathbb{R}" },
      });
      const { doc } = parseMarkdown("价格 $5 与 $6\n\n$$\n\\RR\n$$\n");
      const paragraph = doc.content?.[0];
      expect(paragraph?.content?.some((child) => child.type === "math_inline")).toBe(false);
      expect(topBlockTypes(doc)).toContain("math_block");
    } finally {
      // 恢复默认，避免影响其他用例（模块级设置单例）。
      await settingsStore.update({
        math: { singleDollar: DEFAULT_SETTINGS.math.singleDollar, macros: DEFAULT_SETTINGS.math.macros },
      });
    }
  });

  it("不受信任的指令被拒绝（无脚本执行）", () => {
    // KaTeX 0.19 在 trust:false 时对 \href / \includegraphics 等 trust 类命令
    // 降级为红色错误文本（formatUnsupportedCmd）：不抛错、不生成链接或图片。
    // 输出 <annotation> 中携带的原始 TeX 仅为不可执行文本，下游还有 DOMPurify 过滤。
    const img = renderKatex("\\includegraphics{file:///etc/passwd}", false);
    expect(img.ok).toBe(true);
    if (img.ok) {
      expect(img.html).not.toContain("<img");
    }
    const href = renderKatex("\\href{javascript:alert(1)}{x}", false);
    expect(href.ok).toBe(true);
    if (href.ok) {
      // 注意区分 <a 锚点与 <annotation>（KaTeX MathML 输出含原始源码）。
      expect(href.html).not.toMatch(/<a[\s>]/);
    }
  });
});
