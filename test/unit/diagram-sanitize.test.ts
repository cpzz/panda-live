// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeDiagramSvg } from "../../src/render/diagram/sanitize";

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
});
