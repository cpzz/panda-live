import { diffLines, diffWordsWithSpace } from "diff";

/** 词级差异片段；`same` 原样输出，`ins` / `del` 生成标记。 */
export interface WordSegment {
  kind: "same" | "ins" | "del";
  text: string;
}

export type DiffHunkKind = "add" | "change" | "delete";

export interface DiffHunk {
  kind: DiffHunkKind;
  /** 旧文档起始行与行数（1 基）。 */
  oldStart: number;
  oldCount: number;
  /** 新文档起始行与行数（1 基）。删除 hunk 的 newCount 为 0。 */
  newStart: number;
  newCount: number;
  oldText: string;
  newText: string;
  /** 仅 change hunk 且未降级时存在。 */
  words?: WordSegment[];
}

export interface DiffStats {
  added: number;
  removed: number;
  changed: number;
}

/** 与 git diff 对齐的比较选项。 */
export interface DiffOptions {
  wordDiff?: boolean;
  /** 对应 git diff -w：忽略行内空白差异。 */
  ignoreWhitespace?: boolean;
  /** 对应 --ignore-blank-lines：忽略只涉及空行的增删改。 */
  ignoreBlankLines?: boolean;
  /** 对应 --ignore-cr-at-eol；默认 true，保持应用内统一换行。 */
  ignoreCrAtEol?: boolean;
}

export interface LineDiff {
  hunks: DiffHunk[];
  /** 新文档中新增 / 修改的行号（1 基），供源码 gutter 使用。 */
  newLineKinds: Map<number, "add" | "change">;
  /** 删除发生的锚点行（新文档行号）→ 删除行数。 */
  deletionsAt: Map<number, number>;
  stats: DiffStats;
  /** 文件过大时跳过词级比较。 */
  wordDiffSkipped: boolean;
}

/** 超过该字符数（两段合计）跳过词级 diff，避免大文档卡顿。见 §21.4。 */
const WORD_DIFF_CHAR_LIMIT = 400_000;

/**
 * 统一换行与 BOM，并保证非空文本以单个换行结尾。
 * 不统一时 Windows 的 CRLF 会让整篇文档误报为全量修改。见 §21.3。
 */
export function normalizeDiffText(
  text: string,
  options: { ignoreCrAtEol?: boolean } = {},
): string {
  const source = text.replace(/^\uFEFF/, "");
  const unified =
    options.ignoreCrAtEol === false
      ? source.replace(/\r(?!\n)/g, "\n")
      : source.replace(/\r\n?/g, "\n");
  const trimmed = unified.replace(/\n+$/, "");
  return trimmed.length === 0 ? "" : `${trimmed}\n`;
}

