import { Schema, type DOMOutputSpec, type NodeSpec } from "prosemirror-model";
import { tableNodes } from "prosemirror-tables";
import { t } from "../i18n";

/** ProseMirror JSON 片段；格式适配器与扩展 provider 的公共交换格式。见 doc/design.md §7.6.3。 */
export interface PMJsonMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface PMJson {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMJson[];
  marks?: PMJsonMark[];
  text?: string;
}

export type PandaSchema = Schema;

const nodeIdAttr = { nodeId: { default: null } };

function listItemDOM(node: { attrs: Record<string, unknown> }): DOMOutputSpec {
  const checked = node.attrs.checked;
  if (typeof checked !== "boolean") return ["li", 0];
  return ["li", { class: "task-item", "data-checked": String(checked) }, 0];
}

const nodes: Record<string, NodeSpec> = {
  doc: { content: "block+" },

  text: { group: "inline" },

  paragraph: {
    group: "block",
    content: "inline*",
    attrs: { ...nodeIdAttr },
    toDOM: () => ["p", 0],
  },

  heading: {
    group: "block",
    content: "inline*",
    defining: true,
    attrs: { level: { default: 1 }, id: { default: null }, ...nodeIdAttr },
    toDOM: (node) => {
      const level = Math.min(6, Math.max(1, Number(node.attrs.level) || 1));
      return [`h${level}`, { "data-heading-id": String(node.attrs.id ?? "") }, 0];
    },
  },

  blockquote: {
    group: "block",
    content: "block+",
    defining: true,
    toDOM: () => ["blockquote", 0],
  },

  bullet_list: {
    group: "block",
    content: "list_item+",
    attrs: { ...nodeIdAttr },
    toDOM: () => ["ul", 0],
  },

  ordered_list: {
    group: "block",
    content: "list_item+",
    attrs: { start: { default: 1 }, ...nodeIdAttr },
    toDOM: (node) => ["ol", { start: String(node.attrs.start ?? 1) }, 0],
  },

  list_item: {
    content: "paragraph block*",
    defining: true,
    attrs: { checked: { default: null } },
    toDOM: listItemDOM,
  },

  code_block: {
    group: "block",
    content: "text*",
    marks: "",
    code: true,
    defining: true,
    attrs: { language: { default: "" }, ...nodeIdAttr },
    toDOM: (node) => ["pre", { "data-language": String(node.attrs.language ?? "") }, ["code", 0]],
  },

  math_inline: {
    group: "inline",
    inline: true,
    atom: true,
    attrs: { source: { default: "" }, delimiter: { default: "$" } },
    toDOM: (node) => ["span", { class: "math-inline" }, `$${String(node.attrs.source ?? "")}$`],
  },

  math_block: {
    group: "block",
    atom: true,
    attrs: { source: { default: "" }, delimiter: { default: "$$" }, ...nodeIdAttr },
    toDOM: (node) => ["div", { class: "math-block" }, ["code", `$$${String(node.attrs.source ?? "")}$$`]],
  },

  mathml_block: {
    group: "block",
    atom: true,
    attrs: { source: { default: "" }, ...nodeIdAttr },
    toDOM: (node) => ["pre", { class: "mathml-block" }, String(node.attrs.source ?? "")],
  },

  mathml_inline: {
    group: "inline",
    inline: true,
    atom: true,
    attrs: { source: { default: "" } },
    toDOM: (node) => ["span", { class: "mathml-inline" }, String(node.attrs.source ?? "")],
  },

  diagram_block: {
    group: "block",
    atom: true,
    attrs: { kind: { default: "plantuml" }, source: { default: "" }, ...nodeIdAttr },
    toDOM: (node) => [
      "div",
      { class: "diagram-placeholder", "data-kind": String(node.attrs.kind ?? "") },
      [
        "span",
        { class: "diagram-label" },
        t("{0}（双击编辑源码）", String(node.attrs.kind ?? "")),
      ],
      ["pre", { class: "diagram-source" }, String(node.attrs.source ?? "")],
    ],
  },

  tab_set: {
    group: "block",
    content: "tab_item+",
    attrs: { ...nodeIdAttr },
    toDOM: () => ["div", { class: "myst-tab-set" }, 0],
  },

  tab_item: {
    content: "block+",
    defining: true,
    attrs: { label: { default: "" } },
    toDOM: (node) => ["section", { class: "myst-tab-item", "data-label": String(node.attrs.label ?? "") }, 0],
  },

  grid: {
    group: "block",
    content: "grid_item+",
    attrs: { columns: { default: 2 }, outline: { default: false }, ...nodeIdAttr },
    toDOM: (node) => [
      "div",
      {
        class: "myst-grid",
        style: `grid-template-columns: repeat(${Number(node.attrs.columns) || 2}, minmax(0, 1fr))`,
      },
      0,
    ],
  },

  grid_item: {
    content: "block+",
    defining: true,
    toDOM: () => ["div", { class: "myst-grid-item" }, 0],
  },

  image: {
    group: "inline",
    inline: true,
    atom: true,
    draggable: true,
    attrs: { src: { default: "" }, alt: { default: "" }, title: { default: null } },
    toDOM: (node) => {
      const attrs: Record<string, string> = { src: String(node.attrs.src ?? "") };
      if (node.attrs.alt) attrs.alt = String(node.attrs.alt);
      if (node.attrs.title) attrs.title = String(node.attrs.title);
      return ["img", attrs];
    },
  },

  frontmatter: {
    group: "block",
    atom: true,
    attrs: { raw: { default: "" }, ...nodeIdAttr },
    toDOM: (node) => ["pre", { class: "frontmatter" }, String(node.attrs.raw ?? "")],
  },

  html_block: {
    group: "block",
    atom: true,
    attrs: { raw: { default: "" }, ...nodeIdAttr },
    toDOM: (node) => ["pre", { class: "html-block" }, String(node.attrs.raw ?? "")],
  },

  html_inline: {
    group: "inline",
    inline: true,
    atom: true,
    attrs: { raw: { default: "" } },
    toDOM: (node) => ["span", { class: "html-inline" }, String(node.attrs.raw ?? "")],
  },

  /** 未映射语法的兜底原子节点，保存原始切片。见 doc/design.md §7.5、§8.3。 */
  raw_markdown: {
    group: "block",
    atom: true,
    attrs: { raw: { default: "" }, reason: { default: "unknown" }, ...nodeIdAttr },
    toDOM: (node) => ["div", { class: "raw-markdown", "data-reason": String(node.attrs.reason ?? "") }, ["pre", String(node.attrs.raw ?? "")]],
  },

  horizontal_rule: {
    group: "block",
    atom: true,
    attrs: { ...nodeIdAttr },
    toDOM: () => ["hr"],
  },

  hard_break: {
    group: "inline",
    inline: true,
    atom: true,
    selectable: false,
    toDOM: () => ["br"],
  },
};

