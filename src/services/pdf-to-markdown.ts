/**
 * PDF 文本提取 → Markdown。
 *
 * 三条路径按可靠性优先：
 * 1. 结构树语义重建（Tagged PDF）：结构树 content 节点的 id 与文本流 marked
 *    content 的 id 一一对应，文本可精确归属到 H1-H6/P/L/Table 等语义节点，
 *    表格含多行单元格，页眉页脚（null id 的 Artifact）自然剔除；
 * 2. Lattice 框线检测：从矢量绘图指令重建表格网格（无结构树但有框线）；
 * 3. 几何启发式：按基线/字号/列间隙重建段落、标题、列表与无框线表格（普通 PDF）。
 * 代码块识别（两条路径通用）：等宽字体（Courier/Menlo/Consolas/Source Code 等）
 * 的连续行按字宽把 x 坐标换算成列号，还原缩进后输出围栏代码块。
 * 转换是单向的：只读出文本生成新 Markdown 文档，不修改原 PDF。
 */

/** 可提取文本片段的最小结构（与 pdfjs 的 TextItem 兼容，便于单测）。 */
export interface PdfTextItem {
  str: string;
  /** 变换矩阵 [a, b, c, d, e, f]：e=x，f=y（基线），d≈字号。 */
  transform: number[];
  width: number;
  height: number;
  fontName?: string;
  hasEOL?: boolean;
}

/** PDF 字体样式（来自 TextContent.styles）：用于推断粗体 / 斜体。 */
export interface PdfTextStyle {
  fontFamily: string;
}

/** 结构树节点的最小结构（与 pdfjs 的 StructTreeNode 兼容）。 */
export interface PdfStructNode {
  role?: string;
  structId?: string;
  rowSpan?: number;
  colSpan?: number;
  type?: string;
  id?: string;
  children?: PdfStructNode[];
}

/**
 * 从 pdfjs 的 getOperatorList 归一化出的绘图操作（纯数据，便于单测）。
 * 表格框线是显式的矢量线条（rectangle / moveTo+lineTo+stroke），
 * 这是比文本坐标聚类可靠得多的表格信号（Lattice 法）。
 */
export type PdfDrawOp =
  | { kind: "save" }
  | { kind: "restore" }
  | { kind: "transform"; matrix: number[] }
  | { kind: "rect"; x: number; y: number; width: number; height: number }
  | { kind: "moveTo"; x: number; y: number }
  | { kind: "lineTo"; x: number; y: number }
  | { kind: "closePath" }
  /** stroke / fill / clip 等结束当前路径的操作：flush 已累积的边。 */
  | { kind: "flush"; draw: boolean };

/** 经 CTM 变换后的线段，坐标与文本 transform 同处 PDF 用户空间（y 向上）。 */
export interface PdfSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** 扫描件 / 图片型 PDF 无可提取文本层时的固定错误文案。 */
export const NO_TEXT_ERROR = "该 PDF 没有可提取的文本，可能是扫描件或图片型 PDF";

export interface PositionedItem extends PdfTextItem {
  x: number;
  y: number;
  size: number;
}

export interface Line {
  y: number;
  size: number;
  x: number;
  items: PositionedItem[];
}

/** 语义块：几何重建后的段落/列表/标题/代码块/表格单元。 */
export type Block =
  | { kind: "heading"; text: string; level: number }
  | { kind: "list"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; text: string }
  | { kind: "break" }
  | { kind: "table"; rows: string[][] };

/** 中日韩字符：相邻片段分属 CJK 时不插入空格，避免中文词间出现多余空格。 */
const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const HEADING_ROLE = /^H([1-6])$/;

function normalize(items: PdfTextItem[]): PositionedItem[] {
  return items
    .filter((item) => typeof item.str === "string" && item.str.length > 0)
    .map((item) => {
      const x = Number(item.transform[4]) || 0;
      const y = Number(item.transform[5]) || 0;
      const size = Math.abs(Number(item.transform[3])) || Math.abs(item.height) || 0;
      return { ...item, x, y, size };
    })
    .sort((a, b) => b.y - a.y || a.x - b.x);
}

/** 按基线 y 把片段聚成行；同一行的不同字号基线通常对齐。 */
function groupLines(items: PositionedItem[]): Line[] {
  const lines: Line[] = [];
  for (const item of items) {
    const last = lines[lines.length - 1];
    const tolerance = last ? Math.max(2, Math.min(last.size, item.size) * 0.5) : 0;
    if (last && Math.abs(last.y - item.y) <= tolerance) {
      last.items.push(item);
      last.size = Math.max(last.size, item.size);
    } else {
      lines.push({ y: item.y, size: item.size, x: item.x, items: [item] });
    }
  }
  return lines;
}

/** 由 fontFamily 名推断粗体 / 斜体包裹标记（信息缺失时返回空串）。 */
function styleMark(item: PositionedItem, styles: Record<string, PdfTextStyle>): string {
  const family = (item.fontName && styles[item.fontName]?.fontFamily) || "";
  if (/bold|heavy|black|粗/i.test(family)) return "**";
  if (/italic|oblique|斜/i.test(family)) return "*";
  return "";
}

/** 行内按 x 排序拼接；片段间有明显间隙且非 CJK 相邻时补空格，并套用粗斜体标记。 */
function joinLine(items: PositionedItem[], styles: Record<string, PdfTextStyle>): string {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  let out = "";
  let prev: PositionedItem | null = null;
  for (const item of sorted) {
    if (prev) {
      const gap = item.x - (prev.x + prev.width);
      const prevChar = prev.str.slice(-1);
      const nextChar = item.str.charAt(0);
      if (
        gap > Math.max(1, prev.size * 0.25) &&
        !/\s/.test(prevChar) &&
        !CJK.test(prevChar) &&
        !CJK.test(nextChar)
      ) {
        out += " ";
      }
    }
    const mark = styleMark(item, styles);
    out += mark && item.str.trim() ? `${mark}${item.str}${mark}` : item.str;
    prev = item;
  }
  return out.trimEnd();
}

/** 等宽（代码）字体名匹配：pdfjs 已把 fontName 映射为字体名（fontFamily）。 */
const MONO_FAMILY =
  /mono|courier|menlo|monaco|consolas|andale|source.?code|fira.?code|cascadia|inconsolata|pt.?mono|free.?mono|ubuntu.?mono|dejavu sans mono|liberation mono|noto (sans|serif) mono|ibm plex mono|roboto mono|space mono|cutive mono/i;

