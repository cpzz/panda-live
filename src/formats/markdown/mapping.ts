import type { PMJson, PMJsonMark } from "../../editor/schema";
import { createSlugger } from "../../shared/slug";

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
  /** 引用式链接/图片的写法（full / collapsed / shortcut）。 */
  referenceType?: string | null;
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

/** 映射上下文：标题 slug 与引用式链接定义表。 */
interface MdContext {
  slugger: (text: string) => string;
  definitions: Map<string, { url: string; title: string | null }>;
}

/** 引用式链接标识符规范化（CommonMark 大小写不敏感、空白折叠）。 */
function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

/** 收集全文的链接定义（`[label]: url`），供引用式链接/图片解析。 */
function collectDefinitions(node: MdNode, map: Map<string, { url: string; title: string | null }>): void {
  if (node.type === "definition") {
    const key = normalizeIdentifier(node.identifier ?? node.label ?? "");
    if (key && !map.has(key)) map.set(key, { url: node.url ?? "", title: node.title ?? null });
  }
  for (const child of node.children ?? []) collectDefinitions(child, map);
}

/** 脚注引用在 CommonMark 中是纯文本；拆出来原样保留，避免序列化时被转义。 */
const FOOTNOTE_REFERENCE = /(\[\^[^\]\s]+\])/u;

