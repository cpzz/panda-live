import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

/** M44：工作区树行级「更多操作」菜单的复制路径/相对路径与焦点关闭（含 HTML iframe 预览）。 */
test("M44：工作区复制路径与菜单焦点关闭", async () => {
  test.setTimeout(120_000);
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m44-ws-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m44-ud-"));
  await fs.mkdir(path.join(workspaceDir, "src"));
  await fs.writeFile(path.join(workspaceDir, "src", "alpha.md"), "# Alpha\n", "utf8");
  await fs.writeFile(
    path.join(workspaceDir, "demo.html"),
    "<!doctype html><html><body><h1 id='hit'>Click target</h1></body></html>",
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
    }, workspaceDir);
    await page.getByRole("tab", { name: "工作区", exact: true }).click();
    await page.locator(".files-toolbar").getByRole("button", { name: "打开文件夹", exact: true }).click();
    await expect(page.locator(".workspace-root")).toHaveCount(1);

    // clipboard.writeText 要求文档持有焦点；先把窗口带到前台，避免偶发拒绝。
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().forEach((win) => win.focus());
    });
    const readClipboard = (): Promise<string> =>
      app.evaluate(({ clipboard }) => clipboard.readText());

    // 根目录行菜单：含复制路径/相对路径，位于「从工作区移除」上方。
    const rootMenuBtn = page.locator(".workspace-root-header").getByRole("button", {
      name: "更多操作",
    });
    await rootMenuBtn.click();
    const rootMenu = page.locator(".workspace-root-header .tree-menu");
    await expect(rootMenu.getByRole("menuitem", { name: "复制路径" })).toBeVisible();
    await expect(rootMenu.getByRole("menuitem", { name: "复制相对路径" })).toBeVisible();
    const rootItems = await rootMenu.locator(".tree-menu-item").allTextContents();
    expect(rootItems.indexOf("复制相对路径")).toBe(rootItems.indexOf("从工作区移除") - 1);
    await rootMenu.getByRole("menuitem", { name: "复制相对路径" }).click();
    await expect.poll(readClipboard).toBe(".");
    await expect(page.locator(".toast")).toContainText("已复制相对路径");

    // 展开 src 目录，验证子目录行菜单。
    const srcRow = page.locator(".tree-row.dir").filter({ hasText: "src" });
    await srcRow.locator(".tree-name").click();
    const srcMenuBtn = srcRow.locator(".tree-menu-wrap").getByRole("button", { name: "更多操作" });
    await srcMenuBtn.click();
    const srcMenu = srcRow.locator(".tree-menu");
    await expect(srcMenu.getByRole("menuitem", { name: "复制相对路径" })).toBeVisible();
    await srcMenu.getByRole("menuitem", { name: "复制相对路径" }).click();
    await expect.poll(readClipboard).toBe("src");

    // 文件行菜单：绝对路径与相对路径均正确。
    const fileRow = page.locator(".tree-row.file").filter({ hasText: "alpha.md" });
    const fileMenuBtn = fileRow.locator(".tree-menu-wrap").getByRole("button", { name: "更多操作" });
    await fileMenuBtn.click();
    const fileMenu = fileRow.locator(".tree-menu");
    await fileMenu.getByRole("menuitem", { name: "复制路径" }).click();
    // 复制路径原样使用树节点的 path；从 title 读取真实值，避免 realpath/大小写差异。
    const absPath = await fileRow.locator(".tree-name").getAttribute("title");
    expect(absPath).toBeTruthy();
    await expect.poll(readClipboard).toBe(absPath);

    // 菜单打开后焦点转到显示页面（编辑器）应自动关闭。
    await fileRow.locator(".tree-name").click(); // 从树打开 alpha.md
    await expect(page.locator(".tab-item.active .tab-name")).toHaveText("alpha.md");
    await page.getByRole("button", { name: "源码", exact: true }).click();
    await fileMenuBtn.click();
    await expect(fileRow.locator(".tree-menu")).toBeVisible();
    await page.locator(".cm-content").click();
    await expect(fileRow.locator(".tree-menu")).toHaveCount(0);

    // HTML 预览：iframe 内点击不冒泡到父文档，须经注入脚本 + postMessage 转发关闭菜单。
    const htmlRow = page.locator(".tree-row.file").filter({ hasText: "demo.html" });
    await htmlRow.locator(".tree-name").click();
    await expect(page.locator(".tab-item.active .tab-name")).toHaveText("demo.html");
    await page.locator(".mode-bar .mode-bar-modes button").nth(2).click(); // 预览
    await expect(page.locator(".html-preview-frame")).toBeVisible();
    const htmlMenuBtn = htmlRow.locator(".tree-menu-wrap").getByRole("button", { name: "更多操作" });
    await htmlMenuBtn.click();
    await expect(htmlRow.locator(".tree-menu")).toBeVisible();
    await page.frameLocator(".html-preview-frame").locator("#hit").click();
    await expect(htmlRow.locator(".tree-menu")).toHaveCount(0);
  } finally {
    await app.close();
    await fs.rm(workspaceDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
