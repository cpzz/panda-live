import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { EditorState } from "@codemirror/state";
import { renderMarkdownToHtml } from "../formats/markdown/preview";
import { getFormatEntry, refreshExtensionFormats } from "../extensions/registry";
import { sanitizeHtml } from "../render/html";
import { resolveRelativePath } from "../utils/paths";
import {
  DocumentManager,
  type DocumentState,
  type EditorMode,
} from "../services/document-manager";
import { settingsStore } from "../services/settings-store";
import { WorkspaceStore } from "../services/workspace-store";
import { SourceEditor, type SelectionInfo, type SourceLanguage } from "../source/codemirror";
import { renderMathml } from "../render/math/mathml";
import {
  currentDiagramTheme,
  getDiagramService,
  onDiagramThemeChange,
} from "../render/diagram";
import type { DraftEntry, RecentEntry, SessionState } from "../shared/ipc";
import type { CompileResult, EngineStatus } from "../shared/ipc";
import type { Settings } from "../shared/settings";
import { describeError, getErrorCode } from "../shared/errors";
import { RecoveryDialog } from "./RecoveryDialog";
import { SettingsDialog } from "./SettingsDialog";
import { WorkspacePanel } from "./WorkspacePanel";
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

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

interface SavedEditorState {
  state: EditorState;
  revision: number;
  language: SourceLanguage;
}

function SourcePane({
  document,
  mode,
  searchSignal,
  onChange,
  onSelection,
}: {
  document: DocumentState;
  mode: EditorMode;
  searchSignal: number;
  onChange(content: string): void;
  onSelection(info: SelectionInfo): void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<SourceEditor | null>(null);
  const savedRef = useRef(new Map<string, SavedEditorState>());
  const cursorRef = useRef(document.cursor);
  cursorRef.current = document.cursor;
  const lastRef = useRef<{
    id: string;
    revision: number;
    mode: EditorMode;
    language: SourceLanguage;
  } | null>(null);
  const callbacksRef = useRef({ onChange, onSelection });
  callbacksRef.current = { onChange, onSelection };
  const [gotoOpen, setGotoOpen] = useState(false);
  const [gotoValue, setGotoValue] = useState("");

  const language: SourceLanguage = (() => {
    const syntax = getFormatEntry(document.format)?.syntax ?? "plain";
    return syntax === "xml" ? "xml" : syntax === "markdown" ? "markdown" : "plain";
  })();

  useEffect(() => {
    return () => {
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (searchSignal > 0 && mode !== "wysiwyg" && mode !== "preview") {
      editorRef.current?.openSearch();
    }
  }, [searchSignal, mode]);

  // Ctrl/Cmd+G 跳转行；不依赖 window.prompt（Electron 不支持）。见 §11.5。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g") {
        event.preventDefault();
        setGotoValue("");
        setGotoOpen(true);
      }
    };
    host.addEventListener("keydown", onKeyDown, true);
    return () => {
      host.removeEventListener("keydown", onKeyDown, true);
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
      if (cursorRef.current) editor.setCursor(cursorRef.current);
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
          if (cursorRef.current) editor.setCursor(cursorRef.current);
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
  }, [document.id, document.revision, document.readOnly, mode, language, document.content]);

  return (
    <div className="source-wrap">
      {gotoOpen && (
        <form
          className="goto-line"
          onSubmit={(event) => {
            event.preventDefault();
            const [lineText, columnText] = gotoValue.split(":");
            const line = Number(lineText);
            const column = Number(columnText);
            if (Number.isFinite(line) && line > 0) {
              editorRef.current?.setCursor({
                line,
                column: Number.isFinite(column) && column > 0 ? column : 1,
              });
            }
            setGotoOpen(false);
          }}
        >
          <input
            autoFocus
            className="goto-input"
            placeholder="行:列"
            aria-label="跳转到行"
            value={gotoValue}
            onChange={(event) => setGotoValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setGotoOpen(false);
              }
            }}
          />
          <button type="submit" className="button small">
            跳转
          </button>
          <button type="button" className="button small ghost" onClick={() => setGotoOpen(false)}>
            取消
          </button>
        </form>
      )}
      <div className="editor-host" ref={hostRef} />
    </div>
  );
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

