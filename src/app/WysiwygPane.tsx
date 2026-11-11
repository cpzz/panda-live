import { useEffect, useRef } from "react";
import type { EditorState } from "prosemirror-state";
import { PandaEditor } from "../editor/editor";
import type { PMJson } from "../editor/schema";
import { parseMarkdown } from "../formats/markdown/parse";
import { serializeMarkdown, type BlockLineRange } from "../formats/markdown/serialize";
import { buildWysiwygDiff } from "../diff/wysiwyg";
import { computeLineDiff, normalizeDiffText } from "../diff/compute";
import type { PreviewDiffModel } from "../diff/preview";
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
  diff,
  diffJump,
  onChange,
}: {
  document: DocumentState;
  mode: EditorMode;
  searchSignal: number;
  jump: { index: number; token: number } | null;
  diff: PreviewDiffModel | null;
  diffJump: { line: number; token: number } | null;
  onChange(content: string): void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<PandaEditor | null>(null);
  const savedRef = useRef(new Map<string, SavedWysiwygState>());
  const blockRangesRef = useRef<BlockLineRange[] | null>(null);
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

  // 页内目录：点击 `#anchor` 链接时滚动到对应的原始 HTML 锚点。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onClick = (event: MouseEvent): void => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest("a[href]");
      if (!(link instanceof HTMLAnchorElement)) return;
      const href = link.getAttribute("href") ?? "";
      if (!href.startsWith("#")) return;
      event.preventDefault();
      const raw = href.slice(1);
      let id = raw;
      try {
        id = decodeURIComponent(raw);
      } catch {
        // 非法百分号编码时按原值匹配。
      }
      if (id) editorRef.current?.scrollToAnchorId(id);
    };
    host.addEventListener("click", onClick);
    return () => host.removeEventListener("click", onClick);
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
        documentId: document.id,
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

  // 切换文档时旧的行范围不再有效，避免导航跳到错误的块。
  useEffect(() => {
    blockRangesRef.current = null;
  }, [document.id]);

  // 把行 diff 映射到 ProseMirror 块并应用装饰。见 doc/design.md §21.5、§21.8。
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (!diff) {
      blockRangesRef.current = null;
      editor.setDiffModel(null);
      return;
    }
    if (mode !== "wysiwyg") return;

    let cancelled = false;
    const doc = editor.state.doc;
    const docJson = doc.toJSON() as PMJson;
    const serialized = serializeMarkdown(docJson);
    // 源文件格式与序列化结果不同（或编辑器已领先）时，就地重算一份与当前 doc 对齐的 diff。
    const sourceDiff =
      normalizeDiffText(serialized) === normalizeDiffText(diff.newText)
        ? diff.diff
        : computeLineDiff(diff.oldText, serialized);

    void buildWysiwygDiff({
      docJson,
      newText: serialized,
      oldText: diff.oldText,
      diff: sourceDiff,
      isCancelled: () => cancelled,
    })
      .then((model) => {
        if (cancelled || editorRef.current !== editor) return;
        // 构建期间文档被编辑时放弃本次结果，等下一轮 diff。
        if (editor.state.doc !== doc) return;
        blockRangesRef.current = model?.ranges ?? null;
        editor.setDiffModel(model);
      })
      .catch(() => {
        if (!cancelled && editorRef.current === editor) editor.setDiffModel(null);
      });

    return () => {
      cancelled = true;
    };
    // 输入时装饰由 ProseMirror 按位置映射，无需每个按键重建；等下一轮 diff 到达再刷新。
  }, [diff, mode]);

  // 大纲跳转：滚动到对应标题。见 doc/design.md §15.1。
  useEffect(() => {
    if (!jump) return;
    editorRef.current?.scrollToHeading(jump.index);
  }, [jump]);

  // 改动导航：把源码行号映射到顶层块。
  useEffect(() => {
    if (!diffJump) return;
    const ranges = blockRangesRef.current;
    if (!ranges || ranges.length === 0) return;
    const exact = ranges.findIndex(
      (range) => diffJump.line >= range.start && diffJump.line <= range.end,
    );
    const next = exact >= 0 ? exact : ranges.findIndex((range) => range.start >= diffJump.line);
    editorRef.current?.scrollToBlockIndex(next >= 0 ? next : ranges.length - 1);
  }, [diffJump]);

  return (
    <div className="wysiwyg-wrap">
      <SearchPanel
        editor={editorRef.current}
        openSignal={mode === "wysiwyg" ? searchSignal : 0}
        onClose={() => undefined}
      />
      <div className="wysiwyg-host" ref={hostRef} />
    </div>
  );
}
