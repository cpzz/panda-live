// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../src/formats/markdown/parse";
import { renderMarkdownToHtml } from "../../src/formats/markdown/preview";

const ROOT = path.resolve(".");

describe("MyST 示例文件保持可解析", () => {
  it("41-myst.myst：反引号与冒号围栏都展开为 tab-set / grid", () => {
    const source = readFileSync(path.join(ROOT, "examples", "41-myst.myst"), "utf8");
    const { doc } = parseMarkdown(source);
    const json = JSON.stringify(doc);
    expect(json).toContain('"tab_set"');
    expect(json).toContain('"grid"');
    // 冒号围栏任务卡示例：TSK-01..04 均成为页签 label。
    for (const label of ["TSK-01", "TSK-02", "TSK-03", "TSK-04"]) {
      expect(json).toContain(label);
    }
  });

  it("41-myst.myst：预览渲染出页签按钮与栅格", async () => {
    const source = readFileSync(path.join(ROOT, "examples", "41-myst.myst"), "utf8");
    const html = await renderMarkdownToHtml(source);
    expect(html).toContain('class="myst-tab-set"');
    expect(html).toContain("myst-grid");
    expect(html).toContain("data-columns");
    expect(html).toContain("TSK-01");
    // 反引号示例的三个页签都要存在（围栏长度不足时后面的页签会被吞成代码块）。
    for (const label of ["安装", "使用", "提示"]) {
      expect(html).toContain(`>${label}</button>`);
    }
  });

  it("27-markdown.md：内嵌 MyST 页签正常展开", async () => {
    const source = readFileSync(path.join(ROOT, "examples", "27-markdown.md"), "utf8");
    const { doc } = parseMarkdown(source);
    expect(JSON.stringify(doc)).toContain('"tab_set"');
    const html = await renderMarkdownToHtml(source);
    expect(html).toContain('class="myst-tab-set"');
    for (const label of ["计划", "实现", "说明", "源码模式"]) {
      expect(html).toContain(`>${label}</button>`);
    }
  });
});
