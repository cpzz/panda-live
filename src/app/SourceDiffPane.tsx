import { useEffect, useRef } from "react";
import type { LineDiff } from "../diff/compute";
import { newLineMarkers, oldLineMarkers } from "../diff/markers";
import { t } from "../i18n";
import { SourceEditor, type SourceLanguage } from "../source/codemirror";

export type SourceDiffMode = "diff" | "before" | "after";

/**
 * 非 Markdown 文件的 Git 差异视图：左右并排的只读源码编辑器，
 * 复用源码模式的语言高亮与行标记。见 doc/design.md §21.15。
 */
export function SourceDiffPane({
  oldText,
  newText,
  diff,
  language,
  mode,
  oldLabel,
  newLabel,
  reveal = null,
}: {
  oldText: string;
  newText: string;
  diff: LineDiff | null;
  language: SourceLanguage;
  mode: SourceDiffMode;
  oldLabel: string;
  newLabel: string;
  /** 逐处跳转：把右侧编辑器光标移动到指定行。 */
  reveal?: { line: number; token: number } | null;
}) {
  const oldHostRef = useRef<HTMLDivElement>(null);
  const newHostRef = useRef<HTMLDivElement>(null);
  const newEditorRef = useRef<SourceEditor | null>(null);

  useEffect(() => {
    if (!reveal) return;
    newEditorRef.current?.setCursor({ line: reveal.line, column: 1 });
  }, [reveal]);

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

    const oldEditor = mode === "after" ? null : create(oldHostRef.current, oldText);
    const newEditor = mode === "before" ? null : create(newHostRef.current, newText);
    newEditorRef.current = newEditor;
    if (diff) {
      oldEditor?.setDiffMarkers(oldLineMarkers(diff));
      newEditor?.setDiffMarkers(newLineMarkers(diff));
    }

    return () => {
      for (const editor of editors) editor.destroy();
      newEditorRef.current = null;
    };
  }, [diff, language, mode, newText, oldText]);

  return (
    <div className={mode === "diff" ? "git-source-diff" : "git-source-diff single"}>
      {mode !== "after" && (
        <section className="git-source-side git-source-old" aria-label={t("源文件")}>
          <div className="git-source-label">{t("源文件 · {0}", oldLabel)}</div>
          <div className="git-source-editor" ref={oldHostRef} />
        </section>
      )}
      {mode !== "before" && (
        <section className="git-source-side git-source-new" aria-label={t("改动后")}>
          <div className="git-source-label">{t("改动后 · {0}", newLabel)}</div>
          <div className="git-source-editor" ref={newHostRef} />
        </section>
      )}
    </div>
  );
}
