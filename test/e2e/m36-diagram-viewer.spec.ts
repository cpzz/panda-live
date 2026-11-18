import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");
const MERMAID_SOURCE = [
  "flowchart LR",
  "  A[开始] --> B{判断}",
  "  B -->|是| C[处理]",
  "  B -->|否| D[结束]",
  "  C --> D",
].join("\n");

/**
 * M36：图表缩放视图。
 * 1) 独立 .mmd 预览可真实放大，且 svg 不残留内联 max-width；
 * 2) 同一 userDataDir 二次启动（命中 IndexedDB 持久缓存）后仍可放大——
 *    回归：消毒版本未进入缓存键时，旧 SVG 被直接复用导致 Mermaid 只能缩小。
 * 3) 内嵌图表「放大查看」对话框最大化后还原/关闭按钮可用。见 doc/design.md §10.3。
 */
test("M36：图表缩放与持久缓存回归", async () => {
  test.setTimeout(240_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m36-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m36-ud-"));
  const mmdPath = path.join(tempDir, "flow.mmd");
  await fs.writeFile(mmdPath, MERMAID_SOURCE, "utf8");

  /** 打开 .mmd 并验证插入的 SVG 无内联 max-width、放大后实际变宽。 */
  const verifyStandaloneZoom = async (): Promise<void> => {
    const app = await electron.launch({
      args: ["."],
      cwd: CWD,
      env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
    });
    try {
      const page = await app.firstWindow();
      await app.evaluate(({ dialog }, target) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
      }, mmdPath);
      await page.locator(".app").waitFor();
      await page.keyboard.press("Control+O");

      const svg = page.locator(".diagram-viewer-body svg");
      await expect(svg).toHaveCount(1, { timeout: 30_000 });
      await expect(svg).toBeVisible();

      // 内联 max-width 会把图形钉死在自然宽度（放大时只有容器变宽）。
      await expect
        .poll(() => svg.evaluate((element) => element.getAttribute("style") ?? ""), {
          timeout: 5_000,
        })
        .not.toContain("max-width");

      const widthAt = () =>
        svg.evaluate((element) => Math.round(element.getBoundingClientRect().width));
      const initialWidth = await widthAt();
      expect(initialWidth).toBeGreaterThan(0);

      // 放大到 300%，使内容溢出视口（纵向可滚动）。
      const zoomInput = page.locator(".diagram-zoom-input");
      await zoomInput.fill("300");
      await zoomInput.press("Enter");
      await expect.poll(widthAt, { timeout: 5_000 }).toBeGreaterThan(initialWidth);

      // 工具栏固定在面板顶端：在图表视口内滚动后位置不变，面板本身不滚动。
      const toolbar = page.locator(".diagram-viewer-toolbar");
      const toolbarBefore = await toolbar.boundingBox();
      const scrolled = await page.locator(".diagram-viewer-body").evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
        element.scrollTop = element.scrollHeight;
        return element.scrollLeft;
      });
      expect(scrolled).toBeGreaterThan(0);
      const toolbarAfter = await toolbar.boundingBox();
      expect(toolbarAfter).not.toBeNull();
      expect(toolbarAfter!.y).toBeCloseTo(toolbarBefore!.y, 0);
      expect(
        await page
          .locator(".preview-pane.diagram-pane")
          .evaluate((element) => element.scrollLeft + element.scrollTop),
      ).toBe(0);

      // 复位：恢复自然宽度显示且不超过视口。
      await page
        .locator(".diagram-viewer-toolbar")
        .getByRole("button", { name: "复位", exact: true })
        .click();
      await expect.poll(widthAt, { timeout: 5_000 }).toBeLessThanOrEqual(initialWidth + 1);

      // 缩放快捷键：Ctrl+= 放大、Ctrl+0 重置为 100%（仅缩放显示内生效）。
      const beforeShortcut = await widthAt();
      await page.keyboard.press("Control+=");
      await expect.poll(widthAt, { timeout: 5_000 }).toBeGreaterThan(beforeShortcut);
      await page.keyboard.press("Control+0");
      await expect
        .poll(
          () =>
            page.evaluate(() =>
              Number(
                document.querySelector<HTMLInputElement>(".diagram-zoom-input")?.value ?? "0",
              ),
            ),
          { timeout: 5_000 },
        )
        .toBe(100);
    } finally {
      await app.close();
    }
  };

  try {
    // 首次启动：渲染并写入持久缓存。
    await verifyStandaloneZoom();
    // 二次启动：命中 IndexedDB 缓存，仍须可放大。
    await verifyStandaloneZoom();

    // 内嵌图表 → 放大查看对话框 → 最大化/还原/关闭；同时验证图表左对齐与代码块自然宽度。
    const mdPath = path.join(tempDir, "doc.md");
    await fs.writeFile(
      mdPath,
      [
        "# 图表",
        "",
        "对齐参照段落。",
        "",
        "```mermaid",
        MERMAID_SOURCE,
        "```",
        "",
        "```js",
        "const a = 1;",
        "```",
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
      }, mdPath);
      await page.locator(".app").waitFor();
      await page.keyboard.press("Control+O");
      // Markdown 默认预览模式；图表布局在渲染预览中验证。
      await page.getByRole("button", { name: "预览", exact: true }).click();
      const preview = page.locator(".preview-pane .markdown-body");
      const block = preview.locator(".preview-diagram").first();
      await expect(block.locator("svg.flowchart")).toBeVisible({ timeout: 30_000 });

      // 图表左对齐：与同级正文段落的左边缘一致（此前是居中显示）。
      const blockBox = await block.boundingBox();
      const paragraphBox = await preview.locator("p").first().boundingBox();
      expect(blockBox).not.toBeNull();
      expect(paragraphBox).not.toBeNull();
      expect(Math.abs(blockBox!.x - paragraphBox!.x)).toBeLessThanOrEqual(1);

      // 代码块背景按代码自然宽度收缩，不撑满内容区。
      const codeBox = await preview.locator("pre.shiki").first().boundingBox();
      const bodyBox = await preview.boundingBox();
      expect(codeBox).not.toBeNull();
      expect(bodyBox).not.toBeNull();
      expect(codeBox!.width).toBeLessThan(bodyBox!.width - 40);

      await block.hover();
      await block.locator(".diagram-expand").click();

      const dialog = page.locator(".diagram-viewer-modal");
      await expect(dialog).toBeVisible();
      const maximize = dialog.getByRole("button", { name: "最大化", exact: true });
      const restore = dialog.getByRole("button", { name: "还原", exact: true });
      const close = dialog.getByRole("button", { name: "关闭", exact: true });

      // 对话框内同样不残留内联 max-width（否则放大无效）。
      const dialogSvg = page.locator(".diagram-viewer-modal .diagram-viewer-body svg");
      await expect
        .poll(() => dialogSvg.evaluate((element) => element.getAttribute("style") ?? ""))
        .not.toContain("max-width");

      await maximize.click();
      await expect(restore).toBeVisible();
      await expect(close).toBeVisible();
      const headerBox = await dialog.locator(".modal-header").boundingBox();
      expect(headerBox).not.toBeNull();
      expect(headerBox!.y).toBeGreaterThanOrEqual(0);
      expect(headerBox!.y).toBeLessThan(200);
      await restore.click();
      await expect(maximize).toBeVisible();
      await close.click();
      await expect(dialog).toHaveCount(0);
    } finally {
      await app.close();
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
