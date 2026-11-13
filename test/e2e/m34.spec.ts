import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

test("M34：预览代码块提供复制按钮", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m34-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m34-ud-"));
  const filePath = path.join(tempDir, "copy.md");
  await fs.writeFile(
    filePath,
    ["# 复制", "", "```js", "const answer = 42;", "const name = \"panda\";", "```"].join("\n"),
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
    await page.getByRole("button", { name: "打开", exact: true }).click();
    await expect(page.locator(".tab-name")).toHaveText("copy.md");
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await expect(page.locator(".markdown-body pre.shiki")).toBeVisible({ timeout: 20_000 });

    // 复制按钮挂在代码块右上角，点击后写入剪贴板。
    const button = page.locator(".markdown-body .preview-copy");
    await expect(button).toHaveCount(1);
    // clipboard.writeText 要求文档持有焦点；先把窗口带到前台，避免偶发拒绝。
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().forEach((win) => win.focus());
    });
    await button.click();
    await expect(button).toHaveClass(/copied/);
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 10_000 })
      .toContain("const answer = 42;");
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 10_000 })
      .toContain('const name = "panda";');
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
