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

test("M27：工具栏图标可在中英文之间即时切换", async () => {
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
    await page.getByRole("button", { name: "打开", exact: true }).click();
    await expect(page.locator(".tab-name")).toHaveText("locale.md");

    // 默认中文：模式按钮与语言按钮均为中文。
    await expect(page.getByRole("button", { name: "源码", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "切换到英文界面", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "切换到英文界面", exact: true }).click();
    await expect(page.getByRole("button", { name: "Source", exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Switch to Chinese", exact: true })).toBeVisible();

    // 设置对话框同样跟随语言。
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();

    // 切回中文。
    await page.getByRole("button", { name: "Switch to Chinese", exact: true }).click();
    await expect(page.getByRole("button", { name: "源码", exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("button", { name: "切换到英文界面", exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});
