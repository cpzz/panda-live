import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import type { EditorState } from "@codemirror/state";
import { renderMarkdownToHtml } from "../formats/markdown/preview";
import { parseMarkdown } from "../formats/markdown/parse";
import { buildOutline, formatSupportsOutline, type OutlineItem } from "../formats/outline";
import { EMPTY_PROBLEMS, problemStore, type Problem } from "../services/problem-store";
import { mathOptionsSignature } from "../services/math-settings";
import { formatHasPreview, getFormatEntry, refreshExtensionFormats } from "../extensions/registry";
import { sanitizeHtml } from "../render/html";
import { RenderedMarkdown } from "./RenderedMarkdown";
import {
  DocumentManager,
  type DocumentState,
  type EditorMode,
} from "../services/document-manager";
import { settingsStore } from "../services/settings-store";
import { GitStore } from "../services/git-store";
import type { SearchMode, SearchOptions, SearchRequest } from "../services/search";
import { WorkspaceStore } from "../services/workspace-store";
import { SourceEditor, type DiffLineMarker, type SelectionInfo, type SourceLanguage } from "../source/codemirror";
import { sourceLanguageForFormat } from "../source/language";
import { renderMathml } from "../render/math/mathml";
import {
  applyDiagramMemoryLimit,
  currentDiagramTheme,
  getDiagramService,
  onDiagramThemeChange,
} from "../render/diagram";
import type { DraftEntry, RecentEntry, SessionState } from "../shared/ipc";
import type { CompileResult, EngineStatus } from "../shared/ipc";
import type { Settings } from "../shared/settings";
import { describeError, getErrorCode } from "../shared/errors";
import { pathKey } from "../utils/paths";
import { getLocale, localeTag, resolveLocale, setLocale, t } from "../i18n";
import { RecoveryDialog } from "./RecoveryDialog";
import { CommandPalette, type CommandItem } from "./CommandPalette";
import { DiffControls, type DiffListItem } from "./DiffControls";
import { diffLineMarkers, describeHunk, useDocumentDiff } from "./useDocumentDiff";
import { hunkAnchorLine, type DiffHunk } from "../diff/compute";
import type { PreviewDiffModel } from "../diff/preview";
import { DEFAULT_DOC_DIFF, type DiffViewMode, type DocDiffState } from "../shared/diff";
import { scrollElementToRatio } from "../shared/scroll";
import { Icon, PandaMark, fileIconForPath, type IconName } from "./icons";
import { OutlinePanel } from "./OutlinePanel";
import { PdfPreview, PdfDocumentPreview } from "./PdfPreview";
import {
  DiagramZoomToolbar,
  DiagramViewerDialog,
  clampDiagramZoom,
  diagramViewerWidth,
  useDiagramZoomShortcuts,
} from "./DiagramViewerDialog";
import { svgNaturalWidth } from "../render/diagram/sanitize";
import { DIAGRAM_OPEN_EVENT } from "../render/markdown/diagram-preview";
import { PerformanceOverlay } from "./PerformanceOverlay";
import { ProblemPanel } from "./ProblemPanel";
import { SettingsDialog } from "./SettingsDialog";
import { WorkspacePanel } from "./WorkspacePanel";
import { GitPanel } from "./GitPanel";
import { WysiwygPane } from "./WysiwygPane";
import { GitPane } from "./GitPane";
import { PreviewSearchPanel } from "./PreviewSearchPanel";

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

/** 通知类型与重要级别的显示文案。 */
const NOTICE_KIND_LABELS = { info: "信息", error: "错误" } as const;
const NOTICE_LEVEL_LABELS = {
  low: { zh: "低", en: "Low" },
  medium: { zh: "中", en: "Medium" },
  high: { zh: "高", en: "High" },
} as const;

/** macOS 使用 Cmd+F；系统占用 Cmd+H，替换只通过面板与命令面板进入。 */
const IS_MAC = typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");

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

/** 通知历史里的时间列：只显示时分秒。 */
function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(localeTag(), { hour12: false });
}

const EMPTY_DIFF_HUNKS: DiffHunk[] = [];

/** 预览面板滚动位置记忆：key = document.id；tab 切换时恢复。 */
const previewScrollMem = new Map<string, number>();

/** 计算文本行数；末尾换行不额外计入一行，与 diff 的行号口径一致。 */
function textLineCount(text: string): number {
  if (!text) return 1;
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  return normalized.split("\n").length;
}

/** 判断路径是否位于指定目录内（跨 Windows/POSIX 分隔符）。 */
function isPathUnder(filePath: string, root: string): boolean {
  const normalizedRoot = root.replace(/[\\/]+$/u, "");
  return (
    filePath === normalizedRoot ||
    filePath.startsWith(`${normalizedRoot}\\`) ||
    filePath.startsWith(`${normalizedRoot}/`)
  );
}

interface SavedEditorState {
  state: EditorState;
  revision: number;
  language: SourceLanguage;
}

/** 内容宽度与滑块刻度的旧实现已移除；图表/图片缩放快捷键见 useDiagramZoomShortcuts。 */

