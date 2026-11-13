// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdownToHtml } from "../../src/formats/markdown/preview";
import { settingsStore } from "../../src/services/settings-store";
import { DEFAULT_SETTINGS } from "../../src/shared/settings";

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

  it("数学设置作用于预览：宏被应用，单美元可关闭", async () => {
    try {
      await settingsStore.update({ math: { macros: "\\RR = \\mathbb{R}", singleDollar: false } });
      const html = await renderMarkdownToHtml("货币 $5 与 $6\n\n$$\n\\RR\n$$\n");
      // 单美元关闭：$5 与 $6 保持纯文本；块级公式仍渲染且宏生效（\mathbb 输出）。
      expect(html).toContain("$5 与 $6");
      expect(html).toContain('class="katex-display"');
      expect(html).toContain("mathbb");
    } finally {
      await settingsStore.update({
        math: { macros: DEFAULT_SETTINGS.math.macros, singleDollar: DEFAULT_SETTINGS.math.singleDollar },
      });
    }
  });
});
