/** Word 文档大纲：从 docx 包内的 styles.xml 解析标题层级，再从渲染后的 DOM 提取标题项。
 *
 * docx-preview 把段落一律渲染为 <p>，样式名以 class `office-docx_<styleId>` 附加，
 * 且解析 styles.xml 时会跳过 outlineLvl——因此没有可查询的 h1..h6 或层级信息。
 * 这里在渲染完成后遍历真实 DOM（与展示顺序 1:1，包含 VML 文本框内的段落），
 * 按「有大纲层级的样式 cssName → level」映射提取，并给命中的段落打上 data-docx-heading，
 * 供侧栏大纲按 index 定位。层级来自 word/styles.xml 的 w:outlineLvl、
 * 内建 Heading N 名称/ID，或 w:basedOn 继承链（带环保护）。 */

import JSZip from "jszip";
import type { OutlineItem } from "../../formats/outline";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const CLASS_PREFIX = "office-docx_";

/** docx-preview 的 escapeClassName：空格/点 → `-`，`&` → `and`，整体小写。 */
function escapeStyleId(styleId: string): string {
  return styleId.replace(/[ .]+/g, "-").replace(/[&]+/g, "and").toLowerCase();
}

function cssNameForStyle(styleId: string): string {
  return `${CLASS_PREFIX}${escapeStyleId(styleId)}`;
}

/* 结构类型：同时兼容 Electron renderer 的原生 DOMParser 与测试用的 jsdom。 */
interface XmlAttr {
  readonly name: string;
  readonly value: string;
}
interface XmlNode {
  readonly nodeName: string;
  readonly textContent: string | null;
  readonly attributes: { readonly length: number; item(index: number): XmlAttr | null };
  readonly childNodes: { readonly length: number; item(index: number): XmlNode | null };
}
interface XmlList {
  readonly length: number;
  item(index: number): XmlNode | null;
}
export interface DomParserLike {
  parseFromString(xml: string, mimeType: string): {
    getElementsByTagNameNS(namespace: string, localName: string): XmlList;
  };
}
export type DomParserFactory = () => DomParserLike;

function toArray<T>(list: { readonly length: number; item(index: number): T | null }): T[] {
  const result: T[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const value = list.item(index);
    if (value) result.push(value);
  }
  return result;
}

function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

function attrValue(node: XmlNode | null, name: string): string | null {
  if (!node) return null;
  return toArray(node.attributes).find((attr) => attr.name === name)?.value ?? null;
}

function descendants(node: XmlNode, name: string): XmlNode[] {
  const result: XmlNode[] = [];
  const walk = (parent: XmlNode): void => {
    for (const child of toArray(parent.childNodes)) {
      if (localName(child.nodeName) === name) result.push(child);
      walk(child);
    }
  };
  walk(node);
  return result;
}

const CN_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/**
 * 标题样式名/ID → 层级。覆盖英文 Heading N、中文「标题 N / 标题一」，
 * 以及 WPS/中文 Word 常见的纯数字 styleId（此时须配合样式名确认，避免误判）。
 */
function builtinHeadingLevel(text: string, hint?: string): number | null {
  const value = text.trim();
  let match = /^heading\s*([1-9])$/iu.exec(value);
  if (match) return Number(match[1]);
  match = /^标题\s*([1-9])$/u.exec(value);
  if (match) return Number(match[1]);
  match = /^标题\s*([一二三四五六七八九])$/u.exec(value);
  if (match) return CN_DIGITS[match[1]!] ?? null;
  if (/^[1-9]$/u.test(value) && hint && /标题|heading/iu.test(hint)) return Number(value);
  return null;
}

interface StyleInfo {
  name: string;
  outlineLevel: number | null;
  basedOn: string | null;
}

/** 解析 styles.xml，返回「css class 名 → 大纲层级（从 1 开始）」。 */
function parseHeadingLevels(xml: string | null, factory: DomParserFactory): Map<string, number> {
  const levels = new Map<string, number>();
  if (!xml) return levels;
  let doc: ReturnType<DomParserLike["parseFromString"]>;
  try {
    doc = factory().parseFromString(xml, "application/xml");
  } catch {
    return levels;
  }
  const styles = new Map<string, StyleInfo>();
  for (const style of toArray(doc.getElementsByTagNameNS(W_NS, "style"))) {
    const styleId = attrValue(style, "w:styleId");
    if (!styleId) continue;
    const levelText = attrValue(descendants(style, "outlineLvl")[0] ?? null, "w:val");
    const parsed = levelText === null ? Number.NaN : Number(levelText);
    styles.set(styleId, {
      name: attrValue(descendants(style, "name")[0] ?? null, "w:val") ?? "",
      outlineLevel: Number.isInteger(parsed) && parsed >= 0 && parsed <= 8 ? parsed + 1 : null,
      basedOn: attrValue(descendants(style, "basedOn")[0] ?? null, "w:val"),
    });
  }
  const resolve = (styleId: string, chain: Set<string>): number | null => {
    const info = styles.get(styleId);
    if (!info || chain.has(styleId)) return null;
    chain.add(styleId);
    if (info.outlineLevel !== null) return info.outlineLevel;
    const builtin = builtinHeadingLevel(info.name) ?? builtinHeadingLevel(styleId, info.name);
    if (builtin !== null) return builtin;
    return info.basedOn ? resolve(info.basedOn, chain) : null;
  };
  for (const styleId of styles.keys()) {
    const level = resolve(styleId, new Set<string>());
    if (level !== null) levels.set(cssNameForStyle(styleId), level);
  }
  return levels;
}

