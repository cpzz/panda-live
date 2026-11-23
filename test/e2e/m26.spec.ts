import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

async function prepareUserData(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m26-ud-"));
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

test("M26：渲染态差异——源码 gutter、预览词级标记与删除幽灵块", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m26-file-"));
  const userDataDir = await prepareUserData();
  const filePath = path.join(tempDir, "diff.md");
  await fs.writeFile(filePath, "# Hello world\n\n保留段落\n\n删除段落\n", "utf8");

  const app = await launch(userDataDir);
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, filePath);
    await page.locator(".app").waitFor();
    await page.keyboard.press("Control+O");
    await expect(page.locator(".tab-name")).toHaveText("diff.md");
    // Markdown 默认预览模式；本场景需要源码 + 预览同时可见。
    await page.getByRole("button", { name: "分栏", exact: true }).click();

    // 无 Git 环境自动退化为「上次保存」；未编辑时应显示无改动。
    await page.getByRole("button", { name: /显示改动/ }).click();
    await expect(page.locator(".diff-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".diff-controls")).toContainText("无改动", { timeout: 20_000 });

    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("# Hello panda\n\n保留段落\n");

    await expect(page.locator(".markdown-body .diff-change")).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator(".markdown-body ins.diff-inline-add")).toContainText("panda");
    await expect(page.locator(".markdown-body del.diff-inline-del")).toContainText("world");
    await expect(page.locator("[data-diff-ghost]")).toContainText("删除段落");
    await expect(page.locator(".cm-diff-gutter-mark")).not.toHaveCount(0);

    // WYSIWYG：同一份 diff 驱动 ProseMirror 装饰。
    await page.getByRole("button", { name: "所见即所得", exact: true }).click();
    await expect(page.locator(".prose-editor .pm-diff-change")).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator(".prose-editor .diff-inline-add")).toContainText("panda");
    await expect(page.locator(".prose-editor del.diff-inline-del")).toContainText("world");
    await expect(page.locator(".prose-editor [data-diff-ghost]")).toContainText("删除段落");

    // 预览粒度：仅改动片段生成卡片，可返回全文。
    await page.getByRole("button", { name: "分栏", exact: true }).click();
    await page.locator(".diff-count").click();
    await page.locator(".diff-mode-select").selectOption("fragments");
    const cards = page.locator(".diff-fragment-card");
    await expect(cards.first()).toBeVisible({ timeout: 20_000 });
    await expect(cards.first().locator(".diff-fragment-breadcrumb")).toContainText("Hello");
    await cards.first().getByRole("button", { name: "返回全文", exact: true }).click();
    await expect(page.locator(".diff-fragment-card")).toHaveCount(0);

    // 关闭差异后装饰应完全清理。
    await page.getByRole("button", { name: /显示改动/ }).click();
    await expect(page.locator(".markdown-body ins.diff-inline-add")).toHaveCount(0);
    await expect(page.locator("[data-diff-ghost]")).toHaveCount(0);

  } finally {
    await app.close();
  }
});
