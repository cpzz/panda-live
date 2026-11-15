import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

test("M18：预览代码高亮背景随主题切换", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m18-theme-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m18-theme-ud-"));
  const filePath = path.join(tempDir, "theme.md");
  await fs.writeFile(filePath, "# 主题\n\n```js\nconst value = 1;\n```\n", "utf8");

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  const page = await app.firstWindow();
  const backgroundSum = async (): Promise<number | null> =>
    page.evaluate(() => {
      const pre = document.querySelector(".pane:not([hidden]) .markdown-body pre.shiki");
      if (!pre) return null;
      const parts = getComputedStyle(pre).backgroundColor.match(/\d+/g);
      return parts ? parts.slice(0, 3).reduce((sum, value) => sum + Number(value), 0) : null;
    });

  try {
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, filePath);
    await page.getByRole("button", { name: "打开", exact: true }).click();
    // Markdown 默认以所见即所得打开；本用例验证渲染预览。
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await expect(page.locator(".pane:not([hidden]) .markdown-body pre.shiki")).toBeVisible({
      timeout: 30_000,
    });

    await page.getByRole("button", { name: "设置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "设置" });
    await dialog.getByRole("combobox").first().selectOption("dark");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect.poll(backgroundSum, { timeout: 20_000 }).toBeLessThan(260);

    // 保存不关闭窗口：同一对话框内切回浅色。
    await dialog.getByRole("combobox").first().selectOption("light");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect.poll(backgroundSum, { timeout: 20_000 }).toBeGreaterThan(700);
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

test("M18：预览中代码高亮且图表围栏渲染为 SVG", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m18-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m18-ud-"));
  const filePath = path.join(tempDir, "demo.md");
  await fs.writeFile(
    filePath,
    [
      "# 代码与图表",
      "",
      "```js",
      "const answer = 42;",
      "```",
      "",
      "```plantuml",
      "Alice -> Bob: hello",
      "```",
      "",
    ].join("\n"),
    "utf8",
  );

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  const page = await app.firstWindow();
  try {
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, filePath);
    await page.getByRole("button", { name: "打开", exact: true }).click();
    await expect(page.locator(".tab-name")).toHaveText("demo.md");
    await page.getByRole("button", { name: "预览", exact: true }).click();

    const preview = page.locator(".pane:not([hidden]) .markdown-body");
    await expect(preview.locator("pre.shiki")).toBeVisible({ timeout: 30_000 });
    await expect(preview.locator("pre.shiki")).toContainText("const answer");
    await expect(preview.locator("pre.shiki span").first()).toBeVisible();

    // 图表 SVG 是 `.preview-diagram` 的直接子节点；「放大查看」按钮内的图标 svg 不计入。
    await expect(preview.locator(".preview-diagram > svg")).toBeVisible({ timeout: 30_000 });
    await expect(preview.locator(".preview-diagram[data-kind='plantuml']")).toHaveCount(1);
    await expect(preview.locator("pre code.language-plantuml")).toHaveCount(0);
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
