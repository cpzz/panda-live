import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";
import {
  currentDiagramTheme,
  getDiagramService,
  onDiagramThemeChange,
} from "../../render/diagram";
import type { DiagramKind } from "../../render/diagram/types";
import { t } from "../../i18n";
import { problemStore } from "../../services/problem-store";
import { DIAGRAM_OPEN_EVENT } from "../../render/markdown/diagram-preview";

/**
 * 图表节点：视口懒渲染 + 双击源码编辑 + 错误卡片。见 doc/design.md §10.1、§11.3。
 * 异步结果以「节点 ID + 输入键」校验，过期结果直接丢弃。
 */
export class DiagramNodeView implements NodeView {
  readonly dom: HTMLElement;
  private readonly body: HTMLElement;
  private readonly header: HTMLElement;
  private readonly instanceId: string;
  private node: PMNode;
  private renderKey: string | null = null;
  private token = 0;
  private visible = false;
  private observer: IntersectionObserver | null = null;
  private themeCleanup: () => void;
  private editing = false;
  private readonly toggleButton: HTMLButtonElement;
  private readonly expandButton: HTMLButtonElement;
  private textarea: HTMLTextAreaElement | null = null;
  private destroyed = false;
  /** 最近一次成功渲染的 SVG（已消毒）；「放大查看」直接复用，不重新渲染。 */
  private lastSvg: string | null = null;

  constructor(
    node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly documentId?: string,
    private readonly isReadOnly: () => boolean = () => false,
  ) {
    this.node = node;
    this.instanceId = `diagram-${Math.random().toString(36).slice(2, 10)}`;

    this.dom = document.createElement("div");
    this.dom.className = "diagram-node";
    this.dom.contentEditable = "false";
    this.dom.setAttribute("data-kind", this.kind);

    this.header = document.createElement("div");
    this.header.className = "diagram-node-header";
    const label = document.createElement("span");
    label.className = "diagram-kind";
    label.textContent = this.kind === "mermaid" ? "Mermaid" : this.kind === "plantuml" ? "PlantUML" : this.kind;
    const actions = document.createElement("span");
    actions.className = "diagram-actions";
    // 开关按钮：按下显示代码编辑窗，弹起关闭并提交。
    this.toggleButton = document.createElement("button");
    this.toggleButton.type = "button";
    this.toggleButton.className = "button small ghost";
    this.toggleButton.textContent = t("编辑代码");
    this.toggleButton.setAttribute("aria-pressed", "false");
    this.toggleButton.disabled = this.isReadOnly();
    this.toggleButton.addEventListener("mousedown", (event) => event.preventDefault());
    this.toggleButton.addEventListener("click", () => {
      if (this.isReadOnly()) return;
      if (this.editing) {
        this.commitEditing();
      } else {
        this.startEditing();
      }
    });
    this.expandButton = document.createElement("button");
    this.expandButton.type = "button";
    this.expandButton.className = "button small ghost";
    this.expandButton.textContent = t("放大查看");
    this.expandButton.addEventListener("mousedown", (event) => event.preventDefault());
    this.expandButton.addEventListener("click", () => {
      if (!this.lastSvg) return;
      window.dispatchEvent(
        new CustomEvent(DIAGRAM_OPEN_EVENT, { detail: { svg: this.lastSvg } }),
      );
    });
    actions.append(this.toggleButton, this.expandButton);
    this.header.append(label, actions);

    this.body = document.createElement("div");
    this.body.className = "diagram-node-body";

    this.dom.append(this.header, this.body);
    this.dom.addEventListener("dblclick", () => {
      if (!this.isReadOnly()) this.startEditing();
    });

    this.themeCleanup = onDiagramThemeChange(() => {
      if (!this.visible || this.editing) return;
      this.renderKey = null;
      void this.render();
    });

    if (typeof IntersectionObserver === "function") {
      // 前后各 1 屏进入即渲染，其余显示源码占位。见 doc/design.md §10.1。
      this.observer = new IntersectionObserver(
        (entries) => {
          const entry = entries[0];
          if (!entry) return;
          this.visible = entry.isIntersecting;
          if (this.visible) {
            void this.render();
          } else {
            this.showPlaceholder();
          }
        },
        { rootMargin: "100% 0px" },
      );
      this.observer.observe(this.dom);
    } else {
      this.visible = true;
      void this.render();
    }
  }

  private get kind(): DiagramKind {
    return String(this.node.attrs.kind ?? "plantuml");
  }

  private get source(): string {
    return String(this.node.attrs.source ?? "");
  }

  private get nodeId(): string {
    return String(this.node.attrs.nodeId ?? this.instanceId);
  }

