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

    // 设置：切换深色主题并保存
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settingsModal = page.locator(".modal[aria-label='设置']");
    await expect(settingsModal).toBeVisible();
    await settingsModal.locator(".settings-row select").first().selectOption("dark");
    await settingsModal.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark", { timeout: 10_000 });

    // 设置：数学分组（关闭单美元内联公式）持久化到 settings.json
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const mathGroup = settingsModal.locator(".settings-group", { hasText: "数学" });
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
