import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView, ViewMutationRecord } from "prosemirror-view";
import { t } from "../../i18n";
import { highlightCodeToHtml } from "../../render/code-highlight";
import { onThemeChange, resolveTheme, type AppTheme } from "../../services/theme";

/**
 * 语言下拉的可选值；空字符串表示纯文本。
 * plantuml / mermaid 由 diagram_block 处理，不在此列（选中会在重新解析时变成图表）。
 */
const LANGUAGES = [
  "",
  "text",
  "javascript",
  "typescript",
  "jsx",
  "tsx",
  "json",
  "html",
  "css",
  "scss",
  "python",
  "java",
  "c",
  "cpp",
  "csharp",
  "go",
  "rust",
  "ruby",
  "php",
  "sql",
  "bash",
  "powershell",
  "yaml",
  "toml",
  "xml",
  "markdown",
  "latex",
  "diff",
];

/** 高亮防抖：连续输入时只在停顿后重新着色。 */
const HIGHLIGHT_DELAY = 120;

/**
 * 代码块 NodeView：右上角语言选择，主体为可编辑的 `<pre><code>`；
 * 未聚焦时用 Shiki 高亮层覆盖显示（聚焦后隐藏，保证光标与选区可读）。
 * 语言写入 `code_block.language`，序列化为围栏 info string。见 doc/design.md §11.3。
 */
export class CodeBlockNodeView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly header: HTMLElement;
  private readonly select: HTMLSelectElement;
  private readonly pre: HTMLPreElement;
  private readonly highlight: HTMLElement;
  private node: PMNode;
  private theme: AppTheme = resolveTheme();
  private highlightTimer: number | null = null;
  private highlightKey = "";
  private highlightSeq = 0;
  private readonly stopTheme: () => void;

  constructor(
    node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly isReadOnly: () => boolean,
  ) {
    this.node = node;
    this.dom = document.createElement("div");
    this.dom.className = "code-block-node";

    this.header = document.createElement("div");
    this.header.className = "code-block-header";
    this.header.contentEditable = "false";

    this.select = document.createElement("select");
    this.select.className = "code-lang-select";
    this.select.setAttribute("aria-label", t("代码语言"));
    for (const value of LANGUAGES) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value || t("纯文本");
      this.select.append(option);
    }
    this.select.addEventListener("change", () => {
      if (this.isReadOnly()) return;
      const pos = this.getPos();
      if (pos == null) return;
      this.view.dispatch(
        this.view.state.tr.setNodeMarkup(pos, undefined, {
          ...this.node.attrs,
          language: this.select.value,
        }),
      );
      this.view.focus();
    });
    this.header.append(this.select);
    this.dom.append(this.header);

    const body = document.createElement("div");
    body.className = "code-block-body";

    this.pre = document.createElement("pre");
    this.contentDOM = document.createElement("code");
    this.contentDOM.className = "code-block-content";
    this.pre.append(this.contentDOM);
    body.append(this.pre);

    this.highlight = document.createElement("div");
    this.highlight.className = "code-block-highlight";
    this.highlight.contentEditable = "false";
    this.highlight.setAttribute("aria-hidden", "true");
    body.append(this.highlight);
    this.dom.append(body);

    // 高亮层不接收事件，横向滚动由底层 pre 承担，这里同步偏移保持对齐。
    this.pre.addEventListener("scroll", () => {
      this.highlight.scrollLeft = this.pre.scrollLeft;
      this.highlight.scrollTop = this.pre.scrollTop;
    });
    // 聚焦编辑时隐藏高亮层，失焦后重新着色。
    this.contentDOM.addEventListener("focusin", () => this.clearHighlight());
    this.dom.addEventListener("focusout", () => this.scheduleHighlight());

    this.stopTheme = onThemeChange((theme) => {
      this.theme = theme;
      this.highlightKey = "";
      this.scheduleHighlight();
    });

    this.renderLanguage(String(node.attrs["language"] ?? ""));
    this.select.disabled = this.isReadOnly();
    this.scheduleHighlight();
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "code_block") return false;
    this.node = node;
    this.renderLanguage(String(node.attrs["language"] ?? ""));
    this.select.disabled = this.isReadOnly();
    this.scheduleHighlight();
    return true;
  }

  destroy(): void {
    if (this.highlightTimer !== null) window.clearTimeout(this.highlightTimer);
    this.highlightTimer = null;
    // 让进行中的异步高亮结果失效。
    this.highlightSeq += 1;
    this.stopTheme();
  }

  /** 语言选择器由原生控件处理，不交给 ProseMirror；正文区域仍走默认点击定位。 */
  stopEvent(event: Event): boolean {
    return event.target instanceof Node && this.header.contains(event.target);
  }

  /** 头部、高亮层与属性变化不是文档内容变更，避免 ProseMirror 重新解析。 */
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (mutation.type === "selection") return false;
    return !this.contentDOM.contains(mutation.target);
  }

  private renderLanguage(language: string): void {
    if (![...this.select.options].some((option) => option.value === language)) {
      const option = document.createElement("option");
      option.value = language;
      option.textContent = language;
      this.select.append(option);
    }
    this.select.value = language;
    this.dom.dataset["language"] = language;
  }

  private scheduleHighlight(): void {
    if (this.highlightTimer !== null) window.clearTimeout(this.highlightTimer);
    this.highlightTimer = window.setTimeout(() => {
      this.highlightTimer = null;
      void this.renderHighlight();
    }, HIGHLIGHT_DELAY);
  }

  private clearHighlight(): void {
    this.highlightKey = "";
    this.highlight.replaceChildren();
    this.dom.classList.remove("has-highlight");
  }

  private async renderHighlight(): Promise<void> {
    const language = String(this.node.attrs["language"] ?? "").trim();
    // 聚焦编辑时显示原始文本，避免高亮层遮挡光标与选区。
    if (!language || this.dom.contains(document.activeElement)) {
      this.clearHighlight();
      return;
    }
    const text = this.node.textContent;
    const key = `${this.theme}\u0000${language}\u0000${text}`;
    if (key === this.highlightKey) return;
    const seq = ++this.highlightSeq;
    const html = await highlightCodeToHtml(text, language, this.theme);
    // 异步返回时节点内容/语言/主题可能已变化，丢弃过期结果。
    if (seq !== this.highlightSeq || !html) return;
    const template = document.createElement("template");
    template.innerHTML = html;
    const pre = template.content.firstElementChild;
    if (!(pre instanceof HTMLElement)) return;
    // Shiki 默认给 pre 加 tabindex=0，这里避免高亮层进入 Tab 顺序。
    pre.tabIndex = -1;
    this.highlightKey = key;
    this.highlight.replaceChildren(pre);
    this.highlight.scrollLeft = this.pre.scrollLeft;
    this.highlight.scrollTop = this.pre.scrollTop;
    this.dom.classList.add("has-highlight");
  }
}
