import { basicSetup } from "codemirror";
import { css } from "@codemirror/lang-css";
import { cpp } from "@codemirror/lang-cpp";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { php } from "@codemirror/lang-php";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { csharp, dart, kotlin, objectiveC, scala } from "@codemirror/legacy-modes/mode/clike";
import { go } from "@codemirror/legacy-modes/mode/go";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { r } from "@codemirror/legacy-modes/mode/r";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import {
  HighlightStyle,
  StreamLanguage,
  codeFolding,
  foldGutter,
  foldKeymap,
  foldService,
  indentUnit,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language";
import { closeSearchPanel, openSearchPanel, search } from "@codemirror/search";
import {
  EditorState,
  Compartment,
  RangeSetBuilder,
  StateEffect,
  StateField,
  countColumn,
  type Extension,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutter,
  keymap,
  type DecorationSet,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { t } from "../i18n";
import { iniStreamParser } from "./ini-mode";

export interface SelectionInfo {
  line: number;
  column: number;
}

export type SourceLanguage =
  | "markdown"
  | "xml"
  | "cpp"
  | "java"
  | "javascript"
  | "json"
  | "yaml"
  | "html"
  | "css"
  | "python"
  | "sql"
  | "php"
  | "rust"
  | "csharp"
  | "go"
  | "ruby"
  | "kotlin"
  | "swift"
  | "r"
  | "scala"
  | "shell"
  | "dart"
  | "lua"
  | "perl"
  | "objectivec"
  | "stex"
  | "ini"
  | "toml"
  | "plain";

/** 源码模式的 diff 行标记；`delete` 表示该行之前有删除内容。 */
export interface DiffLineMarker {
  line: number;
  kind: "add" | "change" | "delete";
}

const setDiffMarkersEffect = StateEffect.define<readonly DiffLineMarker[]>();

class DiffGutterMarker extends GutterMarker {
  constructor(readonly kind: DiffLineMarker["kind"]) {
    super();
  }

  override eq(other: GutterMarker): boolean {
    return other instanceof DiffGutterMarker && other.kind === this.kind;
  }

  override toDOM(): Node {
    const span = document.createElement("span");
    span.className = `cm-diff-gutter-mark ${this.kind}`;
    span.textContent = this.kind === "add" ? "+" : this.kind === "change" ? "±" : "−";
    span.title = this.kind === "add" ? t("新增") : this.kind === "change" ? t("修改") : t("删除");
    return span;
  }
}

const diffGutterMarkers: Record<DiffLineMarker["kind"], DiffGutterMarker> = {
  add: new DiffGutterMarker("add"),
  change: new DiffGutterMarker("change"),
  delete: new DiffGutterMarker("delete"),
};

function clampLine(doc: Text, line: number): number {
  return Math.min(Math.max(1, line), doc.lines);
}

function buildDiffDecorations(markers: readonly DiffLineMarker[], doc: Text): DecorationSet {
  const seen = new Set<number>();
  const ranges = [];
  for (const marker of markers) {
    const line = clampLine(doc, marker.line);
    if (seen.has(line)) continue;
    seen.add(line);
    ranges.push(Decoration.line({ class: `cm-diff-line-${marker.kind}` }).range(doc.line(line).from));
  }
  return Decoration.set(ranges, true);
}

function buildDiffGutterMarkers(markers: readonly DiffLineMarker[], doc: Text) {
  const sorted = [...markers].sort((a, b) => a.line - b.line);
  const builder = new RangeSetBuilder<GutterMarker>();
  let last = -1;
  for (const marker of sorted) {
    const line = clampLine(doc, marker.line);
    if (line === last) continue;
    last = line;
    const from = doc.line(line).from;
    builder.add(from, from, diffGutterMarkers[marker.kind]);
  }
  return builder.finish();
}

const diffMarkerField = StateField.define<readonly DiffLineMarker[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setDiffMarkersEffect)) return effect.value;
    }
    // 行号会随编辑漂移，输入时先清空，等下一轮 diff 结果再补齐。
    return transaction.docChanged ? [] : value;
  },
  provide: (field) =>
    EditorView.decorations.compute([field, "doc"], (state) =>
      buildDiffDecorations(state.field(field), state.doc),
    ),
});

/** 源码 diff 装饰：左侧 gutter 标记 + 行底色。见 doc/design.md §21.6、§21.8。 */
const diffExtension: Extension = [
  diffMarkerField,
  gutter({
    class: "cm-diff-gutter",
    markers: (view) => buildDiffGutterMarkers(view.state.field(diffMarkerField), view.state.doc),
    initialSpacer: () => diffGutterMarkers.add,
  }),
];