export function isMonoFamily(family: string | undefined): boolean {
  if (!family) return false;
  return MONO_FAMILY.test(family);
}

/** 片段集合中等宽字体字符的占比（≥0.8 判为代码）。 */
export function monoRatio(items: PdfTextItem[], styles: Record<string, PdfTextStyle>): number {
  let total = 0;
  let mono = 0;
  for (const item of items) {
    const len = item.str.length;
    if (len === 0) continue;
    total += len;
    if (item.fontName && isMonoFamily(styles[item.fontName]?.fontFamily)) mono += len;
  }
  return total > 0 ? mono / total : 0;
}

/** 一行文本几乎全是等宽字体时判为代码行。 */
function lineIsCode(line: Line, styles: Record<string, PdfTextStyle>): boolean {
  return monoRatio(line.items, styles) >= 0.8;
}

/**
 * 重建代码行：等宽字体每字符宽度固定，把 x 坐标换算成列号
 * （col = round((x - x0) / charWidth)），还原原始缩进与行内间距。
 * x0 传代码块基准左边界（页面左缘），保留行首缩进；缺省取行内首个片段。
 * 无法估计字宽时退化为空格拼接。
 */
export function joinCodeLine(line: Line, x0?: number): string {
  const sorted = [...line.items].sort((a, b) => a.x - b.x);
  const widths = sorted
    .filter((i) => i.str.length > 0 && i.width > 0)
    .map((i) => i.width / i.str.length)
    .sort((a, b) => a - b);
  const charW = widths.length > 0 ? (widths[Math.floor(widths.length / 2)] ?? 0) : 0;
  if (charW <= 0) return sorted.map((i) => i.str).join(" ");
  const base = x0 ?? (sorted[0]?.x ?? 0);
  let out = "";
  for (const item of sorted) {
    const col = Math.max(0, Math.round((item.x - base) / charW));
    if (col > out.length) out += " ".repeat(col - out.length);
    out += item.str;
  }
  return out.replace(/\s+$/, "");
}

/**
 * 把一行按 x 间隙切成若干列。列宽阈值取字号倍数，避免把普通词间距误判为列。
 * 返回 null 表示这一行不构成多列（少于 2 列）。
 */
function splitColumns(line: Line): string[] | null {
  const sorted = [...line.items].sort((a, b) => a.x - b.x);
  const first = sorted[0];
  if (!first || sorted.length < 2) return null;
  const cells: string[] = [];
  let current = first.str;
  let prev = first;
  for (const item of sorted.slice(1)) {
    const gap = item.x - (prev.x + prev.width);
    if (gap > Math.max(8, prev.size * 1.5)) {
      cells.push(current.trim());
      current = item.str;
    } else {
      current += (CJK.test(prev.str.slice(-1)) || CJK.test(item.str.charAt(0)) ? "" : " ") + item.str;
    }
    prev = item;
  }
  cells.push(current.trim());
  return cells.length >= 2 ? cells : null;
}

/** 行文本 → 语义块（列表 / 标题 / 段落）。 */
function lineToBlock(text: string, size: number, bodySize: number, indent: number): Block {
  const list = text.match(/^\s*(?:[-*•·]|\d+[.)])\s+(.*)$/);
  if (list) return { kind: "list", text: list[1] ?? "" };
  const ratio = bodySize > 0 ? size / bodySize : 1;
  if (ratio >= 1.5) return { kind: "heading", text, level: 1 };
  if (ratio >= 1.28) return { kind: "heading", text, level: 2 };
  if (ratio >= 1.12) return { kind: "heading", text, level: 3 };
  if (indent > bodySize * 1.5) return { kind: "paragraph", text: ` ${text}` };
  return { kind: "paragraph", text };
}

