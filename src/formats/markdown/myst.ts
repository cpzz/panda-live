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
  // 官方冒号围栏（`:::{tab-set}` / `::::`）与反引号围栏等价；先等行数重写为反引号
  // 再复用同一展开逻辑，行号保持对齐。见 mystmd.org 语法概览。
  const rewritten = rewriteColonFences(source);
  if (rewritten !== null) {
    const reparsed = getFragmentParser().parse(rewritten) as unknown as MdNode;
    const children = reparsed.children ?? [];
    annotate(children, rewritten);
    return { ...root, children: expandChildren(children) };
  }
  const children = root.children ?? [];
  annotate(children, source);
  return { ...root, children: expandChildren(children) };
}

/** 冒号围栏中已支持的指令名；其余指令名保持原样不转换。 */
const COLON_SUPPORTED = new Set(["tab-set", "tab-item", "grid", "grid-item"]);

const COLON_OPEN = /^(:{3,})\s*\{([A-Za-z][A-Za-z0-9_-]*)\}[ \t]*(.*)$/u;
const COLON_CLOSE = /^(:{3,})\s*$/u;
const BACKTICK_FENCE_LINE = /^(`{3,})/u;

interface ColonBlock {
  open: number;
  close: number;
  colons: number;
  name: string;
  args: string;
  /** 内容中出现的最长反引号围栏行（含已转换的内层块）；决定本块反引号长度。 */
  inner: number;
  /** 父块在 blocks 中的索引，-1 表示顶层。 */
  parent: number;
  fenceLen: number;
}

/**
 * 把官方冒号围栏语法等行数重写为反引号围栏，随后走反引号展开管线。
 * 只替换开栏/闭栏行、不增删行，源码行号保持对齐（差异装饰依赖行号）。
 * 嵌套靠冒号数量区分，转换为「内层反引号 + 1」保证外层能包裹内容；
 * 未闭合、或不支持的指令名（如 `{note}`）不转换，按普通文本渲染。
 */
function rewriteColonFences(source: string): string | null {
  if (!/^:{3,}\{/um.test(source)) return null;
  const lines = source.split("\n");
  const blocks: ColonBlock[] = [];
  /** 活跃冒号块在 blocks 中的索引；用索引避免 indexOf 线性查找。 */
  const stack: number[] = [];
  /** 当前反引号代码块长度；> 0 表示代码块内的内容按字面量处理。 */
  let codeFence = 0;
  /** 嵌套冒号数量未按「外多内少」时无法确定边界，放弃整体转换。 */
  let invalid = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const backtick = BACKTICK_FENCE_LINE.exec(line);
    if (codeFence > 0) {
      // 代码块内的 `:::` 是字面量，不参与指令识别；同长或更长的纯反引号行关闭代码块。
      if (backtick && backtick[1]!.length >= codeFence && /^`{3,}\s*$/u.test(line)) codeFence = 0;
      continue;
    }
    if (backtick) {
      codeFence = backtick[1]!.length;
      // 所有活跃冒号块都必须比它更长才能包裹。
      for (const opening of stack) {
        const block = blocks[opening]!;
        block.inner = Math.max(block.inner, codeFence);
      }
      continue;
    }
    const open = COLON_OPEN.exec(line);
    if (open) {
      const colons = open[1]!.length;
      const parentIndex = stack.length > 0 ? stack[stack.length - 1]! : -1;
      const parent = parentIndex >= 0 ? blocks[parentIndex]! : null;
      // 内层必须比外层更短（外层多加冒号才能包裹），否则无法确定边界，保守放弃转换。
      if (parent && colons >= parent.colons) invalid = true;
      blocks.push({
        open: index,
        close: -1,
        colons,
        name: COLON_SUPPORTED.has(open[2]!) ? open[2]! : "",
        args: open[3]!.trim(),
        inner: 0,
        parent: parentIndex,
        fenceLen: 0,
      });
      stack.push(blocks.length - 1);
      continue;
    }
    const close = COLON_CLOSE.exec(line);
    if (close && stack.length > 0) {
      const topIndex = stack[stack.length - 1]!;
      const top = blocks[topIndex]!;
      // 与 markdown-it-container 一致：闭栏冒号数不少于开栏即可。
      if (close[1]!.length >= top.colons) {
        top.close = index;
        stack.pop();
      }
    }
  }
  // 有未闭合块或非法嵌套：保守起见整体不转换，按普通文本渲染。
  if (invalid || stack.length > 0) return null;
  const converted = blocks.filter((block) => block.name);
  if (converted.length === 0) return null;

  // 自底向上确定反引号长度：内层先定长并传播给父块，避免外层无法包裹内层。
  for (const block of [...blocks].sort((a, b) => b.open - a.open)) {
    if (!block.name) continue;
    block.fenceLen = Math.max(3, block.inner + 1);
    if (block.parent >= 0) {
      const parent = blocks[block.parent]!;
      parent.inner = Math.max(parent.inner, block.fenceLen);
    }
  }
  for (const block of converted) {
    const fence = "`".repeat(block.fenceLen);
    lines[block.open] = `${fence}{${block.name}}${block.args ? ` ${block.args}` : ""}`;
    lines[block.close] = fence;
  }
  return lines.join("\n");
}
