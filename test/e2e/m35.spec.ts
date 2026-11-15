import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

test("M35：源码折叠状态随会话持久化，重启后恢复", async () => {
  test.setTimeout(180_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m35-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m35-ud-"));
  const mdPath = path.join(tempDir, "folds.md");
  await fs.writeFile(
    mdPath,
    [
      "# 折叠",
      "",
      "正文段落",
      "",
      "```js",
      "const a = 1;",
      "const b = 2;",
      "const c = 3;",
      "```",
      "",
      "## 子节",
      "",
      "更多正文",
      "",
    ].join("\n"),
    "utf8",
  );

  let app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, mdPath);
    await page.getByRole("button", { name: "打开", exact: true }).click();
    await expect(page.locator(".tab-name")).toHaveText("folds.md");
    // Markdown 默认所见即所得；折叠能力在源码模式验证。
    await page.getByRole("button", { name: "源码", exact: true }).click();

    // 折叠第一个分节（# 折叠 到文末）。
    const gutter = page.locator(".pane:not([hidden]) .cm-foldGutter span:visible");
    await expect(gutter.first()).toBeVisible({ timeout: 15_000 });
    await gutter.first().click();
    const placeholder = page.locator(".pane:not([hidden]) .cm-foldPlaceholder");
    await expect(placeholder).toBeVisible();

    // 会话按 15 s 周期落盘；等待 session.json 携带 folds 后再退出。
    await expect
      .poll(async () => {
        const raw = await fs
          .readFile(path.join(userDataDir, "session.json"), "utf8")
          .catch(() => "");
        const parsed = JSON.parse(raw || "{}") as {
          documents?: { folds?: number[] }[];
        };
        return parsed.documents?.[0]?.folds?.length ?? 0;
      }, { timeout: 30_000, intervals: [2_000] })
      .toBeGreaterThan(0);

    await app.close();
    app = await electron.launch({
      args: ["."],
      cwd: CWD,
      env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
    });
    const page2 = await app.firstWindow();
    await expect(page2.locator(".tab-name", { hasText: "folds.md" })).toBeVisible({
      timeout: 20_000,
    });
    // 重启后折叠状态恢复。
    await expect(page2.locator(".pane:not([hidden]) .cm-foldPlaceholder")).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
