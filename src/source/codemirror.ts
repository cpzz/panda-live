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
  bracketMatching,
  codeFolding,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  foldService,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  syntaxTree,
  foldable,
  foldEffect,
  foldState,
  unfoldEffect,
  type Language,
} from "@codemirror/language";
import { closeSearchPanel, search } from "@codemirror/search";
import {
  EditorState,
  Compartment,
  RangeSetBuilder,
  StateEffect,
  StateField,
  countColumn,
  type Extension,
  type Line,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  drawSelection,
  dropCursor,
  gutter,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  crosshairCursor,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, acceptCompletion, completionStatus } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, copyLineDown, copyLineUp, indentMore, moveLineDown, moveLineUp } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { lintKeymap } from "@codemirror/lint";
import { tags } from "@lezer/highlight";
import type { SyntaxNode } from "@lezer/common";
import { t } from "../i18n";
import type { SearchMode, SearchOptions } from "../services/search";
import { iniStreamParser } from "./ini-mode";
import { createSourceSearchPanel, openSourceSearch } from "./search-panel";

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
  | "plantuml"
  | "plain";

/** 源码模式的 diff 行标记；`delete` 表示该行之前有删除内容。 */
export interface DiffLineMarker {
  line: number;
  kind: "add" | "change" | "delete";
}

/** Git 对比的占位行：在行少的一侧插入空白，保持左右逐行对齐。 */
export interface DiffSpacer {
  /** 1 基行号；插入到该行之前。超过文档行数时追加到文档末尾。 */
  line: number;
  /** 占位行数。 */
  count: number;
  kind: "add" | "delete";
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

/** 行内差异标记：在变化行内高亮具体变化的字符（对比视图）。 */
export interface DiffInlineMark {
  /** 1 基行号。 */
  line: number;
  /** 行内起始列（0 基，UTF-16 偏移）。 */
  from: number;
  /** 行内结束列（不含）。 */
  to: number;
  kind: "add" | "del";
}

const setDiffInlineMarksEffect = StateEffect.define<readonly DiffInlineMark[]>();

function buildInlineDecorations(
  marks: readonly DiffInlineMark[],
  doc: Text,
): DecorationSet {
  const sorted = [...marks].sort((a, b) => a.line - b.line || a.from - b.from);
  const ranges: Array<{ from: number; to: number; value: Decoration }> = [];
  for (const mark of sorted) {
    const line = doc.line(clampLine(doc, mark.line));
    const from = line.from + Math.max(0, Math.min(mark.from, line.length));
    const to = line.from + Math.max(0, Math.min(mark.to, line.length));
    if (to <= from) continue;
    ranges.push(
      Decoration.mark({
        class: mark.kind === "add" ? "cm-inline-add" : "cm-inline-del",
      }).range(from, to),
    );
  }
  return Decoration.set(ranges, true);
}

const diffInlineField = StateField.define<readonly DiffInlineMark[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setDiffInlineMarksEffect)) return effect.value;
    }
    return transaction.docChanged ? [] : value;
  },
  provide: (field) =>
    EditorView.decorations.compute([field, "doc"], (state) =>
      buildInlineDecorations(state.field(field), state.doc),
    ),
});

/** 占位块按编辑器实际行高换算成像素，同时用于高度映射估算与 DOM 高度。 */
interface DiffSpacerMark extends DiffSpacer {
  height: number;
}

const setDiffSpacersEffect = StateEffect.define<readonly DiffSpacerMark[]>();