/** 正文行里若以 Markdown 语法字符开头，转义以免被误解析。 */
function escapeLineStart(text: string): string {
  return text.replace(/^(\s*)(#{1,6}\s|>\s|[-*+]\s|\d+\.\s|[-*_]{3,}\s*$)/, "$1\\$2");
}

function renderTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const padded = rows.map((r) => [...r, ...Array(width - r.length).fill("")]);
  const first = padded[0] ?? [];
  const head = `| ${first.join(" | ")} |`;
  const sep = `| ${first.map(() => "---").join(" | ")} |`;
  return [head, sep, ...padded.slice(1).map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

/**
 * 纯函数：把一页的文本片段重建为语义块列表。
 *
 * 表格识别分两路：
 * - 传入 segments（Lattice）：从矢量框线重建网格，文本按坐标落入单元格，最可靠；
 * - 未传 segments：退化为「连续 ≥2 行的多列结构」几何检测，对无框线表格仍有效。
 */
export function itemsToBlocks(
  items: PdfTextItem[],
  styles: Record<string, PdfTextStyle> = {},
  segments: PdfSegment[] = [],
): Block[] {
  const positioned = normalize(items);
  let regions: TableRegion[] = [];
  let inTable = new Set<PositionedItem>();
  if (segments.length > 0) {
    const detected = detectTableRegions(segments, positioned, styles);
    regions = detected.regions;
    inTable = detected.inTable;
  }
  const outside = inTable.size > 0 ? positioned.filter((i) => !inTable.has(i)) : positioned;
  const lines = groupLines(outside);
  if (lines.length === 0 && regions.length === 0) return [];

  // 块附带 y 坐标，最终按位置排序，保证 Lattice 表格插在正确的阅读顺序位置。
  const placed: Array<{ block: Block; y: number }> = [];
  for (const region of regions) {
    placed.push({ block: { kind: "table", rows: region.rows }, y: region.top });
  }

  const buckets = new Map<number, number>();
  for (const line of lines) {
    const key = Math.round(line.size * 2) / 2;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  let bodySize = 0;
  let best = 0;
  for (const [size, count] of buckets) {
    // 同频时取更小字号：标题通常字号大且数量少，正文才是多数字号。
    if (count > best || (count === best && size < bodySize)) {
      best = count;
      bodySize = size;
    }
  }
  if (!bodySize) bodySize = lines[0]?.size || 12;
  const left = lines.length > 0 ? Math.min(...lines.map((l) => l.x)) : 0;

  let prevY: number | null = null;
  let prevSize = bodySize;
  let tableRows: string[][] | null = null;
  let tableY = 0;

  const flushTable = (): void => {
    if (tableRows && tableRows.length >= 2) {
      placed.push({ block: { kind: "table", rows: tableRows }, y: tableY });
    } else if (tableRows && tableRows.length === 1) {
      // 单行多列不足以构成表格，退化为普通文本行。
      const row = tableRows[0] ?? [];
      placed.push({ block: { kind: "paragraph", text: row.join("  ") }, y: tableY });
    }
    tableRows = null;
  };

  // 代码块缓冲：连续的等宽行合成一个 code 块；孤立的单行退化为普通文本行。
  let code: { lines: string[]; y: number; size: number; x: number } | null = null;
  const flushCode = (): void => {
    if (!code) return;
    const c = code;
    code = null;
    if (c.lines.length >= 2) {
      placed.push({ block: { kind: "code", text: c.lines.join("\n") }, y: c.y });
    } else {
      const text = c.lines[0] ?? "";
      if (text) placed.push({ block: lineToBlock(text, c.size, bodySize, c.x - left), y: c.y });
    }
  };

  for (const line of lines) {
    if (lineIsCode(line, styles)) {
      // 代码行不走多列切分（对齐的列间距会被误判成表格），也不做标题/列表推断。
      flushTable();
      if (prevY !== null && prevY - line.y > Math.max(line.size, prevSize) * 1.8) {
        placed.push({ block: { kind: "break" }, y: line.y + 0.01 });
      }
      if (!code) code = { lines: [], y: line.y, size: line.size, x: line.x };
      const codeText = joinCodeLine(line, left);
      if (codeText) code.lines.push(codeText);
      prevY = line.y;
      prevSize = line.size;
      continue;
    }
    flushCode();
    const columns = splitColumns(line);
    if (columns) {
      tableRows ??= [];
      tableRows.push(columns.map((c) => c.replace(/\|/g, "\\|")));
      tableY = line.y;
      prevY = line.y;
      prevSize = line.size;
      continue;
    }
    flushTable();
    const text = joinLine(line.items, styles);
    if (!text) continue;
    if (prevY !== null && prevY - line.y > Math.max(line.size, prevSize) * 1.8) {
      placed.push({ block: { kind: "break" }, y: line.y + 0.01 });
    }
    placed.push({ block: lineToBlock(text, line.size, bodySize, line.x - left), y: line.y });
    prevY = line.y;
    prevSize = line.size;
  }
  flushCode();
  flushTable();

  placed.sort((a, b) => b.y - a.y);
  return placed.map((p) => p.block);
}

/** 把语义块序列渲染为 Markdown。 */
export function blocksToMarkdown(blocks: Block[]): string {
  const out: string[] = [];
  // 上一个列表项的引用编号（如 [1]）：用于把被拆成独立段落的续接编号（[2]、[3]…）并入列表。
  let lastListRefNum: number | null = null;
  for (const block of blocks) {
    switch (block.kind) {
      case "break":
        out.push("");
        break;
      case "table":
        out.push(renderTable(block.rows));
        lastListRefNum = null;
        break;
      case "heading":
        out.push(`${"#".repeat(Math.min(6, Math.max(1, block.level)))} ${block.text}`);
        lastListRefNum = null;
        break;
      case "list":
        out.push(`- ${block.text}`);
        lastListRefNum = Number(block.text.match(/^\[(\d{1,4})\]/)?.[1] ?? NaN) || null;
        break;
      case "code":
        // 围栏代码块；text 内含真实换行。
        out.push("```");
        out.push(block.text);
        out.push("```");
        lastListRefNum = null;
        break;
      case "paragraph": {
        const text = block.text;
        const ref = text.match(/^\[(\d{1,4})\]/);
        if (ref && lastListRefNum !== null && Number(ref[1]) === lastListRefNum + 1) {
          // 结构树常把同一编号列表的部分项拆成独立 P 节点，续接编号并入列表。
          if (out[out.length - 1] === "") out.pop();
          out.push(`- ${text}`);
          lastListRefNum = Number(ref[1]);
          break;
        }
        out.push(escapeLineStart(text));
        lastListRefNum = null;
        break;
      }
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** 保留旧 API：直接得到 Markdown 文本。 */
export function itemsToMarkdown(
  items: PdfTextItem[],
  styles: Record<string, PdfTextStyle> = {},
): string {
  return blocksToMarkdown(itemsToBlocks(items, styles));
}

/**
 * 纯函数：用结构树的 H1-H6 role 校正标题层级。
 * 只覆盖原本被几何判为 heading 的块（一一对应，可靠）；Table role 不受理（走几何检测）。
 * 返回 null 表示结构树无可用标题信息，应回退到几何结果。
 */
export function applyStructRoles(blocks: Block[], tree: PdfStructNode | null): Block[] | null {
  if (!tree) return null;
  const levels: number[] = [];
  const walk = (node: PdfStructNode): void => {
    const match = node.role?.match(HEADING_ROLE);
    if (match) levels.push(Number(match[1]));
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  const headings = blocks.filter((b) => b.kind === "heading");
  if (levels.length === 0 || headings.length === 0) return null;

  let cursor = 0;
  return blocks.map((block) => {
    if (block.kind === "heading" && cursor < levels.length) {
      const level = levels[cursor++];
      if (level !== undefined) return { kind: "heading" as const, text: block.text, level };
    }
    return block;
  });
}

/* ------------------------------------------------------------------ *
 * 结构树语义重建（Tagged PDF，最可靠路径）
 * ------------------------------------------------------------------ */

/** 文本流条目（含 marked content），按文档顺序。 */
export type StructStreamEntry =
  | { kind: "mc-begin"; id: string | null }
  | { kind: "mc-end" }
  | { kind: "text"; item: PdfTextItem };

/**
 * 纯函数：用结构树重建语义块（Tagged PDF 路径）。
 *
 * 原理：结构树 content 节点的 id 与文本流 marked content 的 id 一一对应
 * （实测 tagged PDF 覆盖率 100%）。据此把每个文本片段归属到最内层包含它的
 * 语义节点，再按文档顺序遍历树生成块：
 * - H1-H6 → heading（精确层级）
 * - P / TOCI → paragraph（P 节点几乎全为等宽字体 → code 代码块，连续代码段合并）
 * - L / LI → list
 * - Table / TR / TD → table（多行单元格用 `<br>` 连接）
 * - Figure → 图注段落（图片本身不可提取）
 * marked content 为 null id 的文本（页眉/页脚/页码）自然剔除。
 *
 * 结构树缺失、content 覆盖率低于 50% 或无任何有效文本时返回 null，
 * 调用方应回退到几何路径。
 */
export function structTreeToBlocks(
  tree: PdfStructNode,
  stream: StructStreamEntry[],
  styles: Record<string, PdfTextStyle>,
): Block[] | null {
  // 1. 括号匹配 → 每个 content id 在 stream 中的范围 [start, end)
  const ranges = new Map<string, [number, number]>();
  const stack: string[] = [];
  const begins = new Map<string, number[]>();
  stream.forEach((entry, idx) => {
    if (entry.kind === "mc-begin") {
      if (entry.id !== null) {
        stack.push(entry.id);
        const list = begins.get(entry.id) ?? [];
        list.push(idx);
        begins.set(entry.id, list);
      }
    } else if (entry.kind === "mc-end") {
      const id = stack.pop();
      if (id === undefined) return;
      const list = begins.get(id);
      const start = list?.shift();
      if (start === undefined) return;
      const prev = ranges.get(id);
      if (prev) prev[1] = idx;
      else ranges.set(id, [start, idx]);
    }
  });
  // 未闭合的 begin 延伸到流末尾
  for (const id of stack) {
    const start = begins.get(id)?.pop();
    if (start === undefined) continue;
    const prev = ranges.get(id);
    if (prev) prev[1] = stream.length;
    else ranges.set(id, [start, stream.length]);
  }
  const rangeList: { id: string; start: number; end: number }[] = [];
  for (const [id, span] of ranges) {
    rangeList.push({ id, start: span[0] ?? 0, end: span[1] ?? 0 });
  }

  // 2. content 节点覆盖率检查：低于 50% 说明映射不可用
  let contentTotal = 0;
  let contentMapped = 0;
  const countContent = (node: PdfStructNode): void => {
    if (node.type === "content") {
      contentTotal += 1;
      if (node.id !== undefined && ranges.has(node.id)) contentMapped += 1;
      return;
    }
    for (const child of node.children ?? []) countContent(child);
  };
  countContent(tree);
  if (contentTotal === 0 || contentMapped / contentTotal < 0.5) return null;

  // 3. 每个文本片段归属到最内层（范围最小）的 content id
  const textByContent = new Map<string, PdfTextItem[]>();
  for (let i = 0; i < stream.length; i += 1) {
    const entry = stream[i];
    if (!entry || entry.kind !== "text") continue;
    let best: { start: number; end: number; id: string } | null = null;
    for (const range of rangeList) {
      if (range.start <= i && i < range.end) {
        if (!best || range.end - range.start < best.end - best.start) best = range;
      }
    }
    if (!best) continue;
    const arr = textByContent.get(best.id) ?? [];
    arr.push(entry.item);
    textByContent.set(best.id, arr);
  }

  // ---- 文本辅助 ----
  const directContentText = (node: PdfStructNode): PdfTextItem[] => {
    const out: PdfTextItem[] = [];
    for (const child of node.children ?? []) {
      if (child.type === "content" && child.id !== undefined) {
        const arr = textByContent.get(child.id);
        if (arr) for (const item of arr) out.push(item);
      }
    }
    return out;
  };
  const allContentText = (node: PdfStructNode): PdfTextItem[] => {
    const out: PdfTextItem[] = [];
    const walk = (n: PdfStructNode): void => {
      if (n.type === "content") {
        if (n.id !== undefined) {
          const arr = textByContent.get(n.id);
          if (arr) for (const item of arr) out.push(item);
        }
        return;
      }
      for (const child of n.children ?? []) walk(child);
    };
    walk(node);
    return out;
  };
  const toLines = (items: PdfTextItem[]): string[] =>
    groupLines(normalize(items))
      .map((line) => joinLine(line.items, styles))
      .filter((text) => text.length > 0);
  /** 多行拼一句：CJK 相邻行不留空格，其余补空格。 */
  const joinLines = (lines: string[]): string => {
    let out = "";
    for (const line of lines) {
      if (!out) {
        out = line;
        continue;
      }
      out += CJK.test(out.slice(-1)) && CJK.test(line.charAt(0)) ? line : ` ${line}`;
    }
    return out;
  };
  /** 纯符号/标点的超短段落（封底的 *、图里的 。/... 等）视为装饰残留，不输出。 */
  const isDecorativeOnly = (text: string): boolean => {
    const t = text.trim();
    if (t.length === 0 || t.length > 3) return false;
    return !/\p{L}|\p{N}/u.test(t);
  };
  /** 单项纯条款编号列表（如术语的 "3.1"）：返回编号，否则 null。 */
  const clauseNumber = (l: PdfStructNode): string | null => {
    const lis = (l.children ?? []).filter((c) => c.role === "LI");
    if (lis.length !== 1) return null;
    const text = joinLines(toLines(allContentText(lis[0]!))).trim();
    // 条款编号至少是 X.Y 层级（如 3.1、6.1.2）
    return /^\d{1,2}\.\d{1,2}(?:\.\d{1,2}){0,2}$/.test(text) ? text : null;
  };

  // 页面左右边界（估计自全部文本）：用于判断换行是否「顶满一行」。
  let pageLeft = Infinity;
  let pageRight = -Infinity;
  for (const entry of stream) {
    if (entry.kind !== "text") continue;
    const x = Number(entry.item.transform[4]) || 0;
    const w = Number(entry.item.width) || 0;
    if (x < pageLeft) pageLeft = x;
    if (x + w > pageRight) pageRight = x + w;
  }

  // ---- 遍历生成块 ----
  const blocks: Block[] = [];
  // 待合并的段落缓冲：Tagged PDF 常把同一自然段按视觉行拆成多个 P 节点，
  // 用「上一行顶满 + 当前行顶格 + 行距正常」的几何条件把它们拼回一个段落。
  interface PendingPara {
    lines: string[];
    full: boolean;
    yBottom: number;
    lastText: string;
    size: number;
  }
  let pending: PendingPara | null = null;
  /** 待并入下一个 P 首行的条款编号（如术语 3.1）。 */
  let pendingClause: string | null = null;
  const flushPending = (): void => {
    if (!pending) return;
    const text = joinLines(pending.lines);
    pending = null;
    if (!text) return;
    // 与前一非空块保持空行分隔，否则 Markdown 会把相邻两段合并成一段。
    const lastKind = blocks.length > 0 ? (blocks[blocks.length - 1] ?? { kind: "break" }).kind : null;
    if (lastKind !== null && lastKind !== "break") blocks.push({ kind: "break" });
    blocks.push({ kind: "paragraph", text });
  };
  const emit = (block: Block): void => {
    flushPending();
    // 块之间加空行（Markdown 块级元素的安全分隔）；连续列表项保持紧邻。
    const lastKind = blocks.length > 0 ? (blocks[blocks.length - 1] ?? { kind: "break" }).kind : null;
    if (lastKind !== null && lastKind !== "break" && !(block.kind === "list" && lastKind === "list")) {
      blocks.push({ kind: "break" });
    }
    blocks.push(block);
  };
  const renderParagraph = (node: PdfStructNode): void => {
    const items = directContentText(node);
    if (items.length === 0) return;
    // 等宽字体段落 → 代码块（Tagged PDF 中字体是强信号）；
    // 连续的代码段（Word 导出常把代码按行拆成多个 P 节点）合并成一个块。
    if (monoRatio(items, styles) >= 0.8) {
      flushPending();
      pendingClause = null;
      const codeText = groupLines(normalize(items))
        .map((line) => joinCodeLine(line, pageLeft))
        .filter((t) => t.length > 0)
        .join("\n");
      if (!codeText) return;
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "code") {
        last.text = `${last.text}\n${codeText}`;
        return;
      }
      emit({ kind: "code", text: codeText });
      return;
    }
    const measured = groupLines(normalize(items))
      .map((line) => ({
        text: joinLine(line.items, styles),
        x: Math.min(...line.items.map((i) => i.x)),
        yTop: Math.max(...line.items.map((i) => i.y)),
        yBottom: Math.min(...line.items.map((i) => i.y)),
        right: Math.max(...line.items.map((i) => i.x + i.width)),
        size: line.size,
      }))
      .filter((line) => line.text.length > 0);
    const first = measured[0];
    const last = measured[measured.length - 1];
    if (!first || !last) return;
    if (isDecorativeOnly(joinLines(measured.map((line) => line.text)))) return;
    const size = first.size || 12;
    const indented = first.x >= pageLeft + size * 1.2;
    const full =
      pageRight > pageLeft ? (last.right - pageLeft) / (pageRight - pageLeft) >= 0.88 : false;
    const mergeable =
      pending !== null &&
      !indented &&
      pending.full &&
      first.yTop - pending.yBottom <= Math.max(pending.size, size) * 1.8 &&
      !(/\d$/.test(pending.lastText) && /^\d/.test(first.text));
    if (mergeable && pending) {
      for (const line of measured) pending.lines.push(line.text);
      pending.full = full;
      pending.yBottom = last.yBottom;
      pending.lastText = last.text;
      pending.size = Math.max(pending.size, size);
      return;
    }
    flushPending();
    const lines = measured.map((line) => line.text);
    if (pendingClause && lines.length > 0) lines[0] = `${pendingClause} ${lines[0] ?? ""}`;
    pendingClause = null;
    pending = {
      lines,
      full,
      yBottom: last.yBottom,
      lastText: last.text,
      size,
    };
  };

  const renderCell = (td: PdfStructNode): string => {
    const parts: string[] = [];
    // 单元格内多行用 <br> 保留换行（Markdown 表格单元格内无法用真实换行）。
    const pushText = (items: PdfTextItem[]): void => {
      const lines = toLines(items);
      if (lines.length > 0) parts.push(lines.join("<br>"));
    };
    const walk = (n: PdfStructNode): void => {
      if (n.type === "content") return;
      if (n.role === "L") {
        let added = false;
        for (const li of n.children ?? []) {
          if (li.role !== "LI") continue;
          const lines = toLines(allContentText(li));
          if (lines.length > 0) {
            parts.push(lines.join("<br>"));
            added = true;
          }
        }
        if (!added) pushText(directContentText(n));
        return;
      }
      if (n.role && n.role !== "TD") pushText(directContentText(n));
      for (const child of n.children ?? []) walk(child);
    };
    pushText(directContentText(td));
    for (const child of td.children ?? []) walk(child);
    return parts.map((p) => p.replace(/\|/g, "\\|")).join("<br>");
  };

  const NESTED_STRUCT = new Set(["Table", "L", "TOC", "Figure", "P"]);
  const renderNode = (node: PdfStructNode): void => {
    const role = node.role ?? "";
    const heading = role.match(HEADING_ROLE);
    if (heading) {
      const lines = toLines(directContentText(node));
      if (lines.length > 0) {
        emit({ kind: "heading", text: joinLines(lines), level: Number(heading[1] ?? 1) });
      }
      return;
    }
    if (role === "Table") {
      const rows: string[][] = [];
      for (const tr of node.children ?? []) {
        if (tr.role !== "TR") continue;
        const cells: string[] = [];
        for (const td of tr.children ?? []) {
          if (td.role !== "TD") continue;
          cells.push(renderCell(td));
        }
        // 全空行（跨页合并单元格留下的空标签等）不单独成行，但保留有内容的行。
        if (cells.length > 0 && cells.some((c) => c.trim() !== "")) rows.push(cells);
      }
      if (rows.length > 0) emit({ kind: "table", rows });
      return;
    }
    if (role === "L") {
      let any = false;
      for (const li of node.children ?? []) {
        if (li.role !== "LI") continue;
        const lines = toLines(allContentText(li));
        if (lines.length === 0) continue;
        emit({ kind: "list", text: joinLines(lines) });
        any = true;
      }
      if (!any) {
        for (const line of toLines(allContentText(node))) emit({ kind: "paragraph", text: line });
      }
      return;
    }
    if (role === "Figure" || role === "FigureReference") {
      for (const line of toLines(allContentText(node))) {
        if (isDecorativeOnly(line)) continue;
        emit({ kind: "paragraph", text: line });
      }
      return;
    }
    if (role === "P") {
      renderParagraph(node);
      for (const child of node.children ?? []) {
        if (child.type !== "content" && NESTED_STRUCT.has(child.role ?? "")) renderNode(child);
      }
      return;
    }
    if (role === "TOCI" || role === "Span" || role === "LBody") {
      // TOCI 的文本常包在 Link/Span 里，取全部后代 content。
      for (const line of toLines(allContentText(node))) emit({ kind: "paragraph", text: line });
      return;
    }
    // Root / Sect / TOC 等容器：按序递归
    const children = node.children ?? [];
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      if (!child) continue;
      if (child.role === "L") {
        // 单项纯条款编号（如术语 3.1）：并入紧随其后的 P 首行，不单独成列表项。
        const num = clauseNumber(child);
        const next = children[i + 1];
        if (num && next && next.role === "P") {
          flushPending();
          const last = blocks[blocks.length - 1];
          if (!last || last.kind !== "break") blocks.push({ kind: "break" });
          pendingClause = num;
          continue;
        }
      }
      renderNode(child);
      pendingClause = null;
    }
  };

  renderNode(tree);
  flushPending();
  const hasText = blocks.some(
    (b) =>
      b.kind === "table" ||
      (b.kind !== "break" && b.text.length > 0),
  );
  return hasText ? blocks : null;
}

/* ------------------------------------------------------------------ *
 * Lattice 表格检测：从矢量框线重建表格网格
 * ------------------------------------------------------------------ */

const IDENTITY_MATRIX = [1, 0, 0, 1, 0, 0];

/** 矩阵乘法（PDF 的 [a,b,c,d,e,f] 约定）。 */
function multiplyMatrix(m: number[], n: number[]): number[] {
  const a = m[0] ?? 1;
  const b = m[1] ?? 0;
  const c = m[2] ?? 0;
  const d = m[3] ?? 1;
  const e = m[4] ?? 0;
  const f = m[5] ?? 0;
  const p = n[0] ?? 1;
  const q = n[1] ?? 0;
  const r = n[2] ?? 0;
  const s = n[3] ?? 1;
  const t = n[4] ?? 0;
  const u = n[5] ?? 0;
  return [
    a * p + c * q,
    b * p + d * q,
    a * r + c * s,
    b * r + d * s,
    a * t + c * u + e,
    b * t + d * u + f,
  ];
}

/** 点经矩阵变换：[a,b,c,d,e,f] → (a·x+c·y+e, b·x+d·y+f)。 */
function applyMatrix(m: number[], x: number, y: number): [number, number] {
  return [
    (m[0] ?? 1) * x + (m[2] ?? 0) * y + (m[4] ?? 0),
    (m[1] ?? 0) * x + (m[3] ?? 1) * y + (m[5] ?? 0),
  ];
}

/** 一条归一化的网格线：位置 + 覆盖区间。 */
interface GridLine {
  pos: number;
  from: number;
  to: number;
}

/** 检测出的表格区域：行列边界 + 生成的行数据 + 覆盖的矩形范围。 */
interface TableRegion {
  rowBounds: number[];
  colBounds: number[];
  rows: string[][];
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * 纯函数：把归一化的绘图操作转成线段，应用 CTM 栈变换。
 * rectangle 展开为四条边；moveTo/lineTo 路径在 flush 时输出边；clip 路径（draw=false）丢弃。
 */
export function drawOpsToSegments(ops: PdfDrawOp[]): PdfSegment[] {
  const segments: PdfSegment[] = [];
  const stack: number[][] = [];
  let ctm = IDENTITY_MATRIX;
  let path: Array<[number, number]> = [];
  let subpathStart: [number, number] | null = null;

  const pushEdge = (a: [number, number], b: [number, number]): void => {
    segments.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
  };

  for (const op of ops) {
    switch (op.kind) {
      case "save":
        stack.push(ctm);
        break;
      case "restore":
        ctm = stack.pop() ?? IDENTITY_MATRIX;
        break;
      case "transform":
        ctm = multiplyMatrix(ctm, op.matrix);
        break;
      case "rect": {
        // 矩形的四个角（PDF rect 参数为 x, y, width, height）
        const corners: Array<[number, number]> = [
          applyMatrix(ctm, op.x, op.y),
          applyMatrix(ctm, op.x + op.width, op.y),
          applyMatrix(ctm, op.x + op.width, op.y + op.height),
          applyMatrix(ctm, op.x, op.y + op.height),
        ];
        for (let i = 0; i < 4; i += 1) {
          pushEdge(corners[i]!, corners[(i + 1) % 4]!);
        }
        break;
      }
      case "moveTo": {
        const point = applyMatrix(ctm, op.x, op.y);
        path = [point];
        subpathStart = point;
        break;
      }
      case "lineTo":
        path.push(applyMatrix(ctm, op.x, op.y));
        break;
      case "closePath":
        if (subpathStart && path.length > 0) path.push(subpathStart);
        break;
      case "flush":
        if (op.draw) {
          for (let i = 1; i < path.length; i += 1) pushEdge(path[i - 1]!, path[i]!);
        }
        path = [];
        subpathStart = null;
        break;
    }
  }
  return segments;
}

/** 从线段中分离出水平线与垂直线（容差内视为正交），过滤过短线段。 */
function classifyLines(segments: PdfSegment[], tolerance: number, minLength: number): {
  h: GridLine[];
  v: GridLine[];
} {
  const h: GridLine[] = [];
  const v: GridLine[] = [];
  for (const s of segments) {
    const dx = Math.abs(s.x2 - s.x1);
    const dy = Math.abs(s.y2 - s.y1);
    if (dy <= tolerance && dx >= minLength) {
      h.push({ pos: (s.y1 + s.y2) / 2, from: Math.min(s.x1, s.x2), to: Math.max(s.x1, s.x2) });
    } else if (dx <= tolerance && dy >= minLength) {
      v.push({ pos: (s.x1 + s.x2) / 2, from: Math.min(s.y1, s.y2), to: Math.max(s.y1, s.y2) });
    }
  }
  return { h, v };
}

/**
 * 把同类线按位置聚类（同一条网格线常被拆成多段），合并覆盖区间。
 * 返回按 pos 降序排列的线（表格从上到下）。
 */
function mergeLines(lines: GridLine[], tolerance: number): GridLine[] {
  if (lines.length === 0) return [];
  const sorted = [...lines].sort((a, b) => b.pos - a.pos || a.from - b.from);
  const groups: GridLine[] = [{ ...sorted[0]! }];
  for (const line of sorted.slice(1)) {
    const last = groups[groups.length - 1]!;
    if (Math.abs(last.pos - line.pos) <= tolerance) {
      last.from = Math.min(last.from, line.from);
      last.to = Math.max(last.to, line.to);
    } else {
      groups.push({ ...line });
    }
  }
  return groups;
}

/** 判断一条横线是否覆盖某段 x 区间（含容差）。 */
function covers(line: GridLine, from: number, to: number, tolerance: number): boolean {
  return line.from <= from + tolerance && line.to >= to - tolerance;
}

/**
 * 纯函数：从网格线检测表格区域。
 * 要求至少 2 条横线 + 2 条竖线，且它们的交叉点构成完整矩形网格（避免误判装饰线）。
 * 检测到的区域从文本集合中移除，避免重复输出。
 */
function detectTableRegions(
  segments: PdfSegment[],
  items: PositionedItem[],
  styles: Record<string, PdfTextStyle>,
): { regions: TableRegion[]; inTable: Set<PositionedItem> } {
  const tolerance = 2.5;
  const { h: rawH, v: rawV } = classifyLines(segments, tolerance, 12);
  const hLines = mergeLines(rawH, tolerance);
  const vLines = mergeLines(rawV, tolerance).reverse(); // 竖线按 x 升序
  if (hLines.length < 2 || vLines.length < 2) return { regions: [], inTable: new Set() };

  // 构建的 x 范围 / y 范围（网格的最小包围盒）
  const gridLeft = vLines[0]!.pos;
  const gridRight = vLines[vLines.length - 1]!.pos;
  const gridTop = hLines[0]!.pos;
  const gridBottom = hLines[hLines.length - 1]!.pos;

  // 检查网格内部交叉点是否都有线覆盖（简化：每条横线覆盖整个网格宽度，
  // 每条竖线覆盖整个网格高度）。若多数线满足则认为是表格。
  const hCoverage = hLines.filter((l) => covers(l, gridLeft, gridRight, tolerance * 2)).length;
  const vCoverage = vLines.filter((l) => covers(l, gridBottom, gridTop, tolerance * 2)).length;
  const minCoverage = Math.max(2, Math.ceil(hLines.length * 0.6));
  const minVCoverage = Math.max(2, Math.ceil(vLines.length * 0.6));
  if (hCoverage < minCoverage || vCoverage < minVCoverage) return { regions: [], inTable: new Set() };

  const rowBounds = hLines.slice().sort((a, b) => b.pos - a.pos).map((l) => l.pos);
  const colBounds = vLines.slice().sort((a, b) => a.pos - b.pos).map((l) => l.pos);

  // 把文本片段按中心点落入单元格
  const cellMap = new Map<string, PositionedItem[]>();
  const inTable = new Set<PositionedItem>();
  for (const item of items) {
    const cx = item.x + item.width / 2;
    const cy = item.y + item.size * 0.35;
    if (cx < gridLeft - tolerance || cx > gridRight + tolerance) continue;
    if (cy > gridTop + tolerance || cy < gridBottom - tolerance) continue;
    let row = -1;
    let col = -1;
    for (let i = 0; i < rowBounds.length - 1; i += 1) {
      if (cy <= rowBounds[i]! && cy >= rowBounds[i + 1]!) {
        row = i;
        break;
      }
    }
    for (let j = 0; j < colBounds.length - 1; j += 1) {
      if (cx >= colBounds[j]! && cx <= colBounds[j + 1]!) {
        col = j;
        break;
      }
    }
    if (row < 0 || col < 0) continue;
    inTable.add(item);
    const key = `${row}:${col}`;
    const bucket = cellMap.get(key) ?? [];
    bucket.push(item);
    cellMap.set(key, bucket);
  }
  if (inTable.size === 0) return { regions: [], inTable: new Set() };

  const rows: string[][] = [];
  for (let i = 0; i < rowBounds.length - 1; i += 1) {
    const row: string[] = [];
    for (let j = 0; j < colBounds.length - 1; j += 1) {
      const cell = cellMap.get(`${i}:${j}`) ?? [];
      cell.sort((a, b) => b.y - a.y || a.x - b.x);
      row.push(joinLine(cell, styles).replace(/\|/g, "\\|"));
    }
    rows.push(row);
  }
  return {
    regions: [{ rowBounds, colBounds, rows, top: gridTop, bottom: gridBottom, left: gridLeft, right: gridRight }],
    inTable,
  };
}

/**
 * 把 pdfjs 的 operator list（fnArray + argsArray）归一化为绘图操作。
 * OPS 数值常量由调用方传入，便于与当前 pdfjs 版本解耦。
 */
export function opListToDrawOps(
  fnArray: number[],
  argsArray: unknown[][],
  ops: {
    save: number;
    restore: number;
    transform: number;
    rectangle: number;
    moveTo: number;
    lineTo: number;
    closePath: number;
    stroke: number;
    closeStroke: number;
    fill: number;
    eoFill: number;
    fillStroke: number;
    eoFillStroke: number;
    closeFillStroke: number;
    closeEOFillStroke: number;
    endPath: number;
    clip: number;
    eoClip: number;
    /** pdfjs 6+ 用 constructPath 统一承载路径；旧版本用 rectangle/moveTo/lineTo。 */
    constructPath?: number;
  },
): PdfDrawOp[] {
  const out: PdfDrawOp[] = [];
  const num = (v: unknown): number => Number(v) || 0;
  const isDrawOp = (fn: number): boolean =>
    fn === ops.stroke ||
    fn === ops.closeStroke ||
    fn === ops.fill ||
    fn === ops.eoFill ||
    fn === ops.fillStroke ||
    fn === ops.eoFillStroke ||
    fn === ops.closeFillStroke ||
    fn === ops.closeEOFillStroke ||
    fn === ops.endPath;

  /** 解析 constructPath 的扁平命令数组：[cmd, ...coords, cmd, ...]。 */
  const parsePathCommands = (raw: unknown): void => {
    // pdfjs 传的是 typed array；跨结构化克隆后可能变成无 length 的索引对象。
    const cmd: number[] = [];
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      const len = typeof obj.length === "number" ? obj.length : Object.keys(obj).length;
      for (let k = 0; k < len; k += 1) cmd.push(num(obj[k]));
    }
    let i = 0;
    while (i < cmd.length) {
      const op = cmd[i++];
      if (op === 0) {
        // moveTo(x, y)
        out.push({ kind: "moveTo", x: num(cmd[i]), y: num(cmd[i + 1]) });
        i += 2;
      } else if (op === 1) {
        // lineTo(x, y)
        out.push({ kind: "lineTo", x: num(cmd[i]), y: num(cmd[i + 1]) });
        i += 2;
      } else if (op === 2 || op === 3) {
        // curveTo / quadraticCurveTo：取终点作为直线段近似（表格框线一般为直线）
        const stride = op === 2 ? 6 : 4;
        out.push({ kind: "lineTo", x: num(cmd[i + stride - 2]), y: num(cmd[i + stride - 1]) });
        i += stride;
      } else if (op === 4) {
        out.push({ kind: "closePath" });
      } else {
        break;
      }
    }
  };

  for (let i = 0; i < fnArray.length; i += 1) {
    const fn = fnArray[i] ?? -1;
    const args = (argsArray[i] ?? []) as unknown[];
    if (ops.constructPath !== undefined && fn === ops.constructPath) {
      // pdfjs 6+：args = [绘制操作码, 命令数组, bbox]
      const drawCode = num(args[0]);
      parsePathCommands(args[1]);
      out.push({ kind: "flush", draw: isDrawOp(drawCode) && drawCode !== ops.endPath });
      continue;
    }
    if (fn === ops.save) out.push({ kind: "save" });
    else if (fn === ops.restore) out.push({ kind: "restore" });
    else if (fn === ops.transform)
      out.push({ kind: "transform", matrix: (args as number[]).slice(0, 6).map(num) });
    else if (fn === ops.rectangle)
      out.push({ kind: "rect", x: num(args[0]), y: num(args[1]), width: num(args[2]), height: num(args[3]) });
    else if (fn === ops.moveTo) out.push({ kind: "moveTo", x: num(args[0]), y: num(args[1]) });
    else if (fn === ops.lineTo) out.push({ kind: "lineTo", x: num(args[0]), y: num(args[1]) });
    else if (fn === ops.closePath) out.push({ kind: "closePath" });
    else if (isDrawOp(fn)) out.push({ kind: "flush", draw: true });
    else if (fn === ops.clip || fn === ops.eoClip) out.push({ kind: "flush", draw: false });
  }
  return out;
}

/** PDF.js 只支持在渲染进程使用；worker 与 CMap 配置沿用 PdfPreview。 */
async function loadPdfjs() {
  const [pdfjs, workerModule] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;
  return pdfjs;
}

/**
 * 合并跨页拆断的表格：上一页以表格结尾、下一页以表格开头且列数一致时，
 * 续页首行满足任一条件即并入上一页表格：
 * - 「重复的表头行」：与上一页表头相同，去重后并入；
 * - 「空标签单元格」：合并单元格跨页留下的空首格；
 * - 「首格标签不同」：续页首行是表格中段的普通行（标签 ≠ 上表首行标签）。
 *   同一模板的相邻两张新表首行标签相同（如都以「测试编号」开头），据此避免误并。
 */
export function mergeSplitTables(pageBlocks: Block[][]): void {
  for (let i = 1; i < pageBlocks.length; i += 1) {
    const prev = pageBlocks[i - 1];
    const cur = pageBlocks[i];
    if (!prev || !cur) continue;
    const prevLast = prev[prev.length - 1];
    const curFirst = cur[0];
    if (!prevLast || !curFirst) continue;
    if (prevLast.kind !== "table" || curFirst.kind !== "table") continue;
    const prevHeader = prevLast.rows[0] ?? [];
    const curFirstRow = curFirst.rows[0] ?? [];
    const sameCols = prevHeader.length > 0 && prevHeader.length === curFirstRow.length;
    if (!sameCols) continue;
    const sameHeader = curFirstRow.every((c, j) => c === (prevHeader[j] ?? ""));
    const contLead = (curFirstRow[0] ?? "").trim();
    const emptyLeadCell = contLead === "";
    const midRow = contLead !== "" && contLead !== (prevHeader[0] ?? "").trim();
    if (!sameHeader && !emptyLeadCell && !midRow) continue;
    for (const row of curFirst.rows.slice(sameHeader ? 1 : 0)) {
      if (row.length > 0) prevLast.rows.push(row);
    }
    cur.shift();
  }
}

/**
 * 从 PDF 字节提取整篇 Markdown。
 * @param data PDF 文件字节
 * @param onProgress 每页完成后的进度回调（当前页、总页数）
 * @throws 无可提取文本层（扫描件）或 PDF.js 加载失败时抛错
 */
export async function extractPdfMarkdown(
  data: Uint8Array,
  onProgress?: (page: number, total: number) => void,
): Promise<string> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    cMapUrl: "panda-cmaps://local/",
    cMapPacked: true,
  });
  try {
    const pdf = await task.promise;
    const pageBlocks: Block[][] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent({ includeMarkedContent: true });
      const items: PdfTextItem[] = [];
      const stream: StructStreamEntry[] = [];
      for (const part of content.items) {
        if ("str" in part) {
          const item: PdfTextItem = {
            str: part.str,
            transform: part.transform,
            width: part.width,
            height: part.height,
            fontName: part.fontName,
            hasEOL: part.hasEOL,
          };
          items.push(item);
          stream.push({ kind: "text", item });
        } else if (part.type === "beginMarkedContentProps") {
          stream.push({ kind: "mc-begin", id: typeof part.id === "string" ? part.id : null });
        } else if (part.type === "endMarkedContent") {
          stream.push({ kind: "mc-end" });
        }
      }
      const styles = content.styles as Record<string, PdfTextStyle>;

      // 结构树优先：Tagged PDF 用语义节点精确重建（标题/表格/列表/段落）。
      let tree: PdfStructNode | null = null;
      try {
        tree = (await page.getStructTree()) as PdfStructNode | null;
      } catch {
        tree = null;
      }
      let blocks: Block[] | null = tree ? structTreeToBlocks(tree, stream, styles) : null;

      // 回退几何路径：Lattice 矢量框线 + 字号/列间隙启发式。
      if (!blocks) {
        let segments: PdfSegment[] = [];
        try {
          const opList = await page.getOperatorList();
          const drawOps = opListToDrawOps(
            opList.fnArray,
            opList.argsArray,
            pdfjs.OPS as Parameters<typeof opListToDrawOps>[2],
          );
          segments = drawOpsToSegments(drawOps);
        } catch {
          segments = [];
        }
        const geo = itemsToBlocks(items, styles, segments);
        blocks = applyStructRoles(geo, tree) ?? geo;
      }
      pageBlocks.push(blocks);
      onProgress?.(pageNumber, pdf.numPages);
    }
    mergeSplitTables(pageBlocks);
    const pages = pageBlocks.map((b) => blocksToMarkdown(b));
    const markdown = pages.join("\n\n").replace(/\n{3,}/g, "\n\n");
    if (!markdown.trim()) throw new Error(NO_TEXT_ERROR);
    return markdown;
  } finally {
    void task.destroy();
  }
}
