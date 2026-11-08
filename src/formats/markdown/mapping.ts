import type { PMJson, PMJsonMark } from "../../editor/schema";

/**
 * mdast 的结构化子集。这里只声明本模块实际访问的字段，
 * 未映射的节点类型统一走 `raw_markdown` 兜底。见 doc/design.md §8.3。
 */
export interface MdNode {
  type: string;
  value?: string | null;
  children?: MdNode[];
  depth?: number | null;
  ordered?: boolean | null;
  start?: number | null;
  spread?: boolean | null;
  checked?: boolean | null;
  align?: Array<string | null> | null;
  lang?: string | null;
  meta?: string | null;
  url?: string | null;
  title?: string | null;
  alt?: string | null;
  identifier?: string | null;
  /** MyST 指令解析时记录的原始切片（位置相对于所属片段）。 */
  rawSource?: string | null;
  /** `tab-item` 页签标题。 */
  label?: string | null;
  /** `grid` 列数。 */
  columns?: number | null;
  /** `grid` 是否显示轮廓。 */
  outline?: boolean | null;
  position?: {
    start?: { offset?: number | null } | null;
    end?: { offset?: number | null } | null;
  } | null;
}

function rawSlice(node: MdNode, source: string): string {
  if (typeof node.rawSource === "string" && node.rawSource) return node.rawSource;
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start === "number" && typeof end === "number") {
    return source.slice(start, end);
  }
  return node.value ?? "";
}

function textContent(node: MdNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(textContent).join("");
}

function createSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text: string) => {
    const base =
      text
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .replace(/\s+/g, "-") || "section";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

function diagramKind(language: string): string | null {
  const normalized = language.trim().toLowerCase();
  if (normalized === "plantuml" || normalized === "puml" || normalized === "uml" || normalized === "{uml}") {
    return "plantuml";
  }
  if (normalized === "mermaid" || normalized === "mmd") {
    return "mermaid";
  }
  return null;
}

/** 完整 `<math>...</math>` 片段判定（块级）。 */
function isMathmlBlock(value: string): boolean {
  return /^\s*<math[\s>][\s\S]*<\/math>\s*$/i.test(value);
}

/** 行内 html 节点只有在自含完整 `<math>` 元素时才提升为 mathml_inline。 */
function isMathmlInline(value: string): boolean {
  return isMathmlBlock(value);
}

function mdastInline(node: MdNode, source: string, marks: PMJsonMark[]): PMJson[] {
  switch (node.type) {
    case "text": {
      const text = node.value ?? "";
      return text ? [{ type: "text", text, ...(marks.length ? { marks } : {}) }] : [];
    }
    case "strong":
      return mdastInlines(node, source, [...marks, { type: "strong" }]);
    case "emphasis":
      return mdastInlines(node, source, [...marks, { type: "em" }]);
    case "delete":
      return mdastInlines(node, source, [...marks, { type: "strikethrough" }]);
    case "link":
      return mdastInlines(node, source, [
        ...marks,
        { type: "link", attrs: { href: node.url ?? "", title: node.title ?? null } },
      ]);
    case "inlineCode": {
      const text = node.value ?? "";
      return text ? [{ type: "text", text, marks: [...marks, { type: "code" }] }] : [];
    }
    case "image":
      return [
        {
          type: "image",
          attrs: { src: node.url ?? "", alt: node.alt ?? "", title: node.title ?? null },
        },
      ];
    case "break":
      return [{ type: "hard_break" }];
    case "html": {
      const raw = node.value ?? "";
      return isMathmlInline(raw)
        ? [{ type: "mathml_inline", attrs: { source: raw } }]
        : [{ type: "html_inline", attrs: { raw } }];
    }
    case "inlineMath":
      return [{ type: "math_inline", attrs: { source: node.value ?? "", delimiter: "$" } }];
    case "math":
      return [{ type: "math_inline", attrs: { source: node.value ?? "", delimiter: "$" } }];
    default: {
      // 未映射的内联语法（脚注引用、引用式链接等）保留可见原文，保证幂等。
      const raw = rawSlice(node, source);
      return raw ? [{ type: "text", text: raw, ...(marks.length ? { marks } : {}) }] : [];
    }
  }
}

/**
 * micromark 会把行内 `<math><mi>y</mi></math>` 拆成若干 html/text 碎片节点。
 * 这里把 `<math` 到 `</math>` 的兄弟运行合并为完整片段，raw 取首尾节点
 * position 的原文切片，保证序列化幂等。
 */
function mergeMathmlInlines(children: MdNode[], source: string): MdNode[] {
  const merged: MdNode[] = [];
  let index = 0;
  while (index < children.length) {
    const child = children[index]!;
    if (child.type === "html" && /^<math[\s>]/i.test((child.value ?? "").trim())) {
      let end = -1;
      for (let scan = index; scan < children.length; scan++) {
        const candidate = children[scan]!;
        if (candidate.type === "html" && /<\/math\s*>/i.test(candidate.value ?? "")) {
          end = scan;
          break;
        }
      }
      if (end > index) {
        const startOffset = child.position?.start?.offset;
        const endOffset = children[end]!.position?.end?.offset;
        const raw =
          typeof startOffset === "number" && typeof endOffset === "number"
            ? source.slice(startOffset, endOffset)
            : children
                .slice(index, end + 1)
                .map((part) => part.value ?? "")
                .join("");
        merged.push({ type: "mathmlInlineRun", value: raw });
        index = end + 1;
        continue;
      }
    }
    merged.push(child);
    index += 1;
  }
  return merged;
}

function mdastInlines(node: MdNode, source: string, marks: PMJsonMark[]): PMJson[] {
  return mergeMathmlInlines(node.children ?? [], source).flatMap((child) => {
    if (child.type === "mathmlInlineRun") {
      return [{ type: "mathml_inline", attrs: { source: child.value ?? "" } }];
    }
    return mdastInline(child, source, marks);
  });
}

function mdastListItem(node: MdNode, source: string, slugger: ReturnType<typeof createSlugger>): PMJson {
  const blocks = (node.children ?? [])
    .map((child) => mdastBlock(child, source, slugger))
    .filter((block): block is PMJson => block !== null);
  const content = blocks[0]?.type === "paragraph" ? blocks : [{ type: "paragraph" }, ...blocks];
  return {
    type: "list_item",
    attrs: { checked: typeof node.checked === "boolean" ? node.checked : null },
    content,
  };
}

function mdastList(node: MdNode, source: string, slugger: ReturnType<typeof createSlugger>): PMJson {
  const items = (node.children ?? []).filter((child) => child.type === "listItem");
  const content = items.map((item) => mdastListItem(item, source, slugger));
  if (content.length === 0) content.push(mdastListItem({ type: "listItem", children: [] }, source, slugger));
  if (node.ordered === true) {
    return { type: "ordered_list", attrs: { start: node.start ?? 1 }, content };
  }
  return { type: "bullet_list", content };
}

function mdastTable(node: MdNode, source: string): PMJson | null {
  const rows = (node.children ?? []).filter((child) => child.type === "tableRow");
  const align = node.align ?? [];
  const pmRows: PMJson[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    const cells = (row.children ?? []).filter((child) => child.type === "tableCell");
    if (cells.length === 0) continue;
    pmRows.push({
      type: "table_row",
      content: cells.map((cell, columnIndex) => ({
        type: rowIndex === 0 ? "table_header" : "table_cell",
        attrs: { align: align[columnIndex] ?? null },
        content: [{ type: "paragraph", content: mdastInlines(cell, source, []) }],
      })),
    });
  }
  if (pmRows.length === 0) {
    const raw = rawSlice(node, source);
    return raw ? { type: "raw_markdown", attrs: { raw, reason: "empty-table" } } : null;
  }
  return { type: "table", content: pmRows };
}

function mdastCode(node: MdNode): PMJson {
  const language = (node.lang ?? "").trim();
  const value = node.value ?? "";
  const kind = diagramKind(language);
  if (kind) return { type: "diagram_block", attrs: { kind, source: value } };
  return {
    type: "code_block",
    attrs: { language },
    content: value ? [{ type: "text", text: value }] : [],
  };
}

function ensureBlocks(blocks: PMJson[]): PMJson[] {
  return blocks.length ? blocks : [{ type: "paragraph" }];
}

/** `tab_item` / `grid_item` 的块内容；空内容补一个空段落以满足 block+ 约束。 */
function mdastContainerItem(
  node: MdNode,
  source: string,
  slugger: ReturnType<typeof createSlugger>,
  type: "tab_item" | "grid_item",
): PMJson {
  const blocks = (node.children ?? [])
    .map((child) => mdastBlock(child, source, slugger))
    .filter((block): block is PMJson => block !== null);
  return {
    type,
    attrs: type === "tab_item" ? { label: node.label ?? "" } : undefined,
    content: ensureBlocks(blocks),
  };
}

function mdastContainer(
  node: MdNode,
  source: string,
  slugger: ReturnType<typeof createSlugger>,
  kind: "tab_set" | "grid",
): PMJson {
  const itemType = kind === "tab_set" ? "mystTabItem" : "mystGridItem";
  const items = (node.children ?? [])
    .filter((child) => child.type === itemType)
    .map((child) => mdastContainerItem(child, source, slugger, kind === "tab_set" ? "tab_item" : "grid_item"));
  if (items.length === 0) {
    items.push(mdastContainerItem({ type: itemType, children: [] }, source, slugger, kind === "tab_set" ? "tab_item" : "grid_item"));
  }
  if (kind === "tab_set") return { type: "tab_set", content: items };
  return {
    type: "grid",
    attrs: { columns: Number(node.columns) || 2, outline: Boolean(node.outline) },
    content: items,
  };
}

function mdastBlock(
  node: MdNode,
  source: string,
  slugger: ReturnType<typeof createSlugger>,
): PMJson | null {
  switch (node.type) {
    case "paragraph": {
      // `<math ...>...</math>` 独占一行时不满足 CommonMark HTML block 类型 7
      // （开放标签后只允许空白），会被解析成 paragraph。若子节点全为 html/text
      // 且原文整体是完整 MathML，则提升为 mathml_block。
      const inlineChildren = node.children ?? [];
      const onlyHtmlOrText =
        inlineChildren.length > 0 &&
        inlineChildren.every((child) => child.type === "html" || child.type === "text");
      if (onlyHtmlOrText) {
        const raw = rawSlice(node, source);
        if (isMathmlBlock(raw)) {
          return { type: "mathml_block", attrs: { source: raw.trim() } };
        }
      }
      return { type: "paragraph", content: mdastInlines(node, source, []) };
    }
    case "heading": {
      const level = Math.min(6, Math.max(1, node.depth ?? 1));
      return {
        type: "heading",
        attrs: { level, id: slugger(textContent(node)) },
        content: mdastInlines(node, source, []),
      };
    }
    case "blockquote": {
      const content = (node.children ?? [])
        .map((child) => mdastBlock(child, source, slugger))
        .filter((block): block is PMJson => block !== null);
      return { type: "blockquote", content: content.length ? content : [{ type: "paragraph" }] };
    }
    case "list":
      return mdastList(node, source, slugger);
    case "table":
      return mdastTable(node, source);
    case "code":
      return mdastCode(node);
    case "mystTabSet":
      return mdastContainer(node, source, slugger, "tab_set");
    case "mystTabItem":
      return mdastContainerItem(node, source, slugger, "tab_item");
    case "mystGrid":
      return mdastContainer(node, source, slugger, "grid");
    case "mystGridItem":
      return mdastContainerItem(node, source, slugger, "grid_item");
    case "thematicBreak":
      return { type: "horizontal_rule" };
    case "yaml":
      return { type: "frontmatter", attrs: { raw: node.value ?? "" } };
    case "html": {
      const raw = node.value ?? "";
      return isMathmlBlock(raw)
        ? { type: "mathml_block", attrs: { source: raw } }
        : { type: "html_block", attrs: { raw } };
    }
    case "math":
      return { type: "math_block", attrs: { source: node.value ?? "", delimiter: "$$" } };
    default: {
      const raw = rawSlice(node, source);
      return raw ? { type: "raw_markdown", attrs: { raw, reason: node.type } } : null;
    }
  }
}

/** mdast → ProseMirror JSON；顶层块分配 `nodeId`。 */
export function mdastToPmJson(root: MdNode, source: string): PMJson {
  const slugger = createSlugger();
  const blocks = (root.children ?? [])
    .map((child) => mdastBlock(child, source, slugger))
    .filter((block): block is PMJson => block !== null)
    .map((block, index) => ({
      ...block,
      attrs: { ...(block.attrs ?? {}), nodeId: `b${index + 1}` },
    }));
  if (blocks.length === 0) {
    return { type: "doc", content: [{ type: "paragraph", attrs: { nodeId: "b1" } }] };
  }
  return { type: "doc", content: blocks };
}

function applyMarks(value: string, marks: PMJsonMark[]): MdNode {
  const map = new Map(marks.map((mark) => [mark.type, mark]));
  let result: MdNode = { type: "text", value };

  if (map.has("code")) result = { type: "inlineCode", value };
  if (map.has("strikethrough")) result = { type: "delete", children: [result] };
  if (map.has("em")) result = { type: "emphasis", children: [result] };
  if (map.has("strong")) result = { type: "strong", children: [result] };
  const link = map.get("link");
  if (link) {
    result = {
      type: "link",
      url: String(link.attrs?.href ?? ""),
      title: link.attrs?.title == null ? null : String(link.attrs.title),
      children: [result],
    };
  }
  return result;
}

function pmInlineToMdast(node: PMJson): MdNode | null {
  switch (node.type) {
    case "text":
      return applyMarks(node.text ?? "", node.marks ?? []);
    case "image":
      return {
        type: "image",
        url: String(node.attrs?.src ?? ""),
        alt: String(node.attrs?.alt ?? ""),
        title: node.attrs?.title == null ? null : String(node.attrs.title),
      };
    case "hard_break":
      return { type: "break" };
    case "html_inline":
      return { type: "html", value: String(node.attrs?.raw ?? "") };
    case "math_inline":
      return { type: "inlineMath", value: String(node.attrs?.source ?? "") };
    case "mathml_inline":
      return { type: "html", value: String(node.attrs?.source ?? "") };
    default:
      return null;
  }
}

function pmInlinesToMdast(content: PMJson[] | undefined): MdNode[] {
  return (content ?? [])
    .map(pmInlineToMdast)
    .filter((node): node is MdNode => node !== null);
}

function pmText(node: PMJson): string {
  return (node.content ?? []).map((child) => child.text ?? "").join("");
}

function pmListItemToMdast(node: PMJson): MdNode {
  const blocks = (node.content ?? [])
    .map(pmBlockToMdast)
    .filter((block): block is MdNode => block !== null);
  const children = blocks[0]?.type === "paragraph" ? blocks : [{ type: "paragraph", children: [] }, ...blocks];
  const checked = node.attrs?.checked;
  return {
    type: "listItem",
    checked: typeof checked === "boolean" ? checked : null,
    spread: false,
    children,
  };
}

function pmTableToMdast(node: PMJson): MdNode {
  const rows = node.content ?? [];
  const header = rows[0];
  const align = (header?.content ?? []).map((cell) => {
    const value = cell.attrs?.align;
    return typeof value === "string" ? value : null;
  });
  return {
    type: "table",
    align,
    children: rows.map((row) => ({
      type: "tableRow",
      children: (row.content ?? []).map((cell) => {
        const paragraph = (cell.content ?? []).find((child) => child.type === "paragraph");
        return {
          type: "tableCell",
          children: pmInlinesToMdast(paragraph?.content),
        };
      }),
    })),
  };
}

function pmBlockToMdast(node: PMJson): MdNode | null {
  switch (node.type) {
    case "paragraph":
      return { type: "paragraph", children: pmInlinesToMdast(node.content) };
    case "heading":
      return {
        type: "heading",
        depth: Math.min(6, Math.max(1, Number(node.attrs?.level) || 1)),
        children: pmInlinesToMdast(node.content),
      };
    case "blockquote": {
      const children = (node.content ?? [])
        .map(pmBlockToMdast)
        .filter((child): child is MdNode => child !== null);
      return { type: "blockquote", children };
    }
    case "bullet_list":
      return {
        type: "list",
        ordered: false,
        spread: false,
        children: (node.content ?? []).map(pmListItemToMdast),
      };
    case "ordered_list":
      return {
        type: "list",
        ordered: true,
        start: Number(node.attrs?.start) || 1,
        spread: false,
        children: (node.content ?? []).map(pmListItemToMdast),
      };
    case "list_item":
      return pmListItemToMdast(node);
    case "code_block":
      return {
        type: "code",
        lang: String(node.attrs?.language ?? "") || null,
        meta: null,
        value: pmText(node),
      };
    case "diagram_block":
      return {
        type: "code",
        lang: String(node.attrs?.kind ?? "plantuml"),
        meta: null,
        value: String(node.attrs?.source ?? ""),
      };
    case "tab_set":
      return {
        type: "mystTabSet",
        children: (node.content ?? [])
          .map(pmBlockToMdast)
          .filter((child): child is MdNode => child !== null),
      };
    case "tab_item":
      return {
        type: "mystTabItem",
        label: String(node.attrs?.label ?? ""),
        children: (node.content ?? [])
          .map(pmBlockToMdast)
          .filter((child): child is MdNode => child !== null),
      };
    case "grid":
      return {
        type: "mystGrid",
        columns: Number(node.attrs?.columns) || 2,
        outline: Boolean(node.attrs?.outline),
        children: (node.content ?? [])
          .map(pmBlockToMdast)
          .filter((child): child is MdNode => child !== null),
      };
    case "grid_item":
      return {
        type: "mystGridItem",
        children: (node.content ?? [])
          .map(pmBlockToMdast)
          .filter((child): child is MdNode => child !== null),
      };
    case "table":
      return pmTableToMdast(node);
    case "frontmatter":
      return { type: "yaml", value: String(node.attrs?.raw ?? "") };
    case "html_block":
      return { type: "html", value: String(node.attrs?.raw ?? "") };
    case "raw_markdown":
      return { type: "html", value: String(node.attrs?.raw ?? "") };
    case "math_block":
      return { type: "math", value: String(node.attrs?.source ?? "") };
    case "mathml_block":
      return { type: "html", value: String(node.attrs?.source ?? "") };
    case "horizontal_rule":
      return { type: "thematicBreak" };
    default:
      return null;
  }
}

/** ProseMirror JSON → mdast；frontmatter 统一置于文档开头。见 doc/design.md §8.4。 */
export function pmJsonToMdast(doc: PMJson): MdNode {
  const blocks: MdNode[] = [];
  let frontmatter: MdNode | null = null;
  for (const node of doc.content ?? []) {
    const converted = pmBlockToMdast(node);
    if (!converted) continue;
    if (converted.type === "yaml") {
      frontmatter ??= converted;
      continue;
    }
    blocks.push(converted);
  }
  return {
    type: "root",
    children: frontmatter ? [frontmatter, ...blocks] : blocks,
  };
}