class DiffSpacerWidget extends WidgetType {
  constructor(private readonly mark: DiffSpacerMark) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof DiffSpacerWidget &&
      other.mark.line === this.mark.line &&
      other.mark.count === this.mark.count &&
      other.mark.kind === this.mark.kind &&
      other.mark.height === this.mark.height
    );
  }

  /** 未渲染时 CodeMirror 用该值估算高度，长文档滚动时不会累积偏差。 */
  override get estimatedHeight(): number {
    return this.mark.height;
  }

  override toDOM(): HTMLElement {
    const element = document.createElement("div");
    element.className = `cm-diff-spacer ${this.mark.kind}`;
    element.style.height = `${this.mark.height}px`;
    element.title = t(
      this.mark.kind === "add" ? "此处新增了 {0} 行" : "此处删除了 {0} 行",
      this.mark.count,
    );
    const label = document.createElement("span");
    label.textContent = `${this.mark.kind === "add" ? "+" : "−"}${this.mark.count} 行`;
    element.appendChild(label);
    element.setAttribute("aria-hidden", "true");
    return element;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

const diffSpacerField = StateField.define<readonly DiffSpacerMark[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setDiffSpacersEffect)) return effect.value;
    }
    return transaction.docChanged ? [] : value;
  },
  provide: (field) =>
    EditorView.decorations.compute([field, "doc"], (state) => {
      const doc = state.doc;
      const ranges: Array<{ from: number; value: Decoration }> = [];
      for (const mark of state.field(field)) {
        // 块级占位挂在上一行末尾，保证行号仍然对应自身内容；
        // 同时 CodeMirror 会把块高度计入行高映射（含 estimatedHeight），长文档不会累积错位。
        const from =
          mark.line <= 1 ? 0 : doc.line(Math.min(mark.line - 1, doc.lines)).to;
        ranges.push({
          from,
          value: Decoration.widget({
            widget: new DiffSpacerWidget(mark),
            block: true,
            side: 1,
          }),
        });
      }
      ranges.sort((a, b) => a.from - b.from);
      return Decoration.set(
        ranges.map((range) => range.value.range(range.from)),
        true,
      );
    }),
});

/** 源码 diff 装饰：左侧 gutter 标记 + 行底色 + 行内变化字符高亮。见 §21.6、§21.8。 */
const diffExtension: Extension = [
  diffMarkerField,
  diffInlineField,
  diffSpacerField,
  gutter({
    class: "cm-diff-gutter",
    markers: (view) => buildDiffGutterMarkers(view.state.field(diffMarkerField), view.state.doc),
    initialSpacer: () => diffGutterMarkers.add,
  }),
];

/** 语言标识 → CodeMirror 语言扩展；未知语言退化为纯文本。 */
function languageExtension(language: SourceLanguage): Extension {
  switch (language) {
    case "markdown": {
      const lang = markdown();
      // PlantUML 折叠服务与标题/围栏折叠并存：md 文档里（围栏内外）的
      // @startuml…@enduml 块也可折叠。见 doc/design.md §11.4。
      return [lang, markdownFolding, plantumlFolding, commentTokensData(lang, language)];
    }
    case "xml":
      return [xml(), commentTokensData(xml(), language)];
    case "html":
      return [html(), commentTokensData(html(), language)];
    case "css":
      return [css(), commentTokensData(css(), language)];
    case "cpp":
      return [cpp(), commentTokensData(cpp(), language)];
    case "java":
      return [java(), commentTokensData(java(), language)];
    case "javascript": {
      const lang = javascript({ jsx: true, typescript: true });
      return [lang, commentTokensData(lang, language)];
    }
    case "json":
      return json();
    case "yaml":
      return [yaml(), commentTokensData(yaml(), language)];
    case "python":
      return [python(), commentTokensData(python(), language)];
    case "sql":
      return [sql(), commentTokensData(sql(), language)];
    case "php":
      return [php(), commentTokensData(php(), language)];
    case "rust":
      return [rust(), commentTokensData(rust(), language)];
    // 其余主流语言复用 CodeMirror 5 的流式解析模式；没有语法树折叠属性，按缩进兜底折叠。
    case "csharp":
      return streamLanguage(csharp, language);
    case "go":
      return streamLanguage(go, language);
    case "ruby":
      return streamLanguage(ruby, language);
    case "kotlin":
      return streamLanguage(kotlin, language);
    case "swift":
      return streamLanguage(swift, language);
    case "r":
      return streamLanguage(r, language);
    case "scala":
      return streamLanguage(scala, language);
    case "shell":
      return streamLanguage(shell, language);
    case "dart":
      return streamLanguage(dart, language);
    case "lua":
      return streamLanguage(lua, language);
    case "perl":
      return streamLanguage(perl, language);
    case "objectivec":
      return streamLanguage(objectiveC, language);
    case "stex":
      return [...streamLanguage(stex, language), stexFolding];
    case "ini":
      return streamLanguage(iniStreamParser, language);
    case "toml":
      return streamLanguage(toml, language);
    case "plantuml":
      // PlantUML 无现成高亮模式；提供 @startuml…@enduml 块折叠。
      return plantumlFolding;
    default:
      return [];
  }
}

