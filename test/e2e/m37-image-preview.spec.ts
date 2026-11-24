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
    await page.locator(".app").waitFor();
    await page.keyboard.press("Control+O");
    await expect(page.locator(".tab-name")).toHaveText("pixel.png");

    // 图片渲染在缩放视图内，工具栏与图表一致。
    const image = page.locator(".preview-pane.diagram-pane .diagram-viewer-body img");
    await expect(image).toBeVisible({ timeout: 30_000 });
    const zoomInput = page.locator(".diagram-zoom-input");
    const defaultView = page.getByRole("button", { name: "默认显示", exact: true });
    const fitWidth = page.getByRole("button", { name: "页宽显示" });
    await expect(zoomInput).toHaveValue("100");
    await expect(defaultView).toBeVisible();
    await expect(defaultView).toBeDisabled();
    await expect(fitWidth).toBeEnabled();

    // 只读图片：没有可切换的文本模式，顶部模式条整体隐藏。
    await expect(page.locator(".mode-bar")).toHaveCount(0);

    // 缩放快捷键：Ctrl+= 放大到 110%，Ctrl+0 复位到 100%。
    await page.keyboard.press("Control+=");
    await expect(zoomInput).toHaveValue("110");
    await expect(defaultView).toBeEnabled();
    await expect(fitWidth).toBeEnabled();
    await page.keyboard.press("Control+0");
    await expect(zoomInput).toHaveValue("100");
    await expect(defaultView).toBeDisabled();
    await expect(fitWidth).toBeEnabled();

    // 页宽显示按视口可用宽度铺满内容（小图会放大，受 1000% 上限夹取），默认显示回到 100%。
    await fitWidth.click();
    await expect.poll(() => zoomInput.inputValue()).not.toBe("100");
    await expect(fitWidth).toBeDisabled();
    await expect(defaultView).toBeEnabled();
    await defaultView.click();
    await expect(zoomInput).toHaveValue("100");
    await expect(defaultView).toBeDisabled();
    await expect(fitWidth).toBeEnabled();
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M37：BMP / JPG / GIF 等主流图片格式按只读预览打开。 */
test("M37：BMP、JPG、GIF 图片格式", async () => {
  test.setTimeout(120_000);
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m37-formats-"));
  const files = ["37-image.bmp", "36-image.jpg", "38-image.gif"];

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  try {
    const page = await app.firstWindow();
    for (const name of files) {
      await app.evaluate(({ dialog }, target) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
      }, path.resolve("examples", name));
      await page.locator(".app").waitFor();
    await page.keyboard.press("Control+O");
      await expect(page.locator(".tab-item.active .tab-name")).toHaveText(name);

      const image = page.locator(".image-pane img");
      await expect(image).toBeVisible({ timeout: 30_000 });
      await expect(image).toHaveAttribute("src", /^data:image\//);
      await expect(page.locator(".mode-bar")).toHaveCount(0);
      await expect(page.locator(".statusbar")).toContainText("图片");
      await expect(page.locator(".statusbar")).toContainText("只读");

      await page.locator(".tab-item.active .tab-close").click();
    }
  } finally {
    await app.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M37：SVG 是独立文本格式，源码可编辑，预览在 img 中隔离渲染。 */
test("M37：SVG 文档源码与安全预览", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m37-svg-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m37-svg-ud-"));
  const filePath = path.join(tempDir, "sample.svg");
  await fs.writeFile(
    filePath,
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160">',
      "<script>window.__pandaSvgScript = true;</script>",
      '<circle cx="80" cy="80" r="60" fill="#0b6b4f" onload="window.__pandaSvgEvent = true"/>',
      '<text x="160" y="90" font-size="20">Panda</text>',
      "</svg>",
    ].join(""),
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
    await page.locator(".app").waitFor();
    await page.keyboard.press("Control+O");
    await expect(page.locator(".tab-item.active .tab-name")).toHaveText("sample.svg");

    // 文本格式：模式条提供 源码 / 分栏 / 预览，不显示「所见即所得」。
    const modes = page.locator(".mode-bar .mode-bar-modes button:not(.mode-button-git)");
    await expect(modes).toHaveCount(3);
    await expect(modes.nth(0)).toHaveAccessibleName("源码");
    await expect(modes.nth(1)).toHaveAccessibleName("分栏");
    await expect(modes.nth(2)).toHaveAccessibleName("预览");

    // 默认分栏：左侧 XML 源码，右侧渲染出的 SVG。
    await expect(page.locator(".cm-content")).toContainText("<svg");
    const svgImage = page.locator(".diagram-viewer-body img");
    await expect(svgImage).toBeVisible({ timeout: 15_000 });
    await expect(svgImage).toHaveAttribute("src", /^data:image\/svg\+xml;base64,/);
    // 预览走 <img> 隔离渲染，SVG 内的脚本不会执行。
    expect(await page.evaluate(() => (window as { __pandaSvgScript?: boolean }).__pandaSvgScript)).toBeUndefined();
    await expect(page.locator(".diagram-zoom-input")).toHaveValue("100");

    // 源码可编辑（XML 是唯一写面），切换预览后仍渲染图形。
    await modes.nth(0).click();
    await expect(page.locator(".cm-content")).toBeVisible();
    await modes.nth(2).click();
    await expect(svgImage).toBeVisible();

    // examples 中的 SVG 示例同样按 SVG 文档打开并渲染。
    await page.locator(".tab-item.active .tab-close").click();
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, path.resolve("examples", "34-image.svg"));
    await page.locator(".app").waitFor();
    await page.keyboard.press("Control+O");
    await expect(page.locator(".tab-item.active .tab-name")).toHaveText("34-image.svg");
    const exampleImage = page.locator(".diagram-viewer-body img");
    await expect(exampleImage).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => exampleImage.evaluate((element) => (element as HTMLImageElement).naturalWidth))
      .toBe(640);
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
