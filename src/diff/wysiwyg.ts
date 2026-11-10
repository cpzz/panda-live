import { diffLines, diffWordsWithSpace } from "diff";
import type { PMJson } from "../editor/schema";
import { renderMarkdownToHtml } from "../formats/markdown/preview";
import { blockLineRanges, type BlockLineRange } from "../formats/markdown/serialize";
import type { LineDiff, WordSegment } from "./compute";

export interface WysiwygBlockMark {
  index: number;
  kind: "add" | "change";
}

export interface WysiwygInlineMark {
  /** 目标文本块的子节点路径：顶层块下标 → 行/单元格 → 段落。 */
  path: number[];
  segments: WordSegment[];
}

export interface WysiwygCodeLine {
  kind: "add" | "del" | "same";
  text: string;
}

export interface WysiwygCodeMark {
  /** 代码块路径；目前代码块都在顶层。 */
  path: number[];
  lines: WysiwygCodeLine[];
}

export interface WysiwygGhost {
  /** 幽灵块插入位置：顶层块下标，等于块数量时追加到末尾。 */
  before: number;
  html: string;
  /** 删除的原始 Markdown，用于「复制原文」。 */
  text: string;
}

export interface WysiwygDiffModel {
  blocks: WysiwygBlockMark[];
  inline: WysiwygInlineMark[];
  code: WysiwygCodeMark[];
  ghosts: WysiwygGhost[];
  /** 顶层块行范围，供导航定位。 */
  ranges: BlockLineRange[];
  totalLines: number;
}

/** 顶层块中的纯文本块类型；容器内文本另行配对。 */
const TEXT_BLOCK_TYPES = new Set(["paragraph", "heading"]);

/** 行内原子节点无法安全拆分，含这类节点的块跳过词级标记。 */
const INLINE_ATOMS = new Set([
  "image",
  "math_inline",
  "mathml_inline",
  "html_inline",
  "hard_break",
]);

/** 容器类型 → 旧渲染 HTML 中的顶层标签。 */
const CONTAINER_TAGS: Record<string, string[]> = {
  bullet_list: ["UL"],
  ordered_list: ["OL"],
  table: ["TABLE"],
  blockquote: ["BLOCKQUOTE"],
};

const OLD_HTML_CACHE_LIMIT = 4;
const oldHtmlCache = new Map<string, string>();

async function renderOldAnnotated(text: string): Promise<string> {
  const cached = oldHtmlCache.get(text);
  if (cached !== undefined) return cached;
  const html = await renderMarkdownToHtml(text, { annotateSource: true });
  oldHtmlCache.set(text, html);
  if (oldHtmlCache.size > OLD_HTML_CACHE_LIMIT) {
    const oldest = oldHtmlCache.keys().next().value;
    if (oldest !== undefined) oldHtmlCache.delete(oldest);
  }
  return html;
}

function textLineCount(text: string): number {
  if (!text) return 1;
  return text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").length;
}

function intersects(range: BlockLineRange, start: number, count: number): boolean {
  if (count <= 0) return false;
  return range.start <= start + count - 1 && range.end >= start;
}

/** 与预览一致：仅接近整篇重写（覆盖 80% 以上）时退化为块级标注。见 §21.5。 */
function isRewrite(diff: LineDiff, newText: string): boolean {
  const total = textLineCount(newText);
  if (total < 20) return false;
  const covered = diff.hunks.reduce(
    (sum, hunk) => (hunk.kind === "delete" ? sum : sum + hunk.newCount),
    0,
  );
  return covered / total > 0.8;
}

function plainText(node: PMJson): string | null {
  if (node.type === "text") return node.text ?? "";
  if (INLINE_ATOMS.has(node.type)) return null;
  if (!node.content) return "";
  let output = "";
  for (const child of node.content) {
    const inner = plainText(child);
    if (inner === null) return null;
    output += inner;
  }
  return output;
}

interface OldUnit {
  element: HTMLElement;
  tag: string;
  start: number;
  end: number;
}

const OLD_UNSAFE_SELECTOR = "pre, table, img, svg, math, .katex, .katex-display, .diagram-svg";
const OLD_TEXT_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6"]);

function oldTopUnits(html: string): OldUnit[] {
  const template = document.createElement("template");
  template.innerHTML = html;
  const units: OldUnit[] = [];
  for (const child of [...template.content.children]) {
    if (!(child instanceof HTMLElement)) continue;
    const start = Number(child.dataset["srcLine"]);
    const end = Number(child.dataset["srcEndLine"] ?? child.dataset["srcLine"]);
    if (!Number.isFinite(start) || start <= 0) continue;
    units.push({
      element: child,
      tag: child.tagName,
      start,
      end: Number.isFinite(end) && end >= start ? end : start,
    });
  }
  return units;
}

