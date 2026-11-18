import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let app: ElectronApplication | undefined;
let tempDir: string;
let userDataDir: string;
let filePath: string;

test.beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-live-e2e-"));
  // 独立 userData：避免与开发实例共用真实用户数据，导致 Preferences 文件被占用（EBUSY）。
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-live-e2e-ud-"));
  filePath = path.join(tempDir, "sample.md");
  await fs.writeFile(filePath, "\uFEFF# 初始标题\r\n\r\n初始正文\r\n", "utf8");
});

test.afterAll(async () => {
  await app?.close();
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.rm(userDataDir, { recursive: true, force: true });
});

test("M0：打开、编辑、预览、保存并保留 BOM 与 CRLF", async () => {
  app = await electron.launch({
    args: ["."],
    cwd: path.resolve("."),
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  const page = await app.firstWindow();

  await expect(page.locator(".empty-state h1")).toHaveText("打开一个文档开始编辑");

  // 用主进程内的假对话框替代原生对话框，避免人工交互。
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, filePath);

  // 顶部工具栏与欢迎页都有「打开文件」，限定顶部工具栏。
  await page.locator(".toolbar").getByRole("button", { name: "打开文件", exact: true }).click();
  await expect(page.locator(".tab-name")).toHaveText("sample.md");
  // Markdown 默认以预览模式打开；本用例需要同时编辑源码并观察预览。
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("初始标题");

  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("# 更新标题\n\n第一行\n第二行");

  await expect(page.locator(".preview-pane .markdown-body h1")).toHaveText("更新标题");

  await page.getByRole("button", { name: "保存文件", exact: true }).click();
  await expect(page.locator(".tab-dot")).toHaveCount(0);

  const raw = await fs.readFile(filePath);
  expect(raw[0]).toBe(0xef);
  expect(raw[1]).toBe(0xbb);
  expect(raw[2]).toBe(0xbf);
  const text = raw.toString("utf8");
  expect(text).toContain("更新标题");
  expect(text).toContain("\r\n");
  expect(text).not.toContain("初始正文");
});
