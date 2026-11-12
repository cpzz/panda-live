import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

test("M31：内容宽度可超过 100%、状态栏滑块与 Ctrl +/- 缩放", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m31-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m31-ud-"));
  const filePath = path.join(tempDir, "width.md");
  await fs.writeFile(filePath, "# 宽度\n\n这是一段用于验证横向滚动的正文。\n", "utf8");

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
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await expect(page.locator(".markdown-body h1")).toHaveText("宽度", { timeout: 15_000 });

    const slider = page.locator(".statusbar-width-range");
    await expect(slider).toBeVisible();
    await slider.evaluate((element) => {
      const input = element as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "150");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--prose-max-width").trim(),
        ),
      )
      .toBe("150%");
    await expect(page.locator(".statusbar-width-value")).toHaveText("150%");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const pane = document.querySelector(".preview-pane");
          return pane ? pane.scrollWidth > pane.clientWidth : false;
        }),
      )
      .toBe(true);

    // Ctrl + 加号放大、Ctrl + 0 复位。
    await page.keyboard.press("Control+=");
    await expect(page.locator(".statusbar-width-value")).toHaveText("160%");
    await page.keyboard.press("Control+0");
    await expect(page.locator(".statusbar-width-value")).toHaveText("100%");
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
