import { useEffect, useRef } from "react";
import type { DiffHunk, LineDiff } from "../diff/compute";
import { newInlineMarks, newLineMarkers, oldInlineMarks, oldLineMarkers } from "../diff/markers";
import { t } from "../i18n";
import { SourceEditor, type DiffSpacer, type SourceLanguage } from "../source/codemirror";

/** 计算某一侧的未改动行区间（1 基、闭区间），至少 2 行才折叠。 */
function unchangedRanges(
  hunks: readonly DiffHunk[],
  side: "old" | "new",
): Array<{ fromLine: number; toLine: number }> {
  if (hunks.length === 0) return [];
  const ranges: Array<{ fromLine: number; toLine: number }> = [];
  let cursor = 1;
  for (const hunk of hunks) {
    const start = side === "old" ? hunk.oldStart : hunk.newStart;
    const count = side === "old" ? hunk.oldCount : hunk.newCount;
    if (start > cursor) ranges.push({ fromLine: cursor, toLine: start - 1 });
    cursor = Math.max(cursor, start + count);
  }
  // 末尾区间不预知总行数，交由 setLineFolds 按文档行数截断。
  ranges.push({ fromLine: cursor, toLine: Number.MAX_SAFE_INTEGER });
  return ranges.filter((range) => range.toLine > range.fromLine);
}

/** 计算某一侧的占位行：行少的一侧补齐，让左右逐行对齐。 */
function diffSpacers(hunks: readonly DiffHunk[], side: "old" | "new"): DiffSpacer[] {
  const spacers: DiffSpacer[] = [];
  for (const hunk of hunks) {
    if (side === "old") {
      if (hunk.kind === "add") {
        spacers.push({ line: hunk.oldStart, count: hunk.newCount, kind: "add" });
      } else if (hunk.kind === "change" && hunk.newCount > hunk.oldCount) {
        spacers.push({
          line: hunk.oldStart + hunk.oldCount,
          count: hunk.newCount - hunk.oldCount,
          kind: "add",
        });
      }
    } else if (hunk.kind === "delete") {
      spacers.push({ line: hunk.newStart, count: hunk.oldCount, kind: "delete" });
    } else if (hunk.kind === "change" && hunk.oldCount > hunk.newCount) {
      spacers.push({
        line: hunk.newStart + hunk.newCount,
        count: hunk.oldCount - hunk.newCount,
        kind: "delete",
      });
    }
  }
  return spacers;
}

/**
 * Git 对比视图：左右并排的只读源码编辑器，复用源码模式的语言高亮与行标记。
 * Markdown 与代码格式共用；折叠粒度只调整折叠，不重建编辑器。见 doc/design.md §21.15。
 */
