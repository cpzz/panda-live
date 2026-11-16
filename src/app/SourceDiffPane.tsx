import { useEffect, useRef } from "react";
import type { DiffHunk, LineDiff } from "../diff/compute";
import { newLineMarkers, oldLineMarkers } from "../diff/markers";
import { t } from "../i18n";
import { SourceEditor, type SourceLanguage } from "../source/codemirror";

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
    if (diff) {
      oldEditor?.setDiffMarkers(oldLineMarkers(diff));
      newEditor?.setDiffMarkers(newLineMarkers(diff));
    }

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