function countLines(value: string): number {
  if (value.length === 0) return 0;
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function toWordSegments(parts: Array<{ value: string; added?: boolean; removed?: boolean }>): WordSegment[] {
  return parts.map((part) => ({
    kind: part.added ? "ins" : part.removed ? "del" : "same",
    text: part.value,
  }));
}

/**
 * 行级 diff + 修改行内的词级 diff。行级结果按「删除后紧跟新增」归并为 change，
 * 避免同一处编辑被拆成两条记录。见 doc/design.md §21.4。
 */
export function computeLineDiff(
  oldText: string,
  newText: string,
  options: DiffOptions = {},
): LineDiff {
  const oldNorm = normalizeDiffText(oldText, options);
  const newNorm = normalizeDiffText(newText, options);
  // -w 只影响比较文本；hunk 仍引用原始行，保证渲染与行号正确。
  const oldCompare = options.ignoreWhitespace ? stripLineWhitespace(oldNorm) : oldNorm;
  const newCompare = options.ignoreWhitespace ? stripLineWhitespace(newNorm) : newNorm;
  const parts = diffLines(oldCompare, newCompare);
  const oldLines = splitTextLines(oldNorm);
  const newLines = splitTextLines(newNorm);
  const hunks: DiffHunk[] = [];
  const allowWords =
    options.wordDiff !== false && oldNorm.length + newNorm.length <= WORD_DIFF_CHAR_LIMIT;

  let oldLine = 1;
  let newLine = 1;
  let index = 0;

  while (index < parts.length) {
    const part = parts[index]!;
    if (!part.added && !part.removed) {
      const count = countLines(part.value);
      oldLine += count;
      newLine += count;
      index += 1;
      continue;
    }

    if (part.removed) {
      const next = parts[index + 1];
      if (next?.added) {
        const oldCount = countLines(part.value);
        const newCount = countLines(next.value);
        const hunk: DiffHunk = {
          kind: "change",
          oldStart: oldLine,
          oldCount,
          newStart: newLine,
          newCount,
          oldText: sliceLines(oldLines, oldLine, oldCount),
          newText: sliceLines(newLines, newLine, newCount),
        };
        if (allowWords) {
          hunk.words = toWordSegments(diffWordsWithSpace(hunk.oldText, hunk.newText));
        }
        hunks.push(hunk);
        oldLine += oldCount;
        newLine += newCount;
        index += 2;
        continue;
      }

      const oldCount = countLines(part.value);
      if (oldCount > 0) {
        hunks.push({
          kind: "delete",
          oldStart: oldLine,
          oldCount,
          newStart: newLine,
          newCount: 0,
          oldText: sliceLines(oldLines, oldLine, oldCount),
          newText: "",
        });
        oldLine += oldCount;
      }
      index += 1;
      continue;
    }

    const newCount = countLines(part.value);
    if (newCount > 0) {
      hunks.push({
        kind: "add",
        oldStart: oldLine,
        oldCount: 0,
        newStart: newLine,
        newCount,
        oldText: "",
        newText: sliceLines(newLines, newLine, newCount),
      });
      newLine += newCount;
    }
    index += 1;
  }

  const finalHunks = options.ignoreBlankLines
    ? hunks.filter((hunk) => !(isBlankText(hunk.oldText) && isBlankText(hunk.newText)))
    : hunks;
  const newLineKinds = new Map<number, "add" | "change">();
  const deletionsAt = new Map<number, number>();
  for (const hunk of finalHunks) {
    if (hunk.kind === "delete") {
      deletionsAt.set(hunk.newStart, (deletionsAt.get(hunk.newStart) ?? 0) + hunk.oldCount);
      continue;
    }
    for (let line = 0; line < hunk.newCount; line += 1) {
      newLineKinds.set(hunk.newStart + line, hunk.kind === "change" ? "change" : "add");
    }
  }

  return {
    hunks: finalHunks,
    newLineKinds,
    deletionsAt,
    stats: summarizeHunks(finalHunks),
    wordDiffSkipped:
      !allowWords && finalHunks.some((hunk) => hunk.kind === "change"),
  };
}

/** 去掉行内空白但保留换行；用于 git diff -w 的比较文本。 */
function stripLineWhitespace(text: string): string {
  return text.replace(/[^\S\n]+/g, "");
}

function splitTextLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.replace(/\n$/, "").split("\n");
}

/** 按 1 基行号截取原始行，保证 hunk 文本不丢原始空白。 */
function sliceLines(lines: string[], start: number, count: number): string {
  if (count <= 0) return "";
  return `${lines.slice(start - 1, start - 1 + count).join("\n")}\n`;
}

function isBlankText(text: string): boolean {
  return text.trim().length === 0;
}

function summarizeHunks(hunks: DiffHunk[]): DiffStats {
  const stats: DiffStats = { added: 0, removed: 0, changed: 0 };
  for (const hunk of hunks) {
    if (hunk.kind === "add") stats.added += hunk.newCount;
    else if (hunk.kind === "delete") stats.removed += hunk.oldCount;
    else {
      stats.changed += hunk.newCount;
      stats.removed += hunk.oldCount;
    }
  }
  return stats;
}

/**
 * 忽略格式差异时用于比较的规范化文本：去掉空白、列表/标题标记与强调符号。
 * 只用于判定 hunk 是否仅由排版差异产生，不改变实际渲染内容。见 §21.15。
 */
export function normalizeFormatText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, "");
}

/** 导航锚点：删除 hunk 落在其后的新行上，末尾删除回退到末行。 */
export function hunkAnchorLine(hunk: DiffHunk, newLineCount: number): number {
  const line = hunk.kind === "delete" ? Math.min(hunk.newStart, Math.max(1, newLineCount)) : hunk.newStart;
  return Math.max(1, line);
}
