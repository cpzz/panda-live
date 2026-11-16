import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

test("M30：性能浮层默认关闭并由状态栏开关；状态栏不再包含 Git 基线控件", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m30-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m30-ud-"));
  const filePath = path.join(tempDir, "perf.md");
  await fs.writeFile(filePath, "# 性能\n\n正文\n", "utf8");

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
    await expect(page.locator(".tab-name")).toHaveText("perf.md");

    // 默认不打开性能浮层。
    await expect(page.locator(".perf-overlay")).toHaveCount(0);
    const toggle = page.locator(".statusbar").getByRole("button", { name: "性能浮层" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(page.locator(".perf-overlay")).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await page.locator(".perf-overlay").getByRole("button", { name: "关闭" }).click();
    await expect(page.locator(".perf-overlay")).toHaveCount(0);

    // 状态栏只保留改动开关/计数，不再有 Git 基线与提交引用输入。
    await expect(page.locator(".diff-controls")).toBeVisible();
    await expect(page.locator(".diff-base")).toHaveCount(0);
    await expect(page.locator(".diff-ref-form")).toHaveCount(0);
    await expect(page.locator(".statusbar")).not.toContainText("指定提交…");
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
