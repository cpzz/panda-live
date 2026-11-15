import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

async function prepareUserData(autoSave: boolean): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m4-ud-"));
  await fs.writeFile(
    path.join(dir, "settings.json"),
    `${JSON.stringify({ schemaVersion: 1, editor: { autoSave } }, null, 2)}\n`,
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

async function openSample(app: ElectronApplication, page: import("@playwright/test").Page, filePath: string) {
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, filePath);
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await expect(page.locator(".tab-name")).toHaveText(path.basename(filePath));
}

test("M4：外部修改未保存文档 → 冲突横幅 → 重新加载", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m4-file-"));
  const userDataDir = await prepareUserData(false);
  const filePath = path.join(tempDir, "conflict.md");
  await fs.writeFile(filePath, "# 初始\n\n正文\n", "utf8");

  const app = await launch(userDataDir);
  try {
    const page = await app.firstWindow();
    await openSample(app, page, filePath);

    // Markdown 默认所见即所得；本场景直接验证源码编辑与冲突恢复。
    await page.getByRole("button", { name: "源码", exact: true }).click();
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("# 本地修改\n\n本地正文");
    await expect(page.locator(".tab-dot")).toHaveCount(1);

    // 外部写入不同内容，主进程监听应在 300 ms 内推送变化。
    await fs.writeFile(filePath, "# 外部修改\n\n外部正文\n", "utf8");
    const banner = page.locator(".banner-warning");
    await expect(banner).toContainText("外部修改", { timeout: 15_000 });

    await banner.getByRole("button", { name: "重新加载" }).click();
    await expect(page.locator(".cm-content")).toContainText("外部正文", { timeout: 10_000 });
    await expect(page.locator(".tab-dot")).toHaveCount(0);
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

test("M4：工作区树、查找面板与设置持久化", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m4-ws-"));
  const userDataDir = await prepareUserData(true);
  await fs.writeFile(path.join(tempDir, "alpha.md"), "# Alpha\n\n正文\n", "utf8");
  await fs.writeFile(path.join(tempDir, "beta.md"), "# Beta\n", "utf8");

  const app = await launch(userDataDir);
  try {
    const page = await app.firstWindow();

    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, tempDir);

    await page
      .locator(".sidebar-header")
      .getByRole("button", { name: "打开文件夹" })
      .click();
    const tree = page.locator(".tree");
    await expect(tree.locator(".tree-name", { hasText: "alpha.md" })).toBeVisible();
    await expect(tree.locator(".tree-name", { hasText: "beta.md" })).toBeVisible();

    await tree.locator(".tree-name", { hasText: "alpha.md" }).click();
    await expect(page.locator(".tab-name")).toHaveText("alpha.md");

    // WYSIWYG 查找面板（工具栏不提供查找按钮，使用 Ctrl+F）
    await page.getByRole("button", { name: "所见即所得", exact: true }).click();
    await page.keyboard.press("Control+f");
    const panel = page.locator(".search-panel");
    await expect(panel).toBeVisible();
    await panel.getByLabel("查找内容").fill("Alpha");
    await expect(panel.locator(".search-count")).toContainText("1 /");

    // 设置：切换深色主题并保存（保存不关闭窗口）
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settingsModal = page.locator(".modal[aria-label='设置']");
    await expect(settingsModal).toBeVisible();
    await settingsModal.locator(".settings-row select").first().selectOption("dark");
    await settingsModal.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark", { timeout: 10_000 });
    await expect(settingsModal).toBeVisible();

    // 设置：数学分组（关闭单美元内联公式）持久化到 settings.json；窗口保持打开
    await settingsModal.getByRole("button", { name: "数学" }).click();
    const mathGroup = settingsModal.locator(".settings-row", { hasText: "单美元" });
    await expect(mathGroup).toBeVisible();
    await mathGroup.getByRole("checkbox").uncheck();
    await settingsModal.getByRole("button", { name: "保存", exact: true }).click();
    await expect
      .poll(async () => {
        const raw = await fs
          .readFile(path.join(userDataDir, "settings.json"), "utf8")
          .catch(() => "");
        const parsed = JSON.parse(raw || "{}") as { math?: { singleDollar?: boolean } };
        return parsed.math?.singleDollar;
      }, { timeout: 10_000 })
      .toBe(false);
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

test("M4：强制退出后从草稿恢复", async () => {
  test.setTimeout(180_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m4-draft-"));
  const userDataDir = await prepareUserData(false);
  const filePath = path.join(tempDir, "draft.md");
  await fs.writeFile(filePath, "# 磁盘版本\n", "utf8");

  let app = await launch(userDataDir);
  try {
    const page = await app.firstWindow();
    await openSample(app, page, filePath);
    await page.getByRole("button", { name: "源码", exact: true }).click();
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("# 未保存草稿\n\n崩溃前的输入");
    await expect(page.locator(".tab-dot")).toHaveCount(1);

    // 草稿写入为 30 s 防抖，轮询等待文件出现。
    const backups = path.join(userDataDir, "backups");
    await expect
      .poll(async () => (await fs.readdir(backups).catch(() => [] as string[])).length, {
        timeout: 90_000,
        intervals: [2_000],
      })
      .toBeGreaterThan(0);

    await app.close();
    app = await launch(userDataDir);
    const page2 = await app.firstWindow();

    const dialog = page2.locator(".modal[aria-label='恢复未保存的草稿']");
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole("button", { name: "恢复", exact: true }).click();
    await expect(page2.locator(".cm-content")).toContainText("崩溃前的输入", { timeout: 10_000 });
    const raw = await fs.readFile(filePath, "utf8");
    expect(raw).toContain("磁盘版本");
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

test("M4：查找与替换模式、快捷键与按钮提示", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m4-find-"));
  const userDataDir = await prepareUserData(false);
  const filePath = path.join(tempDir, "find.md");
  await fs.writeFile(filePath, "# 查找\n\nAlpha Beta Alpha\n", "utf8");

  const app = await launch(userDataDir);
  try {
    const page = await app.firstWindow();
    await openSample(app, page, filePath);
    await expect(page.locator(".prose-editor")).toBeVisible();

    // Ctrl+F 只打开查找：没有替换行，也没有关闭按钮。
    await page.keyboard.press("Control+f");
    const panel = page.locator(".search-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByLabel("查找内容")).toBeVisible();
    await expect(panel.getByLabel("替换内容")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "关闭查找" })).toHaveCount(0);
    const expand = panel.getByRole("button", { name: "展开替换" });
    await expect(expand).toHaveAttribute("title", "展开替换（Ctrl+H）");

    // 面板内展开替换并输入文本；Ctrl+F 收起后，Ctrl+H 再展开仍保留替换文本。
    await expand.click();
    await expect(panel.getByLabel("替换内容")).toBeVisible();
    await panel.getByLabel("替换内容").fill("Omega");
    await page.keyboard.press("Control+f");
    await expect(panel.getByLabel("替换内容")).toHaveCount(0);
    await page.keyboard.press("Control+h");
    await expect(panel.getByLabel("替换内容")).toHaveValue("Omega");

    // 替换仍然生效：查找 Alpha 并替换当前匹配。
    await panel.getByLabel("查找内容").fill("Alpha");
    await expect(panel.locator(".search-count")).toContainText("1 /");
    await panel.getByRole("button", { name: "替换", exact: true }).click();
    await expect(page.locator(".prose-editor")).toContainText("Omega");

    // 图标按钮提示包含快捷键；Esc 关闭面板。
    await expect(panel.getByRole("button", { name: "上一个" })).toHaveAttribute(
      "title",
      "上一个（Shift+Enter）",
    );
    await expect(panel.getByRole("button", { name: "下一个" })).toHaveAttribute(
      "title",
      "下一个（Enter）",
    );
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);

    // 源码模式使用同一套查找/替换语义。
    await page.getByRole("button", { name: "源码", exact: true }).click();
    await page.keyboard.press("Control+f");
    const sourcePanel = page.locator(".cm-panel.source-search-panel");
    await expect(sourcePanel).toBeVisible();
    // 与 VS Code 一致：悬浮在编辑区右上角，贴近顶部且不占满宽度。
    const sourcePanelBox = await sourcePanel.boundingBox();
    const editorBox = await page.locator(".cm-editor").boundingBox();
    expect(sourcePanelBox).not.toBeNull();
    expect(editorBox).not.toBeNull();
    expect(sourcePanelBox!.width).toBeLessThan(editorBox!.width * 0.9);
    expect(sourcePanelBox!.y - editorBox!.y).toBeLessThan(20);
    const sourceReplace = sourcePanel.locator('input[name="replace"]');
    await expect(sourceReplace).toBeHidden();
    await expect(sourcePanel.getByRole("button", { name: "关闭查找" })).toHaveCount(0);
    await expect(sourcePanel.locator('button[name="prev"]')).toHaveAttribute(
      "title",
      "上一个（Shift+Enter）",
    );
    await sourcePanel.locator('button[name="toggleReplace"]').click();
    await expect(sourceReplace).toBeVisible();
    await sourceReplace.fill("Omega");
    await page.keyboard.press("Control+f");
    await expect(sourceReplace).toBeHidden();
    await page.keyboard.press("Control+h");
    await expect(sourceReplace).toBeVisible();
    await expect(sourceReplace).toHaveValue("Omega");
    // 源码面板的替换按钮同样生效。
    await sourcePanel.locator('input[name="search"]').fill("Alpha");
    await sourcePanel.locator('button[name="replace"]').click();
    await expect(page.locator(".cm-content")).toContainText("Omega");
    await page.keyboard.press("Escape");
    await expect(sourcePanel).toHaveCount(0);
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
