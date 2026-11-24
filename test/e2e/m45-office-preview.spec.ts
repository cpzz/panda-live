import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import * as XLSX from "xlsx";

const CWD = path.resolve(".");

const OOXML = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  rel: "http://schemas.openxmlformats.org/package/2006/relationships",
} as const;

/** 最小 docx：内容类型 + 根关系 + 单段文本。 */
async function makeDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
      "</Types>",
    ].join(""),
  );
  zip.file(
    "_rels/.rels",
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      `<Relationships xmlns="${OOXML.rel}">`,
      `<Relationship Id="rId1" Type="${OOXML.r}/officeDocument" Target="word/document.xml"/>`,
      "</Relationships>",
    ].join(""),
  );
  zip.file(
    "word/styles.xml",
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      `<w:styles xmlns:w="${OOXML.w}">`,
      '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>',
      "</w:styles>",
    ].join(""),
  );
  zip.file(
    "word/document.xml",
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      `<w:document xmlns:w="${OOXML.w}">`,
      "<w:body>",
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 总则</w:t></w:r></w:p>',
      "<w:p><w:r><w:t>Hello Panda Word</w:t></w:r></w:p>",
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第二章 附则</w:t></w:r></w:p>',
      "</w:body>",
      "</w:document>",
    ].join(""),
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

/** 最小 xlsx：两行两列 + 命名工作表。 */
function makeXlsx(): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([["名称", "数量"], ["大熊猫", 42]]);
  XLSX.utils.book_append_sheet(workbook, sheet, "名单");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** 最小 pptx：单页幻灯片，文本形状。 */
async function makePptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
      '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>',
      "</Types>",
    ].join(""),
  );
  zip.file(
    "_rels/.rels",
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      `<Relationships xmlns="${OOXML.rel}">`,
      `<Relationship Id="rId1" Type="${OOXML.r}/officeDocument" Target="ppt/presentation.xml"/>`,
      "</Relationships>",
    ].join(""),
  );
  zip.file(
    "ppt/presentation.xml",
    [
      `<p:presentation xmlns:p="${OOXML.p}" xmlns:r="${OOXML.r}">`,
      `<p:sldSz cx="12192000" cy="6858000"/>`,
      `<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>`,
      "</p:presentation>",
    ].join(""),
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    [
      `<Relationships xmlns="${OOXML.rel}">`,
      `<Relationship Id="rId2" Type="${OOXML.r}/slide" Target="slides/slide1.xml"/>`,
      "</Relationships>",
    ].join(""),
  );
  zip.file(
    "ppt/slides/slide1.xml",
    [
      `<p:sld xmlns:p="${OOXML.p}" xmlns:a="${OOXML.a}" xmlns:r="${OOXML.r}">`,
      "<p:cSld><p:spTree>",
      `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/></p:nvGrpSpPr><p:grpSpPr/>`,
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`,
      `<p:spPr><a:xfrm><a:off x="914400" y="274638"/><a:ext cx="8229600" cy="1143000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`,
      `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="2400" dirty="0"/><a:t>幻灯片标题</a:t></a:r></a:p></p:txBody>`,
      "</p:sp>",
      "</p:spTree></p:cSld>",
      "</p:sld>",
    ].join(""),
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
}

async function openFile(app: ElectronApplication, page: Page, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, filePath);
  await page.locator(".app").waitFor();
  await page.keyboard.press("Control+O");
}

