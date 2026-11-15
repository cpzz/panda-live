import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

/** M38：WYSIWYG 行内格式工具栏、链接弹层、块级工具栏与斜杠菜单。 */
test("M38：WYSIWYG 格式工具栏与斜杠命令", async () => {
  test.setTimeout(180_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m38-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m38-ud-"));
  const filePath = path.join(tempDir, "format.md");
  await fs.writeFile(filePath, "# 标题\n\n第一段文字。\n\n第二段文字。\n", "utf8");

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
    await expect(page.locator(".markdown-body h1")).toHaveText("标题", { timeout: 15_000 });
    await page.getByRole("button", { name: "所见即所得", exact: true }).click();

    const editor = page.locator(".prose-editor");
    await expect(editor).toBeVisible({ timeout: 15_000 });
    // 块级工具栏固定在编辑器顶部。
    await expect(page.locator(".block-toolbar")).toBeVisible();

    // P1：顶部工具栏加粗，选中文字后按钮高亮。
    const paragraph = editor.locator("p").first();
    const boldButton = page.locator('.block-toolbar-button[data-tip^="粗体"]');
    await paragraph.click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await boldButton.click();
    await expect(editor.locator("strong").first()).toBeVisible();
    await expect(boldButton).toHaveAttribute("aria-pressed", "true");
    await boldButton.click();
    await expect(editor.locator("strong")).toHaveCount(0);

    // P2：链接弹层写入 href。
    const linkButton = page.locator('.block-toolbar-button[data-tip^="链接"]');
    await paragraph.click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await linkButton.click();
    const popover = page.locator(".input-popover");
    await expect(popover).toBeVisible();
    await popover.locator("input").fill("https://example.com");
    await popover.getByRole("button", { name: "应用", exact: true }).click();
    await expect(editor.locator('a[href="https://example.com"]')).toBeVisible();

    // 链接可移除：选中已链接文字时链接按钮高亮，弹层提供「移除链接」。
    await paragraph.click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await expect(linkButton).toHaveAttribute("aria-pressed", "true");
    await linkButton.click();
    await expect(popover).toBeVisible();
    await popover.getByRole("button", { name: "移除链接", exact: true }).click();
    await expect(editor.locator("a")).toHaveCount(0);

    // Mod-k 快捷键打开链接弹层，Esc 关闭。
    await paragraph.click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await page.keyboard.press("Control+k");
    await expect(popover).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();

    // P3：段落样式下拉把当前段转为标题 2。
    await paragraph.click();
    await page.locator(".block-toolbar-select").selectOption("h2");
    await expect(editor.locator("h2")).toHaveCount(1);

    // P3：列表与引用再次点击同一按钮可取消，恢复段落。
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("列表项");
    await page.locator('.block-toolbar-button[data-tip="无序列表"]').click();
    await expect(editor.locator("ul li")).toHaveCount(1);
    await page.locator('.block-toolbar-button[data-tip="无序列表"]').click();
    await expect(editor.locator("ul")).toHaveCount(0);
    await page.locator('.block-toolbar-button[data-tip="引用（再次点击取消）"]').click();
    await expect(editor.locator("blockquote")).toHaveCount(1);
    await page.locator('.block-toolbar-button[data-tip="引用（再次点击取消）"]').click();
    await expect(editor.locator("blockquote")).toHaveCount(0);

    // P3：列表内 Enter 新建列表项；有序/无序列表互转。
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("第一项");
    await page.locator('.block-toolbar-button[data-tip="无序列表"]').click();
    await expect(editor.locator("ul li")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await page.keyboard.type("第二项");
    await expect(editor.locator("ul li")).toHaveCount(2);
    await page.locator('.block-toolbar-button[data-tip="有序列表"]').click();
    await expect(editor.locator("ol li")).toHaveCount(2);

    // P0：行内输入规则自动转换粗体、删除线与行内代码。
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("**自动粗体**");
    await expect(editor.locator("strong", { hasText: "自动粗体" })).toBeVisible();
    await page.keyboard.press("Enter");
    await page.keyboard.type("~~自动删除~~");
    await expect(editor.locator("s", { hasText: "自动删除" })).toBeVisible();
    await page.keyboard.press("Enter");
    await page.keyboard.type("`自动代码`");
    await expect(editor.locator("code", { hasText: "自动代码" })).toBeVisible();

    // P4：空段落输入 / 打开斜杠菜单并插入表格。
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    const slashMenu = page.locator(".slash-menu");
    await expect(slashMenu).toBeVisible();
    await slashMenu.getByRole("option", { name: "插入表格", exact: true }).click();
    await expect(editor.locator("table")).toHaveCount(1);

    // P4：插入图片（共用输入弹层）。
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    await expect(slashMenu).toBeVisible();
    await slashMenu.getByRole("option", { name: "插入图片", exact: true }).click();
    await expect(popover).toBeVisible();
    await popover.locator("input").fill("https://example.com/pic.png");
    await popover.getByRole("button", { name: "应用", exact: true }).click();
    // 远程图片受 CSP 限制不会实际加载，这里只确认 image 节点已插入。
    await expect(editor.locator('img[src="https://example.com/pic.png"]')).toBeAttached();

    // 任务列表：输入 `- [ ] ` 自动转为任务项；点击勾选框切换完成状态。
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    // 空列表项再按 Enter 退出列表，回到顶层段落。
    await page.keyboard.press("Enter");
    await page.keyboard.type("- [ ] 支持语法高亮");
    await expect(editor.locator('li.task-item[data-checked="false"]')).toHaveCount(1);
    const taskBox = await editor.locator("li.task-item").first().boundingBox();
    if (!taskBox) throw new Error("任务项未渲染");
    await page.mouse.click(taskBox.x - 10, taskBox.y + 8);
    await expect(editor.locator('li.task-item[data-checked="true"]')).toHaveCount(1);
    // 工具栏「任务列表」再次点击取消任务态，回到普通列表项。
    await page.locator('.block-toolbar-button[data-tip="任务列表"]').click();
    await expect(editor.locator("li.task-item")).toHaveCount(0);
    await page.locator('.block-toolbar-button[data-tip="任务列表"]').click();
    await expect(editor.locator('li.task-item[data-checked="false"]')).toHaveCount(1);
    // 勾选后按 Enter：新建的任务项为未完成。
    await page.mouse.click(taskBox.x - 10, taskBox.y + 8);
    await expect(editor.locator('li.task-item[data-checked="true"]')).toHaveCount(1);
    await page.keyboard.press("Enter");
    await page.keyboard.type("支持更多语言");
    await expect(editor.locator("li.task-item")).toHaveCount(2);
    await expect(editor.locator('li.task-item[data-checked="false"]')).toHaveCount(1);

    // 代码块：输入 ```js 回车创建并带上语言；右上角可切换语言，Tab 缩进两格。
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("```js");
    await page.keyboard.press("Enter");
    const langSelect = editor.locator(".code-lang-select").first();
    await expect(langSelect).toHaveValue("js");
    // 光标在代码块内时，段落样式下拉显示「代码块」而不是「正文」。
    await expect(page.locator(".block-toolbar-select")).toHaveValue("code_block");
    await page.keyboard.type("const a = 1");
    await page.keyboard.press("Home");
    await page.keyboard.press("Tab");
    await expect(editor.locator(".code-block-content").last()).toHaveText(/^ {2}const a = 1/);
    await langSelect.selectOption("python");
    await expect(langSelect).toHaveValue("python");
    await expect(editor.locator('.code-block-node[data-language="python"]')).toHaveCount(1);
    // 失焦后代码块叠加 Shiki 高亮层（预览与 WYSIWYG 共用高亮器）。
    await editor.locator("h1").click();
    const highlight = editor.locator(".code-block-highlight pre.shiki");
    await expect(highlight).toBeVisible({ timeout: 15_000 });
    await expect(highlight).toContainText("const a = 1");
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M38：嵌套引用与页内锚点跳转。 */
test("M38：嵌套引用与页内锚点跳转", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-anchor-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-anchor-ud-"));
  const filePath = path.join(tempDir, "anchor.md");
  await fs.writeFile(
    filePath,
    [
      "# 文档",
      "",
      "[跳到章节一](#章节一)",
      "",
      "[跳到命名锚点](#named-anchor)",
      "",
      "> 外层引用",
      "",
      "## 章节一",
      "",
      "正文。",
      "",
      '<a name="named-anchor"></a>',
      "",
      "## 章节二",
      "",
      ...Array.from({ length: 30 }, (_, index) => `填充段落 ${index + 1}。`),
      "",
      "[回到顶部](#)",
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
    await page.getByRole("button", { name: "所见即所得", exact: true }).click();
    const editor = page.locator(".prose-editor");
    await editor.waitFor();

    // 标题自动锚点：点击 `#章节一` 定位并高亮标题。
    await editor.getByRole("link", { name: "跳到章节一" }).click();
    await expect(editor.locator("h2.anchor-target")).toHaveText("章节一");

    // HTML 命名锚点：`<a name="…">`。
    await editor.getByRole("link", { name: "跳到命名锚点" }).click();
    await expect(editor.locator(".anchor-target")).toHaveCount(1);
    await expect(editor.locator(".html-inline.anchor-target")).toBeVisible();

    // 嵌套引用：引用内 Tab 加深一层，Shift+Tab 退出一层。
    await editor.locator("blockquote p").first().click();
    await page.keyboard.press("Tab");
    await expect(editor.locator("blockquote blockquote")).toHaveCount(1);
    await page.keyboard.press("Shift+Tab");
    await expect(editor.locator("blockquote blockquote")).toHaveCount(0);
    // 工具栏引用按钮在最外层引用内再次点击取消。
    await page.locator('.block-toolbar-button[data-tip="引用（再次点击取消）"]').click();
    await expect(editor.locator("blockquote")).toHaveCount(0);

    // 空锚点 `[回到顶部](#)`：滚动到文档顶部而不是改动 URL。
    const host = page.locator(".wysiwyg-host");
    await editor.getByRole("link", { name: "回到顶部" }).click();
    await expect.poll(() => host.evaluate((element) => element.scrollTop)).toBeLessThan(5);
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M38：粘贴消毒、引用式链接/脚注保留、列表内创建代码块。 */
test("M38：粘贴与原始 Markdown 语法保留", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-paste-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-paste-ud-"));
  const filePath = path.join(tempDir, "paste.md");
  await fs.writeFile(
    filePath,
    [
      "# 粘贴",
      "",
      "引用[^1] 与引用式链接 [示例][ref]。",
      "",
      "[^1]: 脚注内容",
      "",
      "[ref]: https://example.com",
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
    await page.getByRole("button", { name: "所见即所得", exact: true }).click();
    const editor = page.locator(".prose-editor");
    await editor.waitFor();

    // 引用式链接按定义解析为链接；脚注引用保留原始 `[^1]` 文本。
    await expect(editor.getByRole("link", { name: "示例" })).toHaveAttribute(
      "href",
      "https://example.com",
    );
    await expect(editor.locator(".raw-inline")).toHaveText("[^1]");

    // 粘贴 HTML：保留结构与行内格式，丢弃脚本与内联样式。
    const paragraph = editor.locator("p").first();
    await paragraph.click();
    await page.keyboard.press("End");
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData(
        "text/html",
        '<p style="color:red">粘贴<b>粗体</b><script>alert(1)</script></p>',
      );
      document
        .querySelector(".prose-editor")
        ?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(editor.locator("strong", { hasText: "粗体" })).toBeVisible();
    await expect(editor.locator("script")).toHaveCount(0);

    // 列表项首段不能直接替换为代码块时，改为在其后插入。
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("列表项");
    await page.locator('.block-toolbar-button[data-tip="无序列表"]').click();
    await expect(editor.locator("ul li")).toHaveCount(1);
    await page.locator('.block-toolbar-button[data-tip="代码块"]').click();
    await expect(editor.locator("ul li .code-block-node")).toHaveCount(1);
    await expect(editor.locator("ul li p")).toHaveText("列表项");
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M38：切换标签时按文件格式回落视图模式。 */
test("M38：切换标签时视图模式按格式回退", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-mode-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-mode-ud-"));
  const markdownPath = path.join(tempDir, "note.md");
  const textPath = path.join(tempDir, "note.txt");
  await fs.writeFile(markdownPath, "# 标题\n\n正文。\n", "utf8");
  await fs.writeFile(textPath, "纯文本内容\n", "utf8");

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  try {
    const page = await app.firstWindow();
    const mockOpen = async (target: string): Promise<void> => {
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
      }, target);
    };
    await mockOpen(markdownPath);
    await page.getByRole("button", { name: "打开", exact: true }).click();
    await page.getByRole("button", { name: "所见即所得", exact: true }).click();
    const editor = page.locator(".prose-editor");
    await expect(editor).toBeVisible();

    // 打开非 Markdown 标签：当前模式不支持，自动切到源码。
    await mockOpen(textPath);
    await page.getByRole("button", { name: "打开", exact: true }).click();
    await expect(page.locator(".pane.source-pane")).toBeVisible();
    await expect(page.locator(".cm-content")).toContainText("纯文本内容");
    await expect(editor).toBeHidden();

    // 切回 Markdown 标签：恢复该标签上次的「所见即所得」模式。
    await page.getByRole("tab", { name: "note.md" }).click();
    await expect(editor).toBeVisible();
    await expect(page.locator(".pane.source-pane")).toBeHidden();
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M38：表格内代码块提示与引用式链接改地址。 */
test("M38：表格内代码块提示与引用式链接改地址", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-ref-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-ref-ud-"));
  const filePath = path.join(tempDir, "ref.md");
  await fs.writeFile(
    filePath,
    [
      "# 表格",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "引用式 [示例][ref]。",
      "",
      "[ref]: https://example.com",
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
    await page.getByRole("button", { name: "所见即所得", exact: true }).click();
    const editor = page.locator(".prose-editor");
    await editor.waitFor();

    // 表格单元无法容纳代码块：安全失败并给出提示条。
    await editor.locator("td").first().click();
    await page.locator('.block-toolbar-button[data-tip="代码块"]').click();
    await expect(page.locator(".banner", { hasText: "当前位置不能插入代码块" })).toBeVisible();
    await expect(editor.locator("table .code-block-node")).toHaveCount(0);

    // 引用式链接改地址：保留 [文字][id]，同步更新文末定义行。
    await editor.getByRole("link", { name: "示例" }).click();
    await page.locator('.block-toolbar-button[data-tip^="链接"]').click();
    const popover = page.locator(".input-popover");
    await expect(popover.locator("input")).toHaveValue("https://example.com");
    await popover.locator("input").fill("https://example.org");
    await popover.getByRole("button", { name: "应用", exact: true }).click();
    await expect(editor.getByRole("link", { name: "示例" })).toHaveAttribute(
      "href",
      "https://example.org",
    );

    await page.getByRole("button", { name: "源码", exact: true }).click();
    await expect(page.locator(".cm-content")).toContainText("[ref]: https://example.org");
    await expect(page.locator(".cm-content")).toContainText("[示例][ref]");
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M38：粘贴纯文本按 Markdown 解析、粘贴图片写入 assets/。 */
test("M38：粘贴 Markdown 文本与图片", async () => {
  test.setTimeout(150_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-paste2-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-paste2-ud-"));
  const filePath = path.join(tempDir, "paste2.md");
  await fs.writeFile(filePath, "# 粘贴\n\n初始段落。\n\n![大图](big.png)\n", "utf8");
  await fs.writeFile(path.join(tempDir, "big.png"), Buffer.alloc(1_300_000, 1));
  // 1×1 透明 PNG。
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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
    const editor = page.locator(".prose-editor");
    await editor.waitFor();

    // 大图（>1 MB）先显示占位与「加载图片」按钮，点击后才读取。
    const bigPlaceholder = editor.locator(".image-node-placeholder");
    await expect(bigPlaceholder).toBeVisible({ timeout: 15_000 });
    await expect(bigPlaceholder.getByRole("button", { name: "加载图片" })).toBeVisible();
    await bigPlaceholder.getByRole("button", { name: "加载图片" }).click();
    await expect(editor.locator(".image-node img").first()).toHaveAttribute(
      "src",
      /^data:image\/png;base64,/,
      { timeout: 15_000 },
    );

    // 开启「粘贴纯文本时按 Markdown 解析」。
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.locator(".settings-nav").getByRole("button", { name: "编辑", exact: true }).click();
    await page
      .locator("label.settings-row")
      .filter({ hasText: "粘贴纯文本时按 Markdown 解析" })
      .locator('input[type="checkbox"]')
      .check();
    await page.locator(".modal-footer").getByRole("button", { name: "保存", exact: true }).click();
    await page.keyboard.press("Escape");

    // 纯文本按 Markdown 解析：两行列表变为列表项。
    await editor.locator("p").last().click();
    await page.keyboard.press("End");
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData("text/plain", "- 第一项\n- 第二项");
      document
        .querySelector(".prose-editor")
        ?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(editor.locator("ul li")).toHaveCount(2);

    // 粘贴图片：写入文档目录 assets/，编辑器内显示解析后的 data URL。
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.evaluate((base64) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const file = new File([bytes], "pixel.png", { type: "image/png" });
      const data = new DataTransfer();
      data.items.add(file);
      document
        .querySelector(".prose-editor")
        ?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, pngBase64);
    await expect(editor.locator(".image-node img")).toHaveCount(2, { timeout: 15_000 });
    await expect(editor.locator(".image-node img").last()).toHaveAttribute(
      "src",
      /^data:image\/png;base64,/,
      { timeout: 15_000 },
    );
    const assets = await fs.readdir(path.join(tempDir, "assets"));
    expect(assets.some((name) => /^\d{8}-\d{6}-[0-9a-f]{8}\.png$/u.test(name))).toBe(true);

    // 拖入图片：与粘贴共用 assets 转存逻辑。
    await page.keyboard.press("Enter");
    await page.evaluate((base64) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const file = new File([bytes], "dropped.png", { type: "image/png" });
      const data = new DataTransfer();
      data.items.add(file);
      // ProseMirror 的 drop 处理需要可定位的坐标；合成事件必须带上编辑器内的 clientX/Y。
      const host = document.querySelector(".prose-editor");
      const target = host?.lastElementChild ?? host;
      const rect = target?.getBoundingClientRect();
      host?.dispatchEvent(
        new DragEvent("drop", {
          dataTransfer: data,
          bubbles: true,
          cancelable: true,
          clientX: (rect?.left ?? 0) + 10,
          clientY: (rect?.top ?? 0) + 10,
        }),
      );
    }, pngBase64);
    await expect(editor.locator(".image-node img")).toHaveCount(3, { timeout: 15_000 });
    await expect(editor.locator(".image-node img").last()).toHaveAttribute(
      "src",
      /^data:image\/png;base64,/,
      { timeout: 15_000 },
    );
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M38：无路径文档粘贴图片时先另存为。 */
test("M38：无路径文档粘贴图片先另存为", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-untitled-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-untitled-ud-"));
  const savedPath = path.join(tempDir, "saved.md");
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "新建文档", exact: true }).click();
    const editor = page.locator(".prose-editor");
    await editor.waitFor();
    // 另存为对话框返回固定路径。
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    }, savedPath);
    await page.locator(".prose-editor p").first().click();
    await page.evaluate((base64) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const file = new File([bytes], "pixel.png", { type: "image/png" });
      const data = new DataTransfer();
      data.items.add(file);
      document
        .querySelector(".prose-editor")
        ?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, pngBase64);
    await expect(editor.locator(".image-node img")).toHaveAttribute(
      "src",
      /^data:image\/png;base64,/,
      { timeout: 20_000 },
    );
    await expect(page.locator(".tab-name")).toHaveText("saved.md");
    const assets = await fs.readdir(path.join(tempDir, "assets"));
    expect(assets.some((name) => name.endsWith(".png"))).toBe(true);
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M38：固定模式条布局、默认模式与打开 Markdown 的规则。 */
test("M38：模式条布局与默认模式", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-modebar-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-modebar-ud-"));
  const markdownPath = path.join(tempDir, "first.md");
  const secondPath = path.join(tempDir, "second.md");
  const textPath = path.join(tempDir, "plain.txt");
  await fs.writeFile(markdownPath, "# 第一\n\n正文\n", "utf8");
  await fs.writeFile(secondPath, "# 第二\n\n正文\n", "utf8");
  await fs.writeFile(textPath, "纯文本\n", "utf8");

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  try {
    const page = await app.firstWindow();
    const mockOpen = async (target: string): Promise<void> => {
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
      }, target);
    };

    await mockOpen(markdownPath);
    await page.getByRole("button", { name: "打开", exact: true }).click();
    const editor = page.locator(".prose-editor");
    // 打开 Markdown 默认进入所见即所得，模式条固定在文件窗口顶部。
    await expect(editor).toBeVisible();
    const bar = page.locator(".mode-bar");
    await expect(bar).toBeVisible();
    const modes = bar.locator(".mode-bar-modes button");
    await expect(modes).toHaveCount(4);
    await expect(modes.nth(0)).toHaveAccessibleName("源码");
    await expect(modes.nth(1)).toHaveAccessibleName("分栏");
    await expect(modes.nth(2)).toHaveAccessibleName("预览");
    await expect(modes.nth(3)).toHaveAccessibleName("所见即所得");
    await expect(modes.nth(3)).toHaveAttribute("aria-pressed", "true");

    // 块级工具栏在模式条左侧，模式按钮在右侧。
    const tools = bar.locator(".mode-bar-tools .block-toolbar");
    await expect(tools).toBeVisible();
    const toolsBox = await tools.boundingBox();
    const modesBox = await bar.locator(".mode-bar-modes").boundingBox();
    expect(toolsBox).not.toBeNull();
    expect(modesBox).not.toBeNull();
    expect(toolsBox!.x).toBeLessThan(modesBox!.x);

    // 非 WYSIWYG 模式：块级工具栏从模式条移回编辑器面板。
    await page.getByRole("button", { name: "源码", exact: true }).click();
    await expect(bar.locator(".block-toolbar")).toHaveCount(0);

    // 打开 .txt：文本格式同样提供 源码 / 分栏 / 预览，不显示「所见即所得」。
    await mockOpen(textPath);
    await page.getByRole("button", { name: "打开", exact: true }).click();
    const textBar = page.locator(".mode-bar");
    await expect(textBar).toBeVisible();
    const textModes = textBar.locator(".mode-bar-modes button");
    await expect(textModes).toHaveCount(3);
    await expect(textModes.nth(0)).toHaveAccessibleName("源码");
    await expect(textModes.nth(1)).toHaveAccessibleName("分栏");
    await expect(textModes.nth(2)).toHaveAccessibleName("预览");
    // 纯文本预览为只读原文，不再显示「暂不支持渲染预览」占位。
    await textModes.nth(2).click();
    await expect(page.locator(".text-preview")).toHaveText("纯文本");
    await expect(page.locator(".mode-bar-modes button[aria-label='预览']")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // 从 .txt（源码）再打开 Markdown：仍然默认所见即所得。
    await mockOpen(secondPath);
    await page.getByRole("button", { name: "打开", exact: true }).click();
    await expect(page.locator(".prose-editor")).toBeVisible();
    await expect(page.locator(".mode-bar .mode-bar-modes button")).toHaveCount(4);
    await expect(page.locator(".mode-bar .mode-bar-modes button").nth(3)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M38：图表「编辑代码」开关。 */
test("M38：图表代码编辑开关", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-diagram-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-diagram-ud-"));
  const filePath = path.join(tempDir, "diagram.md");
  await fs.writeFile(filePath, "# 图表\n\n```mermaid\ngraph TD\nA-->B\n```\n", "utf8");

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
    await page.getByRole("button", { name: "所见即所得", exact: true }).click();
    const editor = page.locator(".prose-editor");
    const toggle = page.getByRole("button", { name: "编辑代码", exact: true });
    const codeEditor = editor.locator(".diagram-source-editor");

    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(codeEditor).toBeVisible();
    await codeEditor.fill("graph TD\nA-->C");

    // 编辑框内全选/双击选词不再关闭窗口（图表事件不交给 ProseMirror）。
    await codeEditor.press("Control+a");
    await codeEditor.dblclick();
    await expect(codeEditor).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    // 失焦也不关闭：编辑窗只由「编辑代码」按钮控制。
    await editor.locator("h1").click();
    await expect(codeEditor).toBeVisible();

    // 再次点击关闭编辑窗并提交；重新打开可见已保存的代码。
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(codeEditor).toBeHidden();
    // 提交后 NodeView 会重建 DOM，偶发首次点击落在旧节点上，这里重试一次。
    await expect(async () => {
      if (!(await codeEditor.isVisible())) await toggle.click();
      await expect(codeEditor).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    await expect(codeEditor).toHaveValue("graph TD\nA-->C");

    // Esc 关闭编辑窗，按钮回到弹起状态。
    await page.keyboard.press("Escape");
    await expect(codeEditor).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

