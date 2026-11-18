import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

async function prepareUserData(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m27-ud-"));
  await fs.writeFile(
    path.join(dir, "settings.json"),
    `${JSON.stringify({ schemaVersion: 1, editor: { autoSave: false } }, null, 2)}\n`,
    "utf8",
  );
  return dir;
}

async function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
}

test("M27：界面语言可在设置中于中英文之间切换", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m27-file-"));
  const userDataDir = await prepareUserData();
  const filePath = path.join(tempDir, "locale.md");
  await fs.writeFile(filePath, "# 语言切换\n\n正文\n", "utf8");

  const app = await launch(userDataDir);
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, filePath);
    await page.locator(".app").waitFor();
    await page.keyboard.press("Control+O");
    await expect(page.locator(".tab-name")).toHaveText("locale.md");

    // 默认中文：工具栏为中文按钮。
    await expect(page.getByRole("button", { name: "源码", exact: true })).toBeVisible();

    // 通过设置对话框切换到英文。
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "设置" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "外观", exact: true })).toBeVisible();
    await dialog
      .locator(".settings-row", { hasText: "界面语言" })
      .locator("select")
      .selectOption("en");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();

    await expect(page.getByRole("button", { name: "Source", exact: true })).toBeVisible({
      timeout: 20_000,
    });
    // 保存按钮位于顶层工具栏，与打开着的设置对话框内 Save 同名，限定工具栏避免 strict 冲突。
    await expect(page.locator(".toolbar [aria-label='Save File']")).toBeVisible();

    // 保存不关闭窗口：同一对话框切换语言后标题变为 Settings；切回中文。
    const dialogEn = page.getByRole("dialog", { name: "Settings" });
    await expect(dialogEn).toBeVisible();
    await expect(dialogEn.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible();
    await dialogEn
      .locator(".settings-row", { hasText: "Interface language" })
      .locator("select")
      .selectOption("zh");
    await dialogEn.getByRole("button", { name: "Save", exact: true }).click();

    await expect(page.getByRole("button", { name: "源码", exact: true })).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
