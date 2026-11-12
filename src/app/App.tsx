import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import type { EditorState } from "@codemirror/state";
import { renderMarkdownToHtml } from "../formats/markdown/preview";
import { parseMarkdown } from "../formats/markdown/parse";
import { buildOutline, type OutlineItem } from "../formats/outline";
import { EMPTY_PROBLEMS, problemStore, type Problem } from "../services/problem-store";
import { getFormatEntry, refreshExtensionFormats } from "../extensions/registry";
import { sanitizeHtml } from "../render/html";
import { RenderedMarkdown } from "./RenderedMarkdown";
import {
  DocumentManager,
  type DocumentState,
  type EditorMode,
} from "../services/document-manager";
import { settingsStore } from "../services/settings-store";
import { WorkspaceStore } from "../services/workspace-store";
import { SourceEditor, type DiffLineMarker, type SelectionInfo, type SourceLanguage } from "../source/codemirror";
import { sourceLanguageForFormat } from "../source/language";
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
import { localeTag, resolveLocale, setLocale, t } from "../i18n";
import { RecoveryDialog } from "./RecoveryDialog";
import { CommandPalette, type CommandItem } from "./CommandPalette";
import { DiffControls, type DiffListItem } from "./DiffControls";
import { diffLineMarkers, describeHunk, useDocumentDiff } from "./useDocumentDiff";
import { hunkAnchorLine, type DiffHunk } from "../diff/compute";
import type { PreviewDiffModel } from "../diff/preview";
import type { DiffBase, DiffViewMode } from "../shared/diff";
import { Icon, PandaMark, type IconName } from "./icons";
import { OutlinePanel } from "./OutlinePanel";
import { PdfPreview } from "./PdfPreview";
import { PerformanceOverlay } from "./PerformanceOverlay";
import { ProblemPanel } from "./ProblemPanel";
import { SettingsDialog } from "./SettingsDialog";
import { WorkspacePanel } from "./WorkspacePanel";
import { WysiwygPane } from "./WysiwygPane";
import { GitPane } from "./GitPane";

const MODE_LABELS: Record<EditorMode, string> = {
  wysiwyg: "所见即所得",
  source: "源码",
  split: "分栏",
  preview: "预览",
  git: "Git 差异",
};

const MODE_ICONS: Record<EditorMode, IconName> = {
  wysiwyg: "pencil",
  source: "code",
  split: "split",
  preview: "eye",
  git: "git",
};

/** 具有渲染预览的内置格式；扩展格式由扩展自身提供预览。 */
const PREVIEW_FORMATS = new Set(["markdown", "latex", "mathml", "plantuml", "mermaid"]);

function formatSupportsPreview(formatId: string): boolean {
  return PREVIEW_FORMATS.has(formatId) || Boolean(getFormatEntry(formatId)?.extensionId);
}

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
  return new Date(ms).toLocaleString(localeTag(), { hour12: false });
}

const EMPTY_DIFF_HUNKS: DiffHunk[] = [];

