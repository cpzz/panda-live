import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  selectMatches,
  setSearchQuery,
  SearchQuery,
} from "@codemirror/search";
import type { EditorView, Panel, ViewUpdate } from "@codemirror/view";
import { t } from "../i18n";
import { buildSearchRegex, findMatches, type SearchMode, type SearchOptions } from "../services/search";

/** 面板创建时读取的最近一次模式；面板关闭后清除，下次默认查找。 */
const requestedMode = new WeakMap<EditorView, SearchMode>();
/** 已打开的面板实例；用于面板打开时原地切换模式。 */
const openPanels = new WeakMap<EditorView, SourceSearchPanel>();

function isMac(): boolean {
  return typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

function field(placeholder: string, label: string, value: string): HTMLInputElement {
  const input = createElement("input", "search-input");
  input.type = "text";
  input.placeholder = placeholder;
  input.setAttribute("aria-label", label);
  input.value = value;
  return input;
}

/** 源码面板使用命令式 DOM，图标以 SVG 字符串内联，保持与 React 图标一致。 */
const ICON_ATTRS =
  'width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const CHEVRON_RIGHT_ICON = `<svg ${ICON_ATTRS}><path d="m9 18 6-6-6-6"/></svg>`;
const CHEVRON_DOWN_ICON = `<svg ${ICON_ATTRS}><path d="m6 9 6 6 6-6"/></svg>`;
const CHEVRON_UP_ICON = `<svg ${ICON_ATTRS}><path d="m18 15-6-6-6 6"/></svg>`;
const SELECT_ALL_ICON = `<svg ${ICON_ATTRS}><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/><path d="m9 12 2 2 4-4"/></svg>`;
const REPLACE_ICON = `<svg ${ICON_ATTRS}><path d="M14 4a1 1 0 0 1 1-1"/><path d="M15 10a1 1 0 0 1-1-1"/><path d="M21 4a1 1 0 0 0-1-1"/><path d="M21 9a1 1 0 0 1-1 1"/><path d="m3 7 3 3 3-3"/><path d="M6 10V5a2 2 0 0 1 2-2h2"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>`;
const REPLACE_ALL_ICON = `<svg ${ICON_ATTRS}><path d="M14 14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1"/><path d="M14 4a1 1 0 0 1 1-1"/><path d="M15 10a1 1 0 0 1-1-1"/><path d="M19 14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1"/><path d="M21 4a1 1 0 0 0-1-1"/><path d="M21 9a1 1 0 0 1-1 1"/><path d="M6 10V5a2 2 0 0 1 2-2h2"/><path d="m3 7 3 3 3-3"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>`;

function svgButton(markup: string, label: string, title: string): HTMLButtonElement {
  const button = createElement("button", "find-icon");
  button.type = "button";
  button.innerHTML = markup;
  button.setAttribute("aria-label", label);
  button.title = title;
  return button;
}

function replaceToggleTitle(mode: SearchMode): string {
  if (mode === "replace") return t("收起替换（Ctrl+F）");
  return isMac() ? t("展开替换") : t("展开替换（Ctrl+H）");
}

/**
 * 源码模式查找/替换面板：与所见即所得面板一致，查找与替换分行显示。
 * Ctrl+F 仅查找，Ctrl+H 展开替换；Esc 关闭，不提供关闭按钮。见 doc/design.md §11.5。
 */
export class SourceSearchPanel implements Panel {
  readonly dom: HTMLElement;
  /** 查找面板固定在编辑区顶部（CodeMirror 默认在底部）。 */
  readonly top = true;

  private mode: SearchMode;
  private query: SearchQuery;
  private caseSensitive: boolean;
  private regexp: boolean;
  private wholeWord: boolean;
  private readonly searchField: HTMLInputElement;
  private readonly replaceField: HTMLInputElement;
  private readonly replaceRow: HTMLElement;
  private readonly expandButton: HTMLButtonElement;
  private readonly caseButton: HTMLButtonElement;
  private readonly regexpButton: HTMLButtonElement;
  private readonly wordButton: HTMLButtonElement;
  private readonly countEl: HTMLSpanElement;
  /** 计数延迟计算，避免大文档每次输入都全文扫描。 */
  private countTimer: ReturnType<typeof setTimeout> | null = null;
  /** 面板打开期间的全局 Esc：焦点不在输入框时也能关闭。 */
  private readonly onWindowKeyDown: (event: KeyboardEvent) => void;

  constructor(private readonly view: EditorView, mode: SearchMode) {
    this.query = getSearchQuery(view.state);
    this.mode = mode;
    this.caseSensitive = this.query.caseSensitive;
    this.regexp = this.query.regexp;
    this.wholeWord = this.query.wholeWord;
    requestedMode.set(view, mode);
    openPanels.set(view, this);

    this.searchField = field(t("查找"), t("查找内容"), this.query.search);
    this.searchField.name = "search";
    this.searchField.setAttribute("main-field", "true");
    this.replaceField = field(t("替换为"), t("替换内容"), this.query.replace);
    this.replaceField.name = "replace";

    this.expandButton = createElement("button", "find-toggle search-expand");
    this.expandButton.type = "button";
    this.expandButton.name = "toggleReplace";
    this.caseButton = createElement("button", "find-toggle");
    this.caseButton.type = "button";
    this.caseButton.name = "case";
    this.caseButton.textContent = "Aa";
    this.caseButton.setAttribute("aria-label", t("区分大小写"));
    this.caseButton.title = t("区分大小写");
    this.regexpButton = createElement("button", "find-toggle");
    this.regexpButton.type = "button";
    this.regexpButton.name = "re";
    this.regexpButton.textContent = ".*";
    this.regexpButton.setAttribute("aria-label", t("正则"));
    this.regexpButton.title = t("使用正则表达式");
    this.wordButton = createElement("button", "find-toggle");
    this.wordButton.type = "button";
    this.wordButton.name = "word";
    this.wordButton.textContent = "ab";
    this.wordButton.setAttribute("aria-label", t("全词"));
    this.wordButton.title = t("全词匹配");
    this.countEl = createElement("span", "search-count");
    this.countEl.setAttribute("aria-live", "polite");
    this.countEl.textContent = "0 / 0";
    this.syncToggles();

    const selectButton = svgButton(SELECT_ALL_ICON, t("选中全部匹配"), t("选中全部匹配"));
    selectButton.name = "select";
    const previousButton = svgButton(CHEVRON_UP_ICON, t("上一个"), t("上一个（Shift+Enter）"));
    previousButton.name = "prev";
    const nextButton = svgButton(CHEVRON_DOWN_ICON, t("下一个"), t("下一个（Enter）"));
    nextButton.name = "next";
    const replaceButton = svgButton(REPLACE_ICON, t("替换"), t("替换（Enter）"));
    replaceButton.name = "replace";
    const replaceAllButton = svgButton(REPLACE_ALL_ICON, t("全部替换"), t("全部替换"));
    replaceAllButton.name = "replaceAll";

    const findRow = createElement("div", "search-row");
    findRow.append(
      this.expandButton,
      this.searchField,
      this.caseButton,
      this.regexpButton,
      this.wordButton,
      selectButton,
      this.countEl,
      previousButton,
      nextButton,
    );
    this.replaceRow = createElement("div", "search-row search-replace-row");
    const replaceSpacer = createElement("span", "search-spacer");
    replaceSpacer.setAttribute("aria-hidden", "true");
    this.replaceRow.append(replaceSpacer, this.replaceField, replaceButton, replaceAllButton);

    this.dom = createElement("div", "source-search-panel");
    this.dom.setAttribute("role", "search");
    this.dom.append(findRow, this.replaceRow);
    this.setMode(mode);

    this.expandButton.addEventListener("click", () => {
      const next = this.mode === "replace" ? "find" : "replace";
      this.setMode(next);
      this.focus(next);
    });
    this.caseButton.addEventListener("click", () => {
      this.caseSensitive = !this.caseSensitive;
      this.syncToggles();
      this.commit();
    });
    this.regexpButton.addEventListener("click", () => {
      this.regexp = !this.regexp;
      this.syncToggles();
      this.commit();
    });
    this.wordButton.addEventListener("click", () => {
      this.wholeWord = !this.wholeWord;
      this.syncToggles();
      this.commit();
    });
    this.searchField.addEventListener("input", () => this.commit());
    this.replaceField.addEventListener("input", () => this.commit());
    selectButton.addEventListener("click", () => {
      selectMatches(view);
    });
    previousButton.addEventListener("click", () => {
      findPrevious(view);
    });
    nextButton.addEventListener("click", () => {
      findNext(view);
    });
    replaceButton.addEventListener("click", () => {
      replaceNext(view);
    });
    replaceAllButton.addEventListener("click", () => {
      replaceAll(view);
    });
    this.dom.addEventListener("keydown", (event) => this.onKeyDown(event));
    this.onWindowKeyDown = (event) => {
      if (event.key !== "Escape") return;
      if (!this.dom.isConnected || this.dom.offsetParent === null) return;
      event.preventDefault();
      closeSearchPanel(view);
    };
    window.addEventListener("keydown", this.onWindowKeyDown, true);
    this.updateCount();
  }

  /** 打开面板或切换模式时聚焦对应输入：查找模式聚焦查找框，替换模式聚焦替换框。 */
  focus(mode: SearchMode = this.mode): void {
    const target = mode === "replace" ? this.replaceField : this.searchField;
    target.focus();
    target.select();
  }

  /** 切换查找/替换模式；替换文本保留在隐藏的输入框中。 */
  setMode(mode: SearchMode): void {
    this.mode = mode;
    requestedMode.set(this.view, mode);
    this.replaceRow.hidden = mode === "find";
    this.expandButton.innerHTML = mode === "replace" ? CHEVRON_DOWN_ICON : CHEVRON_RIGHT_ICON;
    this.expandButton.setAttribute("aria-expanded", String(mode === "replace"));
    this.expandButton.setAttribute("aria-label", mode === "replace" ? t("收起替换") : t("展开替换"));
    this.expandButton.title = replaceToggleTitle(mode);
  }

  update(update: ViewUpdate): void {
    for (const transaction of update.transactions) {
      for (const effect of transaction.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) this.applyQuery(effect.value);
      }
    }
    this.scheduleCount();
  }

  destroy(): void {
    if (this.countTimer) clearTimeout(this.countTimer);
    window.removeEventListener("keydown", this.onWindowKeyDown, true);
    if (openPanels.get(this.view) === this) openPanels.delete(this.view);
    requestedMode.delete(this.view);
  }

  private applyQuery(query: SearchQuery): void {
    this.query = query;
    this.searchField.value = query.search;
    this.replaceField.value = query.replace;
    this.caseSensitive = query.caseSensitive;
    this.regexp = query.regexp;
    this.wholeWord = query.wholeWord;
    this.syncToggles();
    this.scheduleCount();
  }

  private scheduleCount(): void {
    if (this.countTimer) clearTimeout(this.countTimer);
    this.countTimer = setTimeout(() => this.updateCount(), 120);
  }

  /** 显示「当前位置 / 匹配总数」；无匹配或空查询显示 0 / 0。 */
  private updateCount(): void {
    const query = getSearchQuery(this.view.state);
    if (!query.search) {
      this.countEl.textContent = "0 / 0";
      return;
    }
    const options = {
      caseSensitive: query.caseSensitive,
      regex: query.regexp,
      wholeWord: query.wholeWord,
    };
    if (query.regexp && buildSearchRegex(query.search, options) === null) {
      this.countEl.textContent = t("正则无效");
      return;
    }
    const ranges = findMatches(this.view.state.doc.toString(), query.search, options);
    if (ranges.length === 0) {
      this.countEl.textContent = "0 / 0";
      return;
    }
    const head = this.view.state.selection.main.from;
    const index = ranges.findIndex((range) => head >= range.start && head <= range.end);
    this.countEl.textContent = `${index >= 0 ? index + 1 : 1} / ${ranges.length}`;
  }

  private commit(): void {
    const query = new SearchQuery({
      search: this.searchField.value,
      caseSensitive: this.caseSensitive,
      regexp: this.regexp,
      wholeWord: this.wholeWord,
      replace: this.replaceField.value,
    });
    if (query.eq(this.query)) return;
    this.query = query;
    this.view.dispatch({ effects: setSearchQuery.of(query) });
  }

  private syncToggles(): void {
    for (const [button, active] of [
      [this.caseButton, this.caseSensitive],
      [this.regexpButton, this.regexp],
      [this.wordButton, this.wholeWord],
    ] as const) {
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearchPanel(this.view);
      return;
    }
    if (event.key !== "Enter") return;
    // Enter 在查找框跳到下一个匹配，Shift+Enter 跳到上一个；替换框 Enter 替换当前匹配。
    if (event.target === this.searchField) {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(this.view);
    } else if (event.target === this.replaceField) {
      event.preventDefault();
      replaceNext(this.view);
    }
  }
}

/** 查找配置的 createPanel：面板创建时读取 Ctrl+F / Ctrl+H 请求的模式。 */
export function createSourceSearchPanel(view: EditorView): Panel {
  return new SourceSearchPanel(view, requestedMode.get(view) ?? "find");
}

/** 打开源码查找面板并切换模式；面板已打开时原地切换，保留输入内容。 */
export function openSourceSearch(
  view: EditorView,
  mode: SearchMode,
  seed?: string,
  replacement?: string,
  options?: SearchOptions,
): void {
  requestedMode.set(view, mode);
  if (seed !== undefined || replacement !== undefined || options !== undefined) {
    const current = getSearchQuery(view.state);
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: seed ?? current.search,
          caseSensitive: options?.caseSensitive ?? current.caseSensitive,
          regexp: options?.regex ?? current.regexp,
          wholeWord: options?.wholeWord ?? current.wholeWord,
          replace: replacement ?? current.replace,
        }),
      ),
    });
  }
  const panel = openPanels.get(view);
  if (panel) {
    panel.setMode(mode);
    panel.focus(mode);
    return;
  }
  openSearchPanel(view);
  openPanels.get(view)?.focus(mode);
}
