import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

async function prepareUserData(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m29-ud-"));
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

test("M29：侧栏键盘导航与空工作区", async () => {
  test.setTimeout(120_000);
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m29-ws-"));
  const userDataDir = await prepareUserData();
  await fs.writeFile(path.join(workspaceDir, "alpha.md"), "# Alpha\n\n## 小节\n\n正文\n", "utf8");
  await fs.writeFile(path.join(workspaceDir, "beta.md"), "# Beta\n\n正文\n", "utf8");

  const app = await launch(userDataDir);
  try {
    const page = await app.firstWindow();

    // 未打开工作区：文件页只保留提示，不再显示内部「打开文件夹」按钮。
    await page.getByRole("tab", { name: "文件", exact: true }).click();
    await expect(page.locator(".sidebar-empty")).toContainText("未打开文件夹");
    await expect(page.locator(".sidebar-empty").getByRole("button")).toHaveCount(0);
    await expect(
      page.locator(".sidebar-header").getByRole("button", { name: "打开文件夹" }),
    ).toBeVisible();

    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, workspaceDir);
    const openButton = page.locator(".sidebar-header").getByRole("button", { name: "打开文件夹" });
    await openButton.click();
    const tree = page.locator(".tree");
    await expect(tree.locator(".tree-name", { hasText: "alpha.md" })).toBeVisible();

    // 焦点在侧栏标题栏按钮时，方向键直接进入文件列表并切换文档。
    await openButton.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".tab-item.active .tab-name")).toHaveText("alpha.md");
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".tab-item.active .tab-name")).toHaveText("beta.md");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.textContent ?? ""))
      .toBe("beta.md");
    await page.keyboard.press("ArrowUp");
    await expect(page.locator(".tab-item.active .tab-name")).toHaveText("alpha.md");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.textContent ?? ""))
      .toBe("alpha.md");

    // 焦点在「大纲」标签上时，方向键进入大纲并直接跳到第一条标题。
    // Markdown 默认所见即所得；大纲跳转与状态栏行列信息在源码模式验证。
    await page.getByRole("button", { name: "源码", exact: true }).click();
    await page.getByRole("tab", { name: "大纲", exact: true }).click();
    const outlineItems = page.locator(".outline-item");
    await expect(outlineItems).toHaveCount(2, { timeout: 15_000 });
    await page.keyboard.press("ArrowDown");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.textContent ?? ""))
      .toBe("Alpha");
    await expect(page.locator(".statusbar")).toContainText("行 1");
    await page.keyboard.press("ArrowDown");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.textContent ?? ""))
      .toBe("小节");
    await expect(page.locator(".statusbar")).toContainText("行 3");
    await page.keyboard.press("ArrowUp");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.textContent ?? ""))
      .toBe("Alpha");
    await expect(page.locator(".statusbar")).toContainText("行 1");
  } finally {
    await app.close();
    await fs.rm(workspaceDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