function defaultFactory(): DomParserLike {
  return new DOMParser() as unknown as DomParserLike;
}

interface StyleVisual {
  readonly sizePt: number | null;
  readonly bold: boolean;
  readonly basedOn: string | null;
}

/** 解析 styles.xml 中所有段落样式的视觉属性：w:sz 是半点单位，w:b 表示加粗。 */
function parseStyleVisuals(xml: string | null, factory: DomParserFactory): Map<string, StyleVisual> {
  const result = new Map<string, StyleVisual>();
  if (!xml) return result;
  let doc: ReturnType<DomParserLike["parseFromString"]>;
  try {
    doc = factory().parseFromString(xml, "application/xml");
  } catch {
    return result;
  }
  for (const style of toArray(doc.getElementsByTagNameNS(W_NS, "style"))) {
    const styleId = attrValue(style, "w:styleId");
    if (!styleId) continue;
    // 中文 Word/WPS 有时只写 szCs（复杂脚本字号），需兜底读取。
    const sizeNode = descendants(style, "sz")[0] ?? descendants(style, "szCs")[0] ?? null;
    const sizeText = attrValue(sizeNode, "w:val");
    const halfPoints = sizeText === null ? Number.NaN : Number(sizeText);
    const bold = descendants(style, "b").some((node) => {
      const value = attrValue(node, "w:val");
      return value === null || !/^(0|false|off)$/iu.test(value);
    });
    result.set(styleId, {
      sizePt: Number.isFinite(halfPoints) && halfPoints > 0 ? halfPoints / 2 : null,
      bold,
      basedOn: attrValue(descendants(style, "basedOn")[0] ?? null, "w:val"),
    });
  }
  return result;
}

/** 沿 w:basedOn 继承链补全字号与加粗（带环保护）。 */
function resolveStyleVisual(
  styleId: string,
  styles: Map<string, StyleVisual>,
  chain: Set<string>,
): StyleVisual {
  const info = styles.get(styleId);
  if (!info || chain.has(styleId)) return { sizePt: null, bold: false, basedOn: null };
  chain.add(styleId);
  const parent = info.basedOn ? resolveStyleVisual(info.basedOn, styles, chain) : null;
  return {
    sizePt: info.sizePt ?? parent?.sizePt ?? null,
    bold: info.bold || parent?.bold || false,
    basedOn: info.basedOn,
  };
}

/** docx-preview 生成的 css class → 视觉属性，供视觉兜底读取（样式名非标题的自定义样式）。 */
function styleVisualsByClass(
  stylesXml: string | null,
  factory: DomParserFactory,
): Map<string, StyleVisual> {
  const raw = parseStyleVisuals(stylesXml, factory);
  const result = new Map<string, StyleVisual>();
  for (const styleId of raw.keys()) {
    const visual = resolveStyleVisual(styleId, raw, new Set<string>());
    if (visual.sizePt !== null || visual.bold) result.set(cssNameForStyle(styleId), visual);
  }
  return result;
}

/** 把 docx-preview 输出的 inline font-size（如 "18pt"）解析为 pt 数值。 */
function fontSizePt(element: HTMLElement): number | null {
  const size = element.style?.fontSize ?? "";
  const match = /^([\d.]+)pt$/u.exec(size.trim());
  return match ? Number(match[1]) : null;
}

function isBold(element: HTMLElement): boolean {
  const weight = element.style?.fontWeight ?? "";
  return weight === "bold" || (Number(weight) >= 600 && weight !== "");
}

/**
 * 视觉兜底：许多 Word 文档不用「标题样式」，而是手动设字号/加粗，或用自定义样式
 * （如「章标题」「小标题」）设字号。前者渲染为 inline `style="font-size:18pt"`，
 * 后者没有 inline 样式——docx-preview 把字号写进注入的 `<style>`（`.office-docx_s1 span`），
 * 必须回查 styles.xml 的 w:sz / w:b 并按 css class 映射。
 * 以正文字号（段落数众数优先、并列时按文本长度）为基准，字号明显更大或「更大且加粗且文本短」的段落视为标题，
 * 层级按字号从大到小映射（最多 6 级）。排除表格单元格与编号列表（表头/列表首词常带样式），避免误报。
 */
