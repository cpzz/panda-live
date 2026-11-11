import { EditorState, type Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  cellAround,
  deleteColumn,
  deleteRow,
  deleteTable,
  TableMap,
} from "prosemirror-tables";
import { MathNodeView } from "./nodeviews/math";
import { MathmlNodeView } from "./nodeviews/mathml";
import { DiagramNodeView } from "./nodeviews/diagram";
import { GridNodeView, TabSetNodeView } from "./nodeviews/directive";
import type { PMJson } from "./schema";
import { createWysiwygState } from "./state";
import { wysiwygDiffKey } from "./plugins/diff";
import type { WysiwygDiffModel } from "../diff/wysiwyg";
import {
  clearSearch,
  findNextMatch,
  getSearchState,
  replaceAllMatches,
  replaceCurrentMatch,
  setSearch,
} from "./search";
import type { SearchOptions } from "../services/search";
import { t } from "../i18n";

export interface PandaEditorOptions {
  parent: HTMLElement;
  docJson: PMJson;
  readOnly: boolean;
  /** 所属文档 ID，用于把节点级诊断汇入问题面板。 */
  documentId: string;
  /** 文档变化后回调 ProseMirror JSON；序列化由调用方负责。 */
  onChange(docJson: PMJson): void;
}

/** 与光标同列的整列对齐；序列化时以表头对齐为准，因此需要同时更新表头单元格。 */
function setColumnAlign(align: "left" | "center" | "right"): Command {
  return (state, dispatch) => {
    const $cell = cellAround(state.selection.$from);
    if (!$cell) return false;
    if (!dispatch) return true;

    const table = $cell.node(-1);
    const tableStart = $cell.start(-1);
    const map = TableMap.get(table);
    const column = map.findCell($cell.pos - tableStart).left;
    const tr = state.tr;
    for (let row = 0; row < map.height; row += 1) {
      const offset = map.map[row * map.width + column];
      if (offset === undefined) continue;
      const node = tr.doc.nodeAt(tableStart + offset);
      if (!node) continue;
      tr.setNodeMarkup(tableStart + offset, undefined, { ...node.attrs, align });
    }
    dispatch(tr);
    return true;
  };
}

/** ProseMirror 编辑器封装；不依赖 React，也不直接读写文件。见 doc/design.md §11. */
export class PandaEditor {
  private readonly view: EditorView;
  private readonly tableToolbar: HTMLDivElement;
  private readOnly: boolean;

  constructor(private readonly options: PandaEditorOptions) {
    this.readOnly = options.readOnly;
    this.view = new EditorView(options.parent, {
      state: createWysiwygState(options.docJson),
      attributes: { class: "markdown-body prose-editor", spellcheck: "false" },
      editable: () => !this.readOnly,
      nodeViews: {
        math_inline: (node, view, getPos) => new MathNodeView(node, view, getPos, false, options.documentId),
        math_block: (node, view, getPos) => new MathNodeView(node, view, getPos, true, options.documentId),
        mathml_inline: (node) => new MathmlNodeView(node, false),
        mathml_block: (node) => new MathmlNodeView(node, true),
        diagram_block: (node, view, getPos) => new DiagramNodeView(node, view, getPos, options.documentId),
        tab_set: (node) => new TabSetNodeView(node),
        grid: (node) => new GridNodeView(node),
      },
      dispatchTransaction: (transaction) => {
        const state = this.view.state.apply(transaction);
        this.view.updateState(state);
        this.updateTableToolbar();
        if (transaction.docChanged) {
          this.options.onChange(state.doc.toJSON() as PMJson);
        }
      },
    });

    this.tableToolbar = this.buildTableToolbar();
    options.parent.append(this.tableToolbar);
    window.addEventListener("scroll", this.handleViewportChange, true);
    window.addEventListener("resize", this.handleViewportChange);
    this.view.dom.addEventListener("blur", this.handleEditorBlur);
  }

  get state(): EditorState {
    return this.view.state;
  }

  private readonly handleViewportChange = (): void => {
    this.updateTableToolbar();
  };

  private readonly handleEditorBlur = (): void => {
    this.tableToolbar.hidden = true;
  };

  private buildTableToolbar(): HTMLDivElement {
    const toolbar = document.createElement("div");
    toolbar.className = "table-toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", t("表格操作"));
    toolbar.hidden = true;

