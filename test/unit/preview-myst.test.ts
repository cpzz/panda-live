// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdownToHtml } from "../../src/formats/markdown/preview";

const TAB_SET = [
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

describe("MyST 预览渲染", () => {
  it("tab-set 渲染为按钮 + 面板，首项激活", async () => {
    const html = await renderMarkdownToHtml(TAB_SET);
    expect(html).toContain('class="myst-tab-set"');
    expect(html).toContain('data-active="0"');
    expect(html).toContain('class="myst-tab-bar"');
    expect(html).toContain('class="myst-tab-button"');
    // 首个页签必须同时带 active 类，否则初始内容可见但页签无高亮。
    expect(html).toContain('class="myst-tab-button active"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain(">安装</button>");
    expect(html).toContain(">使用</button>");
    expect(html).toContain('class="myst-tab-body"');
    expect(html).toContain('class="myst-tab-item"');
    expect(html).toContain('data-label="安装"');
    expect(html).toContain("<p>npm install</p>");
    expect(html).toContain("<p>npm run dev</p>");
  });

  it("grid 渲染列数与 outline 边框", async () => {
    const html = await renderMarkdownToHtml(
      ["````{grid}", ":columns: 3", ":outline:", "", "```{grid-item} 甲", "一", "```", "````", ""].join("\n"),
    );
    expect(html).toContain('class="myst-grid myst-grid-outline"');
    expect(html).toContain('data-columns="3"');
    expect(html).toContain('class="myst-grid-item"');
    expect(html).toContain("<p>一</p>");
  });

  it("grid 缺省为两列，且栅格项内可嵌套 tab-set", async () => {
    const html = await renderMarkdownToHtml(
      [
        "``````{grid}",
        "",
        "`````{grid-item} 嵌套",
        "````{tab-set}",
        "",
        "```{tab-item} 内层",
        "内容",
        "```",
        "````",
        "`````",
        "",
        "```{grid-item}",
        "普通项",
        "```",
        "``````",
        "",
      ].join("\n"),
    );
    expect(html).toContain('class="myst-grid"');
    expect(html).toContain('data-columns="2"');
    expect(html).toContain('class="myst-tab-set"');
    expect(html).toContain('data-label="内层"');
    expect(html).toContain('class="myst-grid-item"');
    expect(html).toContain("<p>普通项</p>");
  });

  it("冒号围栏（官方语法）渲染为按钮 + 面板，内容含反引号代码块", async () => {
    const html = await renderMarkdownToHtml(
      [
        "::::{tab-set}",
        "",
        ":::{tab-item} TSK-01",
        "第一页内容",
        ":::",
        "",
        ":::{tab-item} TSK-02",
        "```bash",
        "npm install",
        "```",
        ":::",
        "::::",
        "",
      ].join("\n"),
    );
    expect(html).toContain('class="myst-tab-set"');
    expect(html).toContain('data-active="0"');
    expect(html).toContain(">TSK-01</button>");
    expect(html).toContain(">TSK-02</button>");
    expect(html).toContain('data-label="TSK-02"');
    expect(html).toContain("<p>第一页内容</p>");
    expect(html).toMatch(/<pre><code class="language-bash">/);
  });

  it("冒号围栏 grid 渲染列数与 outline", async () => {
    const html = await renderMarkdownToHtml(
      [":::::{grid}", ":columns: 3", ":outline:", "", "::::{grid-item} 甲", "一", "::::", ":::::", ""].join("\n"),
    );
    expect(html).toContain('class="myst-grid myst-grid-outline"');
    expect(html).toContain('data-columns="3"');
    expect(html).toContain("<p>一</p>");
  });

  it("指令内容仍经 DOMPurify 消毒：脚本与事件属性被移除", async () => {
    const html = await renderMarkdownToHtml(
      [
        "````{tab-set}",
        "",
        "```{tab-item} 危险",
        '<script>alert(1)</script><a onclick="alert(1)">链接</a>',
        "```",
        "````",
        "",
      ].join("\n"),
    );
    expect(html).toContain('class="myst-tab-item"');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick");
  });
});