/** 语言标识 → CodeMirror 语言扩展；未知语言退化为纯文本。 */
function languageExtension(language: SourceLanguage): Extension {
  switch (language) {
    case "markdown":
      return [markdown(), markdownFolding];
    case "xml":
      return xml();
    case "html":
      return html();
    case "css":
      return css();
    case "cpp":
      return cpp();
    case "java":
      return java();
    case "javascript":
      return javascript({ jsx: true, typescript: true });
    case "json":
      return json();
    case "yaml":
      return yaml();
    case "python":
      return python();
    case "sql":
      return sql();
    case "php":
      return php();
    case "rust":
      return rust();
    // 其余主流语言复用 CodeMirror 5 的流式解析模式；没有语法树折叠属性，按缩进兜底折叠。
    case "csharp":
      return [StreamLanguage.define(csharp), indentFoldFallback];
    case "go":
      return [StreamLanguage.define(go), indentFoldFallback];
    case "ruby":
      return [StreamLanguage.define(ruby), indentFoldFallback];
    case "kotlin":
      return [StreamLanguage.define(kotlin), indentFoldFallback];
    case "swift":
      return [StreamLanguage.define(swift), indentFoldFallback];
    case "r":
      return [StreamLanguage.define(r), indentFoldFallback];
    case "scala":
      return [StreamLanguage.define(scala), indentFoldFallback];
    case "shell":
      return [StreamLanguage.define(shell), indentFoldFallback];
    case "dart":
      return [StreamLanguage.define(dart), indentFoldFallback];
    case "lua":
      return [StreamLanguage.define(lua), indentFoldFallback];
    case "perl":
      return [StreamLanguage.define(perl), indentFoldFallback];
    case "objectivec":
      return [StreamLanguage.define(objectiveC), indentFoldFallback];
    case "stex":
      return [StreamLanguage.define(stex), indentFoldFallback];
    case "ini":
      return [StreamLanguage.define(iniStreamParser), indentFoldFallback];
    case "toml":
      return [StreamLanguage.define(toml), indentFoldFallback];
    default:
      return [];
  }
}

/**
 * Markdown 围栏代码块折叠：隐藏两行 ``` 之间的内容，保留开闭围栏。见 doc/design.md §11.4。
 * lang-markdown 自带 Table 折叠但不覆盖 FencedCode，这里通过 foldService 补齐。
 */
const markdownFolding: Extension = markdownLanguage.data.of({
  foldService: (state: EditorState, from: number): { from: number; to: number } | null => {
    const node = syntaxTree(state).resolveInner(from, -1);
    for (let current: typeof node | null = node; current; current = current.parent) {
      if (current.name === "FencedCode") {
        const first = state.doc.lineAt(current.from);
        const last = state.doc.lineAt(current.to);
        if (first.number >= last.number) return null;
        return { from: first.to, to: last.from };
      }
    }
    return null;
  },
});

/** 缩进折叠兜底：当前行缩进更小时，把后续更深层缩进的连续行折叠起来。 */
const indentFoldFallback: Extension = foldService.of(
  (state: EditorState, from: number): { from: number; to: number } | null => {
    const line = state.doc.lineAt(from);
    if (!line.text.trim()) return null;
    const base = countColumn(line.text, state.tabSize);
    let last = line.number;
    for (let number = line.number + 1; number <= state.doc.lines; number += 1) {
      const current = state.doc.line(number);
      if (!current.text.trim()) continue;
      if (countColumn(current.text, state.tabSize) > base) last = number;
      else break;
    }
    return last > line.number ? { from: line.to, to: state.doc.line(last).to } : null;
  },
);

export interface SourceEditorOptions {
  parent: HTMLElement;
  doc: string;
  readOnly: boolean;
  /** 语法高亮语言；`.mathml`/`.mml` 使用 XML。 */
  language?: SourceLanguage;
  /** Tab 宽度（空格数），默认 2。 */
  tabSize?: number;
  /** 是否显示行号，默认 true。 */
  showLineNumbers?: boolean;
  onChange(content: string): void;
  onSelection(info: SelectionInfo): void;
}

const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

