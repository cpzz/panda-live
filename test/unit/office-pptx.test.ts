import { JSDOM } from "jsdom";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { pptxToSlideHtml } from "../../src/render/office/pptx-html";

const NS = {
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  rel: "http://schemas.openxmlformats.org/package/2006/relationships",
} as const;

function textShape(id: number, name: string, x: number, y: number, cx: number, cy: number, text: string): string {
  return [
    `<p:sp>`,
    `<p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`,
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`,
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="2400" dirty="0"/><a:t>${text}</a:t></a:r></a:p></p:txBody>`,
    `</p:sp>`,
  ].join("");
}

/** 手造最小 pptx：两页幻灯片（验证演示顺序与多页输出）。 */
async function makePptx(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file(
    "ppt/presentation.xml",
    [
      `<p:presentation xmlns:p="${NS.p}" xmlns:r="${NS.r}">`,
      `<p:sldSz cx="12192000" cy="6858000"/>`,
      `<p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst>`,
      `</p:presentation>`,
    ].join(""),
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    [
      `<Relationships xmlns="${NS.rel}">`,
      `<Relationship Id="rId2" Type="${NS.r}/slide" Target="slides/slide1.xml"/>`,
      `<Relationship Id="rId3" Type="${NS.r}/slide" Target="slides/slide2.xml"/>`,
      `</Relationships>`,
    ].join(""),
  );
  zip.file(
    "ppt/slides/slide1.xml",
    [
      `<p:sld xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}">`,
      `<p:cSld><p:spTree>`,
      `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/></p:nvGrpSpPr><p:grpSpPr/>`,
      textShape(2, "Title 1", 914400, 274638, 8229600, 1143000, "第一页标题"),
      `</p:spTree></p:cSld>`,
      `</p:sld>`,
    ].join(""),
  );
  zip.file(
    "ppt/slides/slide2.xml",
    [
      `<p:sld xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}">`,
      `<p:cSld><p:spTree>`,
      `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/></p:nvGrpSpPr><p:grpSpPr/>`,
      // OOXML 源文件中 & 必须以 &amp; 转义（真实 pptx 均如此），严格解析器不容忍裸 &。
      textShape(2, "Title 2", 914400, 274638, 8229600, 1143000, "第二页内容 &amp; 符号"),
      `</p:spTree></p:cSld>`,
      `</p:sld>`,
    ].join(""),
  );
  return zip.generateAsync({ type: "arraybuffer" });
}

// Node 环境没有全局 DOMParser，注入 jsdom 解析器（库依赖 querySelector，xmldom 不支持）。
const dom = new JSDOM("");
const domParserFactory = (): { parseFromString(xml: string, mime: string): Document } =>
  new dom.window.DOMParser() as unknown as { parseFromString(xml: string, mime: string): Document };

describe("pptxToSlideHtml", () => {
  it("按演示顺序输出每页 HTML 并包含文本", async () => {
    const buffer = await makePptx();
    const slides = await pptxToSlideHtml(buffer, { domParserFactory });
    expect(slides).toHaveLength(2);
    expect(slides[0]).toContain("第一页标题");
    expect(slides[1]).toContain("第二页内容");
  });

  it("文本经 HTML 转义（& 不破坏结构）", async () => {
    const buffer = await makePptx();
    const slides = await pptxToSlideHtml(buffer, { domParserFactory });
    expect(slides[1]).toContain("&amp;");
    expect(slides[1]).not.toContain("内容 & 符号");
  });

  it("缺少 presentation.xml 时回退到 slide 文件扫描", async () => {
    const zip = new JSZip();
    zip.file(
      "ppt/slides/slide1.xml",
      [
        `<p:sld xmlns:p="${NS.p}" xmlns:a="${NS.a}">`,
        `<p:cSld><p:spTree>`,
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/></p:nvGrpSpPr><p:grpSpPr/>`,
        textShape(2, "Title", 914400, 274638, 8229600, 1143000, "回退页"),
        `</p:spTree></p:cSld>`,
        `</p:sld>`,
      ].join(""),
    );
    const buffer = await zip.generateAsync({ type: "arraybuffer" });
    const slides = await pptxToSlideHtml(buffer, { domParserFactory });
    expect(slides).toHaveLength(1);
    expect(slides[0]).toContain("回退页");
  });
});
