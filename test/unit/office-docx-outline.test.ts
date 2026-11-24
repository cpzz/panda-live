import { JSDOM } from "jsdom";
import JSZip from "jszip";
import { describe, expect, test } from "vitest";
import {
  buildDocxOutlineFromDom,
  readDocxStylesXml,
  type DomParserFactory,
} from "../../src/render/office/docx-outline";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const dom = new JSDOM("");
const parserFactory: DomParserFactory = () =>
  new dom.window.DOMParser() as unknown as ReturnType<DomParserFactory>;

function makeStylesXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<w:styles xmlns:w="${W}">`,
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="MyTitle"><w:basedOn w:val="Heading1"/></w:style>',
    '<w:style w:type="paragraph" w:styleId="CycleA"><w:basedOn w:val="CycleB"/></w:style>',
    '<w:style w:type="paragraph" w:styleId="CycleB"><w:basedOn w:val="CycleA"/></w:style>',
    '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>',
    "</w:styles>",
  ].join("");
}

function makeContainer(html: string): HTMLElement {
  const element = dom.window.document.createElement("div");
  element.innerHTML = html;
  return element as unknown as HTMLElement;
}

describe("Word 大纲（docx-outline）", () => {
  test("按 styles.xml 层级从渲染 DOM 提取标题并标记序号", () => {
    const container = makeContainer(
      [
        '<p class="office-docx office-docx_heading1">第一章　总则</p>',
        '<p class="office-docx">正文段落</p>',
        '<p class="office-docx office-docx_mytitle"><span>附录</span> A</p>',
        '<p class="office-docx office-docx_heading2">1.1 范围</p>',
        '<p class="office-docx office-docx_normal">普通样式</p>',
      ].join(""),
    );
    const items = buildDocxOutlineFromDom(container, makeStylesXml(), parserFactory);
    expect(items.map((item) => ({ index: item.index, level: item.level, text: item.text }))).toEqual([
      { index: 0, level: 1, text: "第一章 总则" },
      { index: 1, level: 1, text: "附录 A" },
      { index: 2, level: 2, text: "1.1 范围" },
    ]);
    expect(items.every((item) => item.kind === "heading" && item.symbol === "标题")).toBe(true);
    const paragraphs = Array.from(container.querySelectorAll("p"));
    expect(paragraphs.map((item) => item.getAttribute("data-docx-heading"))).toEqual([
      "0",
      null,
      "1",
      "2",
      null,
    ]);
  });

  test("内建 Heading N 名称兜底（无 outlineLvl）", () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<w:styles xmlns:w="${W}">`,
      '<w:style w:type="paragraph" w:styleId="Custom3"><w:name w:val="Heading 3"/></w:style>',
      "</w:styles>",
    ].join("");
    const container = makeContainer('<p class="office-docx office-docx_custom3">三级标题</p>');
    expect(buildDocxOutlineFromDom(container, xml, parserFactory).map((item) => item.level)).toEqual([
      3,
    ]);
  });

  test("无 styles.xml 或样式无层级时不产生大纲、不打标记", () => {
    const container = makeContainer('<p class="office-docx office-docx_heading1">标题</p>');
    expect(buildDocxOutlineFromDom(container, null, parserFactory)).toEqual([]);
    expect(container.querySelector("p")?.hasAttribute("data-docx-heading")).toBe(false);
    const emptyStyles = `<?xml version="1.0"?><w:styles xmlns:w="${W}"></w:styles>`;
    expect(buildDocxOutlineFromDom(container, emptyStyles, parserFactory)).toEqual([]);
  });

  test("无标题样式的手动排版文档：按字号/加粗推断层级", () => {
    const container = makeContainer(
      [
        '<p><span style="font-weight: bold; font-size: 18pt;">手动大标题</span></p>',
        '<p><span style="font-weight: bold; font-size: 14pt;">手动二级标题</span></p>',
        '<p><span style="font-size: 10.5pt;">这里是正文内容，没有使用任何标题样式，字号为小四。</span></p>',
      ].join(""),
    );
    const items = buildDocxOutlineFromDom(container, null, parserFactory);
    expect(items.map((item) => ({ level: item.level, text: item.text }))).toEqual([
      { level: 1, text: "手动大标题" },
      { level: 2, text: "手动二级标题" },
    ]);
    expect(container.querySelector("p")?.getAttribute("data-docx-heading")).toBe("0");
  });

  test("段落直接设 outlineLvl 但无标题样式时按文本兜底", () => {
    const container = makeContainer(
      [
        '<p><span>段落级标题</span></p>',
        '<p><span>正文</span></p>',
      ].join(""),
    );
    const documentXml = [
      '<?xml version="1.0"?>',
      `<w:document xmlns:w="${W}"><w:body>`,
      '<w:p><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:r><w:t>段落级标题</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>正文</w:t></w:r></w:p>',
      "</w:body></w:document>",
    ].join("");
    expect(
      buildDocxOutlineFromDom(container, null, parserFactory, documentXml).map((item) => ({
        level: item.level,
        text: item.text,
      })),
    ).toEqual([{ level: 3, text: "段落级标题" }]);
  });

  test("中文标题样式名（标题 1 / 标题一）可识别", () => {
    const xml = [
      '<?xml version="1.0"?>',
      `<w:styles xmlns:w="${W}">`,
      '<w:style w:type="paragraph" w:styleId="1"><w:name w:val="标题 1"/></w:style>',
      '<w:style w:type="paragraph" w:styleId="二"><w:name w:val="标题二"/></w:style>',
      "</w:styles>",
    ].join("");
    const container = makeContainer(
      [
        '<p class="office-docx office-docx_1">中文一级</p>',
        '<p class="office-docx office-docx_二">中文二级</p>',
      ].join(""),
    );
    expect(buildDocxOutlineFromDom(container, xml, parserFactory).map((item) => item.level)).toEqual([
      1, 2,
    ]);
  });

  test("readDocxStylesXml 从 zip 读取；缺失时返回 null", async () => {
    const zip = new JSZip();
    zip.file("word/styles.xml", makeStylesXml());
    const bytes = await zip.generateAsync({ type: "uint8array" });
    expect(await readDocxStylesXml(bytes)).toContain("Heading1");
    const withoutStyles = new JSZip();
    withoutStyles.file("word/document.xml", "<w:document/>");
    const otherBytes = await withoutStyles.generateAsync({ type: "uint8array" });
    expect(await readDocxStylesXml(otherBytes)).toBeNull();
    expect(await readDocxStylesXml(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