function oldTextUnits(units: OldUnit[]): OldUnit[] {
  return units.filter((unit) => OLD_TEXT_TAGS.has(unit.tag) && !unit.element.querySelector(OLD_UNSAFE_SELECTOR));
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function textSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const max = Math.max(left.length, right.length);
  if (max === 0) return 1;
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return (prefix + suffix) / max;
}

/** 数量一致时按顺序配对，否则按文本相似度贪心配对。 */
function pairByUnit<A, B>(
  oldItems: A[],
  newItems: B[],
  oldText: (item: A) => string,
  newText: (item: B) => string,
): Array<[A, B]> {
  if (oldItems.length === newItems.length) {
    return oldItems.map((item, index) => [item, newItems[index]!] as [A, B]);
  }
  const pairs: Array<[A, B]> = [];
  const used = new Set<number>();
  for (const newItem of newItems) {
    let best = -1;
    let bestScore = -1;
    oldItems.forEach((oldItem, index) => {
      if (used.has(index)) return;
      const score = textSimilarity(oldText(oldItem), newText(newItem));
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    });
    if (best < 0) continue;
    used.add(best);
    pairs.push([oldItems[best]!, newItem]);
  }
  return pairs;
}

async function buildInline(
  blocks: PMJson[],
  ranges: BlockLineRange[],
  oldUnits: OldUnit[],
  diff: LineDiff,
  isCancelled: () => boolean,
): Promise<WysiwygInlineMark[]> {
  const changeHunks = diff.hunks.filter((hunk) => hunk.kind === "change" && hunk.words);
  if (changeHunks.length === 0) return [];
  const textUnits = oldTextUnits(oldUnits);
  const marks: WysiwygInlineMark[] = [];

  for (const hunk of changeHunks) {
    const newCandidates: Array<{ index: number; text: string }> = [];
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]!;
      if (!TEXT_BLOCK_TYPES.has(block.type)) continue;
      const range = ranges[index];
      if (!range || !intersects(range, hunk.newStart, hunk.newCount)) continue;
      const text = plainText(block);
      if (text !== null && text.length > 0) newCandidates.push({ index, text });
    }
    const oldCandidates = textUnits.filter((unit) =>
      intersects({ start: unit.start, end: unit.end }, hunk.oldStart, hunk.oldCount),
    );
    const pairs = pairByUnit(
      oldCandidates,
      newCandidates,
      (unit) => normalizeText(unit.element.textContent ?? ""),
      (candidate) => normalizeText(candidate.text),
    );
    for (const [source, target] of pairs) {
      const sourceText = normalizeText(source.element.textContent ?? "");
      if (sourceText.length === 0) continue;
      const segments = diffWordsWithSpace(sourceText, target.text);
      if (segments.length === 0) continue;
      marks.push({
        path: [target.index],
        segments: segments.map((part) => ({
          kind: part.added ? "ins" : part.removed ? "del" : "same",
          text: part.value,
        })),
      });
    }
  }
  if (isCancelled()) return [];
  return marks;
}

/** 列表项文本：剔除嵌套列表，避免父项把子项文本算进来。 */
function listItemText(item: HTMLElement): string {
  const clone = item.cloneNode(true) as HTMLElement;
  for (const nested of [...clone.querySelectorAll("ul, ol")]) nested.remove();
  return normalizeText(clone.textContent ?? "");
}

function cellText(cell: Element): string {
  return normalizeText(cell.textContent ?? "");
}

function codeLineDiff(oldCode: string, newCode: string): WysiwygCodeLine[] {
  const parts = diffLines(`${oldCode.replace(/\n+$/, "")}\n`, `${newCode.replace(/\n+$/, "")}\n`);
  const lines: WysiwygCodeLine[] = [];
  for (const part of parts) {
    for (const line of part.value.replace(/\n$/, "").split("\n")) {
      lines.push({ kind: part.added ? "add" : part.removed ? "del" : "same", text: line });
    }
  }
  return lines.some((line) => line.kind !== "same") ? lines : [];
}

function paragraphOf(node: PMJson): PMJson | null {
  const first = node.content?.[0];
  return first && first.type === "paragraph" ? first : null;
}

/**
 * 容器内部的词级与代码行标记：按旧渲染结构的行/单元格顺序与 PM 子节点配对。
 * 只处理与改动 hunk 相交的顶层容器，避免全量比较。见 §21.5。
 */
