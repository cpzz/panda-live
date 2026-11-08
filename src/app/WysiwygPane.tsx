import { useEffect, useRef } from "react";
import type { EditorState } from "prosemirror-state";
import { PandaEditor } from "../editor/editor";
import { parseMarkdown } from "../formats/markdown/parse";
import { serializeMarkdown } from "../formats/markdown/serialize";
import type { DocumentState, EditorMode } from "../services/document-manager";
import { SearchPanel } from "./SearchPanel";

interface SavedWysiwygState {
  state: EditorState;
  revision: number;
}

/**
 * WYSIWYG 编辑面板。模式切换时从当前 Markdown 重建状态并清空撤销历史（§8.5）；
 * 同一模式下的标签切换保留各文档的编辑器状态。
 */
export function WysiwygPane({
  document,
  mode,
  searchSignal,
  jump,
  onChange,
}: {
  document: DocumentState;
  mode: EditorMode;
  searchSignal: number;
  jump: { index: number; token: number } | null;
  onChange(content: string): void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<PandaEditor | null>(null);
  const savedRef = useRef(new Map<string, SavedWysiwygState>());
  const lastRef = useRef<{ id: string; revision: number; mode: EditorMode; readOnly: boolean } | null>(
    null,
  );
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    return () => {
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (document.format !== "markdown") return;

    let editor = editorRef.current;
    if (!editor) {
      if (mode !== "wysiwyg") return;
      editor = new PandaEditor({
        parent: host,
        docJson: parseMarkdown(document.content).doc,
        readOnly: document.readOnly,
        onChange: (docJson) => onChangeRef.current(serializeMarkdown(docJson)),
      });
      editorRef.current = editor;
      lastRef.current = {
        id: document.id,
        revision: document.revision,
        mode,
        readOnly: document.readOnly,
      };
      return;
    }

    const previous = lastRef.current;
    if (previous && previous.id !== document.id) {
      savedRef.current.set(previous.id, { state: editor.state, revision: previous.revision });
      const saved = savedRef.current.get(document.id);
      if (saved && saved.revision === document.revision && mode === "wysiwyg") {
        editor.setState(saved.state);
      } else {
        editor.reset(parseMarkdown(document.content).doc, document.readOnly);
      }
      savedRef.current.delete(document.id);
    } else if (
      previous &&
      (previous.revision !== document.revision ||
        previous.readOnly !== document.readOnly ||
        (previous.mode !== mode && mode === "wysiwyg"))
    ) {
      editor.reset(parseMarkdown(document.content).doc, document.readOnly);
    }

    lastRef.current = {
      id: document.id,
      revision: document.revision,
      mode,
      readOnly: document.readOnly,
    };
  }, [document.id, document.revision, document.readOnly, document.content, document.format, mode]);

  // 大纲跳转：滚动到对应标题。见 doc/design.md §15.1。
  useEffect(() => {
    if (!jump) return;
    editorRef.current?.scrollToHeading(jump.index);
  }, [jump]);

  return (
    <div className="wysiwyg-wrap">
      <SearchPanel
        editor={editorRef.current}
        openSignal={searchSignal}
        onClose={() => undefined}
      />
      <div className="wysiwyg-host" ref={hostRef} />
    </div>
  );
}
