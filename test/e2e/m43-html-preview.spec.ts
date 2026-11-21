import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

/** M43：HTML 文档以 sandbox iframe 预览，脚本在隔离环境执行，源码可切换。 */
test("M43：HTML 预览、沙箱隔离与源码切换", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m43-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m43-ud-"));
  const filePath = path.join(tempDir, "demo.html");
  await fs.writeFile(
    filePath,
    [
      "<!doctype html><html><head><meta charset='utf-8'><title>Demo</title></head>",
      "<body><h1 id='title'>Hello Panda</h1>",
      "<script>",
      "document.getElementById('title').textContent = 'Rendered by JS';",
      "if (typeof window.panda === 'undefined') document.body.setAttribute('data-isolated', 'yes');",
      "</script>",
      "</body></html>",
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
    await expect(page.locator(".tab-item.active .tab-name")).toHaveText("demo.html");

    // 文本格式：模式条提供 源码 / 分栏 / 预览，无「所见即所得」。
    const modes = page.locator(".mode-bar .mode-bar-modes button:not(.mode-button-git)");
    await expect(modes).toHaveCount(3);
    await expect(modes.nth(0)).toHaveAccessibleName("源码");
    await expect(modes.nth(1)).toHaveAccessibleName("分栏");
    await expect(modes.nth(2)).toHaveAccessibleName("预览");

    // 默认进入预览：iframe  sandbox 渲染完整 HTML。
    const frame = page.locator(".html-preview-frame");
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    const inner = page.frameLocator(".html-preview-frame");
    await expect(inner.locator("h1#title")).toHaveText("Rendered by JS", { timeout: 15_000 });

    // sandbox iframe 不注入 preload：脚本能跑（上方已验证），但拿不到 window.panda。
    await expect(inner.locator("body[data-isolated='yes']")).toHaveCount(1);

    // 切到源码可见 HTML 文本，再切回预览仍渲染。
    await modes.nth(0).click();
    await expect(page.locator(".cm-content")).toContainText("Hello Panda");
    await modes.nth(2).click();
    await expect(inner.locator("h1#title")).toHaveText("Rendered by JS");

    const htmlZoom = (): Promise<string> =>
      inner.locator("html").evaluate((el) => (el as HTMLElement).style.zoom);

    // —— 缩放工具栏：与图表/图片预览共用，改动 iframe 内 zoom ——
    const toolbar = page.locator(".html-preview-pane .diagram-viewer-toolbar");
    await expect(toolbar).toBeVisible();
    const zoomInput = toolbar.locator(".diagram-zoom-input");
    await expect(zoomInput).toHaveValue("100");
    await toolbar.getByRole("button", { name: "放大" }).click();
    await expect(zoomInput).toHaveValue("110");
    await expect.poll(htmlZoom).toBe("1.1");
    await toolbar.getByRole("button", { name: "复位" }).click();
    await expect(zoomInput).toHaveValue("100");
    await expect.poll(htmlZoom).toBe("1");

    // —— 缩放：父侧快捷键（焦点在父文档）——
    await modes.nth(2).click(); // 焦点落在父窗口的预览按钮上
    await expect.poll(htmlZoom).toBe("1"); // 初始 100%
    await page.keyboard.press("Control+=");
    await expect.poll(htmlZoom).toBe("1.1");
    await page.keyboard.press("Control+-");
    await expect.poll(htmlZoom).toBe("1");
    await page.keyboard.press("Control+0");
    await expect.poll(htmlZoom).toBe("1");

    // —— 缩放：iframe 内快捷键（焦点进入 iframe，由注入脚本转发）——
    await inner.locator("h1#title").click();
    await page.keyboard.press("Control+=");
    await expect.poll(htmlZoom).toBe("1.1");
    await page.keyboard.press("Control+0");
    await expect.poll(htmlZoom).toBe("1");

    // —— 缩放：Ctrl + 滚轮（指针在 iframe 上，注入脚本转发）——
    const box = await frame.boundingBox();
    if (!box) throw new Error("iframe has no bounding box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -120); // 向上滚 = 放大
    await page.keyboard.up("Control");
    await expect.poll(htmlZoom).toBe("1.1");
    await page.keyboard.press("Control+0");
    await expect.poll(htmlZoom).toBe("1");
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
