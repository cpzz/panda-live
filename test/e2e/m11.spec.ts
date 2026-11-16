import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

const CWD = path.resolve(".");

async function packExtension(sourceDir: string, target: string): Promise<void> {
  const zip = new JSZip();
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, `${prefix}${entry.name}/`);
      } else {
        zip.file(`${prefix}${entry.name}`, await fs.readFile(full));
      }
    }
  };
  await walk(sourceDir, "");
  await fs.writeFile(target, await zip.generateAsync({ type: "nodebuffer" }));
}

test("M11：命令面板支持过滤、执行与扩展命令", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m11-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m11-ud-"));
  const docPath = path.join(tempDir, "note.md");
  await fs.writeFile(docPath, "# 笔记\n\n正文\n", "utf8");

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  const page = await app.firstWindow();
  try {
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, docPath);
    await page.locator(".app").waitFor();
    await page.keyboard.press("Control+O");
    await expect(page.locator(".tab-name")).toHaveText("note.md");

    // 打开命令面板并筛选“新建”，回车执行。
    await page.keyboard.press("Control+Shift+P");
    const palette = page.locator(".palette");
    await expect(palette).toBeVisible();
    const input = page.getByLabel("命令搜索");
    await input.fill("新建文档");
    await expect(page.locator(".palette-item")).toHaveCount(1);
    await input.press("Enter");
    await expect(palette).toHaveCount(0);
    await expect(page.locator(".tab-name")).toHaveCount(2);
    await expect(page.locator(".tab-name").last()).toHaveText("untitled.md");

    // 无匹配提示与 Esc 关闭。
    await page.keyboard.press("Control+Shift+P");
    await page.getByLabel("命令搜索").fill("zzzz-not-exists");
    await expect(page.locator(".palette-empty")).toHaveText("无匹配命令");
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);

    // 安装示例扩展后，其贡献命令出现在面板并可执行。
    const archive = path.join(tempDir, "asciidoc.panda");
    await packExtension(path.resolve("extensions/examples/asciidoc"), archive);
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, archive);
    const info = (await page.evaluate(async () => window.panda.ext.install())) as { id: string };
    await page.evaluate((id) => window.panda.ext.enable(id), info.id);

    await page.keyboard.press("Control+Shift+P");
    await page.getByLabel("命令搜索").fill("AsciiDoc");
    const extensionItem = page.locator(".palette-item").first();
    await expect(extensionItem).toContainText("AsciiDoc: 导出 HTML（示例）");
    await extensionItem.click();
    await expect(page.locator(".toast")).toContainText("已执行：AsciiDoc: 导出 HTML（示例）", {
      timeout: 15_000,
    });

    // 气泡 3 秒后自动关闭，但历史记录仍保留。
    await expect(page.locator(".toast")).toHaveCount(0, { timeout: 8_000 });
    // 状态栏通知按钮打开历史；支持单条删除与 Esc 关闭。
    await page.locator(".statusbar .notice-button").click();
    const noticeDialog = page.getByRole("dialog", { name: "通知历史" });
    await expect(noticeDialog).toBeVisible();
    const executed = noticeDialog.locator(".notice-item").filter({ hasText: "AsciiDoc" });
    await expect(executed).toHaveCount(1);
    await executed.getByRole("button", { name: "删除此条通知" }).click();
    await expect(executed).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(noticeDialog).toHaveCount(0);
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
