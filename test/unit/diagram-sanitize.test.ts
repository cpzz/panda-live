// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeDiagramSvg, svgNaturalWidth } from "../../src/render/diagram/sanitize";

describe("图表 SVG 消毒", () => {
  it("移除脚本、foreignObject 与事件属性", () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">',
      "<script>alert(1)</script>",
      "<foreignObject><img src=\"x\" /></foreignObject>",
      "<circle cx=\"10\" cy=\"10\" r=\"5\" onclick=\"alert(1)\"/>",
      "</svg>",
    ].join("");

    const sanitized = sanitizeDiagramSvg(svg);
    expect(sanitized).not.toContain("<script");
    expect(sanitized).not.toContain("foreignObject");
    expect(sanitized).not.toContain("onload");
    expect(sanitized).not.toContain("onclick");
    expect(sanitized).toContain("<circle");
  });

  it("只保留内部片段链接，移除外部与脚本链接", () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
      '<a xlink:href="javascript:alert(1)"><text>x</text></a>',
      '<a xlink:href="https://evil.example.com/"><text>y</text></a>',
      '<a xlink:href="#node1"><text>z</text></a>',
      "</svg>",
    ].join("");

    const sanitized = sanitizeDiagramSvg(svg);
    expect(sanitized).not.toContain("javascript:");
    expect(sanitized).not.toContain("evil.example.com");
    expect(sanitized).toContain("#node1");
  });

  it("残缺输入被修复为安全 SVG", () => {
    // DOMPurify 会先修复标记；此处只要求结果不含脚本或未知节点。
    const sanitized = sanitizeDiagramSvg("<svg><broken>");
    expect(sanitized).not.toContain("<script");
    expect(sanitized).not.toContain("<broken");
  });

  it("把 Mermaid 内联 max-width 转写为 width 属性（保留自然宽度），其余声明原样保留", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%" style="color:red;max-width:480px;"><g style="color:blue;"/></svg>';

    const sanitized = sanitizeDiagramSvg(svg);
    // 自然宽度转写为固定 width 属性，缩放视图以它为 100% 基准。
    expect(sanitized).toContain('width="480"');
    expect(sanitized).not.toContain("max-width");
    expect(sanitized).toContain("color:red");
    // 非 svg 元素的内联样式不处理。
    expect(sanitized).toContain("color:blue");
  });

  it("已有固定 width 属性时不覆盖，仅移除内联 max-width", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" style="max-width:480px;"></svg>';

    const sanitized = sanitizeDiagramSvg(svg);
    expect(sanitized).toContain('width="640"');
    expect(sanitized).not.toContain("max-width");
  });
});

describe("svgNaturalWidth", () => {
  it("优先取固定像素 width 属性，其次 viewBox，缺省回退 600", () => {
    expect(
      svgNaturalWidth('<svg xmlns="http://www.w3.org/2000/svg" width="720" height="360"/>'),
    ).toBe(720);
    expect(
      svgNaturalWidth(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 480 300"/>',
      ),
    ).toBe(480);
    expect(svgNaturalWidth('<svg xmlns="http://www.w3.org/2000/svg"/>')).toBe(600);
    expect(svgNaturalWidth("not-svg", 123)).toBe(123);
  });
});
