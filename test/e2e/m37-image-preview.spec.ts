import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");
/** 1×1 透明 PNG：只用于验证图片格式注册、二进制只读打开与缩放视图接线。 */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** M37：图片文件以只读预览打开，并使用与图表一致的缩放视图。 */
test("M37：图片预览与缩放快捷键", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m37-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m37-ud-"));
  const filePath = path.join(tempDir, "pixel.png");
  await fs.writeFile(filePath, Buffer.from(PNG_BASE64, "base64"));

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
    await expect(page.locator(".tab-name")).toHaveText("pixel.png");

    // 图片渲染在缩放视图内，工具栏与图表一致。
    const image = page.locator(".preview-pane.diagram-pane .diagram-viewer-body img");
    await expect(image).toBeVisible({ timeout: 30_000 });
    const zoomInput = page.locator(".diagram-zoom-input");
    await expect(zoomInput).toHaveValue("100");
    await expect(page.getByRole("button", { name: "复位", exact: true })).toBeVisible();

    // 只读图片：没有可切换的文本模式，顶部模式条整体隐藏。
    await expect(page.locator(".mode-bar")).toHaveCount(0);

    // 缩放快捷键：Ctrl+= 放大到 110%，Ctrl+0 复位到 100%。
    await page.keyboard.press("Control+=");
    await expect(zoomInput).toHaveValue("110");
    await page.keyboard.press("Control+0");
    await expect(zoomInput).toHaveValue("100");
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