function mdastInline(node: MdNode, source: string, marks: PMJsonMark[], ctx: MdContext): PMJson[] {
  switch (node.type) {
    case "text": {
      const text = node.value ?? "";
      if (!text) return [];
      // 源文本带转义（如 `\[^1]`）时按普通文本处理，避免与「未转义脚注」反复互转导致非幂等。
      if (rawSlice(node, source) !== text) {
        return [{ type: "text", text, ...(marks.length ? { marks } : {}) }];
      }
      return text.split(FOOTNOTE_REFERENCE).filter(Boolean).map((part) =>
        FOOTNOTE_REFERENCE.test(part)
          ? { type: "raw_inline", attrs: { raw: part } }
          : { type: "text", text: part, ...(marks.length ? { marks } : {}) },
      );
    }
    case "strong":
      return mdastInlines(node, source, [...marks, { type: "strong" }], ctx);
    case "emphasis":
      return mdastInlines(node, source, [...marks, { type: "em" }], ctx);
    case "delete":
      return mdastInlines(node, source, [...marks, { type: "strikethrough" }], ctx);
    case "link":
      return mdastInlines(node, source, [
        ...marks,
        { type: "link", attrs: { href: node.url ?? "", title: node.title ?? null } },
      ], ctx);
    case "footnoteReference": {
      // 渲染层不支持脚注，保留原始写法 `[^id]`，避免序列化时被转义成 `\[^id]`。
      const raw = rawSlice(node, source);
      return raw ? [{ type: "raw_inline", attrs: { raw } }] : [];
    }
    case "linkReference": {
      const label = node.label ?? node.identifier ?? "";
      // `[^1]` 属于脚注写法，不按引用式链接处理。
      if (label.trim().startsWith("^")) {
        const raw = rawSlice(node, source);
        return raw ? [{ type: "raw_inline", attrs: { raw } }] : [];
      }
      const definition = ctx.definitions.get(normalizeIdentifier(node.identifier ?? label));
      if (!definition) {
        const raw = rawSlice(node, source);
        return raw ? [{ type: "text", text: raw, ...(marks.length ? { marks } : {}) }] : [];
      }
      return mdastInlines(node, source, [
        ...marks,
        {
          type: "link",
          attrs: {
            href: definition.url,
            title: definition.title,
            reference: label,
            referenceType: node.referenceType ?? "full",
          },
        },
      ], ctx);
    }
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
    case "imageReference": {
      const label = node.label ?? node.identifier ?? "";
      const definition = ctx.definitions.get(normalizeIdentifier(node.identifier ?? label));
      if (!definition) {
        const raw = rawSlice(node, source);
        return raw ? [{ type: "text", text: raw, ...(marks.length ? { marks } : {}) }] : [];
      }
      return [
        {
          type: "image",
          attrs: {
            src: definition.url,
            alt: node.alt ?? "",
            title: definition.title,
            reference: label,
            referenceType: node.referenceType ?? "full",
          },
        },
      ];
    }
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

function mdastInlines(node: MdNode, source: string, marks: PMJsonMark[], ctx: MdContext): PMJson[] {
  return mergeMathmlInlines(node.children ?? [], source).flatMap((child) => {
    if (child.type === "mathmlInlineRun") {
      return [{ type: "mathml_inline", attrs: { source: child.value ?? "" } }];
    }
    return mdastInline(child, source, marks, ctx);
  });
}

function mdastListItem(node: MdNode, source: string, ctx: MdContext): PMJson {
  const blocks = (node.children ?? [])
    .map((child) => mdastBlock(child, source, ctx))
    .filter((block): block is PMJson => block !== null);
  const content = blocks[0]?.type === "paragraph" ? blocks : [{ type: "paragraph" }, ...blocks];
  return {
    type: "list_item",
    attrs: { checked: typeof node.checked === "boolean" ? node.checked : null },
    content,
  };
}

function mdastList(node: MdNode, source: string, ctx: MdContext): PMJson {
  const items = (node.children ?? []).filter((child) => child.type === "listItem");
  const content = items.map((item) => mdastListItem(item, source, ctx));
  if (content.length === 0) content.push(mdastListItem({ type: "listItem", children: [] }, source, ctx));
  if (node.ordered === true) {
    return { type: "ordered_list", attrs: { start: node.start ?? 1 }, content };
  }
  return { type: "bullet_list", content };
}

function mdastTable(node: MdNode, source: string, ctx: MdContext): PMJson | null {
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
        content: [{ type: "paragraph", content: mdastInlines(cell, source, [], ctx) }],
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
  const meta = (node.meta ?? "").trim();
  const kind = diagramKind(language);
  if (kind) return { type: "diagram_block", attrs: { kind, source: value, meta } };
  return {
    type: "code_block",
    attrs: { language, meta },
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
  ctx: MdContext,
  type: "tab_item" | "grid_item",
): PMJson {
  const blocks = (node.children ?? [])
    .map((child) => mdastBlock(child, source, ctx))
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
  ctx: MdContext,
  kind: "tab_set" | "grid",
): PMJson {
  const itemType = kind === "tab_set" ? "mystTabItem" : "mystGridItem";
  const items = (node.children ?? [])
    .filter((child) => child.type === itemType)
    .map((child) => mdastContainerItem(child, source, ctx, kind === "tab_set" ? "tab_item" : "grid_item"));
  if (items.length === 0) {
    items.push(mdastContainerItem({ type: itemType, children: [] }, source, ctx, kind === "tab_set" ? "tab_item" : "grid_item"));
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
  ctx: MdContext,
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
      return { type: "paragraph", content: mdastInlines(node, source, [], ctx) };
    }
    case "heading": {
      const level = Math.min(6, Math.max(1, node.depth ?? 1));
      return {
        type: "heading",
        attrs: { level, id: ctx.slugger(textContent(node)) },
        content: mdastInlines(node, source, [], ctx),
      };
    }
    case "blockquote": {
      const content = (node.children ?? [])
        .map((child) => mdastBlock(child, source, ctx))
        .filter((block): block is PMJson => block !== null);
      return { type: "blockquote", content: content.length ? content : [{ type: "paragraph" }] };
    }
    case "list":
      return mdastList(node, source, ctx);
    case "table":
      return mdastTable(node, source, ctx);
    case "code":
      return mdastCode(node);
    case "mystTabSet":
      return mdastContainer(node, source, ctx, "tab_set");
    case "mystTabItem":
      return mdastContainerItem(node, source, ctx, "tab_item");
    case "mystGrid":
      return mdastContainer(node, source, ctx, "grid");
    case "mystGridItem":
      return mdastContainerItem(node, source, ctx, "grid_item");
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
  const definitions = new Map<string, { url: string; title: string | null }>();
  collectDefinitions(root, definitions);
  const ctx: MdContext = { slugger: createSlugger(), definitions };
  const blocks = (root.children ?? [])
    .map((child) => mdastBlock(child, source, ctx))
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
    const reference = typeof link.attrs?.reference === "string" ? link.attrs.reference : "";
    if (reference) {
      // 引用式链接保留 `[text][label]` 写法，避免把定义改写为内联链接。
      const referenceType = String(link.attrs?.referenceType ?? "full");
      result = {
        type: "linkReference",
        identifier: normalizeIdentifier(reference),
        label: reference,
        referenceType:
          referenceType === "collapsed" || referenceType === "shortcut" ? referenceType : "full",
        children: [result],
      };
    } else {
      result = {
        type: "link",
        url: String(link.attrs?.href ?? ""),
        title: link.attrs?.title == null ? null : String(link.attrs.title),
        children: [result],
      };
    }
  }
  return result;
}

function pmInlineToMdast(node: PMJson): MdNode | null {
  switch (node.type) {
    case "text":
      return applyMarks(node.text ?? "", node.marks ?? []);
    case "image": {
      const reference = typeof node.attrs?.reference === "string" ? node.attrs.reference : "";
      if (reference) {
        const referenceType = String(node.attrs?.referenceType ?? "full");
        return {
          type: "imageReference",
          identifier: normalizeIdentifier(reference),
          label: reference,
          alt: String(node.attrs?.alt ?? ""),
          referenceType:
            referenceType === "collapsed" || referenceType === "shortcut" ? referenceType : "full",
        };
      }
      return {
        type: "image",
        url: String(node.attrs?.src ?? ""),
        alt: String(node.attrs?.alt ?? ""),
        title: node.attrs?.title == null ? null : String(node.attrs.title),
      };
    }
    case "hard_break":
      return { type: "break" };
    case "raw_inline":
      return { type: "html", value: String(node.attrs?.raw ?? "") };
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
        meta: String(node.attrs?.meta ?? "") || null,
        value: pmText(node),
      };
    case "diagram_block":
      return {
        type: "code",
        lang: String(node.attrs?.kind ?? "plantuml"),
        meta: String(node.attrs?.meta ?? "") || null,
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
