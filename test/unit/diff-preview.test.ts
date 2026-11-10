// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { computeLineDiff } from "../../src/diff/compute";
import { applyPreviewDiff, clearPreviewDiff } from "../../src/diff/preview";
import { renderMarkdownToHtml } from "../../src/formats/markdown/preview";

async function createHost(markdown: string): Promise<HTMLElement> {
  const host = document.createElement("article");
  host.innerHTML = await renderMarkdownToHtml(markdown, { annotateSource: true });
  return host;
}

describe("渲染态差异装饰", () => {
  it("渲染 HTML 带源行号", async () => {
    const host = await createHost("# 标题\n\n正文\n");
    const heading = host.querySelector("h1");
    expect(heading?.getAttribute("data-src-line")).toBe("1");
    expect(heading?.getAttribute("data-src-end-line")).toBe("1");
  });

  it("修改标题时只标记变化的词", async () => {
    const oldText = "# Hello world\n\nBody\n";
    const newText = "# Hello panda\n\nBody\n";
    const host = await createHost(newText);
    const diff = computeLineDiff(oldText, newText);

    await applyPreviewDiff(host, { oldText, newText, diff, mode: "full" }, () => false);

    const heading = host.querySelector("h1")!;
    expect(heading.classList.contains("diff-change")).toBe(true);
    expect(heading.querySelector("ins.diff-inline-add")?.textContent).toContain("panda");
    expect(heading.querySelector("del.diff-inline-del")?.textContent).toContain("world");
    expect(heading.textContent).toContain("Hello");
  });

  it("删除段落生成幽灵块", async () => {
    const oldText = "keep\n\ndeleted paragraph\n";
    const newText = "keep\n";
    const host = await createHost(newText);
    const diff = computeLineDiff(oldText, newText);

    await applyPreviewDiff(host, { oldText, newText, diff, mode: "full" }, () => false);

    const ghost = host.querySelector("[data-diff-ghost]");
    expect(ghost).not.toBeNull();
    expect(ghost?.textContent).toContain("deleted paragraph");
    expect(ghost?.querySelector(".diff-ghost-label")?.textContent).toContain("已删除");
  });

  it("删除列表项时幽灵块插回原列表", async () => {
    const oldText = "- 甲\n- 乙\n- 丙\n";
    const newText = "- 甲\n- 丙\n";
    const host = await createHost(newText);
    const diff = computeLineDiff(oldText, newText);

    await applyPreviewDiff(host, { oldText, newText, diff, mode: "full" }, () => false);

    const list = host.querySelector("ul");
    const ghosts = [...(list?.querySelectorAll("[data-diff-ghost]") ?? [])];
    expect(ghosts.length).toBeGreaterThan(0);
    expect(ghosts.map((element) => element.textContent ?? "").join("")).toContain("乙");
    expect(host.querySelector(":scope > [data-diff-ghost]")).toBeNull();
  });

  it("删除表格行时幽灵行插回原表格", async () => {
    const oldText = "| 名称 | 数值 |\n| --- | --- |\n| 甲 | 1 |\n| 乙 | 2 |\n";
    const newText = "| 名称 | 数值 |\n| --- | --- |\n| 甲 | 1 |\n";
    const host = await createHost(newText);
    const diff = computeLineDiff(oldText, newText);

    await applyPreviewDiff(host, { oldText, newText, diff, mode: "full" }, () => false);

    const table = host.querySelector("table");
    const ghosts = [...(table?.querySelectorAll("[data-diff-ghost]") ?? [])];
    expect(ghosts.length).toBeGreaterThan(0);
    expect(ghosts.map((element) => element.textContent ?? "").join("")).toContain("乙");
    expect(host.querySelector(":scope > [data-diff-ghost]")).toBeNull();
  });

  it("关闭差异后装饰可完全清理", async () => {
    const oldText = "# Hello world\n\nBody\n";
    const newText = "# Hello panda\n\nBody\n";
    const host = await createHost(newText);
    const diff = computeLineDiff(oldText, newText);
    await applyPreviewDiff(host, { oldText, newText, diff, mode: "full" }, () => false);
    expect(host.querySelector("ins.diff-inline-add")).not.toBeNull();

    clearPreviewDiff(host);

    expect(host.querySelector("ins.diff-inline-add")).toBeNull();
    expect(host.querySelector("del.diff-inline-del")).toBeNull();
    expect(host.querySelector(".diff-change")).toBeNull();
    expect(host.textContent).toContain("Hello panda");
  });

  it("表格只标注发生变化的单元格", async () => {
    const oldText = "| 名称 | 数值 |\n| --- | --- |\n| 甲 | 1 |\n| 乙 | 2 |\n";
    const newText = "| 名称 | 数值 |\n| --- | --- |\n| 甲 | 9 |\n| 乙 | 2 |\n";
    const host = await createHost(newText);
    const diff = computeLineDiff(oldText, newText);

    await applyPreviewDiff(host, { oldText, newText, diff, mode: "full" }, () => false);

    const rows = host.querySelectorAll("tbody tr");
    expect(rows[0]?.classList.contains("diff-change")).toBe(true);
    const cells = rows[0]?.querySelectorAll("td") ?? [];
    expect(cells[0]?.querySelector("ins, del")).toBeNull();
    expect(cells[1]?.querySelector("ins.diff-inline-add")?.textContent).toContain("9");
    expect(cells[1]?.querySelector("del.diff-inline-del")?.textContent).toContain("1");
  });

  it("代码块按行展示新增与删除", async () => {
    const oldText = "```ts\nconst a = 1;\nconst b = 2;\n```\n";
    const newText = "```ts\nconst a = 1;\nconst c = 3;\n```\n";
    const host = await createHost(newText);
    const diff = computeLineDiff(oldText, newText);

    await applyPreviewDiff(host, { oldText, newText, diff, mode: "full" }, () => false);

    const code = host.querySelector("pre code.diff-code");
    expect(code).not.toBeNull();
    expect(code?.querySelector(".diff-code-line.add")?.textContent).toContain("const c = 3;");
    expect(code?.querySelector(".diff-code-line.del")?.textContent).toContain("const b = 2;");
    // 成对行再标出具体变化的词，而不是只标整行。
    expect(code?.querySelector(".diff-code-line.add .diff-code-word.add")).not.toBeNull();
    expect(code?.querySelector(".diff-code-line.del .diff-code-word.del")).not.toBeNull();
  });

  it("短文档改动超过 40% 仍标出变化的词", async () => {
    const oldText = "# Hello world\n";
    const newText = "# Hello panda\n";
    const host = await createHost(newText);
    const diff = computeLineDiff(oldText, newText);

    await applyPreviewDiff(host, { oldText, newText, diff, mode: "full" }, () => false);

    expect(host.querySelector("ins.diff-inline-add")?.textContent).toContain("panda");
    expect(host.querySelector("del.diff-inline-del")?.textContent).toContain("world");
  });

  it("表格单元格内的行内代码也能标出变化", async () => {
    const oldText = "| 名称 | 值 |\n| --- | --- |\n| `<WORKDIR>` | 1 |\n| `<REPO>` | 2 |\n";
    const newText = "| 名称 | 值 |\n| --- | --- |\n| `<WORKDIR>` | 1 |\n| `<REPO_NEW>` | 2 |\n";
    const host = await createHost(newText);
    const diff = computeLineDiff(oldText, newText);

    await applyPreviewDiff(host, { oldText, newText, diff, mode: "full" }, () => false);

    const row = host.querySelectorAll<HTMLTableRowElement>("tbody tr")[1]!;
    expect(row.classList.contains("diff-change")).toBe(true);
    expect(row.querySelector("code ins.diff-inline-add")?.textContent).toContain("_NEW");
    expect(row.querySelector("code del.diff-inline-del")?.textContent).toContain("REPO");
    // 悬停提示包含对应源码行，便于确认黄线具体改了什么。
    expect(row.title).toContain("REPO_NEW");
  });

  it("表格行无法词级比较时显示改动前/改动后两行", async () => {
    const oldText = "| 值 |\n| --- |\n| ![a](a.png) |\n| 保留 |\n";
    const newText = "| 值 |\n| --- |\n| ![b](b.png) |\n| 保留 |\n";
    const host = await createHost(newText);
    const diff = computeLineDiff(oldText, newText);

    await applyPreviewDiff(host, { oldText, newText, diff, mode: "full" }, () => false);

    const before = host.querySelector("tr.diff-row-before");
    const after = host.querySelector("tr.diff-row-after");
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(before?.querySelector("img")?.getAttribute("src")).toContain("a.png");
    expect(after?.querySelector("img")?.getAttribute("src")).toContain("b.png");

    clearPreviewDiff(host);
    expect(host.querySelector("tr.diff-row-before")).toBeNull();
    expect(host.querySelector("tr.diff-row-after")).toBeNull();
  });

  it("仅空白不同的表格行标记为仅格式变化", async () => {
    const oldText = "| A | B |\n| --- | --- |\n| x |  y |\n| 保留 | 保留 |\n";
    const newText = "| A | B |\n| --- | --- |\n| x | y |\n| 保留 | 保留 |\n";
    const host = await createHost(newText);
    const diff = computeLineDiff(oldText, newText);

    await applyPreviewDiff(host, { oldText, newText, diff, mode: "full" }, () => false);

    expect(host.querySelector("tr.diff-format-only")).not.toBeNull();
    expect(host.querySelector("tr.diff-row-before")).toBeNull();
  });

  it("长文档改掉一半仍保留词级标记", async () => {
    const oldLines = Array.from({ length: 30 }, (_, index) => `段落 ${index + 1}`);
    const newLines = oldLines.map((line, index) =>
      index % 2 === 0 ? `段落 ${index + 1} 修改` : line,
    );
    const oldText = `${oldLines.join("\n\n")}\n`;
    const newText = `${newLines.join("\n\n")}\n`;
    const host = await createHost(newText);
    const diff = computeLineDiff(oldText, newText);

    await applyPreviewDiff(host, { oldText, newText, diff, mode: "full" }, () => false);

    expect(host.querySelector("ins.diff-inline-add")).not.toBeNull();
  });

  it("含行内代码的段落仍标出变化的词", async () => {
    const oldText = "使用 `npm run build` 启动\n\n第二段\n";
    const newText = "使用 `npm run dev` 启动\n\n第二段\n";
    const host = await createHost(newText);
    const diff = computeLineDiff(oldText, newText);

    await applyPreviewDiff(host, { oldText, newText, diff, mode: "full" }, () => false);

    const code = host.querySelector("p code");
    expect(code?.querySelector("ins.diff-inline-add")?.textContent).toContain("dev");
    expect(code?.querySelector("del.diff-inline-del")?.textContent).toContain("build");
  });

  it("折叠未改动保留上下文并可展开", async () => {
    const lines: string[] = [];
    for (let index = 1; index <= 10; index += 1) lines.push(`段落 ${index}`);
    const oldText = `${lines.join("\n\n")}\n`;
    const newText = oldText.replace("段落 5", "段落 5 修改");
    const host = await createHost(newText);
    const diff = computeLineDiff(oldText, newText);

    await applyPreviewDiff(host, { oldText, newText, diff, mode: "collapse" }, () => false);

    const bars = [...host.querySelectorAll<HTMLElement>(".diff-collapse-bar")];
    expect(bars.length).toBeGreaterThan(0);
    expect(bars[0]?.textContent).toContain("个未改动块");
    for (const bar of bars) bar.click();
    expect(host.querySelector(".diff-collapse-bar")).toBeNull();
    expect(host.querySelectorAll("[hidden]")).toHaveLength(0);
  });

  it("仅改动片段生成带面包屑的卡片", async () => {
    const oldText = "# 一级\n\n## 二级\n\n旧段落\n\n结尾\n";
    const newText = "# 一级\n\n## 二级\n\n新段落\n\n结尾\n";
    const host = await createHost(newText);
    const diff = computeLineDiff(oldText, newText);

    await applyPreviewDiff(host, { oldText, newText, diff, mode: "fragments" }, () => false);

    const card = host.querySelector(".diff-fragment-card");
    expect(card).not.toBeNull();
    expect(card?.querySelector(".diff-fragment-breadcrumb")?.textContent).toContain("一级");
    expect(card?.querySelector(".diff-fragment-count")?.textContent).toContain("共 1 处");
    expect(card?.querySelector(".diff-fragment-body")?.textContent).toContain("新段落");
    // 退出片段视图应恢复原始顺序与全部内容。
    clearPreviewDiff(host);
    expect(host.querySelector(".diff-fragment-card")).toBeNull();
    expect(host.textContent).toContain("结尾");
  });

  it("frontmatter 改动给出不可见内容提示", async () => {
    const oldText = "---\ntitle: 旧\n---\n\n正文\n";
    const newText = "---\ntitle: 新\n---\n\n正文\n";
    const host = await createHost(newText);
    const diff = computeLineDiff(oldText, newText);

    await applyPreviewDiff(host, { oldText, newText, diff, mode: "full" }, () => false);

    expect(host.querySelector(".diff-notice")?.textContent).toContain("frontmatter");
  });

  it("frontmatter 整体删除也给出提示", async () => {
    const oldText = "---\ntitle: 旧\n---\n\n正文\n";
    const newText = "正文\n";
    const host = await createHost(newText);
    const diff = computeLineDiff(oldText, newText);

    await applyPreviewDiff(host, { oldText, newText, diff, mode: "full" }, () => false);

    expect(host.querySelector(".diff-notice")?.textContent).toContain("frontmatter");
  });

  it("切换粒度重复应用时还原代码块，不叠加删除行", async () => {
    const oldText = "```ts\nconst a = 1;\nconst b = 2;\n```\n";
    const newText = "```ts\nconst a = 1;\nconst c = 3;\n```\n";
    const host = await createHost(newText);
    const diff = computeLineDiff(oldText, newText);

    await applyPreviewDiff(host, { oldText, newText, diff, mode: "full" }, () => false);
    expect(host.querySelectorAll(".diff-code-line.del")).toHaveLength(1);

    // 模拟切换粒度：同一份 DOM 上重复应用，代码块必须先被还原再重新装饰。
    await applyPreviewDiff(host, { oldText, newText, diff, mode: "collapse" }, () => false);

    const code = host.querySelector("pre code.diff-code");
    expect(code).not.toBeNull();
    const text = code?.textContent ?? "";
    expect(text.match(/const b = 2;/g)).toHaveLength(1);
    expect(text.match(/const c = 3;/g)).toHaveLength(1);
    expect(host.querySelectorAll(".diff-code-line.del")).toHaveLength(1);
  });

  it("折叠未改动时表格内的改动不会被隐藏", async () => {
    const before = Array.from({ length: 6 }, (_, index) => `前置段落 ${index + 1}`).join("\n\n");
    const after = Array.from({ length: 6 }, (_, index) => `后置段落 ${index + 1}`).join("\n\n");
    const oldText = `${before}\n\n| 名称 | 数值 |\n| --- | --- |\n| 甲 | 1 |\n| 乙 | 2 |\n\n${after}\n`;
    const newText = `${before}\n\n| 名称 | 数值 |\n| --- | --- |\n| 甲 | 9 |\n| 乙 | 2 |\n\n${after}\n`;
    const host = await createHost(newText);
    const diff = computeLineDiff(oldText, newText);

    await applyPreviewDiff(host, { oldText, newText, diff, mode: "collapse" }, () => false);

    const table = host.querySelector("table");
    expect(table).not.toBeNull();
    expect(table?.hidden).toBe(false);
    expect(table?.closest(".diff-hidden")).toBeNull();
  });

  it("仅改动片段包含表格内的改动", async () => {
    const oldText = "前文\n\n| 名称 | 数值 |\n| --- | --- |\n| 甲 | 1 |\n\n后文\n";
    const newText = "前文\n\n| 名称 | 数值 |\n| --- | --- |\n| 甲 | 9 |\n\n后文\n";
    const host = await createHost(newText);
    const diff = computeLineDiff(oldText, newText);

    await applyPreviewDiff(host, { oldText, newText, diff, mode: "fragments" }, () => false);

    const card = host.querySelector(".diff-fragment-card");
    expect(card).not.toBeNull();
    expect(card?.querySelector("table")).not.toBeNull();
    expect(card?.textContent).toContain("9");
  });
});