function buildNestedMarks(
  blocks: PMJson[],
  ranges: BlockLineRange[],
  oldUnits: OldUnit[],
  diff: LineDiff,
  isCancelled: () => boolean,
): { inline: WysiwygInlineMark[]; code: WysiwygCodeMark[] } {
  const changeHunks = diff.hunks.filter((hunk) => hunk.kind === "change");
  const inline: WysiwygInlineMark[] = [];
  const code: WysiwygCodeMark[] = [];
  const usedOld = new Set<OldUnit>();

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    const range = ranges[index];
    if (!range) continue;
    const blockHunks = changeHunks.filter((hunk) => intersects(range, hunk.newStart, hunk.newCount));
    if (blockHunks.length === 0) continue;

    if (block.type === "code_block") {
      const old = oldUnits.find(
        (unit) =>
          unit.tag === "PRE" &&
          !usedOld.has(unit) &&
          blockHunks.some((hunk) => intersects({ start: unit.start, end: unit.end }, hunk.oldStart, hunk.oldCount)),
      );
      if (!old) continue;
      usedOld.add(old);
      const oldCode = old.element.textContent ?? "";
      const newCode = (block.content ?? []).map((child) => child.text ?? "").join("");
      if (isCancelled()) return { inline, code };
      const lines = codeLineDiff(oldCode, newCode);
      if (lines.length > 0) code.push({ path: [index], lines });
      continue;
    }

    const tags = CONTAINER_TAGS[block.type];
    if (!tags) continue;
    const old = oldUnits.find(
      (unit) =>
        tags.includes(unit.tag) &&
        !usedOld.has(unit) &&
        blockHunks.some((hunk) => intersects({ start: unit.start, end: unit.end }, hunk.oldStart, hunk.oldCount)),
    );
    if (!old) continue;
    usedOld.add(old);

    if (block.type === "bullet_list" || block.type === "ordered_list") {
      const oldItems = [...old.element.children].filter(
        (element): element is HTMLElement => element instanceof HTMLElement && element.tagName === "LI",
      );
      const newItems = block.content ?? [];
      const pairs = pairByUnit(
        oldItems,
        newItems,
        (item) => listItemText(item),
        (item) => normalizeText(paragraphOf(item) ? (plainText(paragraphOf(item)!) ?? "") : ""),
      );
      for (const [source, target] of pairs) {
        const paragraph = paragraphOf(target);
        if (!paragraph) continue;
        const sourceText = listItemText(source);
        const targetText = plainText(paragraph);
        if (!targetText || sourceText.length === 0 || sourceText === targetText) continue;
        inline.push({
          path: [index, newItems.indexOf(target), 0],
          segments: diffWordsWithSpace(sourceText, targetText).map((part) => ({
            kind: part.added ? "ins" : part.removed ? "del" : "same",
            text: part.value,
          })),
        });
      }
      continue;
    }

    if (block.type === "table") {
      const oldRows = [...old.element.querySelectorAll("tr")];
      const newRows = block.content ?? [];
      const rowPairs = pairByUnit(
        oldRows,
        newRows,
        (row) => normalizeText(row.textContent ?? ""),
        (row) => normalizeText((row.content ?? []).map((cell) => (paragraphOf(cell) ? plainText(paragraphOf(cell)!) ?? "" : "")).join(" ")),
      );
      for (const [oldRow, newRow] of rowPairs) {
        const oldCells = [...oldRow.children].filter(
          (element) => element.tagName === "TD" || element.tagName === "TH",
        );
        const newCells = newRow.content ?? [];
        const cellPairs = pairByUnit(
          oldCells,
          newCells,
          (cell) => cellText(cell),
          (cell) => normalizeText(paragraphOf(cell) ? (plainText(paragraphOf(cell)!) ?? "") : ""),
        );
        for (const [sourceCell, targetCell] of cellPairs) {
          const paragraph = paragraphOf(targetCell);
          if (!paragraph) continue;
          const sourceText = cellText(sourceCell);
          const targetText = plainText(paragraph);
          if (!targetText || sourceText.length === 0 || sourceText === targetText) continue;
          inline.push({
            path: [index, newRows.indexOf(newRow), newCells.indexOf(targetCell), 0],
            segments: diffWordsWithSpace(sourceText, targetText).map((part) => ({
              kind: part.added ? "ins" : part.removed ? "del" : "same",
              text: part.value,
            })),
          });
        }
      }
      continue;
    }

    if (block.type === "blockquote") {
      const oldParagraphs = [...old.element.children].filter(
        (element): element is HTMLElement => element instanceof HTMLElement && element.tagName === "P",
      );
      const newChildren = block.content ?? [];
      const pairs = pairByUnit(
        oldParagraphs,
        newChildren,
        (element) => normalizeText(element.textContent ?? ""),
        (child) => normalizeText(plainText(child) ?? ""),
      );
      for (const [source, target] of pairs) {
        if (target.type !== "paragraph") continue;
        const sourceText = normalizeText(source.textContent ?? "");
        const targetText = plainText(target);
        if (!targetText || sourceText.length === 0 || sourceText === targetText) continue;
        inline.push({
          path: [index, newChildren.indexOf(target)],
          segments: diffWordsWithSpace(sourceText, targetText).map((part) => ({
            kind: part.added ? "ins" : part.removed ? "del" : "same",
            text: part.value,
          })),
        });
      }
    }
  }

  if (isCancelled()) return { inline: [], code: [] };
  return { inline, code };
}

