/** Excel 工作簿 → HTML 表格（只读预览）。纯函数，Node 环境可单测。
 * 样式取 SheetJS cellStyles 解析出的子集：粗体/斜体/字号/字体色/填充色/水平对齐/边框。 */
import type { WorkBook, WorkSheet } from "xlsx";

/** 预览行列上限：超过后截断并提示，避免巨型表格卡死渲染进程。 */
export const XLSX_PREVIEW_MAX_ROWS = 5000;
export const XLSX_PREVIEW_MAX_COLS = 200;

/** 预览最少显示行列：即使该范围无数据也展示网格与表头，贴近 Excel 默认视图（约 A–Q / 30 行）。 */
export const XLSX_PREVIEW_MIN_ROWS = 30;
export const XLSX_PREVIEW_MIN_COLS = 17;

/** 源文件未设列宽时的默认列宽（像素）：≈ Excel 默认 8.43 字符。配合 table-layout:fixed，
 * 每列都有确定宽度，拖某列时不重分配给其他列。 */
export const XLSX_DEFAULT_COL_WIDTH = 64;

export interface OfficeSheetInfo {
  name: string;
  html: string;
  /** 因行列上限被截断。 */
  truncated: boolean;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cssColor(rgb: unknown): string | null {
  if (typeof rgb !== "string") return null;
  // 兼容 6 位（RRGGBB）与 8 位（AARRGGBB）十六进制；8 位取后 6 位丢弃 alpha。
  if (/^[0-9a-fA-F]{6}$/.test(rgb)) return `#${rgb}`;
  if (/^[0-9a-fA-F]{8}$/.test(rgb)) return `#${rgb.slice(2)}`;
  return null;
}

function borderEdge(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const style = (value as { style?: string }).style;
  if (!style) return null;
  const color = cssColor((value as { color?: { rgb?: string } }).color?.rgb) ?? "var(--border)";
  return `1px solid ${color}`;
}

/** 单元格样式 → 内联 CSS 片段（不含 style 引号）。 */
export function cellInlineStyle(cell: { s?: unknown }): string {
  const s = cell.s;
  if (!s || typeof s !== "object") return "";
  const style = s as {
    font?: { bold?: boolean; italic?: boolean; color?: { rgb?: string }; sz?: number };
    fill?: { fgColor?: { rgb?: string }; patternType?: string };
    alignment?: { horizontal?: string };
    border?: { top?: unknown; bottom?: unknown; left?: unknown; right?: unknown };
  };
  const parts: string[] = [];
  const font = style.font;
  if (font) {
    if (font.bold) parts.push("font-weight:600");
    if (font.italic) parts.push("font-style:italic");
    const color = cssColor(font.color?.rgb);
    if (color) parts.push(`color:${color}`);
    if (typeof font.sz === "number" && font.sz > 0) parts.push(`font-size:${Math.round(font.sz * 4) / 3}px`);
  }
  // 有填充图案（solid 等）才取前景色作为背景，贴近源文件底色；纯白底不输出（避免在深色主题强行铺白）。
  const fill = style.fill;
  if (fill && fill.patternType && fill.patternType !== "none") {
    const fillHex = cssColor(fill.fgColor?.rgb);
    if (fillHex && fillHex !== "#FFFFFF") parts.push(`background:${fillHex}`);
  }
  // 水平对齐取源值；折行显示改为全局开关（.office-xlsx-body.no-wrap），不在内联样式输出。
  const horizontal = style.alignment?.horizontal;
  if (horizontal === "center" || horizontal === "right") parts.push(`text-align:${horizontal}`);
  const border = style.border;
  if (border) {
    const top = borderEdge(border.top);
    if (top) parts.push(`border-top:${top}`);
    const bottom = borderEdge(border.bottom);
    if (bottom) parts.push(`border-bottom:${bottom}`);
    const left = borderEdge(border.left);
    if (left) parts.push(`border-left:${left}`);
    const right = borderEdge(border.right);
    if (right) parts.push(`border-right:${right}`);
  }
  return parts.join(";");
}

/** 单元格显示文本：优先格式化文本 w，缺省回退原始值 v。 */
function cellText(cell: { v?: unknown; w?: unknown; t?: string }): string {
  if (cell.w !== undefined && cell.w !== null) return String(cell.w);
  const v = cell.v;
  if (v === undefined || v === null) return "";
  if (cell.t === "e") return String(v);
  if (v instanceof Date) return v.toLocaleString();
  return String(v);
}

interface MergeCell {
  r: number;
  c: number;
  rowspan: number;
  colspan: number;
}

/** 工作表 → HTML 表格字符串。含列宽/合并单元格/截断提示。 */
export function sheetToTableHtml(
  ws: WorkSheet,
  limit: { rows: number; cols: number } = { rows: XLSX_PREVIEW_MAX_ROWS, cols: XLSX_PREVIEW_MAX_COLS },
): OfficeSheetInfo {
  const ref = ws["!ref"];
  if (!ref) {
    return { name: "", html: '<p class="placeholder">（空工作表）</p>', truncated: false };
  }
  const range = decodeRange(ref);
  const startR = range.s.r;
  const startC = range.s.c;
  // 显示范围：至少铺满默认行列（空列/空行也展示网格与表头，贴近 Excel），但不超过 limit 上限。
  const displayEndR = Math.max(range.e.r, startR + XLSX_PREVIEW_MIN_ROWS - 1);
  const displayEndC = Math.max(range.e.c, startC + XLSX_PREVIEW_MIN_COLS - 1);
  const endR = Math.min(startR + limit.rows - 1, displayEndR);
  const endC = Math.min(startC + limit.cols - 1, displayEndC);
  const truncated = range.e.r > endR || range.e.c > endC;

  // 合并单元格：左上角记录跨度，其余成员跳过。
  const mergeMap = new Map<string, MergeCell>();
  const mergeMembers = new Set<string>();
  for (const merge of ws["!merges"] ?? []) {
    const topR = merge.s.r;
    const topC = merge.s.c;
    mergeMap.set(`${topR},${topC}`, {
      r: topR,
      c: topC,
      rowspan: merge.e.r - merge.s.r + 1,
      colspan: merge.e.c - merge.s.c + 1,
    });
    for (let r = merge.s.r; r <= merge.e.r; r += 1) {
      for (let c = merge.s.c; c <= merge.e.c; c += 1) {
        if (r === topR && c === topC) continue;
        mergeMembers.add(`${r},${c}`);
      }
    }
  }

  // 列宽：优先取源文件的像素宽 wpx（最贴近真实 Excel 列宽）；否则用 wch 字符数估算（≈7px/字符）；
  // 缺省用默认宽。每个数据列都给确定宽度（即使源文件无 !cols 也补齐），供 table-layout:fixed 精确布局。
  const cols = Array.isArray(ws["!cols"]) ? (ws["!cols"] as { wpx?: number; wch?: number }[]) : [];
  const colWidths: number[] = [];
  // !cols 按「绝对列」索引（0 = A 列）；此处用绝对列号 c 取值，数据不从 A 列起（startC≠0）时不错位。
  for (let c = startC; c <= endC; c += 1) {
    const entry = cols[c];
    const wpx = entry && typeof entry === "object" ? entry.wpx : undefined;
    const wch = entry && typeof entry === "object" ? entry.wch : undefined;
    if (typeof wpx === "number" && wpx > 0) colWidths.push(Math.round(wpx));
    else if (typeof wch === "number" && wch > 0) colWidths.push(Math.round(wch * 7 + 5));
    else colWidths.push(XLSX_DEFAULT_COL_WIDTH);
  }

  // 行号 gutter 列宽：按最大行号位数估算（预览上限 5000 行 → 至多 4 位）。
  const gutterWidth = Math.max(36, String(endR + 1).length * 7 + 12);
  // 表格总宽 = gutter + 各列宽之和。table-layout:fixed 只有在表格有「确定宽度」时才严格按 <col> 渲染
  // （用 max-content/auto 会被内容或容器撑开，导致列宽无法小于内容、窄列不裁剪）。拖列宽时同步更新此值。
  const tableWidth = gutterWidth + colWidths.reduce((sum, w) => sum + w, 0);

  const parts: string[] = [`<table class="office-xlsx-table" style="width:${tableWidth}px">`];
  parts.push("<colgroup>");
  parts.push(`<col style="width:${gutterWidth}px" />`);
  for (const width of colWidths) {
    parts.push(`<col style="width:${width}px" />`);
  }
  parts.push("</colgroup>");
  // 列字母表头（A/B/C…）+ 角格；行号在每行首格。
  parts.push('<thead><tr><th class="office-xlsx-corner" data-corner></th>');
  for (let c = startC; c <= endC; c += 1) {
    parts.push(`<th class="office-xlsx-colhead" data-c="${c - startC}">${esc(columnLetters(c))}</th>`);
  }
  parts.push("</tr></thead>");
  parts.push("<tbody>");
  for (let r = startR; r <= endR; r += 1) {
    parts.push("<tr>");
    parts.push(`<th class="office-xlsx-rowhead" data-r="${r - startR}">${r + 1}</th>`);
    for (let c = startC; c <= endC; c += 1) {
      const key = `${r},${c}`;
      if (mergeMembers.has(key)) continue;
      const address = encodeCell(r, c);
      const cell = ws[address] as { v?: unknown; w?: unknown; t?: string; s?: unknown } | undefined;
      const merge = mergeMap.get(key);
      const span =
        merge && (merge.rowspan > 1 || merge.colspan > 1)
          ? ` rowspan="${merge.rowspan}" colspan="${merge.colspan}"`
          : "";
      const css = cell ? cellInlineStyle(cell) : "";
      const attrs = `${span}${css ? ` style="${esc(css)}"` : ""}`.trim();
      const text = cell ? esc(cellText(cell)) : "";
      // 文本包一层块级 span：折行/裁剪都作用在这层上，比直接在 <td> 上 overflow:hidden 更可靠地裁到列宽
      // （列宽 < 内容时只显能容纳的部分，如 "ABCDEFG" 收窄到 4 字符宽显示 "ABCD"）。空格不加 span 以控 DOM 体量。
      const inner = text ? `<span class="office-xlsx-celltext">${text}</span>` : "";
      parts.push(`<td data-r="${r - startR}" data-c="${c - startC}"${attrs}>${inner}</td>`);
    }
    parts.push("</tr>");
  }
  parts.push("</tbody></table>");
  return {
    name: "",
    html: parts.join(""),
    truncated,
  };
}

/** 工作簿 → 各工作表 HTML（按 sheet 顺序）。 */
export function workbookToSheetInfos(
  wb: WorkBook,
  limit?: { rows: number; cols: number },
): OfficeSheetInfo[] {
  return wb.SheetNames.map((name) => {
    const sheet = wb.Sheets[name];
    const info = sheet ? sheetToTableHtml(sheet, limit) : { name: "", html: "", truncated: false };
    return { ...info, name };
  });
}

// ---------- 内部工具（不依赖 SheetJS，便于单测） ----------

interface CellPos {
  r: number;
  c: number;
}
interface CellRange {
  s: CellPos;
  e: CellPos;
}

function decodeRange(range: string): CellRange {
  const parts = range.split(":");
  return { s: decodeCell(parts[0] ?? ""), e: decodeCell(parts[1] ?? "") };
}

function decodeCell(address: string): CellPos {
  let col = 0;
  let index = 0;
  while (index < address.length) {
    const letter = address[index] ?? "";
    if (!/[A-Za-z]/u.test(letter)) break;
    col = col * 26 + (letter.toUpperCase().charCodeAt(0) - 64);
    index += 1;
  }
  const row = Number.parseInt(address.slice(index), 10);
  return { c: col - 1, r: Number.isFinite(row) ? row - 1 : 0 };
}

/** 0 基列号 → Excel 列字母（A…Z, AA…）。 */
function columnLetters(c: number): string {
  let n = c + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function encodeCell(r: number, c: number): string {
  let col = c + 1;
  let letters = "";
  while (col > 0) {
    const rem = (col - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    col = Math.floor((col - 1) / 26);
  }
  return `${letters}${r + 1}`;
}
