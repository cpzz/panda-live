import DOMPurify from "dompurify";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";
import { renderKatex } from "../../render/math/katex";
import { problemStore } from "../../services/problem-store";

const KATEX_PROFILE = { USE_PROFILES: { html: true, mathMl: true, svg: true } } as const;

type GetPos = () => number | undefined;

/**
 * LaTeX 公式 NodeView：KaTeX 静态渲染，双击唤起 MathLive 可视化编辑，
 * 提交经事务完成（可撤销，FR-04）；渲染失败保留源码并提示。见 doc/design.md §12。
 */
export class MathNodeView implements NodeView {
  readonly dom: HTMLElement;
  private node: PMNode;
  private editing = false;
  private readonly problemKey: string;

  constructor(
    node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: GetPos,
    private readonly displayMode: boolean,
    private readonly documentId?: string,
  ) {
    this.node = node;
    this.problemKey = String(node.attrs.nodeId ?? `math-${Math.random().toString(36).slice(2, 10)}`);
    this.dom = document.createElement(displayMode ? "div" : "span");
    this.dom.className = displayMode ? "math-node math-node-block" : "math-node math-node-inline";
    this.dom.title = "双击编辑公式";
    this.dom.addEventListener("dblclick", () => {
      void this.startEditing();
    });
    this.render();
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (!this.editing) this.render();
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  stopEvent(event: Event): boolean {
    return this.editing && event.type !== "dblclick";
  }

  private render(): void {
    const source = String(this.node.attrs.source ?? "");
    const result = renderKatex(source, this.displayMode);
    if (result.ok) {
      this.dom.innerHTML = DOMPurify.sanitize(result.html, KATEX_PROFILE);
      this.dom.classList.remove("math-node-error");
      this.dom.title = "双击编辑公式";
      this.reportProblem(null);
    } else {
      this.dom.textContent = `${this.displayMode ? "$$" : "$"}${source}${this.displayMode ? "$$" : "$"}`;
      this.dom.classList.add("math-node-error");
      this.dom.title = `公式错误：${result.error}`;
      this.reportProblem(`公式渲染失败：${result.error}`);
    }
  }

  /** 公式渲染诊断汇入问题面板；错误清除时移除对应条目。 */
  private reportProblem(message: string | null): void {
    if (!this.documentId) return;
    problemStore.setEntry(
      this.documentId,
      "math",
      this.problemKey,
      message ? [{ severity: "error", message }] : [],
    );
  }

  destroy(): void {
    this.reportProblem(null);
  }

  private async startEditing(): Promise<void> {
    if (this.editing || !this.view.editable) return;
    this.editing = true;
    try {
      // MathLive 按需加载（doc/design.md §4.4）。
      const { MathfieldElement } = await import("mathlive");
      if (!this.dom.isConnected) {
        this.editing = false;
        return;
      }
      const field = new MathfieldElement();
      field.value = String(this.node.attrs.source ?? "");
      field.mathVirtualKeyboardPolicy = "manual";
      field.className = "math-editor-field";
      this.dom.replaceChildren(field);
      field.focus();

      let finished = false;
      const finish = (commit: boolean): void => {
        if (finished) return;
        finished = true;
        this.editing = false;
        if (commit) {
          const pos = this.getPos();
          if (pos !== undefined) {
            const tr = this.view.state.tr.setNodeMarkup(pos, undefined, {
              ...this.node.attrs,
              source: field.value,
            });
            this.view.dispatch(tr);
            return;
          }
        }
        this.render();
      };
      field.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      });
      field.addEventListener("blur", () => finish(true));
    } catch {
      this.editing = false;
      this.render();
    }
  }
}
