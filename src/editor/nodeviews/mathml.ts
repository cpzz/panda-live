import type { Node as PMNode } from "prosemirror-model";
import type { NodeView } from "prosemirror-view";
import { renderMathml } from "../../render/math/mathml";

/** MathML 只读 NodeView：Chromium 原生渲染；非法 XML 显示诊断，不崩溃（FR-05）。 */
export class MathmlNodeView implements NodeView {
  readonly dom: HTMLElement;
  private node: PMNode;

  constructor(node: PMNode, displayMode: boolean) {
    this.node = node;
    this.dom = document.createElement(displayMode ? "div" : "span");
    this.dom.className = displayMode
      ? "mathml-node mathml-node-block"
      : "mathml-node mathml-node-inline";
    this.render();
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const changed = node.attrs.source !== this.node.attrs.source;
    this.node = node;
    if (changed) this.render();
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  private render(): void {
    const source = String(this.node.attrs.source ?? "");
    const result = renderMathml(source);
    if (result.ok) {
      this.dom.innerHTML = result.html;
      this.dom.classList.remove("mathml-node-error");
      this.dom.removeAttribute("title");
    } else {
      this.dom.textContent = source;
      this.dom.classList.add("mathml-node-error");
      this.dom.title = result.error;
    }
  }
}
