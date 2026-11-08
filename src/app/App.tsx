import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { EditorState } from "@codemirror/state";
import { renderMarkdownToHtml } from "../formats/markdown/preview";
import {
  DocumentManager,
  type DocumentState,
  type EditorMode,
} from "../services/document-manager";
import { SourceEditor, type SelectionInfo, type SourceLanguage } from "../source/codemirror";
import { renderMathml } from "../render/math/mathml";
import {
  currentDiagramTheme,
  getDiagramService,
  onDiagramThemeChange,
} from "../render/diagram";
import { WysiwygPane } from "./WysiwygPane";

const MODE_LABELS: Record<EditorMode, string> = {
  wysiwyg: "所见即所得",
  source: "源码",
  split: "分栏",
  preview: "预览",
};

const ENCODING_LABELS: Record<string, string> = {
  "utf-8": "UTF-8",
  "utf-8-bom": "UTF-8 (BOM)",
  "utf-16le": "UTF-16 LE",
  "utf-16be": "UTF-16 BE",
  unknown: "未知编码",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface SavedEditorState {
  state: EditorState;
  revision: number;
  language: SourceLanguage;
}

function SourcePane({
  document,
  mode,
  onChange,
  onSelection,
}: {
  document: DocumentState;
  mode: EditorMode;
  onChange(content: string): void;
  onSelection(info: SelectionInfo): void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<SourceEditor | null>(null);
  const savedRef = useRef(new Map<string, SavedEditorState>());
  const lastRef = useRef<{
    id: string;
    revision: number;
    mode: EditorMode;
    language: SourceLanguage;
  } | null>(null);
  const callbacksRef = useRef({ onChange, onSelection });
  callbacksRef.current = { onChange, onSelection };

  const language: SourceLanguage = document.format === "mathml" ? "xml" : "markdown";

  useEffect(() => {
    return () => {
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let editor = editorRef.current;
    if (!editor) {
      editor = new SourceEditor({
        parent: host,
        doc: document.content,
        readOnly: document.readOnly,
        language,
        onChange: (content) => callbacksRef.current.onChange(content),
        onSelection: (info) => callbacksRef.current.onSelection(info),
      });
      editorRef.current = editor;
    } else {
      const previous = lastRef.current;
      if (previous && previous.id !== document.id) {
        savedRef.current.set(previous.id, {
          state: editor.state,
          revision: previous.revision,
          language: previous.language,
        });
        const saved = savedRef.current.get(document.id);
        if (saved && saved.revision === document.revision && saved.language === language) {
          editor.setState(saved.state);
        } else {
          editor.reset(document.content, document.readOnly, language);
        }
        savedRef.current.delete(document.id);
      } else if (
        previous &&
        (previous.revision !== document.revision ||
          previous.language !== language ||
          (previous.mode !== mode && mode !== "preview" && mode !== "wysiwyg"))
      ) {
        editor.reset(document.content, document.readOnly, language);
      }
    }
    lastRef.current = { id: document.id, revision: document.revision, mode, language };
    // 只响应标签切换、模式切换、外部重载与只读变化；普通输入由编辑器自身维护。
  }, [document.id, document.revision, document.readOnly, mode, language]);

  return <div className="editor-host" ref={hostRef} />;
}

function MathmlPreviewPane({ document, enabled }: { document: DocumentState; enabled: boolean }) {
  const [html, setHtml] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => {
      const rendered = renderMathml(document.content);
      if (rendered.ok) {
        setHtml(rendered.html);
        setError(null);
      } else {
        setHtml("");
        setError(rendered.error);
      }
    }, 150);
    return () => {
      clearTimeout(timer);
    };
  }, [document.content, enabled]);

  return (
    <div className="preview-pane">
      {error ? (
        <p className="placeholder">MathML 诊断：{error}</p>
      ) : (
        <div className="mathml-preview" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}

function DiagramPreviewPane({ document, enabled }: { document: DocumentState; enabled: boolean }) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState(currentDiagramTheme);
  const kind = document.format === "mermaid" ? "mermaid" : "plantuml";
  const requestId = `preview:${document.id}`;

  useEffect(() => onDiagramThemeChange(setTheme), []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void getDiagramService()
        .render({ id: requestId, kind, source: document.content, theme })
        .then((result) => {
          if (cancelled) return;
          if (result.ok) {
            setSvg(result.svg);
            setError(null);
          } else {
            setSvg("");
            setError(result.error);
          }
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      getDiagramService().cancel(requestId);
    };
  }, [document.content, requestId, kind, theme, enabled]);

  return (
    <div className="preview-pane">
      {error ? (
        <p className="placeholder">图表诊断：{error}</p>
      ) : (
        <div className="diagram-svg-preview" dangerouslySetInnerHTML={{ __html: svg }} />
      )}
    </div>
  );
}

function PreviewPane({ document, enabled }: { document: DocumentState; enabled: boolean }) {
  const [html, setHtml] = useState("");
  const [error, setError] = useState<string | null>(null);
  const supported = document.format === "markdown";

  useEffect(() => {
    if (!supported || !enabled) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      renderMarkdownToHtml(document.content)
        .then((result) => {
          if (cancelled) return;
          setHtml(result);
          setError(null);
        })
        .catch((reason: unknown) => {
          if (cancelled) return;
          setError(reason instanceof Error ? reason.message : String(reason));
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [document.content, supported, enabled]);

  if (document.format === "mathml") {
    return <MathmlPreviewPane document={document} enabled={enabled} />;
  }
  if (document.format === "plantuml" || document.format === "mermaid") {
    return <DiagramPreviewPane document={document} enabled={enabled} />;
  }
  if (!supported) {
    return (
      <div className="preview-pane">
        <p className="placeholder">该格式暂不支持渲染预览</p>
      </div>
    );
  }

  return (
    <div className="preview-pane">
      {error ? (
        <p className="placeholder">预览渲染失败：{error}</p>
      ) : (
        <article className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}

export function App() {
  const managerRef = useRef<DocumentManager | null>(null);
  if (!managerRef.current) managerRef.current = new DocumentManager();
  const manager = managerRef.current;
  const state = useSyncExternalStore(manager.subscribe, manager.getState);
  const [cursor, setCursor] = useState<SelectionInfo>({ line: 1, column: 1 });

  const active = state.documents.find((doc) => doc.id === state.activeId) ?? null;
  const conflict = state.conflict;

  useEffect(() => {
    return window.panda.onMenuCommand((command) => {
      void manager.runMenuCommand(command);
    });
  }, [manager]);

  useEffect(() => {
    setCursor({ line: 1, column: 1 });
  }, [state.activeId]);

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">Panda Live</span>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="button" onClick={() => void manager.openFiles()}>
            打开
          </button>
          <button
            type="button"
            className="button"
            disabled={!active}
            onClick={() => active && void manager.saveDocument(active.id)}
          >
            保存
          </button>
          <button
            type="button"
            className="button"
            disabled={!active}
            onClick={() => active && void manager.saveDocumentAs(active.id)}
          >
            另存为
          </button>
        </div>
        <div className="mode-switch" role="group" aria-label="视图模式">
          {(Object.keys(MODE_LABELS) as EditorMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={state.mode === mode ? "mode-button active" : "mode-button"}
              aria-pressed={state.mode === mode}
              onClick={() => manager.setMode(mode)}
              disabled={!active || (mode === "wysiwyg" && active.format !== "markdown")}
            >
              {MODE_LABELS[mode]}
            </button>
          ))}
        </div>
      </header>

      <div className="tabstrip" role="tablist" aria-label="打开的文档">
        {state.documents.map((doc) => (
          <button
            key={doc.id}
            type="button"
            role="tab"
            aria-selected={doc.id === state.activeId}
            className={doc.id === state.activeId ? "tab active" : "tab"}
            onClick={() => manager.setActive(doc.id)}
            title={doc.path ?? doc.name}
          >
            {doc.dirty && <span className="tab-dot" aria-label="未保存" />}
            <span className="tab-name">{doc.name}</span>
          </button>
        ))}
        {state.documents.length === 0 && <span className="tabstrip-empty">未打开文档</span>}
      </div>

      {conflict && (
        <div className="banner banner-warning" role="alert">
          <span className="banner-text">文件已被外部修改。请选择处理方式。</span>
          <button type="button" className="button small" onClick={() => void manager.reloadFromDisk(conflict.documentId)}>
            重新加载
          </button>
          <button type="button" className="button small" onClick={() => void manager.overwriteFromDisk(conflict.documentId)}>
            覆盖保存
          </button>
          <button
            type="button"
            className="button small"
            onClick={() => {
              manager.dismissConflict();
              void manager.saveDocumentAs(conflict.documentId);
            }}
          >
            另存为
          </button>
          <button type="button" className="button small ghost" onClick={() => manager.dismissConflict()}>
            忽略
          </button>
        </div>
      )}

      {state.notice && (
        <div className={`banner banner-${state.notice.kind}`} role={state.notice.kind === "error" ? "alert" : "status"}>
          <span className="banner-text">{state.notice.message}</span>
          <button type="button" className="button small ghost" onClick={() => manager.dismissNotice()}>
            关闭
          </button>
        </div>
      )}

      {active ? (
        <main className={`workspace mode-${state.mode}`}>
          <section
            className="pane wysiwyg-pane"
            hidden={state.mode !== "wysiwyg"}
            aria-label="所见即所得编辑"
          >
            <WysiwygPane
              document={active}
              mode={state.mode}
              onChange={(content) => manager.updateContent(active.id, content)}
            />
          </section>
          <section
            className="pane source-pane"
            hidden={state.mode === "preview" || state.mode === "wysiwyg"}
            aria-label="源码编辑"
          >
            <SourcePane
              document={active}
              mode={state.mode}
              onChange={(content) => manager.updateContent(active.id, content)}
              onSelection={setCursor}
            />
          </section>
          <section
            className="pane"
            hidden={state.mode === "source" || state.mode === "wysiwyg"}
            aria-label="渲染预览"
          >
            <PreviewPane document={active} enabled={state.mode !== "source"} />
          </section>
        </main>
      ) : (
        <main className="empty-state">
          <span className="brand-mark large" aria-hidden="true" />
          <h1>打开一个文档开始编辑</h1>
          <p>源码与渲染结果实时同步，保存时保留原文件编码与换行符。</p>
          <button type="button" className="button primary" onClick={() => void manager.openFiles()}>
            打开文件
          </button>
        </main>
      )}

      <footer className="statusbar">
        <span className="statusbar-name">{active?.path ?? "就绪"}</span>
        {active && (
          <span className="statusbar-meta">
            {ENCODING_LABELS[active.encoding] ?? active.encoding}
            {" · "}
            {active.eol.toUpperCase()}
            {active.bom ? " · BOM" : ""}
            {active.readOnly ? " · 只读" : ""}
            {" · "}
            {active.format}
          </span>
        )}
        <span className="statusbar-spacer" />
        {active && (
          <span className="statusbar-meta">
            {formatSize(active.size)}
            {" · "}
            {state.mode === "wysiwyg" ? "所见即所得" : `行 ${cursor.line}，列 ${cursor.column}`}
          </span>
        )}
      </footer>
    </div>
  );
}
