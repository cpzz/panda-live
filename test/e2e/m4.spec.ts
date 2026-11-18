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
  await page.locator(".app").waitFor();
  await page.keyboard.press("Control+O");
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
      .locator(".toolbar")
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

    // Ctrl+F 只打开查找：没有替换行，也不提供关闭按钮。
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
    await expect(sourcePanel.locator(".search-count")).toContainText("1 / 1");
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

/** M4：查找替换窗口的右对齐、输入框对齐、选中带入、模式切换与预览查找。 */
test("M4：查找替换窗口布局与预览查找", async () => {
  test.setTimeout(180_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m4-search-"));
  const userDataDir = await prepareUserData(false);
  const filePath = path.join(tempDir, "layout.md");
  await fs.writeFile(filePath, "# 查找\n\nAlpha Beta Alpha\n\nGamma Alpha\n", "utf8");

  const app = await launch(userDataDir);
  try {
    const page = await app.firstWindow();
    await openSample(app, page, filePath);
    await expect(page.locator(".prose-editor")).toBeVisible();
    const panel = page.locator(".search-panel");

    // 所见即所得面板右对齐，查找与替换输入框左对齐且等宽。
    await page.keyboard.press("Control+f");
    await expect(panel).toBeVisible();
    const panelBox = await panel.boundingBox();
    const wrapBox = await page.locator(".wysiwyg-wrap").boundingBox();
    expect(panelBox).not.toBeNull();
    expect(wrapBox).not.toBeNull();
    expect(
      Math.abs(wrapBox!.x + wrapBox!.width - (panelBox!.x + panelBox!.width) - 16),
    ).toBeLessThan(2);

    await page.keyboard.press("Control+h");
    const replaceInput = panel.getByLabel("替换内容");
    await expect(replaceInput).toBeVisible();
    const findBox = await panel.getByLabel("查找内容").boundingBox();
    const replaceBox = await replaceInput.boundingBox();
    expect(findBox).not.toBeNull();
    expect(replaceBox).not.toBeNull();
    expect(Math.abs(findBox!.x - replaceBox!.x)).toBeLessThan(1);
    expect(Math.abs(findBox!.width - replaceBox!.width)).toBeLessThan(1);

    // 面板打开时选中正文再按 Ctrl+F，查找框带入选中内容。
    const paragraph = page.locator(".prose-editor p").first();
    await paragraph.click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await page.keyboard.press("Control+f");
    await expect(panel.getByLabel("查找内容")).toHaveValue("Alpha Beta Alpha");

    // Esc 关闭后切换模式，不重新弹出。
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await page.getByRole("button", { name: "源码", exact: true }).click();
    await page.waitForTimeout(300);
    await expect(page.locator(".cm-panels-top .source-search-panel")).toHaveCount(0);
    await page.getByRole("button", { name: "所见即所得", exact: true }).click();
    await page.waitForTimeout(300);
    await expect(panel).toHaveCount(0);

    // 源码面板右对齐、图标按钮，查找/替换输入框对齐。
    await page.getByRole("button", { name: "源码", exact: true }).click();
    await page.keyboard.press("Control+f");
    const sourcePanel = page.locator(".cm-panels-top .source-search-panel");
    await expect(sourcePanel).toBeVisible();
    const sourcePanelBox = await sourcePanel.boundingBox();
    const editorBox = await page.locator(".cm-editor").boundingBox();
    expect(sourcePanelBox).not.toBeNull();
    expect(editorBox).not.toBeNull();
    expect(
      Math.abs(
        editorBox!.x + editorBox!.width - (sourcePanelBox!.x + sourcePanelBox!.width) - 16,
      ),
    ).toBeLessThan(3);
    await expect(sourcePanel.getByRole("button", { name: "关闭查找" })).toHaveCount(0);
    await expect(sourcePanel.locator('button[name="replace"] svg')).toHaveCount(1);

    // 源码面板打开时选中行再按 Ctrl+F，也带入查找框。
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("Shift+End");
    await page.keyboard.press("Control+f");
    await expect(sourcePanel.locator('input[name="search"]')).toHaveValue("# 查找");
    // 源码面板同样显示匹配总数与当前位置。
    await expect(sourcePanel.locator(".search-count")).toContainText("1 / 1");

    await sourcePanel.locator('button[name="toggleReplace"]').click();
    const sourceFindBox = await sourcePanel.locator('input[name="search"]').boundingBox();
    const sourceReplaceBox = await sourcePanel.locator('input[name="replace"]').boundingBox();
    expect(sourceFindBox).not.toBeNull();
    expect(sourceReplaceBox).not.toBeNull();
    expect(Math.abs(sourceFindBox!.x - sourceReplaceBox!.x)).toBeLessThan(1);
    expect(Math.abs(sourceFindBox!.width - sourceReplaceBox!.width)).toBeLessThan(1);
    await page.keyboard.press("Escape");
    await expect(sourcePanel).toHaveCount(0);

    // 预览模式支持查找：计数、导航与高亮。
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await expect(page.locator(".preview-pane .markdown-body")).toBeVisible();
    await page.keyboard.press("Control+f");
    const previewPanel = page.locator(".preview-search-panel");
    await expect(previewPanel).toBeVisible();
    await expect(previewPanel.getByLabel("替换内容")).toHaveCount(0);
    await previewPanel.getByLabel("查找内容").fill("Alpha");
    await expect(previewPanel.locator(".search-count")).toContainText("1 / 3");
    const highlighted = await page.evaluate(
      "typeof CSS !== 'undefined' && 'highlights' in CSS && CSS.highlights.has('panda-preview-search')",
    );
    expect(highlighted).toBe(true);
    await page.keyboard.press("Enter");
    await expect(previewPanel.locator(".search-count")).toContainText("2 / 3");
    await page.keyboard.press("Escape");
    await expect(previewPanel).toHaveCount(0);
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M4：查找面板跨模式保持、分栏预览查找与 Esc 全局关闭。 */
test("M4：查找面板跨模式保持与分栏预览查找", async () => {
  test.setTimeout(180_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m4-keep-"));
  const userDataDir = await prepareUserData(false);
  const filePath = path.join(tempDir, "keep.md");
  await fs.writeFile(filePath, "# 查找\n\nAlpha Beta Alpha\n\nGamma Alpha\n", "utf8");

  const app = await launch(userDataDir);
  try {
    const page = await app.firstWindow();
    await openSample(app, page, filePath);
    await expect(page.locator(".prose-editor")).toBeVisible();
    const panel = page.locator(".search-panel");

    await page.keyboard.press("Control+f");
    await panel.getByLabel("查找内容").fill("Alpha");
    await expect(panel.locator(".search-count")).toContainText("1 / 3");

    // 切换模式保持面板打开，并沿用查找词。
    await page.getByRole("button", { name: "源码", exact: true }).click();
    const sourcePanel = page.locator(".cm-panels-top .source-search-panel");
    await expect(sourcePanel).toBeVisible();
    await expect(sourcePanel.locator('input[name="search"]')).toHaveValue("Alpha");
    await expect(sourcePanel.locator(".search-count")).toContainText("1 / 3");
    // 全选按钮位于计数标签之前。
    const selectBox = await sourcePanel.locator('button[name="select"]').boundingBox();
    const countBox = await sourcePanel.locator(".search-count").boundingBox();
    expect(selectBox).not.toBeNull();
    expect(countBox).not.toBeNull();
    expect(selectBox!.x).toBeLessThan(countBox!.x);

    await page.getByRole("button", { name: "所见即所得", exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(panel.getByLabel("查找内容")).toHaveValue("Alpha");

    // 切到分栏：源码面板保持打开。
    await page.getByRole("button", { name: "分栏", exact: true }).click();
    await expect(sourcePanel).toBeVisible();
    await expect(sourcePanel.locator('input[name="search"]')).toHaveValue("Alpha");

    // 焦点在右侧预览时，Ctrl+F 打开预览查找。
    await page.locator(".preview-pane .markdown-body p").first().click();
    await page.keyboard.press("Control+f");
    const previewPanel = page.locator(".preview-search-panel");
    await expect(previewPanel).toBeVisible();
    await expect(previewPanel.getByLabel("查找内容")).toHaveValue("Alpha");
    await expect(previewPanel.locator(".search-count")).toContainText("1 / 3");

    // 焦点移到预览正文后，Esc 仍能关闭预览面板。
    await page.locator(".preview-pane .markdown-body p").first().click();
    await page.keyboard.press("Escape");
    await expect(previewPanel).toHaveCount(0);

    // Esc 关闭后切换模式不再自动打开。
    await page.getByRole("button", { name: "源码", exact: true }).click();
    await page.waitForTimeout(300);
    await expect(page.locator(".cm-panels-top .source-search-panel")).toHaveCount(0);
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M4：切换标签时查找面板保持打开并沿用查找词。 */
test("M4：切换标签保持查找面板", async () => {
  test.setTimeout(180_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m4-tab-"));
  const userDataDir = await prepareUserData(false);
  const fileA = path.join(tempDir, "a.md");
  const fileB = path.join(tempDir, "b.md");
  await fs.writeFile(fileA, "# A\n\nAlpha A\n", "utf8");
  await fs.writeFile(fileB, "# B\n\nAlpha B\n", "utf8");

  const app = await launch(userDataDir);
  try {
    const page = await app.firstWindow();
    await openSample(app, page, fileA);
    await page.getByRole("button", { name: "源码", exact: true }).click();
    await page.locator(".cm-content").waitFor();
    await page.keyboard.press("Control+f");
    const sourcePanel = page.locator(".cm-panels-top .source-search-panel");
    await sourcePanel.locator('input[name="search"]').fill("Alpha");
    await expect(sourcePanel.locator(".search-count")).toContainText("1 / 1");

    // 打开第二个标签：查找面板跟随新标签的当前模式重新打开，查找词保留。
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, fileB);
    await page.keyboard.press("Control+O");
    const tabB = page.locator(".tab-item").filter({ hasText: "b.md" });
    await expect(tabB).toHaveCount(1);
    const anyPanel = page.locator(".search-panel, .cm-panels-top .source-search-panel");
    await expect(anyPanel).toBeVisible();
    await expect(
      anyPanel.locator('input[aria-label="查找内容"], input[name="search"]').first(),
    ).toHaveValue("Alpha");

    // 切回原标签（源码模式）：源码面板仍然保持。
    await page.locator(".tab-item").filter({ hasText: "a.md" }).click();
    await expect(sourcePanel).toBeVisible();
    await expect(sourcePanel.locator('input[name="search"]')).toHaveValue("Alpha");
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M4：切换标签时文件树自动展开父目录，并把活动文件滚动到文件栏中部。 */
test("M4：切换标签自动定位文件树", async () => {
  test.setTimeout(180_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m4-tree-"));
  const userDataDir = await prepareUserData(false);
  const nested = path.join(tempDir, "nested", "deep");
  await fs.mkdir(nested, { recursive: true });
  const fileA = path.join(tempDir, "a.md");
  const fileMid = path.join(tempDir, "f20.md");
  const fileB = path.join(nested, "b.md");
  await fs.writeFile(fileA, "# A\n", "utf8");
  await fs.writeFile(fileB, "# B\n", "utf8");
  // 填充文件让文件树产生滚动，验证活动项会滚动到文件栏中部。
  await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      fs.writeFile(
        path.join(tempDir, `f${String(index).padStart(2, "0")}.md`),
        "# F\n",
        "utf8",
      ),
    ),
  );

  const app = await launch(userDataDir);
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, tempDir);
    await page
      .locator(".files-toolbar")
      .getByRole("button", { name: "打开文件夹", exact: true })
      .click();
    await expect(page.locator(".workspace-root")).toHaveCount(1);

    const openFile = async (target: string): Promise<void> => {
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      }, target);
      await page.keyboard.press("Control+O");
    };

    /** 读取文件栏滚动位置与活动行到可视区中线的距离。 */
    const measure = async (): Promise<{ scrollTop: number; delta: number } | null> =>
      page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>(".workspace-roots");
        const row = scroller?.querySelector<HTMLElement>(".tree-row.active");
        if (!scroller || !row) return null;
        const rowBox = row.getBoundingClientRect();
        const box = scroller.getBoundingClientRect();
        return {
          scrollTop: scroller.scrollTop,
          delta: Math.abs(rowBox.top + rowBox.height / 2 - (box.top + box.height / 2)),
        };
      });

    await openFile(fileA);
    await expect(page.locator(".tree-row.active .tree-name")).toHaveText("a.md");
    await openFile(fileMid);
    await expect(page.locator(".tree-row.active .tree-name")).toHaveText("f20.md");

    // 切换标签后活动文件位于文件栏垂直中部。
    await expect.poll(async () => (await measure())?.delta ?? Number.POSITIVE_INFINITY).toBeLessThan(24);
    expect((await measure())?.scrollTop ?? 0).toBeGreaterThan(0);

    // 从文件树点开文件只切换标签，不重新滚动（列表不跳动）。
    await page.locator(".workspace-roots").evaluate((element: HTMLElement) => {
      element.scrollTop = 0;
    });
    await page.locator(".tree-name", { hasText: "f00.md" }).click();
    await expect(page.locator(".tab-item.active .tab-name")).toHaveText("f00.md");
    await page.waitForTimeout(100);
    expect(
      await page.locator(".workspace-roots").evaluate((element: HTMLElement) => element.scrollTop),
    ).toBe(0);

    await openFile(fileB);
    await expect(page.locator(".tree-row.active .tree-name")).toHaveText("b.md");

    // 父目录自动展开，当前文件在树中可见。
    await expect(page.locator(".tree-row.dir").filter({ hasText: "nested" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(page.locator(".tree-row.dir").filter({ hasText: "deep" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    await page.locator(".tab-item").filter({ hasText: "a.md" }).click();
    await expect(page.locator(".tree-row.active .tree-name")).toHaveText("a.md");
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