/** 注释切换（Mod-/）使用的注释符；按语言附加到语言数据。见 doc/design.md §11.4。 */
interface CommentTokens {
  line?: string;
  block?: { open: string; close: string };
}

const COMMENT_TOKENS: Partial<Record<SourceLanguage, CommentTokens>> = {
  cpp: { line: "//", block: { open: "/*", close: "*/" } },
  csharp: { line: "//", block: { open: "/*", close: "*/" } },
  java: { line: "//", block: { open: "/*", close: "*/" } },
  javascript: { line: "//", block: { open: "/*", close: "*/" } },
  kotlin: { line: "//", block: { open: "/*", close: "*/" } },
  swift: { line: "//", block: { open: "/*", close: "*/" } },
  scala: { line: "//", block: { open: "/*", close: "*/" } },
  objectivec: { line: "//", block: { open: "/*", close: "*/" } },
  dart: { line: "//", block: { open: "/*", close: "*/" } },
  go: { line: "//", block: { open: "/*", close: "*/" } },
  rust: { line: "//", block: { open: "/*", close: "*/" } },
  php: { line: "//", block: { open: "/*", close: "*/" } },
  sql: { line: "--" },
  css: { block: { open: "/*", close: "*/" } },
  html: { block: { open: "<!--", close: "-->" } },
  xml: { block: { open: "<!--", close: "-->" } },
  markdown: { block: { open: "<!--", close: "-->" } },
  python: { line: "#" },
  r: { line: "#" },
  ruby: { line: "#" },
  perl: { line: "#" },
  shell: { line: "#" },
  yaml: { line: "#" },
  toml: { line: "#" },
  ini: { line: "#" },
  lua: { line: "--" },
  stex: { line: "%" },
};

/** 把注释符数据附加到语言实例（Lezer 或 StreamLanguage 均实现 Language.data）。 */
function commentTokensData(extension: Extension & { language?: Language }, language: SourceLanguage): Extension {
  const tokens = COMMENT_TOKENS[language];
  const target = (extension as { language?: Language }).language ?? (extension as unknown as Language);
  return tokens ? target.data.of({ commentTokens: tokens }) : [];
}

function streamLanguage(mode: Parameters<typeof StreamLanguage.define>[0], language: SourceLanguage): Extension[] {
  const lang = StreamLanguage.define(mode);
  return [lang, commentTokensData(lang, language), indentFoldFallback];
}

/**
 * Markdown 折叠：标题分节（同层级下一个标题或文档结尾为界）与围栏代码块（保留开闭围栏）。
 * 见 doc/design.md §11.4。lang-markdown 自带 Table 折叠，但不覆盖标题与 FencedCode。
 */
const MARKDOWN_HEADING = /^(?:ATXHeading|SetextHeading)([1-6])$/;

/** 该行是否为标题起始；返回标题层级（1–6），否则 null。 */
function markdownHeadingLevel(state: EditorState, line: Line): number | null {
  const node = syntaxTree(state).resolveInner(line.from, 1);
  for (let current: SyntaxNode | null = node; current; current = current.parent) {
    const match = MARKDOWN_HEADING.exec(current.name);
    if (match && current.from === line.from) return Number(match[1]);
  }
  return null;
}

