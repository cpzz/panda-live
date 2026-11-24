import JSZip from "jszip";
import { JSDOM } from "jsdom";
import { expect, test } from "vitest";
import { renderAsync } from "docx-preview";
import {
  buildDocxOutlineFromDom,
  readDocxDocumentXml,
  readDocxStylesXml,
} from "../../src/render/office/docx-outline";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** 真实 docx-preview 渲染回归：样式名非 Heading N 时，视觉字号仍需提取为大纲。 */
test("真实渲染：自定义样式设字号的标题可提取大纲", async () => {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/styles.xml",
    `<w:styles xmlns:w="${W}">
<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/><w:rPr><w:sz w:val="21"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="s1"><w:name w:val="自定义标题"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
</w:styles>`,
  );
  zip.file(
    "word/document.xml",
    `<w:document xmlns:w="${W}"><w:body>
<w:p><w:pPr><w:pStyle w:val="s1"/></w:pPr><w:r><w:t>自定义标题</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="a"/></w:pPr><w:r><w:t>正文内容</w:t></w:r></w:p>
</w:body></w:document>`,
  );
  const bytes = new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
  const dom = new JSDOM("<!doctype html><html><body><div id='body'></div><div id='style'></div></body></html>");
  const body = dom.window.document.getElementById("body")!;
  const style = dom.window.document.getElementById("style")!;
  // docx-preview 依赖全局 DOMParser/Blob 等；测试注入 jsdom 实现。
  Object.assign(globalThis, {
    DOMParser: dom.window.DOMParser,
    Blob: dom.window.Blob,
    window: dom.window,
    document: dom.window.document,
    XMLSerializer: dom.window.XMLSerializer,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    DocumentFragment: dom.window.DocumentFragment,
    Text: dom.window.Text,
    CDATA_SECTION_NODE: dom.window.Node.CDATA_SECTION_NODE,
  });
  await renderAsync(bytes, body as unknown as HTMLElement, style as unknown as HTMLElement, {
    className: "office-docx",
    inWrapper: true,
    breakPages: false,
  });
  const items = buildDocxOutlineFromDom(
    body as unknown as HTMLElement,
    await readDocxStylesXml(bytes),
    undefined,
    await readDocxDocumentXml(bytes),
  );
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ level: 1, text: "自定义标题", kind: "heading" });
  // 标记必须落在真实渲染的段落上，侧栏跳转才能滚动到目标。
  expect(body.querySelector("p[data-docx-heading='0']")?.textContent).toBe("自定义标题");
});

/**
 * 真实文档回归：styles.xml 定义了 Heading1–9（Word 默认样式表），但所有段落都没有 pStyle，
 * 标题仅靠加粗表示（整段加粗 / 段首「1. 标题」加粗 + 后接正文）。
 * 必须排除编号列表项和表格单元格（表头也常整格加粗）。
 */
test("真实渲染：仅靠加粗且未使用标题样式的文档可提取大纲", async () => {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`,
  );
  // 关键：定义了 Heading1 层级，但文档段落一个都不用——语义提取会返回空，必须触发兜底。
  zip.file(
    "word/styles.xml",
    `<w:styles xmlns:w="${W}">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
</w:styles>`,
  );
  zip.file(
    "word/numbering.xml",
    `<w:numbering xmlns:w="${W}">
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`,
  );
  zip.file(
    "word/document.xml",
    `<w:document xmlns:w="${W}"><w:body>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>增强功能一：测试标题</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>1. 痛点分析</w:t></w:r><w:r><w:t>这是一段很长的正文内容，用来确保加粗前缀远小于段落总长度。</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>列表项</w:t></w:r><w:r><w:t>：这是列表项正文，不应进入大纲。</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>表头</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`,
  );
  const bytes = new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
  const dom = new JSDOM("<!doctype html><html><body><div id='body'></div><div id='style'></div></body></html>");
  const body = dom.window.document.getElementById("body")!;
  const style = dom.window.document.getElementById("style")!;
  Object.assign(globalThis, {
    DOMParser: dom.window.DOMParser,
    Blob: dom.window.Blob,
    window: dom.window,
    document: dom.window.document,
    XMLSerializer: dom.window.XMLSerializer,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    DocumentFragment: dom.window.DocumentFragment,
    Text: dom.window.Text,
    CDATA_SECTION_NODE: dom.window.Node.CDATA_SECTION_NODE,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  });
  await renderAsync(bytes, body as unknown as HTMLElement, style as unknown as HTMLElement, {
    className: "office-docx",
    inWrapper: true,
    breakPages: false,
  });
  const items = buildDocxOutlineFromDom(
    body as unknown as HTMLElement,
    await readDocxStylesXml(bytes),
    undefined,
    await readDocxDocumentXml(bytes),
  );
  expect(items).toHaveLength(2);
  expect(items[0]).toMatchObject({ level: 1, text: "增强功能一：测试标题" });
  expect(items[1]).toMatchObject({ level: 2, text: "1. 痛点分析" });
  expect(items.some((item) => item.text.includes("列表项") || item.text === "表头")).toBe(false);
});