/** M45：Word 文档按二进制只读打开，连续流式渲染（无分页块、无模式条），缩放工具栏同 PDF/PPT，侧栏大纲可跳转。 */
test("M45：Word 只读预览（连续流式、缩放与大纲）", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m45-docx-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m45-docx-ud-"));
  const filePath = path.join(tempDir, "doc.docx");
  await fs.writeFile(filePath, await makeDocx());

  const app = await launchApp(userDataDir);
  try {
    const page = await app.firstWindow();
    await openFile(app, page, filePath);
    await expect(page.locator(".tab-item.active .tab-name")).toHaveText("doc.docx");

    // 二进制只读：模式条隐藏，状态栏 Word · 只读。
    await expect(page.locator(".mode-bar")).toHaveCount(0);
    await expect(page.locator(".statusbar")).toContainText("Word");
    await expect(page.locator(".statusbar")).toContainText("只读");

    // 连续流式：渲染出真实文本，无分页页面块（breakPages 关闭后无 .office-docx-page）。
    const body = page.locator(".office-docx-body");
    await expect(body).toContainText("Hello Panda Word", { timeout: 30_000 });
    await expect(body.locator(".office-docx-page")).toHaveCount(0);

    // 缩放工具栏：主控件靠左、复位与页宽显示靠右；初始 100%。
    const toolbar = page.locator(".office-toolbar");
    await expect(toolbar).toBeVisible();
    // 工具栏通栏到面板两端：左右缘与 .office-viewer 对齐（负 margin 抵消 12px 内边距，无侧边留白）。
    const viewerBox = await page.locator(".office-viewer").boundingBox();
    const toolbarBox = await toolbar.boundingBox();
    expect(viewerBox).not.toBeNull();
    expect(toolbarBox).not.toBeNull();
    expect(Math.abs(toolbarBox!.x - viewerBox!.x)).toBeLessThan(1);
    expect(
      Math.abs(toolbarBox!.x + toolbarBox!.width - (viewerBox!.x + viewerBox!.width)),
    ).toBeLessThan(1);
    await expect(toolbar.locator(".diagram-zoom-primary .diagram-zoom-input")).toBeVisible();
    const defaultView = toolbar.getByRole("button", { name: "默认显示" });
    const fitWidth = toolbar.getByRole("button", { name: "页宽显示" });
    await expect(defaultView).toBeVisible();
    await expect(fitWidth).toBeVisible();
    await expect(defaultView).toBeDisabled();
    await expect(fitWidth).toBeEnabled();
    const zoomInput = toolbar.locator(".diagram-zoom-input");
    await expect(zoomInput).toHaveValue("100");
    const pagesZoom = (): Promise<string> =>
      page.locator(".office-docx-pages").evaluate((el) => (el as HTMLElement).style.zoom);
    await toolbar.getByRole("button", { name: "放大" }).click();
    await expect(zoomInput).toHaveValue("110");
    await expect.poll(pagesZoom).toBe("1.1");
    await expect(defaultView).toBeEnabled();
    await expect(fitWidth).toBeEnabled();
    await defaultView.click();
    await expect(zoomInput).toHaveValue("100");
    await expect.poll(pagesZoom).toBe("1");
    await expect(defaultView).toBeDisabled();
    await expect(fitWidth).toBeEnabled();
    // 页宽显示：文档宽度恰好铺满视口，不应产生横向滚动条。
    await fitWidth.click();
    await expect
      .poll(() =>
        page.locator(".office-viewer").evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      )
      .toBe(true);
    await expect(fitWidth).toBeDisabled();
    await expect(defaultView).toBeEnabled();

    // 大纲：标题段落按渲染顺序打标，侧栏大纲列出标题并可点击定位。
    await expect(page.locator(".office-docx [data-docx-heading='0']")).toContainText("第一章 总则");
    await expect(page.locator(".office-docx [data-docx-heading='1']")).toContainText("第二章 附则");
    const railOutline = page.locator(".sidebar-rail-button[aria-label='大纲']");
    if (await railOutline.isVisible()) await railOutline.click();
    else await page.locator(".sidebar-tab", { hasText: "大纲" }).click();
    const outlineItem = page.locator(".outline-item", { hasText: "第一章 总则" });
    await expect(outlineItem).toBeVisible({ timeout: 10_000 });
    await outlineItem.click();
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M45：Excel 工作簿解析为表格，工作表标签可切换。 */
test("M45：Excel 只读预览（工作表标签与表格）", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m45-xlsx-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m45-xlsx-ud-"));
  const filePath = path.join(tempDir, "book.xlsx");
  await fs.writeFile(filePath, makeXlsx());

  const app = await launchApp(userDataDir);
  try {
    const page = await app.firstWindow();
    await openFile(app, page, filePath);
    await expect(page.locator(".tab-item.active .tab-name")).toHaveText("book.xlsx");

    await expect(page.locator(".mode-bar")).toHaveCount(0);
    await expect(page.locator(".statusbar")).toContainText("Excel");
    await expect(page.locator(".statusbar")).toContainText("只读");

    // 单工作表不显示标签栏；表格渲染单元格内容。
    await expect(page.locator(".office-sheet-tabs")).toHaveCount(0);
    const table = page.locator(".office-xlsx-table");
    await expect(table).toBeVisible({ timeout: 30_000 });
    await expect(table).toContainText("大熊猫");
    await expect(table).toContainText("42");
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M45：PowerPoint 幻灯片竖排，缩放工具栏与快捷键同 PDF/图表/图片。 */
test("M45：PowerPoint 只读预览与缩放", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m45-pptx-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m45-pptx-ud-"));
  const filePath = path.join(tempDir, "deck.pptx");
  await fs.writeFile(filePath, await makePptx());

  const app = await launchApp(userDataDir);
  try {
    const page = await app.firstWindow();
    await openFile(app, page, filePath);
    await expect(page.locator(".tab-item.active .tab-name")).toHaveText("deck.pptx");

    await expect(page.locator(".mode-bar")).toHaveCount(0);
    await expect(page.locator(".statusbar")).toContainText("PowerPoint");
    await expect(page.locator(".statusbar")).toContainText("只读");

    // 单页幻灯片渲染文本与页码标签。
    const slide = page.locator(".office-pptx-slide");
    await expect(slide).toHaveCount(1, { timeout: 30_000 });
    await expect(slide.locator(".office-pptx-body")).toContainText("幻灯片标题");
    await expect(slide.locator(".office-pptx-label")).toHaveText("1");

    // 缩放工具栏：初始 100%，点「放大」到 110%，复位回 100%。
    const toolbar = page.locator(".office-toolbar");
    await expect(toolbar).toBeVisible();
    const zoomInput = toolbar.locator(".diagram-zoom-input");
    const defaultView = toolbar.getByRole("button", { name: "默认显示" });
    const fitWidth = toolbar.getByRole("button", { name: "页宽显示" });
    await expect(zoomInput).toHaveValue("100");
    await expect(defaultView).toBeDisabled();
    await expect(fitWidth).toBeEnabled();
    const pagesZoom = (): Promise<string> =>
      page.locator(".office-pptx-pages").evaluate((el) => (el as HTMLElement).style.zoom);
    await toolbar.getByRole("button", { name: "放大" }).click();
    await expect(zoomInput).toHaveValue("110");
    await expect.poll(pagesZoom).toBe("1.1");
    await expect(defaultView).toBeEnabled();
    await expect(fitWidth).toBeEnabled();
    await defaultView.click();
    await expect(zoomInput).toHaveValue("100");
    await expect.poll(pagesZoom).toBe("1");
    await expect(defaultView).toBeDisabled();
    await expect(fitWidth).toBeEnabled();
    await fitWidth.click();
    await expect(fitWidth).toBeDisabled();
    await expect(defaultView).toBeEnabled();
    await defaultView.click();
    await expect(zoomInput).toHaveValue("100");

    // 父窗口快捷键：Ctrl+= 放大、Ctrl+0 复位。
    await page.locator(".office-pptx-slide").click();
    await page.keyboard.press("Control+=");
    await expect.poll(pagesZoom).toBe("1.1");
    await page.keyboard.press("Control+0");
    await expect.poll(pagesZoom).toBe("1");
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M45：旧版 OLE2 容器（.doc）不支持解析，给出另存为新格式提示。 */
test("M45：旧版 .doc 提示另存为 .docx", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m45-doc-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m45-doc-ud-"));
  const filePath = path.join(tempDir, "legacy.doc");
  // OLE2 复合文档魔数 + 填充，足以触发容器识别。
  const ole2 = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]);
  await fs.writeFile(filePath, ole2);

  const app = await launchApp(userDataDir);
  try {
    const page = await app.firstWindow();
    await openFile(app, page, filePath);
    await expect(page.locator(".tab-item.active .tab-name")).toHaveText("legacy.doc");

    const message = page.locator(".office-message");
    await expect(message).toBeVisible({ timeout: 30_000 });
    await expect(message).toContainText("不支持旧版 Word 二进制格式");
    await expect(message).toContainText(".docx");
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