/** 颜色全部引用 CSS 变量，明暗主题切换无需重建编辑器。 */
const pandaHighlight = HighlightStyle.define([
  { tag: [tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6], color: "var(--cm-heading)", fontWeight: "600" },
  { tag: tags.strong, color: "var(--cm-strong)", fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: [tags.link, tags.url], color: "var(--cm-link)" },
  { tag: tags.monospace, color: "var(--cm-code)" },
  { tag: tags.keyword, color: "var(--cm-keyword)" },
  { tag: [tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.self], color: "var(--cm-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character], color: "var(--cm-string)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--cm-number)" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--cm-type)" },
  { tag: tags.tagName, color: "var(--cm-tag)" },
  { tag: tags.definition(tags.tagName), color: "var(--cm-ini-section)" },
  { tag: [tags.attributeName, tags.propertyName], color: "var(--cm-attr)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--cm-link)" },
  { tag: tags.variableName, color: "var(--cm-strong)" },
  { tag: [tags.operator, tags.bracket], color: "var(--cm-punct)" },
  { tag: tags.meta, color: "var(--cm-muted)" },
  { tag: tags.comment, color: "var(--cm-muted)", fontStyle: "italic" },
  { tag: tags.punctuation, color: "var(--cm-punct)" },
  { tag: tags.invalid, color: "var(--danger)" },
]);

function buildPhrases(): Record<string, string> {
  return {
    Find: t("查找"),
    Replace: t("替换"),
    next: t("下一个"),
    previous: t("上一个"),
    all: t("全部"),
    "match case": t("区分大小写"),
    regexp: t("正则"),
    "by word": t("全词"),
    replace: t("替换"),
    "replace all": t("全部替换"),
    close: t("关闭"),
    "Go to line": t("跳转到行"),
    go: t("跳转"),
    "Fold line": t("折叠"),
    "Unfold line": t("展开"),
  };
}

const pandaTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      color: "var(--editor-fg)",
      backgroundColor: "var(--editor-bg)",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--editor-font-size)",
      lineHeight: "1.7",
    },
    ".cm-content": {
      padding: "16px 0",
      caretColor: "var(--accent)",
      tabSize: "var(--cm-tab-size)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--editor-gutter-bg)",
      color: "var(--editor-gutter-fg)",
      border: "none",
    },
    ".cm-activeLine": { backgroundColor: "var(--editor-active-line)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--editor-active-line)" },
    ".cm-selectionBackground, .cm-focused .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "var(--editor-selection)",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
    ".cm-panels": {
      backgroundColor: "var(--surface-muted)",
      color: "var(--fg)",
    },
    ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
    ".cm-searchMatch": { backgroundColor: "var(--search-match)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--search-match-active)" },
    ".cm-foldPlaceholder": {
      backgroundColor: "transparent",
      color: "var(--muted)",
      border: "none",
      padding: "0 6px",
      borderRadius: "3px",
      cursor: "pointer",
    },
    ".cm-foldGutter .cm-fold-marker": {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: "14px",
      height: "100%",
      color: "var(--editor-gutter-fg)",
      opacity: "0.6",
      cursor: "pointer",
    },
    ".cm-foldGutter .cm-gutterElement:hover .cm-fold-marker": {
      opacity: "1",
      color: "var(--accent)",
    },
    ".cm-foldGutter .cm-fold-marker svg": {
      transition: "transform 100ms ease",
    },
    ".cm-foldGutter .cm-fold-marker.closed svg": {
      transform: "rotate(-90deg)",
    },
  },
  { dark: prefersDark },
);

/** 折叠箭头：与全局线性图标风格一致，折叠态由 CSS 旋转 -90°。 */
const FOLD_CHEVRON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>';

function createState(
  doc: string,
  readOnly: boolean,
  language: SourceLanguage,
  updateListener: ReturnType<typeof EditorView.updateListener.of>,
  tabSizeCompartment: Compartment,
  tabSize: number,
): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      basicSetup,
      EditorState.phrases.of(buildPhrases()),
      languageExtension(language),
      // 语法折叠：VS Code 风格 chevron 箭头 + 键位（Ctrl+Shift+[ / ] 等）。见 doc/design.md §11.4。
      codeFolding(),
      foldGutter({
        markerDOM: (open) => {
          const marker = document.createElement("span");
          marker.className = open ? "cm-fold-marker open" : "cm-fold-marker closed";
          marker.innerHTML = FOLD_CHEVRON;
          marker.setAttribute("aria-hidden", "true");
          return marker;
        },
      }),
      keymap.of(foldKeymap),
      // 源码模式的查找替换复用 CodeMirror 搜索面板与匹配装饰（§11.5）。
      search({ top: true }),
      EditorView.lineWrapping,
      // 自动缩进使用与 Tab 宽度一致的空格数。
      tabSizeCompartment.of([
        EditorState.tabSize.of(tabSize),
        indentUnit.of(" ".repeat(tabSize)),
      ]),
      syntaxHighlighting(pandaHighlight),
      pandaTheme,
      diffExtension,
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      updateListener,
    ],
  });
}