const tableSpecs = tableNodes({
  tableGroup: "block",
  cellContent: "paragraph",
  cellAttributes: {
    align: {
      default: null,
      getFromDOM: (dom: HTMLElement) => dom.getAttribute("data-align"),
      setDOMAttr: (value: unknown, attrs: Record<string, unknown>) => {
        if (value) attrs["data-align"] = value;
      },
    },
  },
});

const tableSpec = tableSpecs["table"];
const tableWithNodeId: NodeSpec = {
  ...tableSpec,
  attrs: { ...(tableSpec?.attrs ?? {}), nodeId: { default: null } },
};

export const markdownSchema = new Schema({
  nodes: {
    ...nodes,
    ...tableSpecs,
    table: tableWithNodeId,
  },
  marks: {
    strong: {
      toDOM: () => ["strong", 0],
    },
    em: {
      toDOM: () => ["em", 0],
    },
    code: {
      toDOM: () => ["code", 0],
    },
    strikethrough: {
      toDOM: () => ["s", 0],
    },
    link: {
      attrs: { href: { default: "" }, title: { default: null } },
      inclusive: false,
      toDOM: (mark) => {
        const attrs: Record<string, string> = { href: String(mark.attrs.href ?? "") };
        if (mark.attrs.title) attrs.title = String(mark.attrs.title);
        return ["a", attrs, 0];
      },
    },
  },
});

/** 空文档：ProseMirror `doc` 要求至少一个块节点。 */
export function createEmptyDocumentJson(): PMJson {
  return { type: "doc", content: [{ type: "paragraph" }] };
}
