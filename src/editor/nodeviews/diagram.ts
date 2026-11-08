import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";
import {
  currentDiagramTheme,
  getDiagramService,
  onDiagramThemeChange,
} from "../../render/diagram";
import type { DiagramKind } from "../../render/diagram/types";
import { problemStore } from "../../services/problem-store";

const EDIT_COMMIT_DELAY_MS = 300;

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
  private textarea: HTMLTextAreaElement | null = null;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(
    node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly documentId?: string,
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
    const sourceButton = document.createElement("button");
    sourceButton.type = "button";
    sourceButton.className = "button small ghost";
    sourceButton.textContent = "查看源码";
    sourceButton.addEventListener("mousedown", (event) => event.preventDefault());
    sourceButton.addEventListener("click", () => this.startEditing());
    actions.append(sourceButton);
    this.header.append(label, actions);

    this.body = document.createElement("div");
    this.body.className = "diagram-node-body";

    this.dom.append(this.header, this.body);
    this.dom.addEventListener("dblclick", () => this.startEditing());

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

  destroy(): void {
    this.destroyed = true;
    this.token += 1;
    this.observer?.disconnect();
    this.observer = null;
    this.themeCleanup();
    if (this.commitTimer) clearTimeout(this.commitTimer);
    getDiagramService().cancel(`${this.nodeId}:${this.instanceId}`);
    this.reportProblem(null);
  }

  private showPlaceholder(): void {
    if (this.editing) return;
    this.body.replaceChildren();
    const placeholder = document.createElement("pre");
    placeholder.className = "diagram-placeholder-source";
    placeholder.textContent = this.source || "（空图表）";
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
    pending.textContent = "正在渲染图表…";
    this.body.append(pending);

    const result = await getDiagramService().render({
      id: `${this.nodeId}:${this.instanceId}`,
      kind: this.kind,
      source: this.source,
      theme: currentDiagramTheme(),
    });

    if (this.destroyed || token !== this.token || key !== this.key) return;

    if (result.ok) {
      this.body.replaceChildren();
      const svgHost = document.createElement("div");
      svgHost.className = "diagram-svg";
      // SVG 已在父窗口经 DOMPurify 消毒，不执行内联脚本。
      svgHost.innerHTML = result.svg;
      this.body.append(svgHost);
      this.reportProblem(null);
      return;
    }

    if (result.code !== "E_CANCELLED") this.reportProblem(`图表渲染失败：${result.error}`);
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
    text.textContent = `图表渲染失败：${message}`;
    card.append(text);
    if (retryable) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "button small";
      retry.textContent = "重试";
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
    if (this.editing || this.destroyed) return;
    this.editing = true;
    this.renderKey = null;

    const textarea = document.createElement("textarea");
    textarea.className = "diagram-source-editor";
    textarea.spellcheck = false;
    textarea.value = this.source;
    textarea.rows = Math.min(20, Math.max(5, this.source.split("\n").length + 1));
    this.textarea = textarea;

    this.body.replaceChildren(textarea);
    textarea.focus();
    textarea.select();

    textarea.addEventListener("blur", () => {
      // 失焦 300 ms 后提交并重新渲染，避免点击按钮时误提交。见 doc/design.md §10.3。
      if (this.commitTimer) clearTimeout(this.commitTimer);
      this.commitTimer = setTimeout(() => {
        if (this.editing) this.commitEditing();
      }, EDIT_COMMIT_DELAY_MS);
    });
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
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
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