/** 计算文本行数；末尾换行不额外计入一行，与 diff 的行号口径一致。 */
function textLineCount(text: string): number {
  if (!text) return 1;
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  return normalized.split("\n").length;
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
  jump,
  tabSize,
  showLineNumbers,
  diffMarkers,
  onChange,
  onSelection,
}: {
  document: DocumentState;
  mode: EditorMode;
  searchSignal: number;
  jump: { line: number; column: number; token: number } | null;
  tabSize: number;
  showLineNumbers: boolean;
  diffMarkers: readonly DiffLineMarker[];
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
  const diffMarkersRef = useRef(diffMarkers);
  diffMarkersRef.current = diffMarkers;
  const [gotoOpen, setGotoOpen] = useState(false);
  const [gotoValue, setGotoValue] = useState("");

  const language: SourceLanguage = sourceLanguageForFormat(document.format);

  useEffect(() => {
    return () => {
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (searchSignal > 0 && mode !== "wysiwyg" && mode !== "preview" && mode !== "git") {
      editorRef.current?.openSearch();
    }
  }, [searchSignal, mode]);

  // 大纲跳转：按行定位源码光标。
  useEffect(() => {
    if (!jump) return;
    editorRef.current?.setCursor({ line: jump.line, column: jump.column });
  }, [jump]);

  // 设置变更即时应用到现有编辑器。
  useEffect(() => {
    editorRef.current?.setTabSize(tabSize);
  }, [tabSize]);

  useEffect(() => {
    editorRef.current?.setShowLineNumbers(showLineNumbers);
  }, [showLineNumbers]);

  // diff 行标记随对比结果更新；重置编辑器后由重建分支补回。
  useEffect(() => {
    editorRef.current?.setDiffMarkers(diffMarkers);
  }, [diffMarkers]);

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
        tabSize,
        showLineNumbers,
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
          (previous.mode !== mode &&
            mode !== "preview" &&
            mode !== "wysiwyg" &&
            mode !== "git"))
      ) {
        editor.reset(document.content, document.readOnly, language);
      }
    }
    lastRef.current = { id: document.id, revision: document.revision, mode, language };
    editor.setDiffMarkers(diffMarkersRef.current);
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
            placeholder={t("行:列")}
            aria-label={t("跳转到行")}
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
            {t("跳转")}
          </button>
          <button type="button" className="button small ghost" onClick={() => setGotoOpen(false)}>
            {t("取消")}
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
        <p className="placeholder">{t("MathML 诊断：{0}", error)}</p>
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

  // 格式级图表预览错误汇入问题面板。
  useEffect(() => {
    problemStore.setEntry(
      document.id,
      "diagram",
      "preview",
      enabled && error ? [{ severity: "error", message: t("图表渲染失败：{0}", error) }] : [],
    );
  }, [document.id, error, enabled]);

  return (
    <div className="preview-pane">
      {error ? (
        <p className="placeholder">{t("图表诊断：{0}", error)}</p>
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
          problemStore.setSource(
            document.id,
            "extension",
            [...parsed.diagnostics, ...preview.diagnostics].map((item) => ({
              severity: item.severity,
              message: item.message,
              line: item.line,
              column: item.column,
            })),
          );
        } catch (reason) {
          if (cancelled) return;
          const message = reason instanceof Error ? reason.message : String(reason);
          setHtml("");
          setError(message);
          problemStore.setSource(document.id, "extension", [{ severity: "error", message }]);
        }
      })();
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [document.content, document.path, document.id, extensionId, providerId, enabled]);

  useEffect(() => {
    if (!enabled || !extensionId) problemStore.setSource(document.id, "extension", []);
  }, [document.id, extensionId, enabled]);

  if (!entry?.extensionId) {
    return (
      <div className="preview-pane">
        <p className="placeholder">{t("该格式的扩展已被禁用，按纯文本打开")}</p>
      </div>
    );
  }

  return (
    <div className="preview-pane">
      {error ? (
        <p className="placeholder">{t("扩展预览诊断：{0}", error)}</p>
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

  // 编译诊断汇入问题面板。见 doc/design.md §15.1。
  useEffect(() => {
    if (!enabled) {
      problemStore.setSource(document.id, "latex", []);
      return;
    }
    problemStore.setSource(
      document.id,
      "latex",
      (result?.diagnostics ?? []).map((item) => ({
        severity: item.severity,
        message: item.message,
        line: item.line,
        column: item.column,
      })),
    );
  }, [document.id, result, enabled]);

  const detect = async (): Promise<void> => {
    try {
      setEngines(await window.panda.latex.detect());
    } catch {
      setEngines({ available: false, engines: [] });
    }
  };

  const compile = async (): Promise<void> => {
    if (!document.path) {
      setError(t("请先保存 .tex 文件后再编译"));
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
          <p>{t("未检测到 TeX 引擎（Tectonic / latexmk / xelatex）。")}</p>
          <p className="placeholder">
            {t("安装任一引擎后点击“重新检测”；其他功能不受影响。")}
          </p>
          <button type="button" className="button small" onClick={() => void detect()}>
            {t("重新检测")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="preview-pane tex-preview">
      {error && <p className="placeholder">{error}</p>}
      {document.dirty && (
        <p className="placeholder">{t("当前有未保存修改，编译仅使用磁盘内容。")}</p>
      )}
      {busy && (
        <p className="placeholder">{t("编译中…（首次编译需下载 TeX 宏包，可能需要几分钟）")}</p>
      )}
      {result && result.ok && result.pdfKey ? (
        <PdfPreview pdfKey={result.pdfKey} />
      ) : null}
      {result && !result.ok && result.diagnostics.length > 0 && (
        <ul className="tex-diagnostics">
          {result.diagnostics.map((diagnostic, index) => (
            <li key={`${index}-${diagnostic.message}`} className={`tex-diagnostic ${diagnostic.severity}`}>
              {diagnostic.line !== undefined ? t("第 {0} 行：", diagnostic.line) : ""}
              {diagnostic.message}
            </li>
          ))}
        </ul>
      )}
      {!result && engines?.available && !busy && (
        <p className="placeholder">{t("保存后自动编译。")}</p>
      )}
    </div>
  );
}

function PreviewPane({
  document,
  enabled,
  compileSignal,
  diff,
  onDiffModeChange,
  onDiffJump,
}: {
  document: DocumentState;
  enabled: boolean;
  compileSignal: number;
  diff: PreviewDiffModel | null;
  onDiffModeChange(mode: DiffViewMode): void;
  onDiffJump(line: number): void;
}) {
  const [html, setHtml] = useState("");
  const [error, setError] = useState<string | null>(null);
  const supported = document.format === "markdown";
  const annotate = diff !== null;

  useEffect(() => {
    if (!supported || !enabled) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      renderMarkdownToHtml(document.content, { annotateSource: annotate })
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
  }, [document.content, supported, enabled, annotate]);

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
        <p className="placeholder">{t("该格式暂不支持渲染预览")}</p>
      </div>
    );
  }

  return (
    <div className="preview-pane">
      {error ? (
        <p className="placeholder">{t("预览渲染失败：{0}", error)}</p>
      ) : (
        <RenderedMarkdown
          html={html}
          filePath={document.path}
          sourceKey={`md-preview:${document.id}`}
          diff={diff}
          onDiffModeChange={onDiffModeChange}
          onDiffJump={onDiffJump}
        />
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

  // 界面语言在父组件渲染前写入全局，子组件直接调用 t() 即可拿到当前语言。
  const locale = useMemo(() => {
    const resolved = resolveLocale(settings.appearance.language, navigator.language);
    setLocale(resolved);
    if (typeof document !== "undefined") {
      document.documentElement.lang = resolved === "zh" ? "zh-CN" : "en";
    }
    return resolved;
  }, [settings.appearance.language]);

  const [cursor, setCursor] = useState<SelectionInfo>({ line: 1, column: 1 });
  const [searchSignal, setSearchSignal] = useState(0);
  const [compileSignal, setCompileSignal] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recoveries, setRecoveries] = useState<DraftEntry[]>([]);
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [perfVisible, setPerfVisible] = useState(false);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [extensionCommands, setExtensionCommands] = useState<CommandItem[]>([]);
  const [tabsOverflow, setTabsOverflow] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ top: number; right: number } | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(localStorage.getItem("panda.sidebarWidth"));
    return Number.isFinite(stored) && stored >= 120 ? Math.min(480, stored) : 260;
  });
  const [splitRatio, setSplitRatio] = useState(50);
  const appRef = useRef<HTMLDivElement>(null);
  const workspacePaneRef = useRef<HTMLElement>(null);
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const splitRatioRef = useRef(splitRatio);
  splitRatioRef.current = splitRatio;
  const tabstripRef = useRef<HTMLDivElement>(null);
  const tabItemsRef = useRef<HTMLDivElement>(null);
  const tabMenuButtonRef = useRef<HTMLButtonElement>(null);
  const problemsState = useSyncExternalStore(problemStore.subscribe, problemStore.getState);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [sourceJump, setSourceJump] = useState<{ line: number; column: number; token: number } | null>(
    null,
  );
  const [wysiwygJump, setWysiwygJump] = useState<{ index: number; token: number } | null>(null);
  const [wysiwygDiffJump, setWysiwygDiffJump] = useState<{ line: number; token: number } | null>(
    null,
  );
  const jumpTokenRef = useRef(0);

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
  const activeContent = active?.content ?? "";
  const activeFormat = active?.format ?? "";
  const activeId = active?.id ?? "";

  // 渲染态差异：每个文档独立保存开关与基线。见 doc/design.md §21.8.1。
  const [diffOptions, setDiffOptions] = useState<
    Record<string, { enabled: boolean; base: DiffBase; mode: DiffViewMode; ref: string }>
  >({});
  const [diffIndex, setDiffIndex] = useState(-1);
  const [diffRefresh, setDiffRefresh] = useState(0);
  const activeDiff = activeId ? diffOptions[activeId] : undefined;
  const diffEnabled = activeDiff?.enabled ?? false;
  const diffBase = activeDiff?.base ?? "head";
  const diffMode = activeDiff?.mode ?? "full";
  const diffRef = activeDiff?.ref ?? "";

  useEffect(() => {
    if (!activeId) return;
    setDiffOptions((current) =>
      current[activeId]
        ? current
        : {
            ...current,
            [activeId]: {
              enabled: settingsRef.current.diff.defaultOn,
              base: "head",
              mode: "full",
              ref: "",
            },
          },
    );
  }, [activeId]);

  // 文档关闭后清理其 diff 选项，避免长期运行时状态无限增长。见 §21.8.6。
  useEffect(() => {
    const openIds = new Set(state.documents.map((doc) => doc.id));
    setDiffOptions((current) => {
      const keys = Object.keys(current);
      if (keys.every((id) => openIds.has(id))) return current;
      const next: typeof current = {};
      for (const id of keys) {
        if (openIds.has(id)) next[id] = current[id]!;
      }
      return next;
    });
  }, [state.documents]);

  const updateDiffOption = (
    id: string,
    patch: Partial<{ enabled: boolean; base: DiffBase; mode: DiffViewMode; ref: string }>,
  ): void => {
    if (!id) return;
    setDiffOptions((current) => {
      const previous = current[id] ?? {
        enabled: false,
        base: "head" as DiffBase,
        mode: "full" as DiffViewMode,
        ref: "",
      };
      return { ...current, [id]: { ...previous, ...patch } };
    });
    setDiffIndex(-1);
  };

  const diffState = useDocumentDiff({
    document: active,
    enabled: diffEnabled,
    base: diffBase,
    ref: diffRef,
    refreshKey: diffRefresh,
    onFallback: () => {
      const id = activeRef.current?.id;
      if (id) updateDiffOption(id, { base: "lastSave" });
    },
  });

  const sourceDiffMarkers = useMemo(() => diffLineMarkers(diffState.diff), [diffState.diff]);
  const diffHunks = diffState.diff?.hunks ?? EMPTY_DIFF_HUNKS;
  const activeLineCount = active ? textLineCount(active.content) : 1;
  const diffAnchors = useMemo(
    () => diffHunks.map((hunk) => hunkAnchorLine(hunk, activeLineCount)),
    [diffHunks, activeLineCount],
  );
  const diffItems = useMemo<DiffListItem[]>(() => {
    // 改动列表显示所属标题面包屑。见 §21.8.3。
    const breadcrumbAt = (line: number): string => {
      const stack: OutlineItem[] = [];
      for (const heading of outline) {
        if (heading.line > line) break;
        while (stack.length > 0 && stack[stack.length - 1]!.level >= heading.level) stack.pop();
        stack.push(heading);
      }
      return stack.map((heading) => heading.text).join(" › ");
    };
    return diffHunks.map((hunk, index) => {
      const line = diffAnchors[index] ?? hunk.newStart;
      return {
        line,
        label: describeHunk(hunk),
        kind: hunk.kind,
        breadcrumb: breadcrumbAt(line),
      };
    });
  }, [diffHunks, diffAnchors, outline]);

  // 预览装饰只在对比就绪时启用；关闭后传 null 由渲染层清理。
  const previewDiff = useMemo<PreviewDiffModel | null>(() => {
    if (!diffEnabled) return null;
    if (diffState.status !== "ready" && diffState.status !== "stale") return null;
    if (!diffState.diff || diffState.oldText === null) return null;
    return {
      oldText: diffState.oldText,
      newText: activeRef.current?.content ?? "",
      diff: diffState.diff,
      mode: diffMode,
    };
  }, [diffEnabled, diffState.status, diffState.diff, diffState.oldText, diffMode]);

  useEffect(() => {
    setDiffIndex(-1);
  }, [diffState.diff, diffBase, diffEnabled, activeId]);


  // 大纲随内容变化防抖重建；仅 Markdown 与 LaTeX 提供大纲。见 doc/design.md §15.1。
  useEffect(() => {
    if (!activeId || (activeFormat !== "markdown" && activeFormat !== "latex")) {
      setOutline([]);
      return;
    }
    const timer = setTimeout(() => setOutline(buildOutline(activeContent, activeFormat)), 200);
    return () => {
      clearTimeout(timer);
    };
  }, [activeId, activeContent, activeFormat]);

  const problems = activeId ? (problemsState.byDocument[activeId] ?? EMPTY_PROBLEMS) : EMPTY_PROBLEMS;
  const errorCount = problems.filter((problem) => problem.severity === "error").length;
  const warningCount = problems.filter((problem) => problem.severity === "warning").length;

  // Markdown 解析诊断汇入问题面板。见 doc/design.md §15.1。
  useEffect(() => {
    if (!activeId) return;
    if (activeFormat !== "markdown") {
      problemStore.setSource(activeId, "markdown", []);
      return;
    }
    const timer = setTimeout(() => {
      problemStore.setSource(
        activeId,
        "markdown",
        parseMarkdown(activeContent).diagnostics.map((item) => ({
          severity: item.severity,
          message: item.message,
          line: item.line,
          column: item.column,
        })),
      );
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, [activeId, activeContent, activeFormat]);

  const jumpToProblem = (problem: Problem): void => {
    if (problem.line === undefined) return;
    if (state.mode === "wysiwyg" || state.mode === "preview" || state.mode === "git") {
      manager.setMode("source");
    }
    jumpTokenRef.current += 1;
    setSourceJump({ line: problem.line, column: problem.column ?? 1, token: jumpTokenRef.current });
  };

  const jumpToOutline = (item: OutlineItem): void => {
    jumpTokenRef.current += 1;
    const token = jumpTokenRef.current;
    if (state.mode === "wysiwyg") {
      setWysiwygJump({ index: item.index, token });
      return;
    }
    if (state.mode === "source" || state.mode === "split") {
      setSourceJump({ line: item.line, column: 1, token });
      return;
    }
    const headings = document.querySelectorAll<HTMLElement>(
      ".pane:not([hidden]) .markdown-body :is(h1,h2,h3,h4,h5,h6)",
    );
    headings[item.index]?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  /** 定位到渲染预览中覆盖指定源码行号的块。见 doc/design.md §21.8.3。 */
  const scrollPreviewToLine = (line: number): void => {
    const blocks = [
      ...document.querySelectorAll<HTMLElement>(
        ".pane:not([hidden]) .markdown-body [data-src-line]",
      ),
    ].filter((element) => element.closest("[data-diff-ghost]") === null);
    if (blocks.length === 0) return;
    const exact = blocks.find((element) => {
      const start = Number(element.dataset["srcLine"]);
      const end = Number(element.dataset["srcEndLine"] ?? element.dataset["srcLine"]);
      return Number.isFinite(start) && line >= start && line <= (Number.isFinite(end) ? end : start);
    });
    const fallback = [...blocks]
      .reverse()
      .find((element) => Number(element.dataset["srcLine"]) <= line);
    const target = exact ?? fallback;
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
    if (target) {
      // 目标块短暂高亮，便于在长文档中定位。见 §21.8.3。
      target.classList.add("diff-target");
      setTimeout(() => target.classList.remove("diff-target"), 600);
    }
  };

  const revealDiffAt = (line: number): void => {
    if (!active) return;
    jumpTokenRef.current += 1;
    const token = jumpTokenRef.current;
    if (state.mode === "source" || state.mode === "split") {
      setSourceJump({ line, column: 1, token });
      return;
    }
    if (state.mode === "wysiwyg") {
      setWysiwygDiffJump({ line, token });
      return;
    }
    scrollPreviewToLine(line);
  };

  const navigateDiff = (direction: 1 | -1): void => {
    if (diffAnchors.length === 0) return;
    const next =
      diffIndex < 0
        ? direction === 1
          ? 0
          : diffAnchors.length - 1
        : (diffIndex + direction + diffAnchors.length) % diffAnchors.length;
    // 从首/尾绕回时给出短暂提示。见 §21.8.3。
    if (diffIndex >= 0 && next === (direction === 1 ? 0 : diffAnchors.length - 1)) {
      manager.showNotice("info", direction === 1 ? t("已回到第一处") : t("已回到最后一处"));
    }
    setDiffIndex(next);
    const line = diffAnchors[next];
    if (line !== undefined) revealDiffAt(line);
  };

  const saveSession = async (): Promise<void> => {
    const snapshot: SessionState = manager.buildSession({
      mode: stateRef.current.mode,
      sidebarVisible: workspaceStateRef.current.visible,
      recent: recentRef.current,
      workspace:
        workspaceStateRef.current.roots.length > 0
          ? { roots: workspaces.collectRoots() }
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
      manager.showNotice("error", t("仅 Markdown 文档支持导出 HTML"));
      return;
    }
    try {
      const { buildDocumentHtml, saveHtml } = await import("../services/export-service");
      const html = await buildDocumentHtml(doc, { theme: exportTheme() });
      const savedPath = await saveHtml(doc, html);
      if (savedPath) manager.showNotice("info", t("已导出 HTML：{0}", savedPath));
    } catch (reason) {
      manager.showNotice("error", describeError(reason));
    }
  };

  const exportPdfActive = async (): Promise<void> => {
    const doc = activeRef.current;
    if (!doc) return;
    if (doc.format !== "markdown") {
      manager.showNotice("error", t("仅 Markdown 文档支持导出 PDF"));
      return;
    }
    try {
      const { buildDocumentHtml } = await import("../services/export-service");
      const html = await buildDocumentHtml(doc, { theme: exportTheme() });
      const result = await window.panda.export.pdf({
        html,
        suggestedName: `${doc.name.replace(/\.[^.]+$/, "")}.pdf`,
      });
      manager.showNotice("info", t("已导出 PDF：{0}", result.path));
    } catch (reason) {
      if (getErrorCode(reason) === "E_CANCELLED") return;
      manager.showNotice("error", describeError(reason));
    }
  };

  const exportSvgActive = async (): Promise<void> => {
    const doc = activeRef.current;
    if (!doc) return;
    if (doc.format !== "plantuml" && doc.format !== "mermaid") {
      manager.showNotice("error", t("仅 PlantUML / Mermaid 文档支持导出 SVG"));
      return;
    }
    try {
      const { exportDiagramSvg } = await import("../services/export-service");
      const savedPath = await exportDiagramSvg(doc);
      if (savedPath) manager.showNotice("info", t("已导出 SVG：{0}", savedPath));
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
          manager.showNotice("info", result.message ?? t("未配置更新源"));
          return;
        case "available":
          manager.showNotice(
            "info",
            t(
              "发现新版本 {0}（当前 {1}）",
              result.latestVersion ?? "",
              result.currentVersion,
            ),
          );
          return;
        case "latest":
          manager.showNotice("info", t("当前已是最新版本（{0}）", result.currentVersion));
          return;
        default:
          manager.showNotice("error", t("更新检查失败：{0}", result.message ?? ""));
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
      manager.setSaveEol(loaded.editor.eol);
      manager.ensureSessionTimer();
      await refreshExtensionFormats();
      const session = await window.panda.session.load();
      if (session && !disposed) {
        if (!session.sidebarVisible) workspaces.setVisible(false);
        if (session.workspace) {
          const roots =
            session.workspace.roots ??
            (session.workspace.rootPath
              ? [{ rootPath: session.workspace.rootPath, expanded: session.workspace.expanded ?? [] }]
              : []);
          for (const root of roots) {
            await workspaces.openPath(root.rootPath, root.expanded);
          }
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

  // 关闭最后一个文档回到欢迎页时刷新最近文件，避免展示打开前的旧列表。
  useEffect(() => {
    if (state.documents.length > 0) return;
    let disposed = false;
    void window.panda.recent
      .list()
      .then((list) => {
        if (!disposed) setRecent(list);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [state.documents.length]);

  useEffect(() => {
    return window.panda.onOpenPath((filePath) => {
      void manager.openPath(filePath);
    });
  }, [manager]);

  // 命令面板：Ctrl/Cmd+Shift+P 切换；打开时拉取扩展命令。见 doc/design.md §15.1。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  useEffect(() => {
    if (!paletteOpen) return;
    let cancelled = false;
    void window.panda.ext
      .commands()
      .then((list) => {
        if (cancelled) return;
        setExtensionCommands(
          list.map((item) => ({
            id: `ext:${item.id}`,
            title: item.title,
            run: async () => {
              await window.panda.ext.command(item.id);
              manager.showNotice("info", t("已执行：{0}", item.title));
            },
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setExtensionCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [paletteOpen, manager]);

  // 标签超出可用宽度时显示「全部标签」下拉。见 doc/design.md §15.1。
  useEffect(() => {
    const host = tabstripRef.current;
    const items = tabItemsRef.current;
    if (!host || !items) return;
    const update = (): void => {
      const buttonSpace = tabMenuButtonRef.current?.offsetWidth ?? 76;
      setTabsOverflow(items.scrollWidth > host.clientWidth - buttonSpace);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    observer.observe(items);
    return () => observer.disconnect();
  }, [state.documents.length]);

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
        case "view.performance":
          setPerfVisible((visible) => !visible);
          return;
        case "view.commandPalette":
          setPaletteOpen(true);
          return;
        default:
          void manager.runMenuCommand(command);
      }
    });
  }, [manager, workspaces]);

  // 原生窗口菜单已关闭，常用快捷键改由渲染层统一处理。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "p" && event.shiftKey) return;
      if (key === "n" && !event.shiftKey) {
        event.preventDefault();
        void manager.runMenuCommand("file.new");
      } else if (key === "o") {
        event.preventDefault();
        void manager.runMenuCommand(event.shiftKey ? "workspace.open" : "file.open");
      } else if (key === "s") {
        event.preventDefault();
        void manager.runMenuCommand(event.shiftKey ? "file.saveAs" : "file.save");
      } else if (key === "w") {
        event.preventDefault();
        void manager.runMenuCommand("file.close");
      } else if (key === "f") {
        event.preventDefault();
        setSearchSignal((value) => value + 1);
      } else if (key === "b") {
        event.preventDefault();
        setCompileSignal((value) => value + 1);
      } else if (key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [manager, workspaces]);

  // 改动导航：Ctrl+Shift+D 开关，F7 / Shift+F7 在改动间循环。见 §21.8.8。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "d") {
        if (!activeId) return;
        event.preventDefault();
        updateDiffOption(activeId, { enabled: !diffEnabled });
        return;
      }
      if (event.key === "F7" && diffEnabled) {
        event.preventDefault();
        navigateDiff(event.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activeId, diffEnabled, diffAnchors, diffIndex, state.mode, active]);

  useEffect(() => {
    setCursor({ line: 1, column: 1 });
  }, [state.activeId]);

  // 把拖拽结果写入 CSS 变量；不在 inline style 中重复声明，避免其他重渲染把拖拽中的宽度覆盖。
  useLayoutEffect(() => {
    appRef.current?.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
  }, [sidebarWidth]);

  useLayoutEffect(() => {
    const element = workspacePaneRef.current;
    if (!element || state.mode !== "split") return;
    element.style.setProperty("--split-ratio", `${splitRatio}%`);
  }, [splitRatio, state.mode, state.activeId]);

  const paletteCommands: CommandItem[] = [
    { id: "file.new", title: t("新建文档"), shortcut: "Ctrl+N", run: () => manager.newDocument() },
    {
      id: "file.open",
      title: t("打开文件…"),
      shortcut: "Ctrl+O",
      run: () => void manager.openFiles(),
    },
    {
      id: "workspace.open",
      title: t("打开文件夹…"),
      shortcut: "Ctrl+Shift+O",
      run: () => void workspaces.openPicker(),
    },
    {
      id: "file.save",
      title: t("保存"),
      shortcut: "Ctrl+S",
      run: () => {
        if (state.activeId) void manager.saveDocument(state.activeId);
      },
    },
    {
      id: "file.saveAs",
      title: t("另存为…"),
      shortcut: "Ctrl+Shift+S",
      run: () => {
        if (active) void manager.saveDocumentAs(active.id);
      },
    },
    {
      id: "file.close",
      title: t("关闭当前标签"),
      shortcut: "Ctrl+W",
      run: () => {
        if (active) void manager.closeDocument(active.id);
      },
    },
    { id: "file.exportHtml", title: t("导出 HTML…"), run: () => void exportHtmlActive() },
    { id: "file.exportPdf", title: t("导出 PDF…"), run: () => void exportPdfActive() },
    { id: "file.exportSvg", title: t("导出图表 SVG…"), run: () => void exportSvgActive() },
    {
      id: "view.find",
      title: t("查找替换"),
      shortcut: "Ctrl+F",
      run: () => setSearchSignal((value) => value + 1),
    },
    {
      id: "diff.toggle",
      title: diffEnabled ? t("隐藏改动") : t("显示改动"),
      shortcut: "Ctrl+Shift+D",
      run: () => updateDiffOption(activeId, { enabled: !diffEnabled }),
    },
    {
      id: "diff.mode.full",
      title: t("差异视图：全文标注"),
      run: () => updateDiffOption(activeId, { mode: "full" }),
    },
    {
      id: "diff.mode.collapse",
      title: t("差异视图：折叠未改动"),
      run: () => updateDiffOption(activeId, { mode: "collapse" }),
    },
    {
      id: "diff.mode.fragments",
      title: t("差异视图：仅改动片段"),
      run: () => updateDiffOption(activeId, { mode: "fragments" }),
    },
    {
      id: "view.settings",
      title: t("打开设置…"),
      shortcut: "Ctrl+,",
      run: () => setSettingsOpen(true),
    },
    {
      id: "latex.compile",
      title: t("编译 LaTeX"),
      shortcut: "Ctrl+B",
      run: () => setCompileSignal((value) => value + 1),
    },
    { id: "update.check", title: t("检查更新"), run: () => void checkUpdate() },
    {
      id: "view.mode.wysiwyg",
      title: t("视图模式：所见即所得"),
      run: () => manager.setMode("wysiwyg"),
    },
    { id: "view.mode.source", title: t("视图模式：源码"), run: () => manager.setMode("source") },
    { id: "view.mode.split", title: t("视图模式：分栏"), run: () => manager.setMode("split") },
    {
      id: "view.mode.preview",
      title: t("视图模式：预览"),
      run: () => manager.setMode("preview"),
    },
    { id: "view.mode.git", title: t("视图模式：Git 差异"), run: () => manager.setMode("git") },
    ...(import.meta.env.DEV
      ? [
          {
            id: "view.performance",
            title: t("切换性能浮层"),
            run: () => setPerfVisible((visible) => !visible),
          },
        ]
      : []),
    ...extensionCommands,
  ];

  /** 拖拽侧栏分隔条调整宽度，并记住用户选择。 */
  const beginSidebarResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidthRef.current;
    const app = appRef.current;
    const move = (moveEvent: PointerEvent): void => {
      const next = Math.max(120, Math.min(480, startWidth + moveEvent.clientX - startX));
      sidebarWidthRef.current = next;
      // 拖拽期间直接写 CSS 变量，避免 React 每帧重渲染导致闪烁。
      app?.style.setProperty("--sidebar-width", `${next}px`);
    };
    const end = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      document.body.classList.remove("resizing");
      setSidebarWidth(sidebarWidthRef.current);
      try {
        localStorage.setItem("panda.sidebarWidth", String(sidebarWidthRef.current));
      } catch {
        // 忽略无痕模式下的存储失败。
      }
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };

  /** 分栏模式下拖拽中间分隔条调整源码/预览比例。 */
  const beginSplitResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const container = event.currentTarget.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const move = (moveEvent: PointerEvent): void => {
      const ratio = Math.max(25, Math.min(75, ((moveEvent.clientX - rect.left) / rect.width) * 100));
      splitRatioRef.current = ratio;
      container.style.setProperty("--split-ratio", `${ratio}%`);
    };
    const end = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      document.body.classList.remove("resizing");
      setSplitRatio(splitRatioRef.current);
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };

  return (
    <div className="app" ref={appRef}>
      <header className="toolbar">
        <div className="brand" title="Panda Live">
          <PandaMark size={19} />
        </div>
        <span className="toolbar-divider" aria-hidden="true" />
        <button
          type="button"
          className={workspace.visible ? "icon-button sidebar-toggle active" : "icon-button sidebar-toggle"}
          aria-pressed={workspace.visible}
          aria-label={workspace.visible ? t("折叠工作区") : t("展开工作区")}
          title={workspace.visible ? t("折叠工作区") : t("展开工作区")}
          onClick={() => workspaces.setVisible(!workspace.visible)}
        >
          <Icon name={workspace.visible ? "sidebar-close" : "sidebar-open"} />
        </button>
        <div className="toolbar-spacer" />
        <button
          type="button"
          className="icon-button toolbar-icon"
          aria-label={t("新建")}
          title={t("新建（Ctrl+N）")}
          onClick={() => manager.newDocument()}
        >
          <Icon name="file-plus" />
        </button>
        <button
          type="button"
          className="icon-button toolbar-icon"
          aria-label={t("打开")}
          title={t("打开（Ctrl+O）")}
          onClick={() => void manager.openFiles()}
        >
          <Icon name="folder-open" />
        </button>
        <button
          type="button"
          className="icon-button toolbar-icon"
          aria-label={t("保存")}
          title={t("保存（Ctrl+S）")}
          onClick={() => void manager.saveDocument(state.activeId ?? "")}
          disabled={!active}
        >
          <Icon name="save" />
        </button>
        <button
          type="button"
          className="icon-button toolbar-icon"
          aria-label={t("另存为")}
          title={t("另存为（Ctrl+Shift+S）")}
          onClick={() => active && void manager.saveDocumentAs(active.id)}
          disabled={!active}
        >
          <Icon name="save-as" />
        </button>
        <button
          type="button"
          className="icon-button toolbar-icon"
          aria-label={t("命令面板")}
          title={t("命令面板（Ctrl+Shift+P）")}
          onClick={() => setPaletteOpen(true)}
        >
          <Icon name="terminal" />
        </button>
        <span className="toolbar-divider" aria-hidden="true" />
        <div className="mode-switch" role="group" aria-label={t("视图模式")}>
          {(Object.keys(MODE_LABELS) as EditorMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={state.mode === mode ? "mode-button active" : "mode-button"}
              aria-pressed={state.mode === mode}
              aria-label={t(MODE_LABELS[mode]!)}
              title={t(MODE_LABELS[mode]!)}
              onClick={() => manager.setMode(mode)}
              disabled={
                !active ||
                (mode === "wysiwyg" && active.format !== "markdown") ||
                ((mode === "split" || mode === "preview") &&
                  !formatSupportsPreview(active.format))
              }
            >
              <Icon name={MODE_ICONS[mode]} />
            </button>
          ))}
        </div>
        <span className="toolbar-divider" aria-hidden="true" />
        <button
          type="button"
          className="icon-button toolbar-icon"
          aria-label={locale === "zh" ? "切换到英文界面" : "Switch to Chinese"}
          title={locale === "zh" ? "Switch to English" : "切换为中文"}
          onClick={() => {
            void settingsStore.update({
              appearance: { language: locale === "zh" ? "en" : "zh" },
            });
          }}
        >
          <Icon name="languages" />
        </button>
        <button
          type="button"
          className="icon-button toolbar-icon"
          aria-label={t("设置")}
          title={t("设置（Ctrl+,）")}
          onClick={() => setSettingsOpen(true)}
        >
          <Icon name="settings" />
        </button>
      </header>

      <div className="main-row">
        {workspace.visible && (
          <>
            <WorkspacePanel
              store={workspaces}
              activePath={
                state.documents.find((doc) => doc.id === state.activeId)?.path ?? null
              }
              onOpenFile={(node, rootId) => void manager.openWorkspaceFile(node.path, rootId)}
              onOpenPath={(filePath, rootId) => void manager.openPath(filePath, rootId)}
              onRenamed={(oldPath, ref) => void manager.repathDocument(oldPath, ref)}
              onDeleted={(filePath) => {
                void manager.removeDocumentByPath(filePath);
              }}
              outline={<OutlinePanel items={outline} onSelect={jumpToOutline} />}
            />
            <div
              className="resizer sidebar-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label={t("调整侧栏宽度")}
              onPointerDown={beginSidebarResize}
            />
          </>
        )}

        <div className="editor-area">
          <div className="tabstrip" ref={tabstripRef}>
        <div
          className="tabstrip-items"
          role="tablist"
          aria-label={t("打开的文档")}
          ref={tabItemsRef}
        >
          {state.documents.map((doc) => (
            <div
              key={doc.id}
              className={doc.id === state.activeId ? "tab-item active" : "tab-item"}
              draggable
              title={t("{0}（拖拽排序，中键关闭）", doc.path ?? doc.name)}
              onMouseDown={(event) => {
                // 阻止中键在标签上触发自动滚动。
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
            >
              <button
                type="button"
                role="tab"
                aria-selected={doc.id === state.activeId}
                className="tab"
                onClick={() => manager.setActive(doc.id)}
              >
                {doc.dirty && <span className="tab-dot" aria-label={t("未保存")} />}
                <span className="tab-name">{doc.name}</span>
              </button>
              <button
                type="button"
                className="tab-close"
                aria-label={t("关闭 {0}", doc.name)}
                title={t("关闭 {0}", doc.name)}
                onClick={(event) => {
                  event.stopPropagation();
                  void manager.closeDocument(doc.id);
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
          {state.documents.length === 0 && (
            <span className="tabstrip-empty">{t("未打开文档")}</span>
          )}
        </div>
        {tabsOverflow && (
          <button
            ref={tabMenuButtonRef}
            type="button"
            className="tab-overflow-button"
            aria-label={t("全部标签")}
            title={t("全部标签")}
            aria-expanded={tabMenu !== null}
            onClick={(event) => {
              if (tabMenu) {
                setTabMenu(null);
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              setTabMenu({ top: rect.bottom + 2, right: window.innerWidth - rect.right });
            }}
          >
            <Icon name="list" size={14} />
          </button>
        )}
      </div>

      {tabMenu && (
        <>
          <div className="tab-menu-backdrop" onClick={() => setTabMenu(null)} />
          <div
            className="tab-menu"
            role="menu"
            aria-label={t("全部标签")}
            style={{ top: tabMenu.top, right: tabMenu.right }}
          >
            {state.documents.map((doc) => (
              <button
                key={doc.id}
                type="button"
                role="menuitem"
                className={doc.id === state.activeId ? "tab-menu-item active" : "tab-menu-item"}
                title={doc.path ?? doc.name}
                onClick={() => {
                  manager.setActive(doc.id);
                  setTabMenu(null);
                }}
              >
                {doc.dirty && <span className="tab-dot" aria-label={t("未保存")} />}
                <span className="tab-menu-name">{doc.name}</span>
                {doc.id === state.activeId && (
                  <span className="tab-menu-mark">{t("当前")}</span>
                )}
              </button>
            ))}
          </div>
        </>
      )}

      {conflict && (
        <div className="banner banner-warning" role="alert">
          <span className="banner-text">
            {conflict.message}
            {conflict.diskMtimeMs !== undefined && conflict.localMtimeMs !== undefined
              ? t("（本地修改于 {0}）", formatTime(conflict.localMtimeMs))
              : ""}
          </span>
          <button
            type="button"
            className="button small"
            onClick={() => void manager.reloadFromDisk(conflict.documentId)}
          >
            {t("重新加载")}
          </button>
          <button
            type="button"
            className="button small"
            onClick={() => void manager.overwriteFromDisk(conflict.documentId)}
          >
            {t("覆盖保存")}
          </button>
          <button
            type="button"
            className="button small"
            onClick={() => {
              manager.dismissConflict();
              void manager.saveDocumentAs(conflict.documentId);
            }}
          >
            {t("另存为")}
          </button>
          <button type="button" className="button small ghost" onClick={() => manager.dismissConflict()}>
            {t("忽略")}
          </button>
        </div>
      )}

      {state.notice && (
        <div className={`banner banner-${state.notice.kind}`} role={state.notice.kind === "error" ? "alert" : "status"}>
          <span className="banner-text">{state.notice.message}</span>
          <button type="button" className="button small ghost" onClick={() => manager.dismissNotice()}>
            {t("关闭")}
          </button>
        </div>
      )}

      {diffEnabled && diffState.status === "error" && (
        <div className="banner banner-warning" role="status">
          <span className="banner-text">
            {t("读取差异基线失败：{0}", diffState.message ?? t("未知错误"))}
          </span>
          <button
            type="button"
            className="button small"
            onClick={() => setDiffRefresh((value) => value + 1)}
          >
            {t("重试")}
          </button>
          <button
            type="button"
            className="button small ghost"
            onClick={() => updateDiffOption(activeId, { base: "lastSave" })}
          >
            {t("改用上次保存")}
          </button>
        </div>
      )}

        {active ? (
          <main ref={workspacePaneRef} className={`workspace mode-${state.mode}`}>
            <section
              className="pane wysiwyg-pane"
              hidden={state.mode !== "wysiwyg"}
              aria-label={t("所见即所得编辑")}
            >
              <WysiwygPane
                document={active}
                mode={state.mode}
                searchSignal={searchSignal}
                jump={wysiwygJump}
                diff={previewDiff}
                diffJump={wysiwygDiffJump}
                onChange={(content) => manager.updateContent(active.id, content)}
              />
            </section>
            <section
              className="pane source-pane"
              hidden={
                state.mode === "preview" || state.mode === "wysiwyg" || state.mode === "git"
              }
              aria-label={t("源码编辑")}
            >
              <SourcePane
                document={active}
                mode={state.mode}
                searchSignal={searchSignal}
                jump={sourceJump}
                tabSize={settings.editor.tabSize}
                showLineNumbers={settings.editor.showLineNumbers}
                diffMarkers={sourceDiffMarkers}
                onChange={(content) => manager.updateContent(active.id, content)}
                onSelection={(info) => {
                  setCursor(info);
                  manager.updateCursor(active.id, info);
                }}
              />
            </section>
            {state.mode === "split" && (
              <div
                className="resizer split-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label={t("调整分栏宽度")}
                onPointerDown={beginSplitResize}
              />
            )}
            <section
              className="pane"
              hidden={
                state.mode === "source" || state.mode === "wysiwyg" || state.mode === "git"
              }
              aria-label={t("渲染预览")}
            >
              <PreviewPane
                document={active}
                enabled={state.mode === "split" || state.mode === "preview"}
                compileSignal={compileSignal}
                diff={previewDiff}
                onDiffModeChange={(mode) => updateDiffOption(active.id, { mode })}
                onDiffJump={(line) => {
                  if (state.mode === "preview") manager.setMode("source");
                  jumpTokenRef.current += 1;
                  setSourceJump({ line, column: 1, token: jumpTokenRef.current });
                }}
              />
            </section>
            <section
              className="pane git-pane"
              hidden={state.mode !== "git"}
              aria-label={t("Git 差异")}
            >
              <GitPane
                key={active.id}
                document={active}
                active={state.mode === "git"}
              />
            </section>
          </main>
        ) : (
          <main className="empty-state">
            <PandaMark size={64} className="brand-mark-large" />
            <h1>{t("打开一个文档开始编辑")}</h1>
            <p>{t("源码与渲染结果实时同步，保存时保留原文件编码与换行符。")}</p>
            <div className="empty-actions">
              <button type="button" className="button primary" onClick={() => manager.newDocument()}>
                {t("新建文档")}
              </button>
              <button type="button" className="button" onClick={() => void manager.openFiles()}>
                {t("打开文件")}
              </button>
            </div>
            <div className="welcome-shortcuts">
              <div className="welcome-shortcut">
                <kbd>Ctrl+Shift+P</kbd>
                <span>{t("命令面板")}</span>
              </div>
              <div className="welcome-shortcut">
                <kbd>Ctrl+O</kbd>
                <span>{t("打开文件")}</span>
              </div>
              <div className="welcome-shortcut">
                <kbd>Ctrl+S</kbd>
                <span>{t("保存")}</span>
              </div>
              <div className="welcome-shortcut">
                <kbd>Ctrl+F</kbd>
                <span>{t("查找")}</span>
              </div>
            </div>
            {recent.length > 0 && (
              <div className="recent">
                <div className="recent-header">
                  <h2>{t("最近文件")}</h2>
                  <button
                    type="button"
                    className="button small ghost"
                    aria-label={t("删除所有最近文件")}
                    onClick={() => {
                      void window.panda.recent.clear().then(setRecent);
                    }}
                  >
                    {t("删除所有")}
                  </button>
                </div>
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
                      <button
                        type="button"
                        className="icon-button recent-remove"
                        aria-label={t("从最近文件移除 {0}", entry.name)}
                        title={t("从最近文件移除")}
                        onClick={() => {
                          void window.panda.recent.remove({ path: entry.path }).then(setRecent);
                        }}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </main>
        )}

        {problemsOpen && (
          <ProblemPanel
            problems={problems}
            onSelect={jumpToProblem}
            onClose={() => setProblemsOpen(false)}
          />
        )}
        </div>
      </div>

      <footer className="statusbar">
        <span className="statusbar-name">{active?.path ?? t("就绪")}</span>
        {active && (
          <span className="statusbar-meta">
            {t(ENCODING_LABELS[active.encoding] ?? active.encoding)}
            {" · "}
            {active.eol.toUpperCase()}
            {active.bom ? " · BOM" : ""}
            {active.readOnly ? t(" · 只读") : ""}
            {" · "}
            {active.format}
          </span>
        )}
        <span className="statusbar-spacer" />
        {active && (
          <span className="statusbar-meta">
            {formatSize(active.size)}
            {" · "}
            {state.mode === "wysiwyg"
              ? t("所见即所得")
              : t("行 {0}，列 {1}", cursor.line, cursor.column)}
            {active.dirty ? t(" · 未保存") : t(" · 已保存")}
          </span>
        )}
        <span className="statusbar-meta">
          {workspace.roots.length === 0
            ? t("无工作区")
            : workspace.roots.length === 1
              ? (workspace.roots[0]?.root.name ?? t("无工作区"))
              : t("{0} 个工作区", workspace.roots.length)}
        </span>
        <DiffControls
          enabled={diffEnabled}
          state={diffState}
          items={diffItems}
          currentIndex={diffIndex}
          disabled={!active}
          dirty={active?.dirty ?? false}
          mode={diffMode}
          modeAvailable={state.mode !== "wysiwyg"}
          onToggle={() => updateDiffOption(activeId, { enabled: !diffEnabled })}
          onModeChange={(mode) => updateDiffOption(activeId, { mode })}
          onRefresh={() => setDiffRefresh((value) => value + 1)}
          onPrev={() => navigateDiff(-1)}
          onNext={() => navigateDiff(1)}
          onJump={(index) => {
            const line = diffAnchors[index];
            if (line === undefined) return;
            setDiffIndex(index);
            revealDiffAt(line);
          }}
        />
        <button
          type="button"
          className={perfVisible ? "statusbar-button active" : "statusbar-button"}
          aria-label={t("性能浮层")}
          aria-pressed={perfVisible}
          title={t("性能浮层")}
          onClick={() => setPerfVisible((value) => !value)}
        >
          {t("性能")}
        </button>
        {(problems.length > 0 || problemsOpen) && (
          <button
            type="button"
            className={problemsOpen ? "statusbar-button active" : "statusbar-button"}
            aria-label={t("问题面板")}
            aria-expanded={problemsOpen}
            onClick={() => setProblemsOpen((value) => !value)}
          >
            {t("错误 {0} · 警告 {1}", errorCount, warningCount)}
          </button>
        )}
      </footer>

      <CommandPalette
        open={paletteOpen}
        commands={paletteCommands}
        onClose={() => setPaletteOpen(false)}
        onRun={async (command) => {
          try {
            await command.run();
          } catch (reason) {
            manager.showNotice("error", describeError(reason));
          }
        }}
      />

      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={(patch) => {
          const next = patch as Settings;
          const gitCommandChanged = next.git.command !== settings.git.command;
          manager.setAutoSave(next.editor.autoSave);
          manager.setSaveEol(next.editor.eol);
          void settingsStore.update(next).then(() => {
            if (!gitCommandChanged) return;
            // Git 命令变更后重新尝试 Git 基线，而不是停留在「上次保存」。
            const id = activeRef.current?.id;
            if (id) updateDiffOption(id, { base: "head" });
            setDiffRefresh((value) => value + 1);
          });
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

      {perfVisible && <PerformanceOverlay onClose={() => setPerfVisible(false)} />}
    </div>
  );
}