function buildVisualOutline(
  container: HTMLElement,
  classVisuals: Map<string, StyleVisual>,
): OutlineItem[] {
  const paragraphs = toArray(container.querySelectorAll("p")).map((paragraph) => {
    if (/office-docx-num-/u.test(paragraph.className || "") || paragraph.closest("table, td, th")) {
      return { paragraph, text: "", size: 0, bold: false };
    }
    const text = (paragraph.textContent ?? "").replace(/\s+/gu, " ").trim();
    const spans = [paragraph, ...toArray(paragraph.querySelectorAll<HTMLElement>("span"))];
    let maxSize = 0;
    let bold = false;
    for (const span of spans) {
      const size = fontSizePt(span);
      if (size !== null && size > maxSize) maxSize = size;
      if (isBold(span)) bold = true;
    }
    // inline 样式优先；没有 inline 字号/加粗时回查段落 class 对应的样式定义。
    for (const className of Array.from(paragraph.classList)) {
      const visual = classVisuals.get(className);
      if (!visual) continue;
      if (maxSize === 0 && visual.sizePt !== null) maxSize = visual.sizePt;
      if (!bold && visual.bold) bold = true;
    }
    return { paragraph, text, size: maxSize, bold };
  });
  if (paragraphs.length === 0) return [];
  // 正文基准字号：先看段落数（正文段落总占多数），并列时再看文本长度；
  // 若每种字号只出现一次（极短文档），取最小字号为正文基准，标题字号通常更大。
  const counts = new Map<number, number>();
  const weights = new Map<number, number>();
  for (const item of paragraphs) {
    if (item.size <= 0 || !item.text) continue;
    counts.set(item.size, (counts.get(item.size) ?? 0) + 1);
    weights.set(item.size, (weights.get(item.size) ?? 0) + Math.min(item.text.length, 200));
  }
  let bodySize = 0;
  let bestCount = 0;
  let bestWeight = 0;
  for (const [size, count] of counts) {
    const weight = weights.get(size) ?? 0;
    if (count > bestCount || (count === bestCount && weight > bestWeight)) {
      bodySize = size;
      bestCount = count;
      bestWeight = weight;
    }
  }
  if (bestCount <= 1 && counts.size > 0) bodySize = Math.min(...counts.keys());
  if (bodySize <= 0) return [];
  const candidates = paragraphs.filter((item) => {
    if (!item.text || item.size <= bodySize) return false;
    if (item.text.length > 100) return false;
    // 明显大于正文；或略大但加粗（中文文档常见「小三加粗」二级标题）。
    return item.size >= bodySize + 2 || (item.bold && item.size > bodySize);
  });
  const sizes = [...new Set(candidates.map((item) => item.size))].sort((a, b) => b - a).slice(0, 6);
  const items: OutlineItem[] = [];
  for (const item of candidates) {
    const level = sizes.indexOf(item.size) + 1;
    if (level <= 0) continue;
    item.paragraph.setAttribute("data-docx-heading", String(items.length));
    items.push({
      index: items.length,
      level,
      text: item.text,
      line: 0,
      kind: "heading",
      symbol: "标题",
    });
  }
  return items;
}

/**
 * 最后一级兜底：既没有标题样式、也没有字号差异的文档，标题往往只靠加粗表示。
 * 两种形态：整段短文本加粗（文档/章节标题），或段首加粗的编号前缀 + 后接正文（小节标题）。
 * 排除表格单元格（表头也常整格加粗）与自动编号列表（列表项首词也常加粗），避免误报。
 */
function buildBoldOutline(container: HTMLElement): OutlineItem[] {
  const numberedHeading =
    /^\s*(?:\d+(?:\.\d+)*[\s.、：:]|[（(]?\d+[)）]|[一二三四五六七八九十]+[、.．])\s*\S/u;
  const items: OutlineItem[] = [];
  for (const paragraph of toArray(container.querySelectorAll("p"))) {
    const className = paragraph.className || "";
    if (typeof className === "string" && /office-docx-num-/u.test(className)) continue;
    if (paragraph.closest("table, td, th")) continue;
    const text = (paragraph.textContent ?? "").replace(/\s+/gu, " ").trim();
    if (!text) continue;
    const spans = toArray(paragraph.querySelectorAll<HTMLElement>("span")).filter((span) =>
      (span.textContent ?? "").trim(),
    );
    if (spans.length === 0) continue;
    const boldText = spans
      .filter(isBold)
      .map((span) => span.textContent ?? "")
      .join("");
    // 段首连续加粗的文本（正文里零散的加粗词不算标题）。
    let leadingBold = "";
    for (const span of spans) {
      if (!isBold(span)) break;
      leadingBold += span.textContent ?? "";
    }
    const headingText = leadingBold.replace(/\s+/gu, " ").trim();
    const ratio = boldText.length / Math.max(text.length, 1);
    let level: number | null = null;
    let title = text;
    if (ratio >= 0.85 && text.length <= 100) {
      level = 1;
    } else if (headingText.length > 0 && headingText.length <= 30 && numberedHeading.test(headingText)) {
      level = 2;
      title = headingText;
    }
    if (level === null) continue;
    paragraph.setAttribute("data-docx-heading", String(items.length));
    items.push({
      index: items.length,
      level,
      text: title,
      line: 0,
      kind: "heading",
      symbol: "标题",
    });
  }
  return items;
}

