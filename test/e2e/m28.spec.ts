import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

test("M28：Markdown 页内目录锚点跳转", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m28-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m28-ud-"));
  const body = Array.from({ length: 40 }, (_, index) => `段落 ${index + 1}\n`).join("\n");
  const filePath = path.join(tempDir, "toc.md");
  await fs.writeFile(
    filePath,
    [
      "# 目录",
      "",
      "[交付物信息](#sec-1)",
      "",
      body,
      '<a id="sec-1"></a>',
      "",
      "## 交付物信息",
      "",
      "目标内容",
      "",
    ].join("\n"),
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
    }, filePath);
    await page.getByRole("button", { name: "打开", exact: true }).click();
    await expect(page.locator(".tab-name")).toHaveText("toc.md");

    // 预览：原始 HTML 锚点被保留，而不是转义成文本。
    await page.getByRole("button", { name: "预览", exact: true }).click();
    const preview = page.locator(".preview-pane .markdown-body");
    await expect(preview.locator('a#sec-1')).toHaveCount(1, { timeout: 15_000 });
    await expect(preview).not.toContainText('<a id="sec-1">');

    await preview.locator('a[href="#sec-1"]').first().click();
    await expect(preview.locator("#sec-1")).toHaveClass(/anchor-target/);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const target = document.querySelector("#sec-1");
          if (!target) return false;
          const rect = target.getBoundingClientRect();
          return rect.top >= -20 && rect.top <= window.innerHeight - 40;
        }),
      )
      .toBe(true);
    // 拦截后不修改页面 URL。
    expect(await page.evaluate(() => window.location.hash)).toBe("");

    // 所见即所得：点击目录链接滚动到对应的原始 HTML 锚点块。
    await page.getByRole("button", { name: "所见即所得", exact: true }).click();
    const link = page.locator('.prose-editor a[href="#sec-1"]').first();
    await expect(link).toBeVisible({ timeout: 15_000 });
    const before = await page.evaluate(() => {
      const anchor = document.querySelector(".prose-editor .html-inline");
      return {
        top: anchor ? Math.round(anchor.getBoundingClientRect().top) : null,
        viewport: window.innerHeight,
      };
    });
    expect(before.top !== null && before.top > before.viewport).toBe(true);
    await link.click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const anchor = document.querySelector(".prose-editor .html-inline");
          if (!anchor) return false;
          const rect = anchor.getBoundingClientRect();
          // 居中滚动到视口内即可；具体像素位置随窗口高度变化。
          return rect.top > 0 && rect.top < window.innerHeight - 40;
        }),
      )
      .toBe(true);
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