/** CodeMirror 6 源码编辑器封装；一个实例对应一个标签页。 */
export class SourceEditor {
  private readonly view: EditorView;
  private readonly updateListener: ReturnType<typeof EditorView.updateListener.of>;
  private readonly tabSizeCompartment = new Compartment();
  private tabSize: number;
  private showLineNumbers: boolean;
  private suppressChange = false;

  constructor(private readonly options: SourceEditorOptions) {
    this.tabSize = options.tabSize ?? 2;
    this.showLineNumbers = options.showLineNumbers ?? true;
    this.updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && !this.suppressChange) {
        options.onChange(update.state.doc.toString());
      }
      if (update.selectionSet || update.docChanged) {
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        options.onSelection({ line: line.number, column: head - line.from + 1 });
      }
    });

    this.view = new EditorView({
      state: createState(
        options.doc,
        options.readOnly,
        options.language ?? "markdown",
        this.updateListener,
        this.tabSizeCompartment,
        this.tabSize,
      ),
      parent: options.parent,
    });
    this.applyShowLineNumbers();
  }

  /** 设置变更后更新 Tab 宽度，无需重建编辑器。 */
  setTabSize(size: number): void {
    if (size === this.tabSize) return;
    this.tabSize = size;
    this.view.dispatch({
      effects: this.tabSizeCompartment.reconfigure([
        EditorState.tabSize.of(size),
        indentUnit.of(" ".repeat(size)),
      ]),
    });
  }

  /** 行号通过 CSS 隐藏，避免重建编辑器丢失撤销历史。 */
  setShowLineNumbers(enabled: boolean): void {
    if (enabled === this.showLineNumbers) return;
    this.showLineNumbers = enabled;
    this.applyShowLineNumbers();
  }

  /** 更新 diff 行标记；传空数组关闭装饰。 */
  setDiffMarkers(markers: readonly DiffLineMarker[]): void {
    this.view.dom.classList.toggle("diff-active", markers.length > 0);
    this.view.dispatch({ effects: setDiffMarkersEffect.of(markers) });
  }

  private applyShowLineNumbers(): void {
    this.view.dom.classList.toggle("hide-line-numbers", !this.showLineNumbers);
  }

  get state(): EditorState {
    return this.view.state;
  }

  get content(): string {
    return this.view.state.doc.toString();
  }

  setState(state: EditorState): void {
    this.suppressChange = true;
    this.view.setState(state);
    this.suppressChange = false;
    this.emitSelection();
  }

  /** 用新内容重建状态（用于外部重新加载或切换标签）。 */
  reset(content: string, readOnly: boolean, language?: SourceLanguage): void {
    this.setState(
      createState(
        content,
        readOnly,
        language ?? this.options.language ?? "markdown",
        this.updateListener,
        this.tabSizeCompartment,
        this.tabSize,
      ),
    );
  }

  focus(): void {
    this.view.focus();
  }

  openSearch(): void {
    openSearchPanel(this.view);
  }

  closeSearch(): void {
    closeSearchPanel(this.view);
  }

  /** 当前光标位置；用于会话恢复。 */
  getCursor(): { line: number; column: number } {
    const head = this.view.state.selection.main.head;
    const line = this.view.state.doc.lineAt(head);
    return { line: line.number, column: head - line.from + 1 };
  }

  /** 按行/列定位光标并滚动到可见区域。 */
  setCursor(cursor: { line: number; column: number }): void {
    const lineInfo = this.view.state.doc.line(Math.min(Math.max(1, cursor.line), this.view.state.doc.lines));
    const offset = Math.min(lineInfo.to, lineInfo.from + Math.max(0, cursor.column - 1));
    this.view.dispatch({
      selection: { anchor: offset },
      scrollIntoView: true,
    });
    this.view.focus();
  }

  destroy(): void {
    this.view.destroy();
  }

  private emitSelection(): void {
    const head = this.view.state.selection.main.head;
    const line = this.view.state.doc.lineAt(head);
    this.options.onSelection({ line: line.number, column: head - line.from + 1 });
  }
}
