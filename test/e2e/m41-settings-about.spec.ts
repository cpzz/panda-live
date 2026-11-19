import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

/** M41：设置新增「关于」页——展示应用版本、运行时信息与用户数据目录。 */
test("M41：设置关于页展示版本与运行时信息", async () => {
  test.setTimeout(60_000);
  const { version } = JSON.parse(await fs.readFile(path.join(CWD, "package.json"), "utf8")) as {
    version: string;
  };
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m41-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m41-ud-"));

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  try {
    const page = await app.firstWindow();
    await page.locator(".app").waitFor();

    await page.getByRole("button", { name: "设置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "设置" });

    // 「关于」是最后一个分类；点击后右侧展示只读信息。
    await dialog.locator(".settings-nav-item").filter({ hasText: "关于" }).click();
    const pane = dialog.locator(".settings-pane");
    // 「版本」用正则锚定行首，避免误匹配「Electron 版本」行。
    await expect(pane.locator(".settings-row", { hasText: /^版本\d/ })).toContainText(version);
    await expect(pane.locator(".settings-row", { hasText: "Electron 版本" })).toContainText(
      /\d+\.\d+/,
    );
    await expect(pane.locator(".settings-about-path")).toContainText(userDataDir.slice(0, 20));

    // 关于页没有可修改项：保存按钮保持禁用。
    await expect(dialog.locator(".modal-footer .button.primary")).toBeDisabled();
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
