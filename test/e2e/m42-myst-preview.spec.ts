import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

test("M42：MyST 文档预览渲染 tab-set / grid 并可切换页签", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m42-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m42-ud-"));
  const filePath = path.join(tempDir, "demo.myst");
  await fs.writeFile(
    filePath,
    [
      "# MyST 演示",
      "",
      "````{tab-set}",
      "",
      "```{tab-item} 首页",
      "第一页内容",
      "```",
      "",
      "```{tab-item} 配置",
      "第二页内容",
      "```",
      "````",
      "",
      "````{grid} 2",
      ":outline:",
      "",
      "```{grid-item} 甲",
      "左列内容",
      "```",
      "",
      "```{grid-item} 乙",
      "右列内容",
      "```",
      "````",
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
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, filePath);
    await page.locator(".app").waitFor();
    await page.keyboard.press("Control+O");
    // .myst 识别为 Markdown 格式打开。
    await expect(page.locator(".tab-name")).toHaveText("demo.myst");
    await page.getByRole("button", { name: "预览", exact: true }).click();

    // tab-set 渲染为按钮 + 面板，首项可见、次项隐藏。
    const preview = page.locator(".preview-pane .markdown-body");
    const buttons = preview.locator(".myst-tab-button");
    await expect(buttons).toHaveCount(2, { timeout: 20_000 });
    await expect(buttons.first()).toHaveText("首页");
    // 首次打开时首个页签即为焦点（高亮），与可见内容一致。
    await expect(buttons.first()).toHaveClass(/active/);
    await expect(buttons.nth(1)).not.toHaveClass(/active/);
    const items = preview.locator(".myst-tab-item");
    await expect(items.first()).toBeVisible();
    await expect(items.nth(1)).not.toBeVisible();

    // 点击第二个页签按钮切换激活项。
    await buttons.nth(1).click();
    await expect(items.nth(1)).toBeVisible();
    await expect(items.first()).not.toBeVisible();
    await expect(items.nth(1)).toContainText("第二页内容");

    // grid 渲染列数与 outline。
    const grid = preview.locator(".myst-grid");
    await expect(grid).toHaveAttribute("data-columns", "2");
    await expect(grid).toHaveClass(/myst-grid-outline/);
    await expect(grid.locator(".myst-grid-item")).toHaveCount(2);
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

test("M42：MyST 冒号围栏（官方语法）多页签预览", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m42c-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m42c-ud-"));
  const filePath = path.join(tempDir, "colon.myst");
  await fs.writeFile(
    filePath,
    [
      "# 冒号围栏演示",
      "",
      "::::{tab-set}",
      "",
      ":::{tab-item} TSK-01",
      "任务一内容",
      ":::",
      "",
      ":::{tab-item} TSK-02",
      "任务二内容",
      ":::",
      "",
      ":::{tab-item} TSK-03",
      "```js",
      "console.log(\"冒号块内代码\");",
      "```",
      ":::",
      "::::",
      "",
      ":::::{grid} 2",
      ":outline:",
      "",
      "::::{grid-item} 甲",
      "左列内容",
      "::::",
      "",
      "::::{grid-item} 乙",
      "右列内容",
      "::::",
      ":::::",
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
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, filePath);
    await page.locator(".app").waitFor();
    await page.keyboard.press("Control+O");
    await expect(page.locator(".tab-name")).toHaveText("colon.myst");
    await page.getByRole("button", { name: "预览", exact: true }).click();

    const preview = page.locator(".preview-pane .markdown-body");
    const buttons = preview.locator(".myst-tab-button");
    await expect(buttons).toHaveCount(3, { timeout: 20_000 });
    await expect(buttons.nth(0)).toHaveText("TSK-01");
    await expect(buttons.nth(2)).toHaveText("TSK-03");

    // 冒号块内的反引号代码块正常渲染。
    const items = preview.locator(".myst-tab-item");
    await expect(preview.locator(".myst-tab-item code.language-js")).toHaveCount(1, {
      timeout: 20_000,
    });

    // 切换到第三个页签。
    await buttons.nth(2).click();
    await expect(items.nth(2)).toBeVisible();
    await expect(items.first()).not.toBeVisible();
    await expect(items.nth(2)).toContainText("冒号块内代码");

    // 冒号 grid 渲染。
    const grid = preview.locator(".myst-grid");
    await expect(grid).toHaveAttribute("data-columns", "2");
    await expect(grid).toHaveClass(/myst-grid-outline/);
    await expect(grid.locator(".myst-grid-item")).toHaveCount(2);
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
