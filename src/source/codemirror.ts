import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { xml } from "@codemirror/lang-xml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { closeSearchPanel, openSearchPanel, search } from "@codemirror/search";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

export interface SelectionInfo {
  line: number;
  column: number;
}

export type SourceLanguage = "markdown" | "xml" | "plain";

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
  { tag: tags.meta, color: "var(--cm-muted)" },
  { tag: tags.comment, color: "var(--cm-muted)", fontStyle: "italic" },
  { tag: tags.punctuation, color: "var(--cm-punct)" },
]);

const pandaPhrases = EditorState.phrases.of({
  Find: "查找",
  Replace: "替换",
  next: "下一个",
  previous: "上一个",
  all: "全部",
  "match case": "区分大小写",
  regexp: "正则",
  "by word": "全词",
  replace: "替换",
  "replace all": "全部替换",
  close: "关闭",
  "Go to line": "跳转到行",
  go: "跳转",
});

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
    },
  },
  { dark: prefersDark },
);

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
      pandaPhrases,
      language === "xml" ? xml() : language === "markdown" ? markdown() : [],
      // 源码模式的查找替换复用 CodeMirror 搜索面板与匹配装饰（§11.5）。
      search({ top: true }),
      EditorView.lineWrapping,
      tabSizeCompartment.of(EditorState.tabSize.of(tabSize)),
      syntaxHighlighting(pandaHighlight),
      pandaTheme,
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
      effects: this.tabSizeCompartment.reconfigure(EditorState.tabSize.of(size)),
    });
  }

  /** 行号通过 CSS 隐藏，避免重建编辑器丢失撤销历史。 */
  setShowLineNumbers(enabled: boolean): void {
    if (enabled === this.showLineNumbers) return;
    this.showLineNumbers = enabled;
    this.applyShowLineNumbers();
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