export function SourceDiffPane({
  oldText,
  newText,
  diff,
  language,
  granularity = "full",
  oldLabel,
  newLabel,
  reveal = null,
}: {
  oldText: string;
  newText: string;
  diff: LineDiff | null;
  language: SourceLanguage;
  /** 对比视图粒度：全文显示 / 折叠未改动。 */
  granularity?: "full" | "collapse";
  oldLabel: string;
  newLabel: string;
  /** 逐处跳转：把右侧编辑器光标移动到指定行。 */
  reveal?: { line: number; token: number } | null;
}) {
  const oldHostRef = useRef<HTMLDivElement>(null);
  const newHostRef = useRef<HTMLDivElement>(null);
  const oldEditorRef = useRef<SourceEditor | null>(null);
  const newEditorRef = useRef<SourceEditor | null>(null);

  useEffect(() => {
    const editors: SourceEditor[] = [];
    const create = (host: HTMLDivElement | null, text: string) => {
      if (!host) return null;
      const editor = new SourceEditor({
        parent: host,
        doc: text,
        readOnly: true,
        language,
        tabSize: 2,
        showLineNumbers: true,
        // 对比视图关闭自动换行：行高统一，占位行才能精确保持左右对齐。
        lineWrapping: false,
        onChange: () => undefined,
        onSelection: () => undefined,
      });
      editors.push(editor);
      return editor;
    };

    const oldEditor = create(oldHostRef.current, oldText);
    const newEditor = create(newHostRef.current, newText);
    oldEditorRef.current = oldEditor;
    newEditorRef.current = newEditor;
    const hunks = diff?.hunks ?? [];
    if (diff) {
      oldEditor?.setDiffMarkers(oldLineMarkers(diff));
      newEditor?.setDiffMarkers(newLineMarkers(diff));
      // 行内字符级高亮：变化行保持浅色行底色，具体变化的字符加深。
      oldEditor?.setDiffInlineMarks(oldInlineMarks(diff));
      newEditor?.setDiffInlineMarks(newInlineMarks(diff));
    }
    // 行少的一侧插入占位行，使左右同一处改动从同一水平行开始。
    oldEditor?.setDiffSpacers(diffSpacers(hunks, "old"));
    newEditor?.setDiffSpacers(diffSpacers(hunks, "new"));

    return () => {
      for (const editor of editors) editor.destroy();
      oldEditorRef.current = null;
      newEditorRef.current = null;
    };
  }, [diff, language, newText, oldText]);

  // 折叠未改动区域：左右两栏按各自行号独立折叠；只调整折叠，不重建编辑器。
  useEffect(() => {
    const applyGranularity = (editor: SourceEditor | null, side: "old" | "new") => {
      if (!editor) return;
      editor.setLineFolds(
        granularity === "collapse" && diff ? unchangedRanges(diff.hunks, side) : [],
      );
    };
    applyGranularity(oldEditorRef.current, "old");
    applyGranularity(newEditorRef.current, "new");
  }, [diff, granularity]);

  // 左右联动滚动：占位块保证两侧内容逐行等高，直接逐像素同步（含横向）。
  useEffect(() => {
    const oldScroller = oldEditorRef.current?.scroller;
    const newScroller = newEditorRef.current?.scroller;
    if (!oldScroller || !newScroller) return;
    const apply = (from: HTMLElement, to: HTMLElement): void => {
      const top = Math.max(
        0,
        Math.min(from.scrollTop, Math.max(0, to.scrollHeight - to.clientHeight)),
      );
      if (Math.abs(to.scrollTop - top) >= 1) to.scrollTop = top;
      const left = Math.max(0, Math.min(from.scrollLeft, to.scrollWidth - to.clientWidth));
      if (Math.abs(to.scrollLeft - left) >= 1) to.scrollLeft = left;
    };
    const onOld = (): void => apply(oldScroller, newScroller);
    const onNew = (): void => apply(newScroller, oldScroller);
    oldScroller.addEventListener("scroll", onOld, { passive: true });
    newScroller.addEventListener("scroll", onNew, { passive: true });
    return () => {
      oldScroller.removeEventListener("scroll", onOld);
      newScroller.removeEventListener("scroll", onNew);
    };
  }, [diff, language, newText, oldText]);

  useEffect(() => {
    if (!reveal) return;
    // 目标行可能落在折叠区内，先展开再定位。
    newEditorRef.current?.unfoldAtLine(reveal.line);
    newEditorRef.current?.setCursor({ line: reveal.line, column: 1 });
  }, [reveal]);

  return (
    <div className="git-source-diff">
      <section className="git-source-side git-source-old" aria-label={t("源文件")}>
        <div className="git-source-label">{t("源文件 · {0}", oldLabel)}</div>
        <div className="git-source-editor" ref={oldHostRef} />
      </section>
      <section className="git-source-side git-source-new" aria-label={t("改动后")}>
        <div className="git-source-label">{t("改动后 · {0}", newLabel)}</div>
        <div className="git-source-editor" ref={newHostRef} />
      </section>
    </div>
  );
}
