import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

/** 构造带正确 xref 的单页最小 PDF，供 PDF.js 解析。 */
function buildSamplePdf(): Buffer {
  const stream = "BT /F1 24 Tf 20 40 Td (Hello Panda) Tj ET";
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj${object}endobj\n`;
  });
  const xrefStart = Buffer.byteLength(body, "latin1");
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `${xref}trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

test("M32：打开 PDF 文档显示只读预览", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m32-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m32-ud-"));
  const filePath = path.join(tempDir, "sample.pdf");
  await fs.writeFile(filePath, buildSamplePdf());

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
    await expect(page.locator(".tab-name")).toHaveText("sample.pdf");

    // PDF 面板可见，页面槽位与 canvas 渲染完成（首次加载需拉起 pdfjs chunk 与 worker）。
    const viewer = page.locator(".pdf-viewer");
    await expect(viewer).toBeVisible({ timeout: 30_000 });
    await expect(viewer.locator(".pdf-page")).toHaveCount(1, { timeout: 30_000 });
    await expect(viewer.locator("canvas")).toBeVisible({ timeout: 30_000 });

    // 只读 PDF：没有可切换的文本模式，顶部模式条整体隐藏。
    await expect(page.locator(".mode-bar")).toHaveCount(0);
    await expect(page.locator(".statusbar")).toContainText("PDF");
    await expect(page.locator(".statusbar")).toContainText("只读");

    // 缩放控件与图表预览一致（输入框、滑块、±、默认显示/页宽显示），且与页码在同一行。
    const zoomControls = page.locator(".pdf-zoom-controls");
    await expect(zoomControls).toBeVisible();
    await expect(zoomControls.locator(".diagram-zoom-input")).toHaveValue("100");
    await expect(zoomControls.locator(".diagram-zoom-range")).toBeVisible();
    await expect(zoomControls.getByRole("button", { name: "默认显示", exact: true })).toBeVisible();
    await expect(zoomControls.getByRole("button", { name: "页宽显示" })).toBeVisible();
    // 转 Markdown 按钮暂不展示。
    await expect(page.getByRole("button", { name: "转 Markdown" })).toBeHidden();
    // 缩放快捷键：Ctrl+= 放大到 110%，Ctrl+0 复位到 100%。
    const zoomInput = zoomControls.locator(".diagram-zoom-input");
    await page.keyboard.press("Control+=");
    await expect(zoomInput).toHaveValue("110");
    await page.keyboard.press("Control+0");
    await expect(zoomInput).toHaveValue("100");
    // 页宽显示：页面恰好铺满视口，不应产生横向滚动条。
    await zoomControls.getByRole("button", { name: "页宽显示" }).click();
    await expect
      .poll(() =>
        page.locator(".pdf-viewer").evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      )
      .toBe(true);
    const pageJumpBox = await page.locator(".pdf-page-jump").boundingBox();
    const toolbarBox = await page.locator(".pdf-toolbar").boundingBox();
    expect(pageJumpBox).not.toBeNull();
    expect(toolbarBox).not.toBeNull();
    // 页码输入/总页数在工具栏水平居中。
    expect(
      Math.abs(
        pageJumpBox!.x + pageJumpBox!.width / 2 - (toolbarBox!.x + toolbarBox!.width / 2),
      ),
    ).toBeLessThan(2);
    // 单行工具栏：高度约一行按钮，不会把页宽显示挤到第二行。
    expect(toolbarBox!.height).toBeLessThan(44);
    expect(Math.abs(pageJumpBox!.y - toolbarBox!.y)).toBeLessThan(20);
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
