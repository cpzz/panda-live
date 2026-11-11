import type { Node as PMNode } from "prosemirror-model";
import type { NodeView } from "prosemirror-view";
import { t } from "../../i18n";

/**
 * MyST `tab-set` 容器：页签状态由 NodeView 本地维护，不进入文档。见 doc/design.md §11.1。
 * 非当前页签的 `tab_item` 由 CSS 依据 `data-active` 隐藏。
 */
export class TabSetNodeView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly bar: HTMLElement;
  private buttons: HTMLButtonElement[] = [];
  private labels: string[] = [];
  private active = 0;

  constructor(node: PMNode) {
    this.dom = document.createElement("div");
    this.dom.className = "myst-tab-set";

    this.bar = document.createElement("div");
    this.bar.className = "myst-tab-bar";
    this.bar.contentEditable = "false";

    this.contentDOM = document.createElement("div");
    this.contentDOM.className = "myst-tab-body";

    this.dom.append(this.bar, this.contentDOM);
    this.sync(node);
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "tab_set") return false;
    this.sync(node);
    return true;
  }

  stopEvent(event: Event): boolean {
    // 页签按钮的点击不应交给 ProseMirror 处理选区。
    return this.bar.contains(event.target as globalThis.Node);
  }

  private sync(node: PMNode): void {
    const labels: string[] = [];
    node.content.forEach((child, _offset, index) => {
      labels.push(String(child.attrs.label ?? "") || t("页签 {0}", index + 1));
    });
    const changed = labels.length !== this.labels.length || labels.some((label, index) => label !== this.labels[index]);
    if (changed) {
      this.labels = labels;
      this.rebuildButtons();
    }
    if (this.active >= labels.length) this.active = Math.max(0, labels.length - 1);
    this.applyActive();
  }

  private rebuildButtons(): void {
    this.buttons = [];
    this.bar.replaceChildren();
    this.labels.forEach((label, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "myst-tab-button";
      button.textContent = label || t("页签 {0}", index + 1);
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        this.active = index;
        this.applyActive();
      });
      this.buttons.push(button);
      this.bar.append(button);
    });
  }

  private applyActive(): void {
    this.dom.setAttribute("data-active", String(this.active));
    this.buttons.forEach((button, index) => {
      const isActive = index === this.active;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-selected", String(isActive));
    });
  }
}

/** MyST `grid` 容器：列数与轮廓由 attrs 控制。 */
export class GridNodeView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;

  constructor(node: PMNode) {
    this.dom = document.createElement("div");
    this.dom.className = "myst-grid";
    this.contentDOM = this.dom;
    this.apply(node);
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "grid") return false;
    this.apply(node);
    return true;
  }

  private apply(node: PMNode): void {
    const columns = Math.min(12, Math.max(1, Number(node.attrs.columns) || 2));
    this.dom.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
    this.dom.classList.toggle("myst-grid-outline", Boolean(node.attrs.outline));
  }
}