    const actions: Array<{ label: string; title: string; command: Command }> = [
      { label: t("↑行"), title: t("在上方插入行"), command: addRowBefore },
      { label: t("↓行"), title: t("在下方插入行"), command: addRowAfter },
      { label: t("←列"), title: t("在左侧插入列"), command: addColumnBefore },
      { label: t("→列"), title: t("在右侧插入列"), command: addColumnAfter },
      { label: t("删行"), title: t("删除行"), command: deleteRow },
      { label: t("删列"), title: t("删除列"), command: deleteColumn },
      { label: t("左"), title: t("左对齐"), command: setColumnAlign("left") },
      { label: t("中"), title: t("居中"), command: setColumnAlign("center") },
      { label: t("右"), title: t("右对齐"), command: setColumnAlign("right") },
      { label: t("删表"), title: t("删除表格"), command: deleteTable },
    ];

    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "table-toolbar-button";
      button.textContent = action.label;
      button.title = action.title;
      button.setAttribute("aria-label", action.title);
      // 保持编辑器焦点，避免失焦时工具条消失。
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        action.command(this.view.state, this.view.dispatch, this.view);
        this.view.focus();
      });
      toolbar.append(button);
    }
    return toolbar;
  }

  /** 找到包含当前选区的表格节点位置。 */
  private findTablePos(): number | null {
    const { $from } = this.view.state.selection;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if ($from.node(depth).type.name === "table") return $from.before(depth);
    }
    return null;
  }

  /** 选区在表格内且编辑器聚焦时，在表格上方显示行列工具条。见 doc/design.md §15.1。 */
  private updateTableToolbar(): void {
    if (!this.readOnly && this.view.hasFocus()) {
      const tablePos = this.findTablePos();
      const tableDom = tablePos === null ? null : this.view.nodeDOM(tablePos);
      if (tableDom instanceof HTMLElement) {
        this.tableToolbar.hidden = false;
        const rect = tableDom.getBoundingClientRect();
        const toolbarRect = this.tableToolbar.getBoundingClientRect();
        const height = toolbarRect.height || 30;
        const width = toolbarRect.width || 360;
        let top = rect.top - height - 6;
        if (top < 8) top = rect.bottom + 6;
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
        this.tableToolbar.style.left = `${Math.round(left)}px`;
        this.tableToolbar.style.top = `${Math.round(top)}px`;
        return;
      }
    }
    this.tableToolbar.hidden = true;
  }

  /** 恢复标签页维度的编辑器状态（保留撤销历史）。 */
  setState(state: EditorState): void {
    this.view.updateState(state);
    this.updateTableToolbar();
  }

  /** 用新内容重建状态并建立新的撤销基线（模式切换、外部重载）。 */
  reset(docJson: PMJson, readOnly: boolean): void {
    this.readOnly = readOnly;
    this.view.updateState(createWysiwygState(docJson));
    this.updateTableToolbar();
  }

  focus(): void {
    this.view.focus();
  }

  /** 滚动到第 index 个标题（从 0 开始），用于大纲跳转。见 doc/design.md §15.1。 */
  scrollToHeading(index: number): void {
    let count = 0;
    let target: number | null = null;
    this.view.state.doc.descendants((node, pos) => {
      if (target !== null) return false;
      if (node.type.name !== "heading") return true;
      if (count === index) {
        target = pos;
        return false;
      }
      count += 1;
      return true;
    });
    if (target === null) return;
    this.scrollToPosition(target + 1);
  }

  /**
   * 滚动到页内锚点：优先匹配标题 id，其次匹配原始 HTML 锚点（`<a id="…">`）。
   * 用于 Markdown 目录跳转；WYSIWYG 不保留锚点元素，因此按节点 raw 属性匹配。
   */
  scrollToAnchorId(id: string): boolean {
    let target: number | null = null;
    this.view.state.doc.descendants((node, pos) => {
      if (target !== null) return false;
      // 标题自带 id（与大纲一致），可直接作为锚点目标。
      if (node.type.name === "heading") {
        if (String(node.attrs.id ?? "") !== id) return true;
        target = pos;
        return false;
      }
      if (node.type.name !== "html_block" && node.type.name !== "html_inline") return true;
      const raw = String(node.attrs.raw ?? "");
      const match = /\bid\s*=\s*(["'])(.*?)\1/iu.exec(raw);
      if (!match || match[2] !== id) return true;
      target = pos;
      return false;
    });
    if (target === null) return false;
    const dom = this.view.nodeDOM(target);
    if (!(dom instanceof HTMLElement)) return false;
    dom.scrollIntoView({ block: "center", behavior: "smooth" });
    dom.classList.add("anchor-target");
    window.setTimeout(() => dom.classList.remove("anchor-target"), 900);
    return true;
  }

  /** 应用或清除差异装饰；传 null 清除。见 doc/design.md §21.5。 */
  setDiffModel(model: WysiwygDiffModel | null): void {
    this.view.dispatch(this.view.state.tr.setMeta(wysiwygDiffKey, model));
  }

  /** 滚动到第 index 个顶层块，用于改动导航。 */
  scrollToBlockIndex(index: number): void {
    let target: number | null = null;
    let count = 0;
    this.view.state.doc.forEach((_node, offset) => {
      if (target !== null) return;
      if (count === index) {
        target = offset;
        return;
      }
      count += 1;
    });
    if (target === null) return;
    this.scrollToPosition(target + 1, true);
  }

  private scrollToPosition(pos: number, flash = false): void {
    const dom = this.view.domAtPos(pos);
    const element = dom.node.nodeType === 1 ? (dom.node as HTMLElement) : dom.node.parentElement;
    if (!element) return;
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    if (flash) {
      element.classList.add("diff-target");
      setTimeout(() => element.classList.remove("diff-target"), 600);
    }
  }

  /** 查找：返回当前匹配序号（从 1 开始）与总数。见 doc/design.md §11.5。 */
  search(term: string, options: SearchOptions): { active: number; total: number } {
    const state = setSearch(this.view, term, options);
    return {
      active: state.ranges.length > 0 ? state.active + 1 : 0,
      total: state.ranges.length,
    };
  }

  findNext(direction: 1 | -1): { active: number; total: number } {
    const index = findNextMatch(this.view, direction);
    const state = getSearchState(this.view);
    return { active: index >= 0 ? index + 1 : 0, total: state?.ranges.length ?? 0 };
  }

  replaceCurrent(replacement: string): number {
    return replaceCurrentMatch(this.view, replacement);
  }

  replaceAll(replacement: string): number {
    return replaceAllMatches(this.view, replacement);
  }

  clearSearch(): void {
    clearSearch(this.view);
  }

  destroy(): void {
    window.removeEventListener("scroll", this.handleViewportChange, true);
    window.removeEventListener("resize", this.handleViewportChange);
    this.view.dom.removeEventListener("blur", this.handleEditorBlur);
    this.tableToolbar.remove();
    this.view.destroy();
  }
}