function ExtensionPreviewPane({
  document,
  enabled,
}: {
  document: DocumentState;
  enabled: boolean;
}) {
  const entry = getFormatEntry(document.format);
  const [html, setHtml] = useState("");
  const [error, setError] = useState<string | null>(null);
  const extensionId = entry?.extensionId ?? null;
  const providerId = entry?.id ?? "";

  useEffect(() => {
    if (!enabled || !extensionId) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const parsed = await window.panda.ext.parse({
            extensionId,
            providerId,
            source: document.content,
            path: document.path,
          });
          const preview = await window.panda.ext.preview({
            extensionId,
            providerId,
            doc: parsed.doc,
            path: document.path,
          });
          if (cancelled) return;
          setHtml(sanitizeHtml(preview.html));
          const diagnostic = preview.diagnostics.find((item) => item.severity === "error");
          setError(diagnostic?.message ?? null);
        } catch (reason) {
          if (cancelled) return;
          setHtml("");
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })();
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [document.content, document.path, extensionId, providerId, enabled]);

  if (!entry?.extensionId) {
    return (
      <div className="preview-pane">
        <p className="placeholder">该格式的扩展已被禁用，按纯文本打开</p>
      </div>
    );
  }

  return (
    <div className="preview-pane">
      {error ? (
        <p className="placeholder">扩展预览诊断：{error}</p>
      ) : (
        <article className="markdown-body extension-preview" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}

function TexPreviewPane({
  document,
  enabled,
  compileSignal,
}: {
  document: DocumentState;
  enabled: boolean;
  compileSignal: number;
}) {
  const [engines, setEngines] = useState<EngineStatus | null>(null);
  const [result, setResult] = useState<CompileResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detect = async (): Promise<void> => {
    try {
      setEngines(await window.panda.latex.detect());
    } catch {
      setEngines({ available: false, engines: [] });
    }
  };

  const compile = async (): Promise<void> => {
    if (!document.path) {
      setError("请先保存 .tex 文件后再编译");
      return;
    }
    setBusy(true);
    try {
      const compiled = await window.panda.latex.compile({
        jobId: `tex:${document.id}:${Date.now()}`,
        rootPath: document.path,
      });
      setResult(compiled);
      setError(null);
    } catch (reason) {
      setResult(null);
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (enabled) void detect();
  }, [enabled]);

  // 保存后 1.5 s 防抖编译；dirty 时提示并等待下次保存。见 §9.5。
  useEffect(() => {
    if (!enabled || !document.path || document.dirty || !engines?.available) return;
    const timer = setTimeout(() => {
      void compile();
    }, 1500);
    return () => {
      clearTimeout(timer);
    };
  }, [document.path, document.savedContent, document.dirty, enabled, engines?.available]);

  useEffect(() => {
    if (compileSignal > 0) void compile();
  }, [compileSignal]);

  if (engines && !engines.available) {
    return (
      <div className="preview-pane">
        <div className="tex-placeholder">
          <p>未检测到 TeX 引擎（Tectonic / latexmk / xelatex）。</p>
          <p className="placeholder">安装任一引擎后点击“重新检测”；其他功能不受影响。</p>
          <button type="button" className="button small" onClick={() => void detect()}>
            重新检测
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="preview-pane tex-preview">
      {error && <p className="placeholder">{error}</p>}
      {document.dirty && <p className="placeholder">当前有未保存修改，编译仅使用磁盘内容。</p>}
      {busy && <p className="placeholder">编译中…</p>}
      {result && result.ok && result.pdfKey ? (
        <iframe
          className="pdf-viewer"
          title="LaTeX 预览"
          src={`panda-pdf://${result.pdfKey}`}
        />
      ) : null}
      {result && !result.ok && result.diagnostics.length > 0 && (
        <ul className="tex-diagnostics">
          {result.diagnostics.map((diagnostic, index) => (
            <li key={`${index}-${diagnostic.message}`} className={`tex-diagnostic ${diagnostic.severity}`}>
              {diagnostic.line !== undefined ? `第 ${diagnostic.line} 行：` : ""}
              {diagnostic.message}
            </li>
          ))}
        </ul>
      )}
      {!result && engines?.available && !busy && (
        <p className="placeholder">保存后自动编译，或点击下方按钮手动编译。</p>
      )}
      <div className="tex-actions">
        <button type="button" className="button small" disabled={busy} onClick={() => void compile()}>
          {busy ? "编译中…" : "编译"}
        </button>
        <span className="settings-note">
          {engines?.engines.length ? `引擎：${engines.engines[0]?.id}` : "正在检测引擎…"}
        </span>
      </div>
    </div>
  );
}

function MarkdownPreview({ html, doc }: { html: string; doc: DocumentState }) {
  const hostRef = useRef<HTMLElement>(null);

  // 超过 1 MB 的图片改为占位 + 手动加载。见 doc/design.md §14.3。
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !doc.path) return;
    let cancelled = false;
    for (const image of [...host.querySelectorAll("img")]) {
      const src = image.getAttribute("src") ?? "";
      const resolved = resolveRelativePath(doc.path, src);
      if (!resolved) continue;
      void window.panda.fs
        .stat({ path: resolved })
        .then((stats) => {
          if (cancelled || stats.size <= 1024 * 1024) return;
          const wrapper = globalThis.document.createElement("div");
          wrapper.className = "big-image-placeholder";
          const label = globalThis.document.createElement("span");
          label.textContent = `图片较大（${(stats.size / (1024 * 1024)).toFixed(1)} MB），未自动加载`;
          const button = globalThis.document.createElement("button");
          button.type = "button";
          button.className = "button small";
          button.textContent = "加载图片";
          button.addEventListener("click", () => {
            void window.panda.fs.readBase64({ path: resolved }).then((file) => {
              const loaded = globalThis.document.createElement("img");
              loaded.src = `data:${file.mime};base64,${file.data}`;
              wrapper.replaceWith(loaded);
            });
          });
          wrapper.append(label, button);
          image.replaceWith(wrapper);
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [html, doc.path]);

  return (
    <article className="markdown-body" ref={hostRef} dangerouslySetInnerHTML={{ __html: html }} />
  );
}

function PreviewPane({
  document,
  enabled,
  compileSignal,
}: {
  document: DocumentState;
  enabled: boolean;
  compileSignal: number;
}) {
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

  const entry = getFormatEntry(document.format);
  if (entry?.extensionId) {
    return <ExtensionPreviewPane document={document} enabled={enabled} />;
  }
  if (document.format === "latex") {
    return <TexPreviewPane document={document} enabled={enabled} compileSignal={compileSignal} />;
  }
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
        <MarkdownPreview html={html} doc={document} />
      )}
    </div>
  );
}

export function App() {
  const managerRef = useRef<DocumentManager | null>(null);
  if (!managerRef.current) managerRef.current = new DocumentManager();
  const manager = managerRef.current;
  const workspaceRef = useRef<WorkspaceStore | null>(null);
  if (!workspaceRef.current) workspaceRef.current = new WorkspaceStore();
  const workspaces = workspaceRef.current;

  const state = useSyncExternalStore(manager.subscribe, manager.getState);
  const settings = useSyncExternalStore(settingsStore.subscribe, settingsStore.getState);
  const workspace = useSyncExternalStore(workspaces.subscribe, workspaces.getState);

  const [cursor, setCursor] = useState<SelectionInfo>({ line: 1, column: 1 });
  const [searchSignal, setSearchSignal] = useState(0);
  const [compileSignal, setCompileSignal] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recoveries, setRecoveries] = useState<DraftEntry[]>([]);
  const [recent, setRecent] = useState<RecentEntry[]>([]);

  const stateRef = useRef(state);
  stateRef.current = state;
  const workspaceStateRef = useRef(workspace);
  workspaceStateRef.current = workspace;
  const recentRef = useRef(recent);
  recentRef.current = recent;
  const dragTabRef = useRef<string | null>(null);

  const active = state.documents.find((doc) => doc.id === state.activeId) ?? null;
  const activeRef = useRef(active);
  activeRef.current = active;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const conflict = state.conflict;

  const saveSession = async (): Promise<void> => {
    const snapshot: SessionState = manager.buildSession({
      mode: stateRef.current.mode,
      sidebarVisible: workspaceStateRef.current.visible,
      recent: recentRef.current,
      workspace: workspaceStateRef.current.root
        ? {
            rootPath: workspaceStateRef.current.root.path,
            expanded: workspaces.collectExpanded(),
          }
        : undefined,
    });
    await manager.saveSession(snapshot);
  };

  const exportTheme = (): "light" | "dark" => {
    const theme = settingsRef.current.appearance.theme;
    if (theme === "light") return "light";
    if (theme === "dark") return "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };

  const exportHtmlActive = async (): Promise<void> => {
    const doc = activeRef.current;
    if (!doc) return;
    if (doc.format !== "markdown") {
      manager.showNotice("error", "仅 Markdown 文档支持导出 HTML");
      return;
    }
    try {
      const { buildDocumentHtml, saveHtml } = await import("../services/export-service");
      const html = await buildDocumentHtml(doc, { theme: exportTheme() });
      const savedPath = await saveHtml(doc, html);
      if (savedPath) manager.showNotice("info", `已导出 HTML：${savedPath}`);
    } catch (reason) {
      manager.showNotice("error", describeError(reason));
    }
  };

  const exportPdfActive = async (): Promise<void> => {
    const doc = activeRef.current;
    if (!doc) return;
    if (doc.format !== "markdown") {
      manager.showNotice("error", "仅 Markdown 文档支持导出 PDF");
      return;
    }
    try {
      const { buildDocumentHtml } = await import("../services/export-service");
      const html = await buildDocumentHtml(doc, { theme: exportTheme() });
      const result = await window.panda.export.pdf({
        html,
        suggestedName: `${doc.name.replace(/\.[^.]+$/, "")}.pdf`,
      });
      manager.showNotice("info", `已导出 PDF：${result.path}`);
    } catch (reason) {
      if (getErrorCode(reason) === "E_CANCELLED") return;
      manager.showNotice("error", describeError(reason));
    }
  };

  const exportSvgActive = async (): Promise<void> => {
    const doc = activeRef.current;
    if (!doc) return;
    if (doc.format !== "plantuml" && doc.format !== "mermaid") {
      manager.showNotice("error", "仅 PlantUML / Mermaid 文档支持导出 SVG");
      return;
    }
    try {
      const { exportDiagramSvg } = await import("../services/export-service");
      const savedPath = await exportDiagramSvg(doc);
      if (savedPath) manager.showNotice("info", `已导出 SVG：${savedPath}`);
    } catch (reason) {
      if (getErrorCode(reason) === "E_CANCELLED") return;
      manager.showNotice("error", describeError(reason));
    }
  };

  const checkUpdate = async (): Promise<void> => {
    try {
      const result = await window.panda.update.check();
      switch (result.status) {
        case "not-configured":
          manager.showNotice("info", result.message ?? "未配置更新源");
          return;
        case "available":
          manager.showNotice(
            "info",
            `发现新版本 ${result.latestVersion ?? ""}（当前 ${result.currentVersion}）`,
          );
          return;
        case "latest":
          manager.showNotice("info", `当前已是最新版本（${result.currentVersion}）`);
          return;
        default:
          manager.showNotice("error", `更新检查失败：${result.message ?? ""}`);
      }
    } catch (reason) {
      manager.showNotice("error", describeError(reason));
    }
  };

  useEffect(() => {
    manager.onSessionTick = saveSession;
    manager.openWorkspaceFolder = () => workspaces.openPicker();
    return () => {
      manager.onSessionTick = null;
      manager.openWorkspaceFolder = async () => undefined;
    };
  }, [manager, workspaces]);

  useEffect(() => {
    let disposed = false;
    const bootstrap = async (): Promise<void> => {
      const loaded = await settingsStore.load();
      manager.setAutoSave(loaded.editor.autoSave);
      manager.ensureSessionTimer();
      await refreshExtensionFormats();
      const session = await window.panda.session.load();
      if (session && !disposed) {
        if (!session.sidebarVisible) workspaces.setVisible(false);
        if (session.workspace) {
          await workspaces.openPath(session.workspace.rootPath, session.workspace.expanded);
        }
        await manager.restoreSession(session);
      }
      const drafts = await window.panda.drafts.list();
      if (!disposed && drafts.length > 0) setRecoveries(drafts);
      const list = await window.panda.recent.list();
      if (!disposed) setRecent(list);
      // 文件关联/启动参数带来的文档
      const pending = await window.panda.app.pendingOpenPaths();
      for (const filePath of pending) {
        await manager.openPath(filePath);
      }
    };
    void bootstrap();

    const offFsChanged = window.panda.onFsChanged((event) => {
      manager.handleFsChanged(event);
      workspaces.handleFsChanged(event);
    });
    const onPageHide = (): void => {
      void saveSession();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      disposed = true;
      offFsChanged();
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [manager, workspaces]);

  useEffect(() => {
    return window.panda.onOpenPath((filePath) => {
      void manager.openPath(filePath);
    });
  }, [manager]);

  useEffect(() => {
    return window.panda.onMenuCommand((command) => {
      switch (command) {
        case "view.find":
          setSearchSignal((value) => value + 1);
          return;
        case "view.settings":
          setSettingsOpen(true);
          return;
        case "workspace.open":
          void workspaces.openPicker();
          return;
        case "latex.compile":
          setCompileSignal((value) => value + 1);
          return;
        case "file.exportHtml":
          void exportHtmlActive();
          return;
        case "file.exportPdf":
          void exportPdfActive();
          return;
        case "file.exportSvg":
          void exportSvgActive();
          return;
        case "update.check":
          void checkUpdate();
          return;
        default:
          void manager.runMenuCommand(command);
      }
    });
  }, [manager, workspaces]);

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
        <button
          type="button"
          className="icon-button"
          aria-pressed={workspace.visible}
          title={workspace.visible ? "折叠工作区" : "展开工作区"}
          onClick={() => workspaces.setVisible(!workspace.visible)}
        >
          侧栏
        </button>
        <div className="toolbar-actions">
          <button type="button" className="button" onClick={() => manager.newDocument()}>
            新建
          </button>
          <button type="button" className="button" onClick={() => void manager.openFiles()}>
            打开
          </button>
          <button type="button" className="button" onClick={() => void manager.saveDocument(state.activeId ?? "")} disabled={!active}>
            保存
          </button>
          <button type="button" className="button" onClick={() => active && void manager.saveDocumentAs(active.id)} disabled={!active}>
            另存为
          </button>
          <button type="button" className="button" onClick={() => setSearchSignal((value) => value + 1)} disabled={!active}>
            查找
          </button>
          <button type="button" className="button" onClick={() => setSettingsOpen(true)}>
            设置
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
            draggable
            aria-selected={doc.id === state.activeId}
            className={doc.id === state.activeId ? "tab active" : "tab"}
            onClick={() => manager.setActive(doc.id)}
            onMouseDown={(event) => {
              // 阻止中键在按钮上触发自动滚动。
              if (event.button === 1) event.preventDefault();
            }}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              void manager.closeDocument(doc.id);
            }}
            onDragStart={(event) => {
              dragTabRef.current = doc.id;
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", doc.id);
            }}
            onDragOver={(event) => {
              if (!dragTabRef.current || dragTabRef.current === doc.id) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onDrop={(event) => {
              event.preventDefault();
              const fromId = dragTabRef.current ?? event.dataTransfer.getData("text/plain");
              dragTabRef.current = null;
              if (fromId) manager.moveDocument(fromId, doc.id);
            }}
            onDragEnd={() => {
              dragTabRef.current = null;
            }}
            title={`${doc.path ?? doc.name}（拖拽排序，中键关闭）`}
          >
            {doc.dirty && <span className="tab-dot" aria-label="未保存" />}
            <span className="tab-name">{doc.name}</span>
          </button>
        ))}
        {state.documents.length === 0 && <span className="tabstrip-empty">未打开文档</span>}
      </div>

      {conflict && (
        <div className="banner banner-warning" role="alert">
          <span className="banner-text">
            {conflict.message}
            {conflict.diskMtimeMs !== undefined && conflict.localMtimeMs !== undefined
              ? `（本地修改于 ${formatTime(conflict.localMtimeMs)}）`
              : ""}
          </span>
          <button
            type="button"
            className="button small"
            onClick={() => void manager.reloadFromDisk(conflict.documentId)}
          >
            重新加载
          </button>
          <button
            type="button"
            className="button small"
            onClick={() => void manager.overwriteFromDisk(conflict.documentId)}
          >
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

      <div className="main-row">
        {workspace.visible && (
          <WorkspacePanel
            store={workspaces}
            onOpenFile={(node) => void manager.openWorkspaceFile(node.path, workspace.root?.rootId ?? null)}
            onRenamed={(oldPath, ref) => void manager.repathDocument(oldPath, ref)}
            onDeleted={(filePath) => {
              void manager.removeDocumentByPath(filePath);
            }}
          />
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
                searchSignal={searchSignal}
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
                searchSignal={searchSignal}
                onChange={(content) => manager.updateContent(active.id, content)}
                onSelection={(info) => {
                  setCursor(info);
                  manager.updateCursor(active.id, info);
                }}
              />
            </section>
            <section
              className="pane"
              hidden={state.mode === "source" || state.mode === "wysiwyg"}
              aria-label="渲染预览"
            >
              <PreviewPane
                document={active}
                enabled={state.mode !== "source"}
                compileSignal={compileSignal}
              />
            </section>
          </main>
        ) : (
          <main className="empty-state">
            <span className="brand-mark large" aria-hidden="true" />
            <h1>打开一个文档开始编辑</h1>
            <p>源码与渲染结果实时同步，保存时保留原文件编码与换行符。</p>
            <div className="empty-actions">
              <button type="button" className="button primary" onClick={() => manager.newDocument()}>
                新建文档
              </button>
              <button type="button" className="button" onClick={() => void manager.openFiles()}>
                打开文件
              </button>
            </div>
            {recent.length > 0 && (
              <div className="recent">
                <h2>最近文件</h2>
                <ul>
                  {recent.map((entry) => (
                    <li key={entry.path}>
                      <button
                        type="button"
                        className="recent-item"
                        title={entry.path}
                        onClick={() => void manager.openPath(entry.path)}
                      >
                        {entry.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </main>
        )}
      </div>

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
            {active.dirty ? " · 未保存" : " · 已保存"}
          </span>
        )}
        <span className="statusbar-meta">{workspace.root ? workspace.root.name : "无工作区"}</span>
      </footer>

      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={(patch) => {
          const next = patch as Settings;
          manager.setAutoSave(next.editor.autoSave);
          void settingsStore.update(next);
        }}
        onExtensionsChanged={() => {
          void refreshExtensionFormats();
        }}
      />

      <RecoveryDialog
        entries={recoveries}
        onRestore={(entry) => {
          void manager.restoreDraft(entry);
          setRecoveries((items) => items.filter((item) => item.key !== entry.key));
        }}
        onDiscard={(entry) => {
          void manager.discardDraft(entry.key);
          setRecoveries((items) => items.filter((item) => item.key !== entry.key));
        }}
        onClose={() => setRecoveries([])}
      />
    </div>
  );
}
