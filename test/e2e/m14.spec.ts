import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

test("M14：标签溢出时提供全部标签下拉并可切换", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m14-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m14-ud-"));
  const files: string[] = [];
  for (let index = 1; index <= 12; index += 1) {
    const filePath = path.join(tempDir, `note-${String(index).padStart(2, "0")}.md`);
    await fs.writeFile(filePath, `# 笔记 ${index}\n`, "utf8");
    files.push(filePath);
  }

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  const page = await app.firstWindow();
  try {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(960, 760);
    });
    await app.evaluate(({ dialog }, targets) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: targets });
    }, files);
    await page.locator(".app").waitFor();
    await page.keyboard.press("Control+O");

    const tabs = page.locator(".tabstrip-items .tab");
    await expect(tabs).toHaveCount(12, { timeout: 30_000 });
    await expect(page.locator('.tab[aria-selected="true"] .tab-name')).toHaveText("note-12.md");

    const overflowButton = page.locator(".tab-overflow-button");
    await expect(overflowButton).toBeVisible();
    await overflowButton.click();

    const menuItems = page.locator(".tab-menu-item");
    await expect(menuItems).toHaveCount(12);
    await expect(page.locator(".tab-menu-item.active .tab-menu-name")).toHaveText("note-12.md");

    await page.locator(".tab-menu-item", { hasText: "note-01.md" }).click();
    await expect(page.locator(".tab-menu")).toHaveCount(0);
    await expect(page.locator('.tab[aria-selected="true"] .tab-name')).toHaveText("note-01.md");
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