const markdownFolding: Extension = markdownLanguage.data.of({
  foldService: (state: EditorState, from: number): { from: number; to: number } | null => {
    const line = state.doc.lineAt(from);
    // 标题分节：折叠到下一个同级或更高级标题之前；无边界则折叠到文档结尾（与 VS Code 一致）。
    const level = markdownHeadingLevel(state, line);
    if (level !== null) {
      for (let number = line.number + 1; number <= state.doc.lines; number += 1) {
        const next = state.doc.line(number);
        const nextLevel = markdownHeadingLevel(state, next);
        if (nextLevel !== null && nextLevel <= level) {
          return next.from > line.to ? { from: line.to, to: next.from } : null;
        }
      }
      return state.doc.length > line.to ? { from: line.to, to: state.doc.length } : null;
    }
    // 围栏代码块：隐藏两行 ``` 之间的内容。仅在起始行给标记，
    // 围栏内部行的键盘折叠由 CodeMirror 的 foldableContainer 向前回溯处理。
    const node = syntaxTree(state).resolveInner(from, -1);
    for (let current: SyntaxNode | null = node; current; current = current.parent) {
      if (current.name === "FencedCode" && current.from === from) {
        const first = state.doc.lineAt(current.from);
        const last = state.doc.lineAt(current.to);
        if (first.number >= last.number) return null;
        return { from: first.to, to: last.from };
      }
    }
    return null;
  },
});

/** 行首空白对应的列数（Tab 按 tabSize 展开），用于缩进折叠判断。 */
function lineIndent(text: string, tabSize: number): number {
  const match = /^[ \t]*/.exec(text);
  return countColumn(match?.[0] ?? "", tabSize);
}

/** 缩进折叠兜底：当前行缩进更小时，把后续更深层缩进的连续行折叠起来。 */
const indentFoldFallback: Extension = foldService.of(
  (state: EditorState, from: number): { from: number; to: number } | null => {
    const line = state.doc.lineAt(from);
    if (!line.text.trim()) return null;
    const base = lineIndent(line.text, state.tabSize);
    let last = line.number;
    for (let number = line.number + 1; number <= state.doc.lines; number += 1) {
      const current = state.doc.line(number);
      if (!current.text.trim()) continue;
      if (lineIndent(current.text, state.tabSize) > base) last = number;
      else break;
    }
    return last > line.number ? { from: line.to, to: state.doc.line(last).to } : null;
  },
);

/** LaTeX 章节命令与其层级；折叠到下一个同级或更高级命令之前。见 doc/design.md §11.4。 */
const LATEX_SECTION_LEVELS: readonly (readonly [RegExp, number])[] = [
  [/^\\part\*?\b/, 0],
  [/^\\chapter\*?\b/, 1],
  [/^\\section\*?\b/, 2],
  [/^\\subsection\*?\b/, 3],
  [/^\\subsubsection\*?\b/, 4],
  [/^\\paragraph\*?\b/, 5],
  [/^\\subparagraph\*?\b/, 6],
];

const stexFolding: Extension = foldService.of(
  (state: EditorState, from: number): { from: number; to: number } | null => {
    const line = state.doc.lineAt(from);
    const current = LATEX_SECTION_LEVELS.find(([pattern]) => pattern.test(line.text));
    if (!current) return null;
    for (let number = line.number + 1; number <= state.doc.lines; number += 1) {
      const next = state.doc.line(number);
      const found = LATEX_SECTION_LEVELS.find(([pattern]) => pattern.test(next.text));
      if (found && found[1] <= current[1]) {
        return next.from > line.to ? { from: line.to, to: next.from } : null;
      }
    }
    return state.doc.length > line.to ? { from: line.to, to: state.doc.length } : null;
  },
);

