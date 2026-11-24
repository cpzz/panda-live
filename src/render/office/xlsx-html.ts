/** Excel 工作簿 → HTML 表格（只读预览）。纯函数，Node 环境可单测。
 * 样式取 SheetJS cellStyles 解析出的子集：粗体/斜体/字号/字体色/填充色/水平对齐/边框。 */
import type { WorkBook, WorkSheet } from "xlsx";

/** 预览行列上限：超过后截断并提示，避免巨型表格卡死渲染进程。 */
export const XLSX_PREVIEW_MAX_ROWS = 5000;
export const XLSX_PREVIEW_MAX_COLS = 200;

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
  if (typeof rgb === "string" && /^[0-9a-fA-F]{6}$/.test(rgb)) return `#${rgb}`;
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
  // 无填充图案（如"gray125"以外的纯色）才取前景色；白底不输出。
  const fill = style.fill;
  if (fill && fill.patternType !== "none") {
    const fillHex = cssColor(fill.fgColor?.rgb);
    if (fillHex && fillHex !== "#FFFFFF" && fillHex !== "#000000") parts.push(`background:${fillHex}`);
  }
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
  const endR = Math.min(range.e.r, startR + limit.rows - 1);
  const endC = Math.min(range.e.c, startC + limit.cols - 1);
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

  // 列宽（wch 字符数 ≈ 7px）。
  const colWidths: (number | null)[] = [];
  const cols = ws["!cols"];
  if (Array.isArray(cols)) {
    for (let c = startC; c <= endC; c += 1) {
      const entry = cols[c - startC];
      const wch = entry && typeof entry === "object" ? (entry as { wch?: number }).wch : undefined;
      colWidths.push(typeof wch === "number" && wch > 0 ? Math.round(wch * 7) : null);
    }
  }

  const parts: string[] = ['<table class="office-xlsx-table">'];
  if (colWidths.some((width) => width !== null)) {
    parts.push("<colgroup>");
    for (const width of colWidths) {
      parts.push(width !== null ? `<col style="width:${width}px" />` : "<col />");
    }
    parts.push("</colgroup>");
  }
  parts.push("<tbody>");
  for (let r = startR; r <= endR; r += 1) {
    parts.push("<tr>");
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
      parts.push(`<td${attrs}>${text}</td>`);
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