/** 从 zip 中读出指定 OOXML part；缺失或损坏返回 null。 */
async function readDocxPart(bytes: Uint8Array, name: string): Promise<string | null> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const part = zip.file(name);
    return part ? await part.async("string") : null;
  } catch {
    return null;
  }
}

/** 从 zip 中读出 word/styles.xml；缺失或损坏返回 null（Word 文档无样式时无大纲）。 */
export async function readDocxStylesXml(bytes: Uint8Array): Promise<string | null> {
  return readDocxPart(bytes, "word/styles.xml");
}

/** 读出 word/document.xml：用于识别「段落直接设 outlineLvl 但无标题样式」的文档。 */
export async function readDocxDocumentXml(bytes: Uint8Array): Promise<string | null> {
  return readDocxPart(bytes, "word/document.xml");
}

/** 从 document.xml 提取「段落自身 outlineLvl」→ 层级，按文本用于兜底匹配 DOM 段落。 */
function parseDirectOutlineLevels(
  xml: string | null,
  factory: DomParserFactory,
): Map<string, number> {
  const result = new Map<string, number>();
  if (!xml) return result;
  let doc: ReturnType<DomParserLike["parseFromString"]>;
  try {
    doc = factory().parseFromString(xml, "application/xml");
  } catch {
    return result;
  }
  for (const paragraph of toArray(doc.getElementsByTagNameNS(W_NS, "p"))) {
    const levelText = attrValue(descendants(paragraph, "outlineLvl")[0] ?? null, "w:val");
    if (levelText === null) continue;
    const level = Number(levelText) + 1;
    if (!Number.isInteger(level) || level < 1 || level > 9) continue;
    const text = descendants(paragraph, "t")
      .map((node) => node.textContent ?? "")
      .join("")
      .replace(/\s+/gu, " ")
      .trim();
    if (text) result.set(text, level);
  }
  return result;
}

/**
 * 从已渲染的 docx DOM 提取大纲；命中段落打上 data-docx-heading 序号。
 * 需在 renderAsync 完成后调用，保证标记与真实展示顺序一致。
 */
export function buildDocxOutlineFromDom(
  container: HTMLElement,
  stylesXml: string | null,
  factory: DomParserFactory = defaultFactory,
  documentXml: string | null = null,
): OutlineItem[] {
  const levels = parseHeadingLevels(stylesXml, factory);
  const directLevels = parseDirectOutlineLevels(documentXml, factory);
  const items: OutlineItem[] = [];
  const targets: HTMLElement[] = [];
  if (levels.size > 0 || directLevels.size > 0) {
    for (const paragraph of toArray(container.querySelectorAll("p"))) {
      let level: number | null = null;
      for (let index = 0; index < paragraph.classList.length; index += 1) {
        const className = paragraph.classList.item(index);
        if (!className?.startsWith(CLASS_PREFIX)) continue;
        level = levels.get(className) ?? null;
        if (level !== null) break;
      }
      const text = (paragraph.textContent ?? "").replace(/\s+/gu, " ").trim();
      // 段落直接设 outlineLvl 却无标题样式：docx-preview 不会给它样式 class，按文本兜底。
      if (level === null && text) level = directLevels.get(text) ?? null;
      if (level === null || !text) continue;
      targets.push(paragraph);
      items.push({
        index: items.length,
        level,
        text,
        // 二进制只读文档没有源码行号；面板 tooltip 与源码跳转均不适用。
        line: 0,
        kind: "heading",
        symbol: "标题",
      });
    }
  }
  // 注意：styles.xml 常含 Word 默认 Heading1–9 定义，但文档段落可能一个都没用。
  // 因此判断兜底要看「是否真的提取到标题」，不能只看样式表里有没有标题层级。
  if (items.length === 0) {
    const visual = buildVisualOutline(container, styleVisualsByClass(stylesXml, factory));
    if (visual.length > 0) return visual;
    return buildBoldOutline(container);
  }
  for (const [index, paragraph] of targets.entries()) {
    paragraph.setAttribute("data-docx-heading", String(index));
  }
  return items;
}
