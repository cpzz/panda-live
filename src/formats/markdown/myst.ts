import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { singleDollarEnabled } from "../../services/math-settings";
import type { MdNode } from "./mapping";

function buildFragmentParser() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkMath, { singleDollarTextMath: singleDollarEnabled() });
}

/** 与 parse.ts 使用相同的语法插件，保证指令内容按 Markdown 解析；按单美元开关缓存。 */
let cachedParser: ReturnType<typeof buildFragmentParser> | null = null;
let cachedSingleDollar: boolean | null = null;

function getFragmentParser(): ReturnType<typeof buildFragmentParser> {
  const singleDollar = singleDollarEnabled();
  if (!cachedParser || cachedSingleDollar !== singleDollar) {
    cachedParser = buildFragmentParser();
    cachedSingleDollar = singleDollar;
  }
  return cachedParser;
}

type DirectiveName = "tab-set" | "tab-item" | "grid" | "grid-item";

const DIRECTIVE_LANG = /^\{(tab-set|tab-item|grid|grid-item)\}$/u;

function directiveName(node: MdNode): DirectiveName | null {
  const lang = (node.lang ?? "").trim();
  const match = DIRECTIVE_LANG.exec(lang);
  return match ? (match[1] as DirectiveName) : null;
}

/** 把解析片段的原始切片记录到节点上，供 `raw_markdown` 兜底使用（位置相对于片段）。 */
function annotate(children: MdNode[], source: string): void {
  for (const child of children) {
    const start = child.position?.start?.offset;
    const end = child.position?.end?.offset;
    if (typeof start === "number" && typeof end === "number") {
      child.rawSource = source.slice(start, end);
    }
    if (child.children) annotate(child.children, source);
  }
}

function emptyParagraph(): MdNode {
  return { type: "paragraph", children: [] };
}

/**
 * 递归展开 MyST 围栏指令。外层围栏已由 micromark 解析为 code 节点，
 * 内部文本再交给同一解析器，天然支持嵌套围栏。见 doc/design.md §8.2。
 */
function parseFragment(source: string): MdNode[] {
  try {
    const root = getFragmentParser().parse(source) as unknown as MdNode;
    const children = root.children ?? [];
    annotate(children, source);
    return expandChildren(children);
  } catch {
    return [];
  }
}

function expandChildren(children: MdNode[]): MdNode[] {
  const result: MdNode[] = [];
  for (const child of children) {
    if (child.type === "code") {
      const name = directiveName(child);
      if (name === "tab-set" || name === "grid") {
        result.push(expandContainer(child, name));
        continue;
      }
    }
    if (child.children) {
      result.push({ ...child, children: expandChildren(child.children) });
      continue;
    }
    result.push(child);
  }
  return result;
}

/** 提取指令体开头的 `:key: value` 选项行，返回剩余内容。 */
function extractOptions(raw: string): { options: Record<string, string>; rest: string } {
  const lines = raw.split("\n");
  const options: Record<string, string> = {};
  let index = 0;
  while (index < lines.length && lines[index]!.trim() === "") index++;

  let consumed = false;
  while (index < lines.length) {
    const match = /^\s*:([A-Za-z0-9_-]+):\s*(.*)$/u.exec(lines[index]!);
    if (!match) break;
    options[match[1]!.toLowerCase()] = match[2]!.trim();
    consumed = true;
    index += 1;
  }
  if (consumed) {
    while (index < lines.length && lines[index]!.trim() === "") index++;
  }
  return { options, rest: lines.slice(index).join("\n") };
}

function expandContainer(node: MdNode, name: "tab-set" | "grid"): MdNode {
  const { options, rest } = extractOptions(node.value ?? "");
  const blocks = parseFragment(rest);
  const itemName = name === "tab-set" ? "tab-item" : "grid-item";

  const items: MdNode[] = [];
  for (const block of blocks) {
    if (block.type !== "code" || directiveName(block) !== itemName) continue;
    const content = parseFragment(block.value ?? "");
    items.push({
      type: name === "tab-set" ? "mystTabItem" : "mystGridItem",
      ...(name === "tab-set" ? { label: (block.meta ?? "").trim() } : {}),
      children: content.length ? content : [emptyParagraph()],
    });
  }

  if (name === "tab-set") {
    return {
      type: "mystTabSet",
      children: items.length ? items : [{ type: "mystTabItem", label: "", children: [emptyParagraph()] }],
    };
  }

  const metaColumns = Number((node.meta ?? "").trim().split(/\s+/u)[0]);
  const columns =
    Number(options.columns) > 0
      ? Number(options.columns)
      : Number.isFinite(metaColumns) && metaColumns > 0
        ? metaColumns
        : 2;
  const outline = Object.hasOwn(options, "outline");
  return {
    type: "mystGrid",
    columns,
    outline,
    children: items.length ? items : [{ type: "mystGridItem", children: [emptyParagraph()] }],
  };
}

/** 对整棵 mdast 应用 MyST 指令展开；非指令节点原样返回。 */
export function expandMyst(root: MdNode, source: string): MdNode {
  const children = root.children ?? [];
  annotate(children, source);
  return { ...root, children: expandChildren(children) };
}