function SourcePane({
  document,
  mode,
  searchRequest,
  jump,
  tabSize,
  insertSpaces,
  showLineNumbers,
  diffMarkers,
  onChange,
  onSelection,
  onFolds,
}: {
  document: DocumentState;
  mode: EditorMode;
  searchRequest: SearchRequest | null;
  jump: { line: number; column: number; token: number; ratio?: number } | null;
  tabSize: number;
  /** Tab 键输出空格（false = 硬制表符）。 */
  insertSpaces: boolean;
  showLineNumbers: boolean;
  diffMarkers: readonly DiffLineMarker[];
  onChange(content: string): void;
  onSelection(info: SelectionInfo): void;
  onFolds(lines: number[]): void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<SourceEditor | null>(null);
  const savedRef = useRef(new Map<string, SavedEditorState>());
  const cursorRef = useRef(document.cursor);
  cursorRef.current = document.cursor;
  const foldsRef = useRef(document.folds);
  foldsRef.current = document.folds;
  const appliedFoldsRef = useRef<string | null>(null);
  /** 已消费的查找请求 token；模式切换不应重放旧请求。 */
  const handledSearchRef = useRef(0);
  /** 上一次编辑模式；切换模式时关闭源码查找面板。 */
  const previousModeRef = useRef(mode);

  /** 把已保存的折叠行应用到编辑器（创建或切换标签重建时）。 */
  const applySavedFolds = (): void => {
    const editor = editorRef.current;
    const folds = foldsRef.current;
    if (!editor || !folds || folds.length === 0) return;
    appliedFoldsRef.current = folds.join(",");
    editor.setFolds(folds);
  };
  const lastRef = useRef<{
    id: string;
    revision: number;
    mode: EditorMode;
    language: SourceLanguage;
  } | null>(null);
  const callbacksRef = useRef({ onChange, onSelection, onFolds });
  callbacksRef.current = { onChange, onSelection, onFolds };
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

  // 会话恢复：折叠数据可能在编辑器创建后经 patchDocument 才到位，单独响应。
  useEffect(() => {
    const folds = document.folds;
    if (!folds || folds.length === 0) return;
    const key = folds.join(",");
    if (appliedFoldsRef.current === key || !editorRef.current) return;
    appliedFoldsRef.current = key;
    editorRef.current.setFolds(folds);
  }, [document.folds]);

  // 设置变更即时应用到现有编辑器。
  useEffect(() => {
    editorRef.current?.setTabSize(tabSize);
  }, [tabSize]);

  useEffect(() => {
    editorRef.current?.setInsertSpaces(insertSpaces);
  }, [insertSpaces]);

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

  // 跳转行浮层：Esc 取消，不需要额外的取消按钮。
  useEffect(() => {
    if (!gotoOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setGotoOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [gotoOpen]);

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
        insertSpaces,
        showLineNumbers,
        onChange: (content) => callbacksRef.current.onChange(content),
        onSelection: (info) => callbacksRef.current.onSelection(info),
        onFolds: (lines) => callbacksRef.current.onFolds(lines),
      });
      editorRef.current = editor;
      if (cursorRef.current) editor.setCursor(cursorRef.current);
      applySavedFolds();
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
          // 模式切换会重建状态；重建后恢复最近的折叠范围，避免折叠丢失。
          applySavedFolds();
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
        // 模式切换/外部重载会重建状态；重建后恢复折叠范围，避免折叠丢失。
        applySavedFolds();
      }
    }
    lastRef.current = { id: document.id, revision: document.revision, mode, language };
    editor.setDiffMarkers(diffMarkersRef.current);
    // 只响应标签切换、模式切换、外部重载与只读变化；普通输入由编辑器自身维护。
  }, [document.id, document.revision, document.readOnly, mode, language, document.content]);

  // 大纲/问题跳转：放在编辑器创建与 reset 之后，避免 preview→source 切换时
  // 模式切换触发的 state 重建把刚设置的光标/滚动位置清掉。带 ratio 时把目标行放到视口指定高度。
  // 限定源码类模式：切到 preview 时不重放旧跳转，也不抢焦点到隐藏的编辑器。
  useEffect(() => {
    if (!jump || (mode !== "source" && mode !== "split")) return;
    if (jump.ratio !== undefined) {
      editorRef.current?.setCursorAtRatio(
        { line: jump.line, column: jump.column },
        jump.ratio,
      );
      return;
    }
    editorRef.current?.setCursor({ line: jump.line, column: jump.column });
  }, [jump, mode]);

  // 切换编辑模式时关闭源码查找面板；若新请求随后到达会重新打开。
  useEffect(() => {
    if (previousModeRef.current === mode) return;
    previousModeRef.current = mode;
    editorRef.current?.closeSearch();
  }, [mode]);

  // 查找请求在编辑器创建之后处理，避免首次挂载时 editorRef 尚未赋值。
  useEffect(() => {
    if (!searchRequest) {
      editorRef.current?.closeSearch();
      return;
    }
    if (searchRequest.token === handledSearchRef.current) return;
    handledSearchRef.current = searchRequest.token;
    // 请求只在发起它的编辑模式生效，避免切换模式后重放。
    if (
      searchRequest.editorMode &&
      searchRequest.editorMode !== "source" &&
      searchRequest.editorMode !== "split"
    ) {
      return;
    }
    // 分栏模式下请求可能指向右侧预览，源码面板关闭自身并交给预览。
    if (searchRequest.surface === "preview") {
      editorRef.current?.closeSearch();
      return;
    }
    if (mode === "wysiwyg" || mode === "preview" || mode === "git") return;
    editorRef.current?.openSearch(
      searchRequest.mode,
      searchRequest.seed,
      searchRequest.replacement,
      searchRequest.options,
    );
  }, [searchRequest, mode]);

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
          />
          <button type="submit" className="button small">
            {t("跳转")}
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
  // 独立图表预览的缩放：会话级，不落盘；100% = 自然尺寸。
  // 适配宽度为一次性动作；首图渲染后按全局设置自动适配一次，之后缩放自由。
  const bodyRef = useRef<HTMLDivElement>(null);
  const fittedRef = useRef<string | null>(null);
  const [zoom, setZoom] = useState(100);
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

  const natural = useMemo(() => (svg ? svgNaturalWidth(svg) : 0), [svg]);
  // 图表/图片缩放快捷键：仅在支持缩放的显示里生效。
  useDiagramZoomShortcuts(zoom, setZoom);

  /** 适配宽度：按视口可用宽度与自然宽度计算缩放比（≤100%）。 */
  const applyFit = useCallback((): void => {
    const body = bodyRef.current;
    if (!body || natural <= 0) return;
    const style = getComputedStyle(body);
    const available =
      body.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
    if (!(available > 0)) return;
    setZoom(clampDiagramZoom(Math.min(100, Math.round((available / natural) * 100))));
  }, [natural]);

  // 每个文档首图渲染后按「设置 → 外观 → 图表适配宽度」自动适配一次。
  useEffect(() => {
    if (fittedRef.current === document.id || natural <= 0) return;
    fittedRef.current = document.id;
    if (settingsStore.getState().appearance.diagramFitWidth) applyFit();
  }, [document.id, natural, applyFit]);

  const width = natural > 0 ? diagramViewerWidth(natural, zoom) : undefined;

  return (
    <div className="preview-pane diagram-pane">
      {error ? (
        <p className="placeholder">{t("图表诊断：{0}", error)}</p>
      ) : (
        <div className="diagram-viewer">
          <DiagramZoomToolbar zoom={zoom} onZoomChange={setZoom} onFit={applyFit} />
          <div className="diagram-viewer-body" ref={bodyRef}>
            <div
              className="diagram-viewer-sizing"
              style={width ? { width } : undefined}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** SVG 源码 → data URL：在 `<img>` 中渲染，脚本与内部样式不会进入应用文档。 */
function svgDataUrl(source: string): string {
  const bytes = new TextEncoder().encode(source);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x2000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x2000));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/** SVG 文档预览：源码按 XML 编辑，预览用隔离的图片视图渲染。 */
function SvgPreviewPane({ document, enabled }: { document: DocumentState; enabled: boolean }) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);
  const bodyRef = useRef<HTMLDivElement>(null);
  const fittedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => {
      if (!document.content.trim()) {
        setSrc("");
        setError(t("SVG 内容为空"));
        return;
      }
      setSrc(svgDataUrl(document.content));
      setError(null);
    }, 150);
    return () => clearTimeout(timer);
  }, [document.content, enabled]);

  const natural = useMemo(
    () => (document.content.trim() ? svgNaturalWidth(document.content) : 0),
    [document.content],
  );
  // 图片视图缩放快捷键：仅在支持缩放的显示里生效。
  useDiagramZoomShortcuts(zoom, setZoom);

  /** 适配宽度：按视口可用宽度与 SVG 自然宽度计算缩放比（≤100%）。 */
  const applyFit = useCallback((): void => {
    const body = bodyRef.current;
    if (!body || natural <= 0) return;
    const style = getComputedStyle(body);
    const available =
      body.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
    if (!(available > 0)) return;
    setZoom(clampDiagramZoom(Math.min(100, Math.round((available / natural) * 100))));
  }, [natural]);

  // 每个文档首次渲染后按「设置 → 外观 → 图表适配宽度」自动适配一次。
  useEffect(() => {
    if (fittedRef.current === document.id || natural <= 0) return;
    fittedRef.current = document.id;
    if (settingsStore.getState().appearance.diagramFitWidth) applyFit();
  }, [document.id, natural, applyFit]);

  const width = natural > 0 ? diagramViewerWidth(natural, zoom) : undefined;

  return (
    <div className="preview-pane diagram-pane">
      {error ? (
        <p className="placeholder">{t("图表诊断：{0}", error)}</p>
      ) : (
        <div className="diagram-viewer">
          <DiagramZoomToolbar zoom={zoom} onZoomChange={setZoom} onFit={applyFit} />
          <div className="diagram-viewer-body" ref={bodyRef}>
            <div className="diagram-viewer-sizing" style={width ? { width } : undefined}>
              {src ? (
                <img src={src} alt={document.name} onError={() => setError(t("SVG 解析失败"))} />
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 图片文件预览：readBase64 读取磁盘字节，缩放/适配与图表视图共用同一工具栏。 */
function ImagePreviewPane({ document }: { document: DocumentState }) {
  const [src, setSrc] = useState("");
  const [natural, setNatural] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);
  const bodyRef = useRef<HTMLDivElement>(null);
  const path = document.path;

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setSrc("");
    setNatural(0);
    setError(null);
    void (async () => {
      try {
        const file = await window.panda.fs.readBase64({ path });
        if (cancelled) return;
        setSrc(`data:${file.mime};base64,${file.data}`);
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, document.mtimeMs]);

  /** 适配宽度：按视口可用宽度与图片自然宽度计算缩放比（≤100%）。 */
  const applyFit = useCallback((): void => {
    const body = bodyRef.current;
    if (!body || natural <= 0) return;
    const style = getComputedStyle(body);
    const available =
      body.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
    if (!(available > 0)) return;
    setZoom(clampDiagramZoom(Math.min(100, Math.round((available / natural) * 100))));
  }, [natural]);

  // 每个文档加载后按「设置 → 外观 → 图表适配宽度」自动适配一次；后续缩放由用户控制。
  useEffect(() => {
    if (natural <= 0) return;
    if (settingsStore.getState().appearance.diagramFitWidth) applyFit();
  }, [natural, applyFit]);

  const width = natural > 0 ? diagramViewerWidth(natural, zoom) : undefined;
  // 图片缩放快捷键：仅在支持缩放的显示里生效。
  useDiagramZoomShortcuts(zoom, setZoom);

  return (
    <div className="preview-pane diagram-pane">
      {error ? (
        <p className="placeholder">{t("图片加载失败：{0}", error)}</p>
      ) : (
        <div className="diagram-viewer">
          <DiagramZoomToolbar zoom={zoom} onZoomChange={setZoom} onFit={applyFit} />
          <div className="diagram-viewer-body" ref={bodyRef}>
            <div className="diagram-viewer-sizing" style={width ? { width } : undefined}>
              <img
                src={src}
                alt={document.name}
                onLoad={(event) => setNatural(event.currentTarget.naturalWidth)}
              />
            </div>
          </div>
        </div>
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

  // 稳定 source 引用：避免父组件重渲染时 PdfPreview 反复销毁重载。
  const texSource = useMemo(
    () => (result && result.ok && result.pdfKey ? { url: `panda-pdf://${result.pdfKey}` } : null),
    [result],
  );

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
      {texSource ? <PdfPreview source={texSource} /> : null}
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
  mathKey,
  searchRequest,
  onDiffModeChange,
  onDiffJump,
  onOpenLocalFile,
}: {
  document: DocumentState;
  enabled: boolean;
  compileSignal: number;
  diff: PreviewDiffModel | null;
  /** 数学设置签名（宏 + 单美元）；变化时用新设置重渲染预览。 */
  mathKey: string;
  /** 仅预览模式传入；查找只读渲染结果。 */
  searchRequest: SearchRequest | null;
  onDiffModeChange(mode: DiffViewMode): void;
  onDiffJump(line: number): void;
  onOpenLocalFile?: (path: string) => void;
}) {
  const [html, setHtml] = useState("");
  const [error, setError] = useState<string | null>(null);
  const searchHostRef = useRef<HTMLDivElement>(null);
  const supported = document.format === "markdown";
  const annotate = diff !== null;

  // tab 切换恢复预览滚动位置：从 previewScrollMem 恢复；新文件没有记忆，从 0 开始。
  // 只在 document.id / enabled 变化时触发，不跟随 html（html 变化时 DOM 节点可能已替换，
  // 强行设旧 scrollTop 会跳错位置；让浏览器自己滚动更安全）。
  useEffect(() => {
    const host = searchHostRef.current;
    if (!host) return;
    const saved = previewScrollMem.get(document.id);
    if (saved != null) {
      requestAnimationFrame(() => {
        host.scrollTop = saved;
      });
    }
    return () => {
      previewScrollMem.set(document.id, host.scrollTop);
    };
  }, [document.id, enabled]);

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
  }, [document.content, supported, enabled, annotate, mathKey]);

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
  if (document.format === "svg") {
    return <SvgPreviewPane key={document.id} document={document} enabled={enabled} />;
  }
  if (!supported) {
    return (
      <div className="preview-pane">
        <p className="placeholder">{t("该格式暂不支持渲染预览")}</p>
      </div>
    );
  }

  return (
    <div className="preview-wrap">
      <PreviewSearchPanel
        containerRef={searchHostRef}
        request={searchRequest}
        contentKey={html}
      />
      <div className="preview-pane" ref={searchHostRef}>
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
            onOpenLocalFile={onOpenLocalFile}
          />
        )}
      </div>
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
  const gitRef = useRef<GitStore | null>(null);
  if (!gitRef.current) gitRef.current = new GitStore();
  const git = gitRef.current;

  const state = useSyncExternalStore(manager.subscribe, manager.getState);
  const settings = useSyncExternalStore(settingsStore.subscribe, settingsStore.getState);
  const workspace = useSyncExternalStore(workspaces.subscribe, workspaces.getState);
  const gitState = useSyncExternalStore(git.subscribe, git.getState);

  // 界面语言在父组件渲染前写入全局，子组件直接调用 t() 即可拿到当前语言。
  useMemo(() => {
    const resolved = resolveLocale(settings.appearance.language, navigator.language);
    setLocale(resolved);
    if (typeof document !== "undefined") {
      document.documentElement.lang = resolved === "zh" ? "zh-CN" : "en";
    }
  }, [settings.appearance.language]);

  // 图表内存缓存上限跟随设置即时生效（服务已创建时调整容量）。
  useEffect(() => {
    applyDiagramMemoryLimit();
  }, [settings.diagram.memoryCacheLimit]);

  const [cursor, setCursor] = useState<SelectionInfo>({ line: 1, column: 1 });
  const [searchRequest, setSearchRequest] = useState<SearchRequest | null>(null);
  /** 查找面板最近一次的用户输入，用于切换模式后沿用。 */
  const searchActiveRef = useRef(false);
  const searchTermRef = useRef("");
  const searchReplacementRef = useRef("");
  const searchKindRef = useRef<SearchMode>("find");
  const searchOptionsRef = useRef<SearchOptions>({
    caseSensitive: false,
    regex: false,
    wholeWord: false,
  });
  /** 分栏模式下最近一次点击的编辑面板。 */
  const searchSurfaceRef = useRef<"source" | "preview">("source");
  const requestSearch = useCallback(
    (mode: SearchMode): void => {
      const editorMode = manager.getState().mode;
      const focused = window.document.activeElement;
      const insidePanel =
        focused instanceof Element &&
        focused.closest(".search-panel, .source-search-panel, .preview-search-panel") !== null;
      // 选中文本优先；没有选区时沿用已打开面板里的查找词。
      const selected = insidePanel ? "" : (window.getSelection()?.toString() ?? "").trim();
      const seed =
        selected.length > 0 && selected.length <= 100 && !/[\r\n]/.test(selected)
          ? selected
          : undefined;
      const activeDoc = manager
        .getState()
        .documents.find((doc) => doc.id === manager.getState().activeId);
      const previewAvailable = activeDoc?.format === "markdown";
      const surface =
        editorMode === "wysiwyg"
          ? "wysiwyg"
          : editorMode === "preview"
            ? "preview"
            : editorMode === "split"
              ? previewAvailable
                ? searchSurfaceRef.current
                : "source"
              : "source";
      const panel = window.document.querySelector(
        surface === "preview"
          ? ".preview-search-panel"
          : surface === "wysiwyg"
            ? ".search-panel"
            : ".source-search-panel",
      );
      const openFind = panel?.querySelector<HTMLInputElement>(
        'input[aria-label="查找内容"], input[name="search"]',
      );
      const openReplace = panel?.querySelector<HTMLInputElement>(
        'input[aria-label="替换内容"], input[name="replace"]',
      );
      const term = seed ?? openFind?.value ?? searchTermRef.current;
      // 收起替换行时输入框不在 DOM 中，沿用上一次的替换文本。
      const replacement = openReplace ? openReplace.value : searchReplacementRef.current;
      const options: SearchOptions = { ...searchOptionsRef.current };
      panel?.querySelectorAll<HTMLButtonElement>("button.find-toggle[aria-pressed]").forEach((button) => {
        const text = button.textContent?.trim();
        const pressed = button.getAttribute("aria-pressed") === "true";
        if (text === "Aa") options.caseSensitive = pressed;
        else if (text === ".*") options.regex = pressed;
        else if (text === "ab") options.wholeWord = pressed;
      });
      searchOptionsRef.current = options;
      searchActiveRef.current = true;
      searchKindRef.current = mode;
      searchTermRef.current = term;
      searchReplacementRef.current = replacement;
      setSearchRequest((current) => ({
        mode,
        token: (current?.token ?? 0) + 1,
        editorMode,
        surface,
        seed: term || undefined,
        replacement,
        options,
      }));
    },
    [manager],
  );
  // 记录面板内的输入，切换模式时沿用；Esc 表示用户主动关闭，不再自动重开。
  useEffect(() => {
    const onInput = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.name === "search" || target.getAttribute("aria-label") === "查找内容") {
        searchTermRef.current = target.value;
      } else if (target.name === "replace" || target.getAttribute("aria-label") === "替换内容") {
        searchReplacementRef.current = target.value;
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") searchActiveRef.current = false;
    };
    const onClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      // 点击展开/收起或选项时同步持久状态；capture 阶段读取点击前的 aria 值。
      const expand = target.closest("button.find-toggle[aria-expanded]");
      if (expand) {
        searchKindRef.current =
          expand.getAttribute("aria-expanded") === "true" ? "find" : "replace";
      }
      const option = target.closest("button.find-toggle[aria-pressed]");
      if (option) {
        const glyph = option.textContent?.trim();
        const next = option.getAttribute("aria-pressed") !== "true";
        if (glyph === "Aa") {
          searchOptionsRef.current = { ...searchOptionsRef.current, caseSensitive: next };
        } else if (glyph === ".*") {
          searchOptionsRef.current = { ...searchOptionsRef.current, regex: next };
        } else if (glyph === "ab") {
          searchOptionsRef.current = { ...searchOptionsRef.current, wholeWord: next };
        }
      }
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".preview-wrap, .preview-pane")) searchSurfaceRef.current = "preview";
      else if (target.closest(".source-pane, .wysiwyg-pane")) searchSurfaceRef.current = "source";
    };
    window.addEventListener("input", onInput, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("input", onInput, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);
  // 切换编辑模式或标签时保持查找面板：在新目标中按上一次的查找词/替换词重开。
  const previousSearchTargetRef = useRef({ mode: state.mode, id: state.activeId });
  useEffect(() => {
    const previous = previousSearchTargetRef.current;
    const changed = previous.mode !== state.mode || previous.id !== state.activeId;
    previousSearchTargetRef.current = { mode: state.mode, id: state.activeId };
    if (!changed || !searchActiveRef.current) return;
    const activeDoc = manager.getState().documents.find((doc) => doc.id === state.activeId);
    if (
      !activeDoc ||
      activeDoc.format === "pdf" ||
      activeDoc.format === "image" ||
      ((state.mode === "wysiwyg" || state.mode === "preview") && activeDoc.format !== "markdown")
    ) {
      searchActiveRef.current = false;
      setSearchRequest(null);
      return;
    }
    if (state.mode === "git") {
      searchActiveRef.current = false;
      setSearchRequest(null);
      return;
    }
    const surface =
      state.mode === "wysiwyg"
        ? "wysiwyg"
        : state.mode === "preview"
          ? "preview"
          : state.mode === "split"
            ? activeDoc.format === "markdown"
              ? searchSurfaceRef.current
              : "source"
            : "source";
    setSearchRequest((current) => ({
      mode: searchKindRef.current,
      token: (current?.token ?? 0) + 1,
      editorMode: state.mode,
      surface,
      seed: searchTermRef.current.trim() || undefined,
      replacement: searchReplacementRef.current,
      options: searchOptionsRef.current,
    }));
  }, [state.mode, state.activeId, manager]);
  const openSourceControl = useCallback((): void => {
    workspaces.setVisible(true);
    setSidebarTabRequest((current) => ({
      tab: "source-control",
      token: (current?.token ?? 0) + 1,
    }));
  }, [workspaces]);
  const [compileSignal, setCompileSignal] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 模式条左侧的块级工具栏挂载点；由 React 回调 ref 写入。 */
  const [modeToolbarHost, setModeToolbarHost] = useState<HTMLDivElement | null>(null);
  /** git 模式下模式条左侧的 Git 工具区挂载点；GitPane 通过 portal 渲染到这里。 */
  const [gitToolbarHost, setGitToolbarHost] = useState<HTMLDivElement | null>(null);
  /** 进入 Git 差异前的模式，用于工具栏按钮切回。 */
  const modeBeforeGitRef = useRef<EditorMode>("source");
  // 「放大查看」对话框：承载内嵌图表块的放大视图；svg 已由图表服务消毒。
  const [diagramViewer, setDiagramViewer] = useState<{ svg: string; title: string } | null>(null);
  const [recoveries, setRecoveries] = useState<DraftEntry[]>([]);
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [perfVisible, setPerfVisible] = useState(false);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** 模式条导出下拉（仅 Markdown：HTML / PDF）。 */
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  /** 状态栏通知历史浮层。 */
  const [noticesOpen, setNoticesOpen] = useState(false);
  const [extensionCommands, setExtensionCommands] = useState<CommandItem[]>([]);
  const [tabsOverflow, setTabsOverflow] = useState(false);
  const [canScrollTabs, setCanScrollTabs] = useState<{ left: boolean; right: boolean }>({
    left: false,
    right: false,
  });
  const [tabMenu, setTabMenu] = useState<{ top: number; right: number } | null>(null);
  /** 标签右键菜单：固定/取消固定单个标签。 */
  const [tabContextMenu, setTabContextMenu] = useState<{ top: number; left: number; docId: string } | null>(
    null,
  );
  const [sidebarTabRequest, setSidebarTabRequest] = useState<{
    tab: "source-control";
    token: number;
  } | null>(null);
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
  const tabScrollRef = useRef<HTMLDivElement>(null);
  const tabItemsRef = useRef<HTMLDivElement>(null);
  const tabMenuButtonRef = useRef<HTMLButtonElement>(null);
  const exportWrapRef = useRef<HTMLDivElement>(null);
  const problemsState = useSyncExternalStore(problemStore.subscribe, problemStore.getState);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [sourceJump, setSourceJump] = useState<{
    line: number;
    column: number;
    token: number;
    ratio?: number;
  } | null>(
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
  // PDF 是二进制只读文档：所有编辑/预览面板隐藏，由专用 PDF 面板展示。
  const activeIsPdf = active?.format === "pdf";
  // 图片同理：二进制只读，由专用图片面板展示。
  const activeIsImage = active?.format === "image";
  const activeIsBinary = activeIsPdf || activeIsImage;
  const activeRef = useRef(active);
  activeRef.current = active;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // 内嵌图表块（预览与 WYSIWYG）通过窗口事件请求打开放大查看对话框。
  useEffect(() => {
    const onOpen = (event: Event): void => {
      const svg = (event as CustomEvent<{ svg?: string }>).detail?.svg;
      if (!svg) return;
      setDiagramViewer({ svg, title: activeRef.current?.name ?? "" });
    };
    window.addEventListener(DIAGRAM_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(DIAGRAM_OPEN_EVENT, onOpen);
  }, []);

  const conflict = state.conflict;
  const activeContent = active?.content ?? "";
  const activeFormat = active?.format ?? "";
  const activeId = active?.id ?? "";
  // 模式条：所有文本格式都显示（含只有「源码」的代码文件）；二进制由专用只读面板展示。
  // git 模式下同一栏左侧显示 Git 工具，右侧显示模式按钮 + git 按钮。见 §21.15。
  const modeBarVisible = Boolean(active) && !activeIsBinary;
  const modeBarModes: EditorMode[] =
    active?.format === "markdown"
      ? ["wysiwyg", "source", "split", "preview"]
      : formatHasPreview(activeFormat)
        ? ["source", "split", "preview"]
        : ["source"];
  const showModeBarDivider =
    modeBarVisible && state.mode === "wysiwyg" && active?.format === "markdown" && !active.readOnly;
  // 模式条导出入口：Markdown 为 HTML / PDF 下拉，PlantUML / Mermaid 直接导出 SVG。
  const exportAsMarkdown = active?.format === "markdown";
  const exportAsDiagram = active?.format === "plantuml" || active?.format === "mermaid";
  const showExportButton =
    modeBarVisible && state.mode !== "git" && (exportAsMarkdown || exportAsDiagram);

  // 源代码管理：默认跟随当前文件所在仓库，也可在多根工作区中手动切换。
  const [gitRepoChoice, setGitRepoChoice] = useState<string | null>(null);
  const gitActiveDir = active?.path ? active.path.replace(/[\\/][^\\/]+$/u, "") : null;
  const gitRepoOptions = useMemo(() => {
    const options = workspace.roots.map((entry) => ({
      path: entry.root.path,
      name: entry.root.name,
      probe: entry.root.path,
    }));
    if (!gitActiveDir) return options;
    const owner = options.find((option) => isPathUnder(gitActiveDir, option.path));
    if (owner) {
      return options.map((option) =>
        option.path === owner.path ? { ...option, probe: gitActiveDir } : option,
      );
    }
    // 当前文件不在任何工作区根内：把它所在目录作为额外候选。
    const name = gitActiveDir.split(/[\\/]/u).filter(Boolean).pop() ?? gitActiveDir;
    return [{ path: gitActiveDir, name, probe: gitActiveDir }, ...options];
  }, [workspace.roots, gitActiveDir]);
  // 切换文档时回到该文档所属仓库，避免上一个手动选择影响新文件。
  useEffect(() => {
    setGitRepoChoice(null);
  }, [gitActiveDir]);
  const gitRepoSelected = gitRepoOptions.some((option) => option.path === gitRepoChoice)
    ? gitRepoChoice
    : (gitRepoOptions.find((option) => option.probe === gitActiveDir)?.path ??
      gitRepoOptions[0]?.path ??
      null);
  const gitProbePath =
    gitRepoOptions.find((option) => option.path === gitRepoSelected)?.probe ?? null;
  useEffect(() => {
    void git.setPath(gitProbePath);
  }, [git, gitProbePath]);
  /** 打开仓库内文件并进入 GitPane：target 决定「新」侧是工作区还是暂存区。 */
  const openGitFile = (filePath: string, target: "buffer" | "index"): void => {
    void manager.openPath(filePath).then(() => {
      const current = manager.getState();
      const doc = current.documents.find((item) => item.id === current.activeId);
      if (!doc || !doc.path || pathKey(doc.path) !== pathKey(filePath)) return;
      updateDiffOption(doc.id, { base: "head", ref: "", target, paneMode: "baseline" });
      if (doc.format !== "pdf" && doc.format !== "image") {
        if (current.mode !== "git") modeBeforeGitRef.current = current.mode;
        manager.setMode("git");
      }
    });
  };
  /** 打开提交详情中的文件：对比该提交与其父提交（只看这次改动）。 */
  const openCommitFile = (shortHash: string, file: string): void => {
    if (!gitRoot) return;
    const filePath = `${gitRoot.replace(/[\\/]+$/u, "")}/${file}`;
    void manager.openPath(filePath).then(() => {
      const current = manager.getState();
      const doc = current.documents.find((item) => item.id === current.activeId);
      if (!doc || !doc.path || pathKey(doc.path) !== pathKey(filePath)) return;
      updateDiffOption(doc.id, { paneMode: "refs", refA: `${shortHash}^`, refB: shortHash });
      if (doc.format !== "pdf" && doc.format !== "image") {
        if (current.mode !== "git") modeBeforeGitRef.current = current.mode;
        manager.setMode("git");
      }
    });
  };
  /** 打开「比较」视图中的文件：目标是工作区时读磁盘，双提交时对比两个引用。 */
  const openCompareFile = (filePath: string, base: string, target: string | null): void => {
    void manager.openPath(filePath).then(() => {
      const current = manager.getState();
      const doc = current.documents.find((item) => item.id === current.activeId);
      if (!doc || !doc.path || pathKey(doc.path) !== pathKey(filePath)) return;
      if (target) {
        updateDiffOption(doc.id, { paneMode: "refs", refA: base, refB: target });
      } else {
        updateDiffOption(doc.id, {
          paneMode: "baseline",
          base: "commit",
          ref: base,
          target: "worktree",
        });
      }
      if (doc.format !== "pdf" && doc.format !== "image") {
        if (current.mode !== "git") modeBeforeGitRef.current = current.mode;
        manager.setMode("git");
      }
    });
  };
  /** 从 Git 栏打开冲突文件：与其它 Git 入口一致进入差异视图。 */
  const openConflictFile = (filePath: string): void => {
    void manager.openPath(filePath).then(() => {
      const current = manager.getState();
      const doc = current.documents.find((item) => item.id === current.activeId);
      if (!doc || !doc.path || pathKey(doc.path) !== pathKey(filePath)) return;
      updateDiffOption(doc.id, {
        paneMode: "baseline",
        base: "head",
        ref: "",
        target: "worktree",
      });
      if (doc.format !== "pdf" && doc.format !== "image") {
        if (current.mode !== "git") modeBeforeGitRef.current = current.mode;
        manager.setMode("git");
      }
    });
  };
  /** 进入 GitPane（保持当前共享基线）。 */
  const enterGitView = (): void => {
    const current = manager.getState();
    const doc = current.documents.find((item) => item.id === current.activeId);
    if (!doc || doc.format === "pdf" || doc.format === "image") return;
    if (current.mode !== "git") modeBeforeGitRef.current = current.mode;
    manager.setMode("git");
  };
  /** 返回 GitPane 之前的编辑视图。 */
  const leaveGitView = (): void => {
    const target = modeBeforeGitRef.current;
    manager.setMode(
      (target === "split" || target === "preview") && !formatHasPreview(active?.format ?? "")
        ? "source"
        : target,
    );
  };
  // 仓库状态自动刷新：设置决定是否在窗口聚焦时刷新，以及是否定时刷新。见 §22.3。
  useEffect(() => {
    const mode = settings.git.autoRefresh;
    if (mode === "off") return;
    const onFocus = (): void => {
      void git.refresh();
    };
    window.addEventListener("focus", onFocus);
    const intervalMs = mode === "60s" ? 60_000 : mode === "300s" ? 300_000 : 0;
    const timer =
      intervalMs > 0
        ? window.setInterval(() => {
            if (!document.hidden) void git.refresh();
          }, intervalMs)
        : null;
    return () => {
      window.removeEventListener("focus", onFocus);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [git, settings.git.autoRefresh]);

  // 历史分页大小随设置生效；变更后按新页大小重新加载第一页。
  useEffect(() => {
    git.setHistoryPageSize(settings.git.historyPageSize);
  }, [git, settings.git.historyPageSize]);
  // 通知历史浮层：Esc 关闭。
  useEffect(() => {
    if (!noticesOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setNoticesOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [noticesOpen]);
  const gitRoot = gitState.snapshot?.root ?? null;
  const gitDirtyCount = gitRoot ? manager.dirtyCountInRoot(gitRoot) : 0;
  const previousDirtyRef = useRef<Map<string, boolean>>(new Map());
  // 文档从“未保存”变为“已保存”时刷新 Git 状态，覆盖保存/自动保存。
  useEffect(() => {
    let saved = false;
    const next = new Map<string, boolean>();
    for (const doc of state.documents) {
      next.set(doc.id, doc.dirty);
      if (previousDirtyRef.current.get(doc.id) === true && !doc.dirty) saved = true;
    }
    previousDirtyRef.current = next;
    if (saved) void git.refresh();
  }, [state.documents, git]);

  // 渲染态差异：每个文档一份共享状态，驱动状态栏就地标注与 GitPane。见 §21.8.1、§22.9。
  const [diffOptions, setDiffOptions] = useState<Record<string, DocDiffState>>({});
  const [diffIndex, setDiffIndex] = useState(-1);
  const [diffRefresh, setDiffRefresh] = useState(0);
  // Git 写操作成功后刷新已打开的差异视图，避免基线（HEAD/索引）变更后仍显示旧结果。
  useEffect(() => {
    if (gitState.version === 0) return;
    setDiffRefresh((value) => value + 1);
  }, [gitState.version]);
  const activeDiff = activeId ? diffOptions[activeId] : undefined;
  const diffEnabled = activeDiff?.enabled ?? false;
  const diffBase = activeDiff?.base ?? "head";
  const diffMode = activeDiff?.mode ?? "full";
  const diffRef = activeDiff?.ref ?? "";
  const diffFlags = activeDiff?.flags ?? DEFAULT_DOC_DIFF.flags;
  const diffBaselineLabel = !activeDiff
    ? ""
    : activeDiff.base === "head"
      ? "⇄ HEAD"
      : activeDiff.base === "index"
        ? `⇄ ${t("暂存区")}`
        : activeDiff.base === "commit"
          ? `⇄ ${(activeDiff.ref.trim() || "HEAD").slice(0, 8)}`
          : `⇄ ${t("上次保存")}`;

  useEffect(() => {
    if (!activeId) return;
    setDiffOptions((current) =>
      current[activeId]
        ? current
        : {
            ...current,
            [activeId]: {
              ...DEFAULT_DOC_DIFF,
              enabled: settingsRef.current.diff.defaultOn,
              base: settingsRef.current.diff.defaultBase,
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

  const updateDiffOption = (id: string, patch: Partial<DocDiffState>): void => {
    if (!id) return;
    setDiffOptions((current) => {
      const previous = current[id] ?? DEFAULT_DOC_DIFF;
      return { ...current, [id]: { ...previous, ...patch } };
    });
    setDiffIndex(-1);
  };

  const diffState = useDocumentDiff({
    document: active,
    // PDF 是二进制只读文档，不参与差异对比。
    enabled: diffEnabled && !activeIsBinary,
    base: diffBase,
    ref: diffRef,
    flags: diffFlags,
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


  // 大纲随内容变化防抖重建；支持格式由 OUTLINE_FORMATS 统一声明。见 doc/design.md §15.1。
  useEffect(() => {
    if (!activeId || !formatSupportsOutline(activeFormat)) {
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
      setSourceJump({ line: item.line, column: 1, token, ratio: 1 / 3 });
      return;
    }
    const headings = document.querySelectorAll<HTMLElement>(
      ".pane:not([hidden]) .markdown-body :is(h1,h2,h3,h4,h5,h6)",
    );
    const heading = headings[item.index];
    if (heading) {
      scrollElementToRatio(heading, 1 / 3);
      return;
    }
    // 代码 / SVG / 图表类格式没有标题 DOM，退回源码按行号定位。
    manager.setMode("source");
    setSourceJump({ line: item.line, column: 1, token, ratio: 1 / 3 });
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

  // 导出下拉：点击外部或按 Esc 关闭；切换文档 / 显示模式时自动收起。
  useEffect(() => {
    if (!exportMenuOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !exportWrapRef.current?.contains(event.target)) {
        setExportMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setExportMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [exportMenuOpen]);

  useEffect(() => {
    setExportMenuOpen(false);
  }, [state.activeId, state.mode]);

  // 标签超出滚动区宽度时显示「全部标签」与左右滚动按钮。见 doc/design.md §15.1。
  useEffect(() => {
    const host = tabScrollRef.current;
    const items = tabItemsRef.current;
    if (!host || !items) return;
    const update = (): void => {
      setTabsOverflow(items.scrollWidth > host.clientWidth);
      setCanScrollTabs({
        left: host.scrollLeft > 1,
        right: host.scrollLeft < host.scrollWidth - host.clientWidth - 1,
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    observer.observe(items);
    host.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      host.removeEventListener("scroll", update);
    };
  }, [state.documents.length]);

  const scrollTabs = (direction: -1 | 1): void => {
    tabScrollRef.current?.scrollBy({ left: direction * 240, behavior: "smooth" });
  };

  // 活动标签滚动到可视区：溢出菜单、命令面板或搜索跳转激活文档时同样生效。
  useEffect(() => {
    tabItemsRef.current
      ?.querySelector<HTMLElement>(".tab-item.active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [state.activeId, state.documents.length]);

  /** 关闭全部文档：固定标签保留；dirty 时弹四选一（全部保存 / 全部丢弃 / 逐个询问 / 取消）。 */
  const closeAllDocuments = async (): Promise<void> => {
    const docs = manager.getState().documents.filter((doc) => !doc.pinned);
    if (docs.length === 0) return;
    const dirtyCount = docs.filter((doc) => doc.dirty).length;
    const ids = docs.map((doc) => doc.id);

    let mode: "saveAll" | "discardAll" | "askOneByOne" | "cancel" | null = null;
    if (dirtyCount > 0) {
      mode = await window.panda.dialog.confirmCloseAll({ total: ids.length, dirty: dirtyCount });
      if (mode === "cancel") return;
    } else {
      // 无未保存：纯 window.confirm 一次过。
      if (
        !window.confirm(
          t("确定关闭全部 {0} 个文档吗？", ids.length),
        )
      )
        return;
      mode = "saveAll"; // 全部 clean，bypass 实际不触发保存
    }

    if (mode === "saveAll") {
      for (const id of ids) {
        await manager.closeDocument(id, { saveAll: true });
      }
    } else if (mode === "discardAll") {
      for (const id of ids) {
        await manager.closeDocument(id, { discardAll: true });
      }
    } else {
      // askOneByOne：保留原 for...of await，让每个 dirty 弹三选一 dialog
      for (const id of ids) {
        await manager.closeDocument(id);
        // 文档仍在列表中说明关闭被取消，中止剩余关闭。
        if (manager.getState().documents.some((item) => item.id === id)) break;
      }
    }
    setTabMenu(null);
  };

  useEffect(() => {
    return window.panda.onMenuCommand((command) => {
      switch (command) {
        case "view.find":
          requestSearch("find");
          return;
        case "view.replace":
          requestSearch("replace");
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
  }, [manager, workspaces, requestSearch]);

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
        requestSearch("find");
      } else if (key === "h" && !IS_MAC) {
        event.preventDefault();
        requestSearch("replace");
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
  }, [manager, workspaces, requestSearch]);

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
        // 固定标签不允许单独关闭（含快捷键），需先取消固定；与 × / 中键行为一致。
        if (active && !active.pinned) void manager.closeDocument(active.id);
      },
    },
    {
      id: "view.find",
      title: t("查找"),
      shortcut: IS_MAC ? "⌘F" : "Ctrl+F",
      run: () => requestSearch("find"),
    },
    {
      id: "view.replace",
      title: t("替换"),
      shortcut: IS_MAC ? "" : "Ctrl+H",
      run: () => requestSearch("replace"),
    },
    {
      id: "git.open",
      title: t("打开 Git"),
      run: openSourceControl,
    },
    {
      id: "git.refresh",
      title: t("刷新 Git"),
      run: () => void git.refresh(),
    },
    {
      id: "git.stageAll",
      title: t("暂存全部更改"),
      run: () => {
        const paths = [
          ...new Set(
            (git.getState().snapshot?.changes ?? [])
              .filter((change) => !change.staged && !change.conflicted)
              .flatMap((change) =>
                change.origPath ? [change.origPath, change.path] : [change.path],
              ),
          ),
        ];
        if (paths.length > 0) void git.stage(paths).catch(() => undefined);
      },
    },
    {
      id: "git.fetch",
      title: t("获取（Git fetch）"),
      run: () => void git.fetch().catch(() => undefined),
    },
    {
      id: "git.pull",
      title: t("拉取（Git pull）"),
      run: () => void git.pull().catch(() => undefined),
    },
    {
      id: "git.push",
      title: t("推送（Git push）"),
      run: () => {
        const snapshot = git.getState().snapshot;
        // 无上游且设置为自动时直接 `push -u`；否则保持原行为（Git 报错或面板询问）。
        const setUpstream = Boolean(
          snapshot && !snapshot.upstream && settingsRef.current.git.autoSetUpstream,
        );
        void git.push(setUpstream).catch(() => undefined);
      },
    },
    {
      id: "diff.toggle",
      title: diffEnabled ? t("隐藏改动") : t("显示改动"),
      shortcut: "Ctrl+Shift+D",
      run: () => updateDiffOption(activeId, { enabled: !diffEnabled }),
    },
    {
      id: "diff.mode.full",
      title: t("差异视图：全文显示"),
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
    {
      id: "view.mode.git",
      title: t("打开 Git 差异视图"),
      run: () => enterGitView(),
    },
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
          data-tip={workspace.visible ? t("折叠工作区") : t("展开工作区")}
          onClick={() => workspaces.setVisible(!workspace.visible)}
        >
          <Icon name={workspace.visible ? "sidebar-close" : "sidebar-open"} />
        </button>
        <div className="toolbar-spacer" />
        <div className={active?.dirty ? "toolbar-doc dirty" : "toolbar-doc"}>
          <span className="toolbar-doc-dot" aria-hidden="true" />
          <span
            className={active ? "toolbar-doc-name" : "toolbar-doc-name empty"}
            title={active?.path ?? "Panda Live"}
          >
            {active ? active.name : "Panda Live"}
          </span>
        </div>
        <div className="toolbar-spacer" />
        {/* Git 显示模式入口已移到编辑区模式条最右侧的 git 按钮。见 §21.15。 */}
        {/* 文档操作常驻顶层：新建/打开文件/打开文件夹/保存。 */}
        <button
          type="button"
          className="icon-button toolbar-icon tip-left"
          aria-label={t("新建文件")}
          data-tip={t("新建文件")}
          onClick={() => manager.newDocument()}
        >
          <Icon name="file-plus" />
        </button>
        <button
          type="button"
          className="icon-button toolbar-icon tip-left"
          aria-label={t("打开文件")}
          data-tip={t("打开文件（Ctrl+O）")}
          onClick={() => void manager.openFiles()}
        >
          <Icon name="file" />
        </button>
        <button
          type="button"
          className="icon-button toolbar-icon tip-left"
          aria-label={t("打开文件夹")}
          data-tip={t("打开文件夹")}
          onClick={() => void workspaces.openPicker()}
        >
          <Icon name="folder-open" />
        </button>
        <button
          type="button"
          className="icon-button toolbar-icon tip-left"
          aria-label={t("保存文件")}
          data-tip={t("保存文件（Ctrl+S）")}
          onClick={() => void manager.saveDocument(state.activeId ?? "")}
          disabled={!active}
        >
          <Icon name="save" />
        </button>
        <span className="toolbar-divider" aria-hidden="true" />
        <button
          type="button"
          className="icon-button toolbar-icon tip-left"
          aria-label={t("设置")}
          data-tip={t("设置（Ctrl+,）")}
          onClick={() => setSettingsOpen(true)}
        >
          <Icon name="settings" />
        </button>
        {/* 与 Windows titleBarOverlay 的系统按钮（最小化/最大化/关闭）视觉分隔。 */}
        <span className="toolbar-divider" aria-hidden="true" />
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
              sourceControl={
                <GitPanel
                  store={git}
                  state={gitState}
                  dirtyCount={gitDirtyCount}
                  autoSetUpstream={settings.git.autoSetUpstream}
                  repos={gitRepoOptions}
                  selectedRepo={gitRepoSelected}
                  onSelectRepo={setGitRepoChoice}
                  onSaveAll={async () => {
                    if (!gitRoot) return true;
                    const saved = await manager.saveDocumentsInRoot(gitRoot);
                    await git.refresh();
                    return saved;
                  }}
                  onOpenFile={(filePath) => openGitFile(filePath, "buffer")}
                  onOpenStagedFile={(filePath) => openGitFile(filePath, "index")}
                  onOpenCommitFile={(shortHash, file) => openCommitFile(shortHash, file)}
                  onOpenCompareFile={openCompareFile}
                  onOpenConflictFile={(filePath) => openConflictFile(filePath)}
                />
              }
              sourceControlCount={gitState.snapshot?.changes.length ?? 0}
              tabRequest={sidebarTabRequest}
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
          <div className="tabstrip">
            <div className="tabstrip-scroll" ref={tabScrollRef}>
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
                    title={
                      doc.pinned
                        ? t("{0}（已固定：不参与关闭全部，点击图钉取消固定）", doc.path ?? doc.name)
                        : t("{0}（拖拽排序，中键关闭）", doc.path ?? doc.name)
                    }
                    onContextMenu={(event) => {
                      event.preventDefault();
                      const margin = 170;
                      setTabContextMenu({
                        top: Math.min(event.clientY, window.innerHeight - 100),
                        left: Math.min(event.clientX, window.innerWidth - margin),
                        docId: doc.id,
                      });
                    }}
                    onMouseDown={(event) => {
                      // 阻止中键在标签上触发自动滚动。
                      if (event.button === 1) event.preventDefault();
                    }}
                    onAuxClick={(event) => {
                      if (event.button !== 1) return;
                      // 固定标签不允许中键关闭，与 VS Code 行为一致。
                      if (doc.pinned) return;
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
                      className={doc.pinned ? "tab tab-pinned" : "tab"}
                      onClick={() => manager.setActive(doc.id)}
                    >
                      <span
                        role="button"
                        tabIndex={-1}
                        className="tab-pin-slot"
                        aria-label={doc.pinned ? t("取消固定 {0}", doc.name) : t("固定 {0}", doc.name)}
                        title={doc.pinned ? t("取消固定 {0}", doc.name) : t("固定 {0}", doc.name)}
                        onClick={(event) => {
                          event.stopPropagation();
                          manager.togglePinDocument(doc.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          event.stopPropagation();
                          manager.togglePinDocument(doc.id);
                        }}
                      >
                        <Icon name={fileIconForPath(doc.path)} size={13} className="tab-icon tab-file-icon" />
                        <Icon name="pin" size={12} className="tab-pin-hover" />
                        {doc.pinned && <Icon name="pin" size={9} className="tab-pin-badge" />}
                      </span>
                      {doc.dirty && <span className="tab-dot" aria-label={t("未保存")} />}
                      <span className="tab-name">{doc.name}</span>
                    </button>
                    {!doc.pinned && (
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
                    )}
                  </div>
                ))}
              </div>
              {state.documents.length === 0 && (
                <span className="tabstrip-empty">{t("未打开文档")}</span>
              )}
            </div>
            <div className="tabstrip-actions">
              {tabsOverflow && (
                <>
                  <button
                    type="button"
                    className="tab-scroll"
                    aria-label={t("向左滚动标签")}
                    title={t("向左滚动标签")}
                    disabled={!canScrollTabs.left}
                    onClick={() => scrollTabs(-1)}
                  >
                    <Icon name="chevron-left" size={14} />
                  </button>
                  <button
                    type="button"
                    className="tab-scroll"
                    aria-label={t("向右滚动标签")}
                    title={t("向右滚动标签")}
                    disabled={!canScrollTabs.right}
                    onClick={() => scrollTabs(1)}
                  >
                    <Icon name="chevron-right" size={14} />
                  </button>
                </>
              )}
              {state.documents.length > 1 && (
                <button
                  type="button"
                  className="tab-close-all"
                  aria-label={t("关闭全部")}
                  title={t("关闭全部")}
                  onClick={() => void closeAllDocuments()}
                >
                  <Icon name="close" size={13} />
                </button>
              )}
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
              <div
                key={doc.id}
                className={doc.id === state.activeId ? "tab-menu-item active" : "tab-menu-item"}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="tab-menu-open"
                  title={doc.path ?? doc.name}
                  onClick={() => {
                    manager.setActive(doc.id);
                    setTabMenu(null);
                  }}
                >
                  <Icon name={fileIconForPath(doc.path)} size={13} className="tab-menu-icon" />
                  {doc.pinned && <Icon name="pin" size={11} className="tab-menu-pin" />}
                  {doc.dirty && <span className="tab-dot" aria-label={t("未保存")} />}
                  <span className="tab-menu-name">{doc.name}</span>
                  {doc.id === state.activeId && (
                    <span className="tab-menu-mark">{t("当前")}</span>
                  )}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="tab-menu-close"
                  aria-label={t("关闭 {0}", doc.name)}
                  title={doc.pinned ? t("固定标签需先取消固定") : t("关闭 {0}", doc.name)}
                  disabled={doc.pinned}
                  onClick={(event) => {
                    event.stopPropagation();
                    void manager.closeDocument(doc.id).then(() => {
                      // 关掉最后一个文档时同步收起菜单。
                      if (manager.getState().documents.length === 0) setTabMenu(null);
                    });
                  }}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            ))}
            {state.documents.length > 0 && (
              <div className="tab-menu-footer">
                <button
                  type="button"
                  role="menuitem"
                  className="tab-menu-action"
                  onClick={() => void closeAllDocuments()}
                >
                  <Icon name="close" size={12} />
                  {t("关闭全部")}
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {tabContextMenu && (
        <>
          <div className="tab-menu-backdrop" onClick={() => setTabContextMenu(null)} />
          <div
            className="tab-menu tab-context-menu"
            role="menu"
            aria-label={t("标签操作")}
            style={{ top: tabContextMenu.top, left: tabContextMenu.left }}
          >
            <button
              type="button"
              role="menuitem"
              className="tab-menu-action"
              onClick={() => {
                manager.togglePinDocument(tabContextMenu.docId);
                setTabContextMenu(null);
              }}
            >
              <Icon name="pin" size={12} />
              {state.documents.find((doc) => doc.id === tabContextMenu.docId)?.pinned
                ? t("取消固定")
                : t("固定标签")}
            </button>
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

      {state.toasts.length > 0 && (
        <div className="toast-stack" role="region" aria-label={t("通知")}>
          {state.toasts.map((toast) => (
            <div
              key={toast.id}
              className={`toast toast-${toast.kind}`}
              role={toast.kind === "error" ? "alert" : "status"}
            >
              <span className="toast-text">{toast.message}</span>
              <button
                type="button"
                className="toast-close"
                aria-label={t("关闭")}
                onClick={() => manager.dismissToast(toast.id)}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {noticesOpen && (
        <>
          <div
            className="notice-overlay"
            aria-hidden="true"
            onClick={() => setNoticesOpen(false)}
          />
          <div className="notice-popover" role="dialog" aria-label={t("通知历史")}>
            <div className="notice-popover-head">
              <span className="notice-popover-title">{t("通知历史")}</span>
              <button
                type="button"
                className="button small ghost"
                disabled={state.notices.length === 0}
                onClick={() => manager.clearNotices()}
              >
                {t("全部清除")}
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={t("关闭")}
                onClick={() => setNoticesOpen(false)}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
            {state.notices.length === 0 ? (
              <p className="placeholder notice-empty">{t("暂无通知记录")}</p>
            ) : (
              <>
                <div className="notice-head" aria-hidden="true">
                  <span>ID</span>
                  <span>{t("类型")}</span>
                  <span>{t("内容")}</span>
                  <span>{t("时间")}</span>
                  <span>{t("重要级别")}</span>
                  <span />
                </div>
                <ul className="notice-list">
                  {state.notices.map((entry) => (
                    <li key={entry.id} className="notice-item">
                      <span className="notice-id">#{entry.id}</span>
                      <span className={`notice-kind notice-kind-${entry.kind}`}>
                        {t(NOTICE_KIND_LABELS[entry.kind])}
                      </span>
                      <span className="notice-message" title={entry.message}>
                        {entry.message}
                      </span>
                      <span className="notice-time">{formatClock(entry.at)}</span>
                      <span className={`notice-level notice-level-${entry.level}`}>
                        {getLocale() === "en"
                          ? NOTICE_LEVEL_LABELS[entry.level].en
                          : NOTICE_LEVEL_LABELS[entry.level].zh}
                      </span>
                      <button
                        type="button"
                        className="icon-button notice-remove"
                        aria-label={t("删除此条通知")}
                        title={t("删除此条通知")}
                        onClick={() => manager.removeNotice(entry.id)}
                      >
                        <Icon name="close" size={10} />
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </>
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
          <div className="editor-area">
            {modeBarVisible && (
              <div className="mode-bar">
                {state.mode === "git" ? (
                  // git 工具左对齐；由 GitPane portal 填充。
                  <div className="mode-bar-git" ref={setGitToolbarHost} />
                ) : (
                  <>
                    <div className="mode-bar-tools" ref={setModeToolbarHost} />
                    {showModeBarDivider && (
                      <span className="mode-bar-divider" aria-hidden="true" />
                    )}
                  </>
                )}
                <div className="mode-bar-modes" role="group" aria-label={t("视图模式")}>
                  {modeBarModes.map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={state.mode === mode ? "mode-button active" : "mode-button"}
                      aria-pressed={state.mode === mode}
                      aria-label={t(MODE_LABELS[mode]!)}
                      data-tip={t(MODE_LABELS[mode]!)}
                      onClick={() => {
                        // git 模式下点其它显示模式＝退出 git 并切换模式。
                        if (state.mode === "git") leaveGitView();
                        manager.setMode(mode);
                      }}
                      disabled={mode === "wysiwyg" && active.format !== "markdown"}
                    >
                      <Icon name={MODE_ICONS[mode]} />
                    </button>
                  ))}
                  {gitState.snapshot?.inRepo && (
                    <button
                      type="button"
                      className={
                        state.mode === "git"
                          ? "mode-button mode-button-git active"
                          : "mode-button mode-button-git"
                      }
                      aria-pressed={state.mode === "git"}
                      aria-label={t("Git 差异")}
                      data-tip={
                        state.mode === "git" ? t("退出 Git 差异") : t("打开 Git 差异")
                      }
                      onClick={() => {
                        if (state.mode === "git") leaveGitView();
                        else enterGitView();
                      }}
                    >
                      <Icon name={MODE_ICONS.git} />
                    </button>
                  )}
                </div>
                {showExportButton && (
                  <>
                    <span className="mode-bar-divider" aria-hidden="true" />
                    <div
                      className={exportMenuOpen ? "mode-bar-export open" : "mode-bar-export"}
                      ref={exportWrapRef}
                    >
                      <button
                        type="button"
                        className={
                          exportMenuOpen
                            ? "mode-button mode-bar-export-button active"
                            : "mode-button mode-bar-export-button"
                        }
                        aria-label={exportAsMarkdown ? t("导出") : t("导出 SVG")}
                        data-tip={exportAsMarkdown ? t("导出") : t("导出 SVG")}
                        aria-haspopup={exportAsMarkdown ? "menu" : undefined}
                        aria-expanded={exportAsMarkdown ? exportMenuOpen : undefined}
                        onClick={() => {
                          if (exportAsMarkdown) setExportMenuOpen((open) => !open);
                          else void exportSvgActive();
                        }}
                      >
                        <Icon name="download" />
                      </button>
                      {exportAsMarkdown && exportMenuOpen && (
                        <div className="export-menu" role="menu" aria-label={t("导出")}>
                          <button
                            type="button"
                            role="menuitem"
                            className="export-menu-item"
                            onClick={() => {
                              setExportMenuOpen(false);
                              void exportHtmlActive();
                            }}
                          >
                            <Icon name="file-html" size={14} className="export-menu-icon" />
                            <span>{t("导出 HTML…")}</span>
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="export-menu-item"
                            onClick={() => {
                              setExportMenuOpen(false);
                              void exportPdfActive();
                            }}
                          >
                            <Icon name="file-pdf" size={14} className="export-menu-icon" />
                            <span>{t("导出 PDF…")}</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          <main ref={workspacePaneRef} className={`workspace mode-${state.mode}`}>
            <section
              className="pane wysiwyg-pane"
              hidden={activeIsBinary || active.format !== "markdown" || state.mode !== "wysiwyg"}
              aria-label={t("所见即所得编辑")}
            >
              <WysiwygPane
                document={active}
                mode={state.mode}
                searchRequest={searchRequest}
                jump={wysiwygJump}
                diff={previewDiff}
                diffJump={wysiwygDiffJump}
                onChange={(content) => manager.updateContent(active.id, content)}
                onNotice={(message) => manager.showNotice("info", message)}
                pasteAsMarkdown={settings.editor.pasteAsMarkdown}
                toolbarHost={state.mode === "wysiwyg" ? modeToolbarHost : null}
                onRequestDocumentPath={async () => {
                  const current = activeRef.current;
                  if (!current) return null;
                  if (current.path) return current.path;
                  await manager.saveDocumentAs(current.id);
                  return (
                    manager.getState().documents.find((item) => item.id === current.id)?.path ?? null
                  );
                }}
              />
            </section>
            <section
              className="pane source-pane"
              hidden={
                activeIsBinary ||
                state.mode === "preview" ||
                state.mode === "wysiwyg" ||
                state.mode === "git"
              }
              aria-label={t("源码编辑")}
            >
              <SourcePane
                document={active}
                mode={state.mode}
                searchRequest={
                  state.mode === "source" || state.mode === "split" ? searchRequest : null
                }
                jump={sourceJump}
                tabSize={settings.editor.tabSize}
                insertSpaces={settings.editor.insertSpaces}
                showLineNumbers={settings.editor.showLineNumbers}
                diffMarkers={sourceDiffMarkers}
                onChange={(content) => manager.updateContent(active.id, content)}
                onSelection={(info) => {
                  setCursor(info);
                  manager.updateCursor(active.id, info);
                }}
                onFolds={(lines) => manager.updateFolds(active.id, lines)}
              />
            </section>
            {state.mode === "split" && !activeIsBinary && (
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
                activeIsBinary ||
                state.mode === "source" ||
                state.mode === "wysiwyg" ||
                state.mode === "git"
              }
              aria-label={t("渲染预览")}
            >
              <PreviewPane
                document={active}
                enabled={(state.mode === "split" || state.mode === "preview") && !activeIsBinary}
                compileSignal={compileSignal}
                diff={previewDiff}
                mathKey={mathOptionsSignature()}
                searchRequest={
                  state.mode === "preview" || state.mode === "split" ? searchRequest : null
                }
                onDiffModeChange={(mode) => updateDiffOption(active.id, { mode })}
                onDiffJump={(line) => {
                  if (state.mode === "preview") manager.setMode("source");
                  jumpTokenRef.current += 1;
                  setSourceJump({ line, column: 1, token: jumpTokenRef.current });
                }}
                onOpenLocalFile={(path) => void manager.openPath(path)}
              />
            </section>
            <section
              className="pane git-pane"
              hidden={activeIsBinary || state.mode !== "git"}
              aria-label={t("Git 差异")}
            >
              <GitPane
                key={active.id}
                document={active}
                active={state.mode === "git" && !activeIsBinary}
                diff={activeDiff ?? DEFAULT_DOC_DIFF}
                refreshKey={diffRefresh}
                toolbarHost={state.mode === "git" ? gitToolbarHost : null}
                onDiffChange={(patch) => updateDiffOption(active.id, patch)}
                onOpenLocalFile={(path) => void manager.openPath(path)}
              />
            </section>
            <section
              className="pane pdf-pane"
              hidden={!activeIsPdf}
              aria-label={t("PDF 预览")}
            >
              {activeIsPdf && active?.path ? (
                <PdfDocumentPreview path={active.path} mtimeMs={active.mtimeMs} />
              ) : null}
            </section>
            <section
              className="pane image-pane"
              hidden={!activeIsImage}
              aria-label={t("图片预览")}
            >
              {activeIsImage ? <ImagePreviewPane document={active} /> : null}
            </section>
          </main>
          </div>
        ) : (
          <main className="empty-state">
            <PandaMark size={64} className="brand-mark-large" />
            <h1>{t("打开一个文档开始编辑")}</h1>
            <p>{t("源码与渲染结果实时同步，保存时保留原文件编码与换行符。")}</p>
            <div className="empty-actions">
              <button type="button" className="button primary" onClick={() => manager.newDocument()}>
                <Icon name="file-plus" size={14} />
                {t("新建文档")}
              </button>
              <button type="button" className="button" onClick={() => void manager.openFiles()}>
                <Icon name="folder-open" size={14} />
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
        {gitState.snapshot?.inRepo && (
          <button
            type="button"
            className="statusbar-button git-status-button"
            title={t("打开 Git")}
            onClick={openSourceControl}
          >
            <Icon name="git" size={12} />
            <span>
              {gitState.snapshot.detached
                ? t("detached HEAD")
                : (gitState.snapshot.branch ?? t("无分支"))}
            </span>
            {gitState.snapshot.ahead > 0 && <span>↑{gitState.snapshot.ahead}</span>}
            {gitState.snapshot.behind > 0 && <span>↓{gitState.snapshot.behind}</span>}
            {gitState.snapshot.operation && <span>{t("操作中")}</span>}
          </button>
        )}
        {active && (
          <span className="statusbar-meta">
            {active.format === "pdf"
              ? `PDF · ${formatSize(active.size)} · ${t("只读")}`
              : active.format === "image"
                ? `${t("图片")} · ${formatSize(active.size)} · ${t("只读")}`
                : [
                    t(ENCODING_LABELS[active.encoding] ?? active.encoding),
                    active.eol.toUpperCase(),
                    active.bom ? "BOM" : "",
                    active.readOnly ? t("只读") : "",
                    active.format,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
          </span>
        )}
        <span className="statusbar-spacer" />
        {active && !activeIsBinary && (
          <span className="statusbar-meta">
            {formatSize(active.size)}
            {" · "}
            {state.mode === "wysiwyg"
              ? t("所见即所得")
              : t("行 {0}，列 {1}", cursor.line, cursor.column)}
          </span>
        )}
        {active && !activeIsBinary && (
          <span className="statusbar-meta" role="status">
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
        {state.mode !== "git" && (
          <>
            <DiffControls
              enabled={diffEnabled && !activeIsBinary}
              state={diffState}
              items={diffItems}
              currentIndex={diffIndex}
              disabled={!active || activeIsBinary}
              dirty={active?.dirty ?? false}
              mode={diffMode}
              baseLabel={diffBaselineLabel}
              modeAvailable={state.mode !== "wysiwyg"}
              onToggle={() => updateDiffOption(activeId, { enabled: !diffEnabled })}
              onModeChange={(mode) => updateDiffOption(activeId, { mode })}
              onRefresh={() => setDiffRefresh((value) => value + 1)}
              onPrev={() => navigateDiff(-1)}
              onNext={() => navigateDiff(1)}
              onOpenFullDiff={enterGitView}
              onJump={(index) => {
                const line = diffAnchors[index];
                if (line === undefined) return;
                setDiffIndex(index);
                revealDiffAt(line);
              }}
            />
            <span className="statusbar-divider" aria-hidden="true" />
          </>
        )}
        <button
          type="button"
          className={
            noticesOpen ? "statusbar-button notice-button active" : "statusbar-button notice-button"
          }
          aria-expanded={noticesOpen}
          aria-label={t("通知历史")}
          title={t("通知历史")}
          onClick={() => setNoticesOpen((open) => !open)}
        >
          <Icon name="bell" size={12} />
          {state.notices.length > 0 && (
            <span className="notice-badge">
              {state.notices.length > 99 ? "99+" : state.notices.length}
            </span>
          )}
        </button>
        <span className="statusbar-divider" aria-hidden="true" />
        <button
          type="button"
          className={
            perfVisible ? "statusbar-button statusbar-icon active" : "statusbar-button statusbar-icon"
          }
          aria-label={t("性能浮层")}
          aria-pressed={perfVisible}
          title={t("性能浮层")}
          onClick={() => setPerfVisible((value) => !value)}
        >
          <Icon name="activity" size={12} />
        </button>
        {(problems.length > 0 || problemsOpen) && (
          <>
            <span className="statusbar-divider" aria-hidden="true" />
            <button
              type="button"
              className={problemsOpen ? "statusbar-button active" : "statusbar-button"}
              aria-label={t("问题面板")}
              aria-expanded={problemsOpen}
              onClick={() => setProblemsOpen((value) => !value)}
            >
              {t("错误 {0} · 警告 {1}", errorCount, warningCount)}
            </button>
          </>
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
          void refreshExtensionFormats().then(() => manager.revalidateActiveMode());
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

      {diagramViewer && (
        <DiagramViewerDialog
          svg={diagramViewer.svg}
          title={diagramViewer.title}
          onClose={() => setDiagramViewer(null)}
        />
      )}

      {perfVisible && <PerformanceOverlay onClose={() => setPerfVisible(false)} />}
    </div>
  );
}
