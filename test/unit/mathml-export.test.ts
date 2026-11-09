// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { extractMathml } from "../../src/render/math/katex";

describe("KaTeX MathML 提取", () => {
  it("从渲染输出中提取 <math> 分支", () => {
    const mathml = extractMathml("\\frac{a}{b}", true);
    expect(mathml).not.toBeNull();
    expect(mathml).toContain("<math");
    expect(mathml).toContain("mfrac");
    expect(mathml).toContain("a");
    expect(mathml).toContain("b");
  });

  it("非法公式返回 null", () => {
    expect(extractMathml("\\frac{1}{", false)).toBeNull();
  });
});