/** PlantUML 折叠：`@startuml…@enduml` 块隐藏中间内容，保留首尾指令行。见 doc/design.md §11.4。 */
const PLANTUML_START = /^@startuml\b/iu;
const PLANTUML_END = /^@enduml\b/iu;

const plantumlFolding: Extension = foldService.of(
  (state: EditorState, from: number): { from: number; to: number } | null => {
    const line = state.doc.lineAt(from);
    if (!PLANTUML_START.test(line.text.trim())) return null;
    for (let number = line.number + 1; number <= state.doc.lines; number += 1) {
      const current = state.doc.line(number);
      const text = current.text.trim();
      // 未闭合就出现新的 @startuml：语法异常，不在起点提供折叠。
      if (PLANTUML_START.test(text)) return null;
      if (PLANTUML_END.test(text)) {
        // 仅相邻一行（无内容）时不提供折叠。
        return current.number > line.number + 1 ? { from: line.to, to: current.from } : null;
      }
    }
    return null;
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
  /** Tab 键是否输出空格（false = 输出硬制表符 \t），默认 true。 */
  insertSpaces?: boolean;
  /** 是否显示行号，默认 true。 */
  showLineNumbers?: boolean;
  /** 是否自动换行，默认 true；Git 对比关闭以保证两侧行高一致、占位行精确对齐。 */
  lineWrapping?: boolean;
  onChange(content: string): void;
  onSelection(info: SelectionInfo): void;
  /** 折叠状态变化（展开/折叠）；用于会话持久化。见 doc/design.md §21.6。 */
  onFolds?(lines: number[]): void;
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

/** 注释切换（Mod-/）：行注释优先；只有块注释符的语言包裹选中行。见 doc/design.md §11.4。 */
function toggleCommentCommand(view: EditorView): boolean {
  const state = view.state;
  const changes: { from: number; insert: string; to?: number }[] = [];
  const handled = new Set<number>();
  for (const range of state.selection.ranges) {
    const fromLine = state.doc.lineAt(range.from).number;
    const toLine = state.doc.lineAt(range.to).number;
    for (let number = fromLine; number <= toLine; number += 1) {
      if (handled.has(number)) continue;
      handled.add(number);
      const line = state.doc.line(number);
      if (!line.text.trim()) continue;
      const tokens = state.languageDataAt<CommentTokens>("commentTokens", line.from)[0] ?? {};
      const trimmed = line.text.trimStart();
      const indentLength = line.text.length - trimmed.length;
      if (tokens.line && trimmed.startsWith(tokens.line)) {
        // 取消行注释（连同其后一个空格）。
        const start = line.from + indentLength;
        const end = state.doc.sliceString(start + tokens.line.length, start + tokens.line.length + 1) === " "
          ? start + tokens.line.length + 1
          : start + tokens.line.length;
        changes.push({ from: start, to: end, insert: "" });
      } else if (tokens.line) {
        changes.push({ from: line.from + indentLength, insert: `${tokens.line} ` });
      } else if (tokens.block) {
        changes.push({ from: line.from, insert: `${tokens.block.open} ` });
        changes.push({ from: line.to, insert: ` ${tokens.block.close}` });
      }
    }
  }
  if (changes.length === 0) return false;
  view.dispatch({ changes });
  return true;
}

/**
 * Tab 键缩进单位（StateField 存「Tab 是否输出空格」，命令运行时读取，随设置即时切换）。
 * 见 doc/design.md §11.4、§15.3。
 */
const setInsertSpacesEffect = StateEffect.define<boolean>();

const insertSpacesField = StateField.define<boolean>({
  create: () => true,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setInsertSpacesEffect)) return effect.value;
    }
    return value;
  },
});

