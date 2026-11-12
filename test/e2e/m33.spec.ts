import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

test("M33：源码编辑器支持语法折叠与围栏代码块折叠", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m33-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m33-ud-"));
  const mdPath = path.join(tempDir, "fold.md");
  await fs.writeFile(
    mdPath,
    ["# 折叠", "", "```js", "const a = 1;", "const b = 2;", "const c = 3;", "```", "", "正文"].join(
      "\n",
    ),
    "utf8",
  );
  const jsonPath = path.join(tempDir, "sample.json");
  await fs.writeFile(jsonPath, ["{", '  "alpha": {', '    "beta": 1', "  }", "}"].join("\n"), "utf8");

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  try {
    const page = await app.firstWindow();

    // Markdown：围栏代码块可折叠。
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, mdPath);
    await page.getByRole("button", { name: "打开", exact: true }).click();
    await expect(page.locator(".tab-name")).toHaveText("fold.md");
    // gutter 含一个 visibility:hidden 的宽度占位 span，用 :visible 过滤真实标记。
    const gutter = page.locator(".pane:not([hidden]) .cm-foldGutter span:visible");
    await expect(gutter.first()).toBeVisible({ timeout: 15_000 });
    await gutter.first().click();
    await expect(page.locator(".pane:not([hidden]) .cm-foldPlaceholder")).toBeVisible();
    // 再次点击展开。
    await gutter.first().click();
    await expect(page.locator(".pane:not([hidden]) .cm-foldPlaceholder")).toHaveCount(0);

    // JSON：语法树原生折叠。
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, jsonPath);
    await page.getByRole("button", { name: "打开", exact: true }).click();
    await expect(page.locator(".tab-item.active .tab-name")).toHaveText("sample.json");
    await expect(page.locator(".pane:not([hidden]) .cm-foldGutter span:visible").first()).toBeVisible(
      { timeout: 15_000 },
    );
    await page.locator(".pane:not([hidden]) .cm-foldGutter span:visible").first().click();
    await expect(page.locator(".pane:not([hidden]) .cm-foldPlaceholder")).toBeVisible();
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
