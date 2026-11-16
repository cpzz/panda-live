import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

test("M33：源码编辑器支持语法折叠、标题分节与章节折叠", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m33-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m33-ud-"));
  const mdPath = path.join(tempDir, "fold.md");
  await fs.writeFile(
    mdPath,
    [
      "# 折叠",
      "",
      "正文段落",
      "",
      "```js",
      "const a = 1;",
      "const b = 2;",
      "const c = 3;",
      "```",
      "",
      "## 子节",
      "",
      "更多正文",
      "",
      "## 图表",
      "",
      "```plantuml",
      "@startuml",
      "用户 -> 编辑器: 输入",
      "编辑器 --> 用户: 预览",
      "@enduml",
      "```",
      "",
    ].join("\n"),
    "utf8",
  );
  const jsonPath = path.join(tempDir, "sample.json");
  await fs.writeFile(jsonPath, ["{", '  "alpha": {', '    "beta": 1', "  }", "}"].join("\n"), "utf8");
  const texPath = path.join(tempDir, "sections.tex");
  await fs.writeFile(
    texPath,
    ["\\section{第一节}", "内容一", "\\subsection{小节}", "内容二", "\\section{第二节}", "内容三", ""].join(
      "\n",
    ),
    "utf8",
  );
  const pumlPath = path.join(tempDir, "blocks.puml");
  await fs.writeFile(
    pumlPath,
    [
      "@startuml",
      "用户 -> 编辑器: 打开",
      "编辑器 --> 用户: 渲染",
      "@enduml",
      "",
      "@startuml",
      "A -> B: 消息",
      "B -> C: 转发",
      "@enduml",
      "",
    ].join("\n"),
    "utf8",
  );

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  try {
    const page = await app.firstWindow();

    // Markdown：标题分节与围栏代码块均可折叠。
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, mdPath);
    await page.locator(".app").waitFor();
    await page.keyboard.press("Control+O");
    await expect(page.locator(".tab-name")).toHaveText("fold.md");
    // Markdown 默认所见即所得；折叠能力在源码模式验证。
    await page.getByRole("button", { name: "源码", exact: true }).click();
    // gutter 含一个 visibility:hidden 的宽度占位 span，用 :visible 过滤真实标记。
    const gutter = page.locator(".pane:not([hidden]) .cm-foldGutter span:visible");
    await expect(gutter.first()).toBeVisible({ timeout: 15_000 });
    await expect(gutter).toHaveCount(6); // # 折叠、```js 围栏、## 子节、## 图表、```plantuml 围栏、@startuml
    // 第一个标记：标题分节折叠，再次点击展开。
    await gutter.first().click();
    await expect(page.locator(".pane:not([hidden]) .cm-foldPlaceholder")).toBeVisible();
    await gutter.first().click();
    await expect(page.locator(".pane:not([hidden]) .cm-foldPlaceholder")).toHaveCount(0);
    // 第二个标记：围栏代码块折叠（其后依次为 ## 子节、```plantuml 围栏、@startuml）。
    await gutter.nth(1).click();
    await expect(page.locator(".pane:not([hidden]) .cm-foldPlaceholder")).toBeVisible();
    await expect(page.locator(".pane:not([hidden]) .cm-foldPlaceholder")).toHaveCount(1);
    // Markdown 内 PlantUML：@startuml…@enduml 块折叠（与围栏折叠嵌套并存）。
    await gutter.last().click();
    await expect(page.locator(".pane:not([hidden]) .cm-foldPlaceholder")).toHaveCount(2);
    await gutter.last().click();
    await expect(page.locator(".pane:not([hidden]) .cm-foldPlaceholder")).toHaveCount(1);

    // JSON：语法树原生折叠。
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, jsonPath);
    await page.locator(".app").waitFor();
    await page.keyboard.press("Control+O");
    await expect(page.locator(".tab-item.active .tab-name")).toHaveText("sample.json");
    const jsonGutter = page.locator(".pane:not([hidden]) .cm-foldGutter span:visible");
    await expect(jsonGutter.first()).toBeVisible({ timeout: 15_000 });
    await jsonGutter.first().click();
    await expect(page.locator(".pane:not([hidden]) .cm-foldPlaceholder")).toBeVisible();

    // LaTeX：章节命令折叠到下一个同级命令之前。
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, texPath);
    await page.locator(".app").waitFor();
    await page.keyboard.press("Control+O");
    await expect(page.locator(".tab-item.active .tab-name")).toHaveText("sections.tex");
    const texGutter = page.locator(".pane:not([hidden]) .cm-foldGutter span:visible");
    await expect(texGutter).toHaveCount(3, { timeout: 15_000 });
    await texGutter.first().click();
    await expect(page.locator(".pane:not([hidden]) .cm-foldPlaceholder")).toBeVisible();

    // PlantUML：@startuml…@enduml 块折叠（保留首尾指令行）。
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, pumlPath);
    await page.locator(".app").waitFor();
    await page.keyboard.press("Control+O");
    await expect(page.locator(".tab-item.active .tab-name")).toHaveText("blocks.puml");
    const pumlGutter = page.locator(".pane:not([hidden]) .cm-foldGutter span:visible");
    await expect(pumlGutter).toHaveCount(2, { timeout: 15_000 });
    await pumlGutter.first().click();
    await expect(page.locator(".pane:not([hidden]) .cm-foldPlaceholder")).toBeVisible();
    await pumlGutter.first().click();
    await expect(page.locator(".pane:not([hidden]) .cm-foldPlaceholder")).toHaveCount(0);
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