/** Tab 键：输出缩进单位（N 空格或硬制表符）；有选区/多光标时整段缩进；补全激活时先接受补全。 */
function tabCommand(view: EditorView): boolean {
  if (completionStatus(view.state) === "active") return acceptCompletion(view);
  const state = view.state;
  if (state.selection.ranges.length > 1 || !state.selection.main.empty) return indentMore(view);
  const insertSpaces = state.field(insertSpacesField, false) ?? true;
  view.dispatch(state.replaceSelection(insertSpaces ? " ".repeat(state.tabSize) : "\t"));
  return true;
}

/** Tab 宽度与输出单位（空格/硬 Tab）；Tab 键位在 pandaSetup 中（动态读取 insertSpacesField）。 */
function buildIndentExtension(tabSize: number, insertSpaces: boolean): Extension {
  return [EditorState.tabSize.of(tabSize), indentUnit.of(insertSpaces ? " ".repeat(tabSize) : "\t")];
}

/**
 * 显式基础扩展集：复制 CodeMirror basicSetup 并定制折叠 gutter（VS Code 风格箭头）。
 * 不能与 basicSetup 叠加使用——basicSetup 已内置 foldGutter，叠加会出现两条折叠槽。
 */
const pandaSetup: Extension[] = [
  insertSpacesField,
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  foldGutter({ markerDOM: foldMarkerDOM }),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  // Tab 输出缩进单位；单独一个 keymap 并置于 defaultKeymap（Tab→indentMore）之前以获得更高优先级。
  keymap.of([{ key: "Tab", run: tabCommand }]),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...completionKeymap,
    ...lintKeymap,
  ]),
  // 效率键位（FR-14，VS Code 默认键位）：Mod-/ 注释切换；Alt+↑/↓ 移动行；Shift+Alt+↑/↓ 复制行。
  keymap.of([{ key: "Mod-/", run: toggleCommentCommand }]),
  keymap.of([
    { key: "Alt-ArrowUp", run: moveLineUp },
    { key: "Alt-ArrowDown", run: moveLineDown },
    { key: "Shift-Alt-ArrowUp", run: copyLineUp },
    { key: "Shift-Alt-ArrowDown", run: copyLineDown },
  ]),
];

function foldMarkerDOM(open: boolean): HTMLElement {
  const marker = document.createElement("span");
  marker.className = open ? "cm-fold-marker open" : "cm-fold-marker closed";
  marker.innerHTML = FOLD_CHEVRON;
  marker.setAttribute("aria-hidden", "true");
  return marker;
}

