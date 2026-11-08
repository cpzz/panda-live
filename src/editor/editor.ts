import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { MathNodeView } from "./nodeviews/math";
import { MathmlNodeView } from "./nodeviews/mathml";
import { DiagramNodeView } from "./nodeviews/diagram";
import { GridNodeView, TabSetNodeView } from "./nodeviews/directive";
import type { PMJson } from "./schema";
import { createWysiwygState } from "./state";

export interface PandaEditorOptions {
  parent: HTMLElement;
  docJson: PMJson;
  readOnly: boolean;
  /** 文档变化后回调 ProseMirror JSON；序列化由调用方负责。 */
  onChange(docJson: PMJson): void;
}

/** ProseMirror 编辑器封装；不依赖 React，也不直接读写文件。见 doc/design.md §11. */
export class PandaEditor {
  private readonly view: EditorView;
  private readOnly: boolean;

  constructor(private readonly options: PandaEditorOptions) {
    this.readOnly = options.readOnly;
    this.view = new EditorView(options.parent, {
      state: createWysiwygState(options.docJson),
      attributes: { class: "markdown-body prose-editor", spellcheck: "false" },
      editable: () => !this.readOnly,
      nodeViews: {
        math_inline: (node, view, getPos) => new MathNodeView(node, view, getPos, false),
        math_block: (node, view, getPos) => new MathNodeView(node, view, getPos, true),
        mathml_inline: (node) => new MathmlNodeView(node, false),
        mathml_block: (node) => new MathmlNodeView(node, true),
        diagram_block: (node, view, getPos) => new DiagramNodeView(node, view, getPos),
        tab_set: (node) => new TabSetNodeView(node),
        grid: (node) => new GridNodeView(node),
      },
      dispatchTransaction: (transaction) => {
        const state = this.view.state.apply(transaction);
        this.view.updateState(state);
        if (transaction.docChanged) {
          this.options.onChange(state.doc.toJSON() as PMJson);
        }
      },
    });
  }

  get state(): EditorState {
    return this.view.state;
  }

  /** 恢复标签页维度的编辑器状态（保留撤销历史）。 */
  setState(state: EditorState): void {
    this.view.updateState(state);
  }

  /** 用新内容重建状态并建立新的撤销基线（模式切换、外部重载）。 */
  reset(docJson: PMJson, readOnly: boolean): void {
    this.readOnly = readOnly;
    this.view.updateState(createWysiwygState(docJson));
  }

  focus(): void {
    this.view.focus();
  }

  destroy(): void {
    this.view.destroy();
  }
}
