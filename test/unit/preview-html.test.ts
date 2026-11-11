// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdownToHtml } from "../../src/formats/markdown/preview";

describe("Markdown 预览中的原始 HTML", () => {
  it("保留页内目录链接与显式锚点", async () => {
    const html = await renderMarkdownToHtml(
      "# 目录\n\n[交付物信息](#sec-1)\n\n<a id=\"sec-1\"></a>\n\n## 交付物信息\n",
    );
    expect(html).toContain('href="#sec-1"');
    expect(html).toContain('id="sec-1"');
    expect(html).not.toContain("&lt;a");
  });

  it("消毒后仍移除脚本与事件属性", async () => {
    const html = await renderMarkdownToHtml(
      '<a id="sec-1" onclick="alert(1)"></a>\n\n<script>alert(1)</script>\n',
    );
    expect(html).toContain('id="sec-1"');
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("<script");
  });
});