function createState(
  doc: string,
  readOnly: boolean,
  language: SourceLanguage,
  updateListener: ReturnType<typeof EditorView.updateListener.of>,
  tabSizeCompartment: Compartment,
  tabSize: number,
  insertSpaces: boolean,
  lineWrapping: boolean,
): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      pandaSetup,
      EditorState.phrases.of(buildPhrases()),
      languageExtension(language),
      // 源码模式的查找替换使用与 WYSIWYG 一致的自绘面板（§11.5）。
      search({ top: true, createPanel: createSourceSearchPanel }),
      ...(lineWrapping ? [EditorView.lineWrapping] : []),
      // 自动缩进与 Tab 输出使用一致的单位（空格或硬制表符）。
      tabSizeCompartment.of(buildIndentExtension(tabSize, insertSpaces)),
      syntaxHighlighting(pandaHighlight),
      pandaTheme,
      diffExtension,
      // 折叠占位显示「⋯ N 行未改动」；Git 对比用 setLineFolds 折叠未改动区域。
      codeFolding({
        preparePlaceholder: (state, value: { from: number; to: number }) => {
          const fromLine = state.doc.lineAt(value.from).number;
          const toLine = state.doc.lineAt(value.to).number;
          return Math.max(1, toLine - fromLine + 1);
        },
        placeholderDOM: (view, onclick, prepared?: number) => {
          const element = document.createElement("span");
          element.className = "cm-foldPlaceholder";
          // 只读的 Git 对比显示「⋯ N 行未改动」；可编辑模式的语法折叠保持简洁的「⋯」。
          const readOnly = view.state.facet(EditorState.readOnly);
          element.textContent =
            readOnly && typeof prepared === "number" ? t("⋯ {0} 行未改动", prepared) : "⋯";
          element.title = t("展开");
          element.onclick = onclick;
          return element;
        },
      }),
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
  private insertSpaces: boolean;
  private showLineNumbers: boolean;
  private readonly lineWrapping: boolean;
  private suppressChange = false;

  constructor(private readonly options: SourceEditorOptions) {
    this.tabSize = options.tabSize ?? 2;
    this.insertSpaces = options.insertSpaces ?? true;
    this.showLineNumbers = options.showLineNumbers ?? true;
    this.lineWrapping = options.lineWrapping ?? true;
    this.updateListener = EditorView.updateListener.of((update) => {
      // 折叠/展开随事务出现；逐事务检查是否包含折叠效果。
      for (const tr of update.transactions) {
        if (tr.effects.some((effect) => effect.is(foldEffect) || effect.is(unfoldEffect))) {
          if (!this.suppressChange) options.onFolds?.(this.getFolds());
          break;
        }
      }
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
        this.insertSpaces,
        this.lineWrapping,
      ),
      parent: options.parent,
    });
    this.applyShowLineNumbers();
    if (!this.insertSpaces) {
      // compartment 已按硬 Tab 构建；补齐 StateField 初始值。
      this.view.dispatch({ effects: setInsertSpacesEffect.of(false) });
    }
  }

  /** 设置变更后更新 Tab 宽度，无需重建编辑器。 */
  setTabSize(size: number): void {
    if (size === this.tabSize) return;
    this.tabSize = size;
    this.view.dispatch({
      effects: this.tabSizeCompartment.reconfigure(buildIndentExtension(size, this.insertSpaces)),
    });
  }

  /** 设置变更后切换 Tab 输出单位（空格 ↔ 硬制表符），无需重建编辑器。 */
  setInsertSpaces(enabled: boolean): void {
    if (enabled === this.insertSpaces) return;
    this.insertSpaces = enabled;
    this.view.dispatch({
      effects: [
        setInsertSpacesEffect.of(enabled),
        this.tabSizeCompartment.reconfigure(buildIndentExtension(this.tabSize, enabled)),
      ],
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

  /** 更新行内差异高亮（对比视图）；传空数组关闭。 */
  setDiffInlineMarks(marks: readonly DiffInlineMark[]): void {
    this.view.dispatch({ effects: setDiffInlineMarksEffect.of(marks) });
  }

  /** 更新左右对齐用的占位行；高度按编辑器实际行高换算。 */
  setDiffSpacers(spacers: readonly DiffSpacer[]): void {
    const computed = Number.parseFloat(getComputedStyle(this.view.contentDOM).lineHeight);
    const lineHeight =
      Number.isFinite(computed) && computed > 0 ? computed : this.view.defaultLineHeight;
    this.view.dispatch({
      effects: setDiffSpacersEffect.of(
        spacers.map((spacer) => ({ ...spacer, height: spacer.count * lineHeight })),
      ),
    });
  }

  /** 滚动容器；Git 对比视图用于左右联动。 */
  get scroller(): HTMLElement {
    return this.view.scrollDOM;
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
        this.insertSpaces,
        this.lineWrapping,
      ),
    );
    if (!this.insertSpaces) {
      // 新 State 的 field 回到默认值；补齐硬 Tab 语义。
      this.view.dispatch({ effects: setInsertSpacesEffect.of(false) });
    }
  }

  focus(): void {
    this.view.focus();
  }

  openSearch(
    mode: SearchMode = "find",
    seed?: string,
    replacement?: string,
    options?: SearchOptions,
  ): void {
    openSourceSearch(this.view, mode, seed, replacement, options);
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

  /**
   * 按行/列定位光标，并把目标行放到视口约 1/3 高度处，
   * 为跳转后的上文阅读留出空间（逐处改动跳转使用）。
   */
  setCursorAtRatio(cursor: { line: number; column: number }, ratio = 1 / 3): void {
    const lineInfo = this.view.state.doc.line(
      Math.min(Math.max(1, cursor.line), this.view.state.doc.lines),
    );
    const offset = Math.min(lineInfo.to, lineInfo.from + Math.max(0, cursor.column - 1));
    this.view.dispatch({
      selection: { anchor: offset },
      scrollIntoView: true,
    });
    const scroller = this.view.scrollDOM;
    const coords = this.view.coordsAtPos(offset);
    if (coords) {
      const rect = scroller.getBoundingClientRect();
      scroller.scrollTop += coords.top - (rect.top + rect.height * ratio);
    }
    this.view.focus();
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

  /** 当前折叠的起始行号列表（会话持久化）。见 doc/design.md §21.6。 */
  getFolds(): number[] {
    const folds = this.view.state.field(foldState, false);
    if (!folds || folds.size === 0) return [];
    const doc = this.view.state.doc;
    const lines: number[] = [];
    const cursor = folds.iter();
    while (cursor.value) {
      lines.push(doc.lineAt(cursor.from).number);
      cursor.next();
    }
    return lines;
  }

  /** 恢复折叠状态：先全部展开，再对给定行做可折叠范围折叠。 */
  setFolds(lines: readonly number[]): void {
    const state = this.view.state;
    const effects: Array<StateEffect<unknown>> = [];
    const current = state.field(foldState, false);
    if (current && current.size > 0) {
      const cursor = current.iter();
      while (cursor.value) {
        effects.push(unfoldEffect.of({ from: cursor.from, to: cursor.to }));
        cursor.next();
      }
    }
    for (const line of lines) {
      if (!Number.isInteger(line) || line < 1 || line > state.doc.lines) continue;
      const lineInfo = state.doc.line(line);
      const range = foldable(state, lineInfo.from, lineInfo.to);
      if (range) effects.push(foldEffect.of(range));
    }
    if (effects.length > 0) this.view.dispatch({ effects });
  }

  /**
   * 按行区间折叠（1 基、闭区间）；用于 Git 对比隐藏未改动区域。
   * 先展开现有折叠，避免与语法折叠或上次结果叠加。
   */
  setLineFolds(ranges: ReadonlyArray<{ fromLine: number; toLine: number }>): void {
    const state = this.view.state;
    const effects: Array<StateEffect<unknown>> = [];
    const current = state.field(foldState, false);
    if (current && current.size > 0) {
      const cursor = current.iter();
      while (cursor.value) {
        effects.push(unfoldEffect.of({ from: cursor.from, to: cursor.to }));
        cursor.next();
      }
    }
    for (const range of ranges) {
      const from = Math.max(1, Math.min(range.fromLine, state.doc.lines));
      const to = Math.min(state.doc.lines, range.toLine);
      if (to <= from) continue;
      effects.push(
        foldEffect.of({ from: state.doc.line(from).from, to: state.doc.line(to).to }),
      );
    }
    if (effects.length > 0) this.view.dispatch({ effects });
  }

  /** 展开包含指定行的折叠（逐处跳转前调用，保证目标行可见）。 */
  unfoldAtLine(line: number): void {
    const state = this.view.state;
    const folds = state.field(foldState, false);
    if (!folds || folds.size === 0) return;
    const pos = state.doc.line(Math.max(1, Math.min(line, state.doc.lines))).from;
    const effects: Array<StateEffect<unknown>> = [];
    const cursor = folds.iter();
    while (cursor.value) {
      if (cursor.from <= pos && pos <= cursor.to) {
        effects.push(unfoldEffect.of({ from: cursor.from, to: cursor.to }));
      }
      cursor.next();
    }
    if (effects.length > 0) this.view.dispatch({ effects });
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
