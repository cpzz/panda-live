import { diffWordsWithSpace } from "diff";
import type { DiffInlineMark, DiffLineMarker } from "../source/codemirror";
import type { DiffHunk, LineDiff } from "./compute";

/** 单个变化行超过该字符数时跳过行内标记，避免压缩成一行的大文件卡顿。 */
const INLINE_LINE_CHAR_LIMIT = 100_000;

/** 旧文本一侧的行标记：修改与删除。用于并排源码差异的左侧。 */
export function oldLineMarkers(diff: LineDiff): DiffLineMarker[] {
  const markers: DiffLineMarker[] = [];
  for (const hunk of diff.hunks) {
    if (hunk.kind === "change") {
      for (let line = 0; line < hunk.oldCount; line += 1) {
        markers.push({ line: hunk.oldStart + line, kind: "change" });
      }
    } else if (hunk.kind === "delete") {
      for (let line = 0; line < hunk.oldCount; line += 1) {
        markers.push({ line: hunk.oldStart + line, kind: "delete" });
      }
    }
  }
  return markers;
}

/** 新文本一侧的行标记：新增与修改。用于并排源码差异的右侧。 */
export function newLineMarkers(diff: LineDiff): DiffLineMarker[] {
  const markers: DiffLineMarker[] = [];
  for (const hunk of diff.hunks) {
    if (hunk.kind === "delete") continue;
    for (let line = 0; line < hunk.newCount; line += 1) {
      markers.push({
        line: hunk.newStart + line,
        kind: hunk.kind === "change" ? "change" : "add",
      });
    }
  }
  return markers;
}

/**
 * 计算变化行内的字符级标记：逐行做词级 diff，成本只随改动行数增长，
 * 因此不设整体文档上限；仅超长单行跳过（整行底色仍可见）。
 */
function inlineMarks(hunks: readonly DiffHunk[], side: "old" | "new"): DiffInlineMark[] {
  const marks: DiffInlineMark[] = [];
  for (const hunk of hunks) {
    if (hunk.kind !== "change") continue;
    const oldLines = hunk.oldText.split("\n");
    const newLines = hunk.newText.split("\n");
    const pairs = Math.min(hunk.oldCount, hunk.newCount);
    for (let index = 0; index < pairs; index += 1) {
      const oldLine = oldLines[index] ?? "";
      const newLine = newLines[index] ?? "";
      if (oldLine.length + newLine.length > INLINE_LINE_CHAR_LIMIT) continue;
      const parts = diffWordsWithSpace(oldLine, newLine);
      const line = side === "old" ? hunk.oldStart + index : hunk.newStart + index;
      let column = 0;
      for (const part of parts) {
        const length = part.value.length;
        if (side === "old") {
          if (part.removed && length > 0) {
            marks.push({ line, from: column, to: column + length, kind: "del" });
          }
          if (!part.added) column += length;
        } else {
          if (part.added && length > 0) {
            marks.push({ line, from: column, to: column + length, kind: "add" });
          }
          if (!part.removed) column += length;
        }
      }
    }
  }
  return marks;
}

/** 旧文本一侧的行内删除字符。 */
export function oldInlineMarks(diff: LineDiff): DiffInlineMark[] {
  return inlineMarks(diff.hunks, "old");
}

/** 新文本一侧的行内新增字符。 */
export function newInlineMarks(diff: LineDiff): DiffInlineMark[] {
  return inlineMarks(diff.hunks, "new");
}