/** 删除的表格行缺少表头时补一个骨架，避免幽灵块退化成竖线文本。 */
function tableGhostText(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0 || !lines.every((line) => /^\s*\|.*\|\s*$/.test(line))) return text;
  const columns = Math.max(...lines.map((line) => Math.max(0, line.split("|").length - 2)));
  if (columns <= 0) return text;
  const header = `|${Array.from({ length: columns }, () => " ").join("|")}|`;
  const divider = `|${Array.from({ length: columns }, () => "---").join("|")}|`;
  return `${header}\n${divider}\n${lines.join("\n")}\n`;
}

async function buildGhosts(
  diff: LineDiff,
  ranges: BlockLineRange[],
  blockCount: number,
  isCancelled: () => boolean,
): Promise<WysiwygGhost[]> {
  const grouped = new Map<number, { html: string[]; text: string[] }>();
  for (const hunk of diff.hunks) {
    if (hunk.kind !== "delete") continue;
    const found = ranges.findIndex((range) => range.start >= hunk.newStart);
    const before = found === -1 ? blockCount : found;
    const html = await renderMarkdownToHtml(tableGhostText(hunk.oldText), {
      annotateSource: true,
    });
    if (isCancelled()) return [];
    const entry = grouped.get(before) ?? { html: [], text: [] };
    entry.html.push(html);
    entry.text.push(hunk.oldText);
    grouped.set(before, entry);
  }
  return [...grouped.entries()]
    .map(([before, entry]) => ({
      before,
      html: entry.html.join(""),
      text: entry.text.join("\n"),
    }))
    .sort((a, b) => a.before - b.before);
}

/**
 * 把行 diff 映射到 ProseMirror 顶层块与容器子节点。
 * 行号来自与 `serializeMarkdown` 相同的序列化器，保证与当前文档一致。见 §21.5。
 */
export async function buildWysiwygDiff({
  docJson,
  newText,
  oldText,
  diff,
  isCancelled = () => false,
}: {
  docJson: PMJson;
  newText: string;
  oldText: string;
  diff: LineDiff;
  isCancelled?: () => boolean;
}): Promise<WysiwygDiffModel | null> {
  const blocks = docJson.content ?? [];
  const map = blockLineRanges(docJson);
  if (map.ranges.length !== blocks.length) return null;
  // 序列化器与编辑器内容不同步时放弃装饰，避免标错块。
  if (Math.abs(map.totalLines - textLineCount(newText)) > 1) return null;

  const kinds = new Map<number, "add" | "change">();
  for (const hunk of diff.hunks) {
    if (hunk.kind === "delete") continue;
    for (let index = 0; index < blocks.length; index += 1) {
      const range = map.ranges[index];
      if (!range || !intersects(range, hunk.newStart, hunk.newCount)) continue;
      const kind = hunk.kind === "change" ? "change" : "add";
      if (kinds.get(index) !== "change") kinds.set(index, kind);
    }
  }

  const rewrite = isRewrite(diff, newText);
  const oldHtml =
    !rewrite && oldText.trim().length > 0 ? await renderOldAnnotated(oldText) : "";
  if (isCancelled()) return null;
  const oldUnits = oldHtml ? oldTopUnits(oldHtml) : [];
  const inline = rewrite
    ? []
    : await buildInline(blocks, map.ranges, oldUnits, diff, isCancelled);
  if (isCancelled()) return null;
  const nested = rewrite
    ? { inline: [], code: [] }
    : buildNestedMarks(blocks, map.ranges, oldUnits, diff, isCancelled);
  if (isCancelled()) return null;
  const ghosts = await buildGhosts(diff, map.ranges, blocks.length, isCancelled);
  if (isCancelled()) return null;

  return {
    blocks: [...kinds.entries()].map(([index, kind]) => ({ index, kind })),
    inline: [...inline, ...nested.inline],
    code: nested.code,
    ghosts,
    ranges: map.ranges,
    totalLines: map.totalLines,
  };
}