  private get key(): string {
    return `${this.kind}\u0000${currentDiagramTheme()}\u0000${this.source}`;
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const previous = this.key;
    this.node = node;
    this.toggleButton.disabled = this.isReadOnly();
    this.dom.setAttribute("data-kind", this.kind);
    const label = this.header.querySelector(".diagram-kind");
    if (label) label.textContent = this.kind === "mermaid" ? "Mermaid" : this.kind === "plantuml" ? "PlantUML" : this.kind;

    if (previous !== this.key) {
      this.renderKey = null;
      getDiagramService().cancel(`${this.nodeId}:${this.instanceId}`);
      if (!this.editing) void this.render();
    }
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  /**
   * 头部按钮与源码编辑框的事件不交给 ProseMirror：
   * 否则编辑框里 Ctrl+A、双击选词会被当作文档全选/选词，焦点被抢回文档。
   * 图表 SVG 区域仍交给 ProseMirror 处理，保留点击选中节点的常规行为。
   */
  stopEvent(event: Event): boolean {
    const target = event.target;
    if (!(target instanceof Node)) return false;
    if (this.header.contains(target)) return true;
    return this.textarea !== null && this.textarea.contains(target);
  }

  destroy(): void {
    this.destroyed = true;
    this.token += 1;
    this.observer?.disconnect();
    this.observer = null;
    this.themeCleanup();
    getDiagramService().cancel(`${this.nodeId}:${this.instanceId}`);
    this.reportProblem(null);
  }

  private showPlaceholder(): void {
    if (this.editing) return;
    this.lastSvg = null;
    this.body.replaceChildren();
    const placeholder = document.createElement("pre");
    placeholder.className = "diagram-placeholder-source";
    placeholder.textContent = this.source || t("（空图表）");
    this.body.append(placeholder);
  }

  private async render(): Promise<void> {
    if (this.destroyed || this.editing || !this.visible) return;
    const key = this.key;
    if (this.renderKey === key) return;
    this.renderKey = key;
    const token = ++this.token;

    this.body.replaceChildren();
    const pending = document.createElement("div");
    pending.className = "diagram-rendering";
    pending.textContent = t("正在渲染图表…");
    this.body.append(pending);

    const result = await getDiagramService().render({
      id: `${this.nodeId}:${this.instanceId}`,
      kind: this.kind,
      source: this.source,
      theme: currentDiagramTheme(),
    });

    if (this.destroyed || token !== this.token || key !== this.key) return;

    if (result.ok) {
      this.lastSvg = result.svg;
      this.body.replaceChildren();
      const svgHost = document.createElement("div");
      svgHost.className = "diagram-svg";
      // SVG 已在父窗口经 DOMPurify 消毒，不执行内联脚本。
      svgHost.innerHTML = result.svg;
      this.body.append(svgHost);
      this.reportProblem(null);
      return;
    }

    if (result.code !== "E_CANCELLED") {
      this.reportProblem(t("图表渲染失败：{0}", result.error));
    }
    this.showError(result.error, result.code === "E_RENDER_TIMEOUT" || result.code === "E_RENDER_FAILED");
  }

  /** 图表诊断汇入问题面板；同一节点重复上报会覆盖旧条目。见 doc/design.md §15.1。 */
  private reportProblem(message: string | null): void {
    if (!this.documentId) return;
    problemStore.setEntry(
      this.documentId,
      "diagram",
      `${this.nodeId}:${this.instanceId}`,
      message ? [{ severity: "error", message }] : [],
    );
  }

  private showError(message: string, retryable: boolean): void {
    this.body.replaceChildren();
    const card = document.createElement("div");
    card.className = "diagram-error";
    const text = document.createElement("span");
    text.className = "diagram-error-text";
    text.textContent = t("图表渲染失败：{0}", message);
    card.append(text);
    if (retryable) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "button small";
      retry.textContent = t("重试");
      retry.addEventListener("mousedown", (event) => event.preventDefault());
      retry.addEventListener("click", () => {
        this.renderKey = null;
        void this.render();
      });
      card.append(retry);
    }
    this.body.append(card);
  }

  private startEditing(): void {
    if (this.editing || this.destroyed || this.isReadOnly()) return;
    this.editing = true;
    this.renderKey = null;
    this.lastSvg = null;
    this.toggleButton.setAttribute("aria-pressed", "true");
    this.expandButton.disabled = true;

    const textarea = document.createElement("textarea");
    textarea.className = "diagram-source-editor";
    textarea.spellcheck = false;
    textarea.value = this.source;
    textarea.rows = Math.min(20, Math.max(5, this.source.split("\n").length + 1));
    this.textarea = textarea;

    this.body.replaceChildren(textarea);
    textarea.focus();
    textarea.select();

    // 编辑窗的开关只由「编辑代码」按钮控制（Esc 取消、Ctrl+Enter 提交），失焦不自动关闭。
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.exitEditing();
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        this.commitEditing();
      }
    });
  }

  private commitEditing(): void {
    const textarea = this.textarea;
    if (!textarea) return;
    const value = textarea.value;
    const attrs = { ...this.node.attrs, source: value };
    this.exitEditing(false);
    if (value === this.source) {
      void this.render();
      return;
    }
    try {
      const position = this.getPos();
      if (typeof position !== "number") return;
      const transaction = this.view.state.tr.setNodeMarkup(position, undefined, attrs);
      this.view.dispatch(transaction);
    } catch {
      // 节点已被删除时 getPos 会抛错；忽略即可。
    }
  }

  private exitEditing(renderAfter = true): void {
    this.editing = false;
    this.toggleButton.setAttribute("aria-pressed", "false");
    this.expandButton.disabled = false;
    this.textarea = null;
    this.renderKey = null;
    if (!renderAfter) return;
    if (this.visible) {
      void this.render();
    } else {
      this.showPlaceholder();
    }
  }
}
