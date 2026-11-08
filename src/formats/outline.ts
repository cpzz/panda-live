import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

export interface OutlineItem {
  /** 文档内标题序号（从 0 开始），用于在 WYSIWYG 与预览中按顺序定位。 */
  index: number;
  /** 层级，1 为最高层。 */
  level: number;
  text: string;
  /** 源码行号，从 1 开始。 */
  line: number;
}

interface MdastNode {
  type: string;
  value?: string | null;
  depth?: number | null;
  children?: MdastNode[];
  position?: { start?: { line?: number } | null } | null;
}

const markdownParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkMath);

/** 提取节点的纯文本，用于大纲标题。 */
function nodeText(node: MdastNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(nodeText).join("");
}

function markdownOutline(source: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const walk = (node: MdastNode): void => {
    if (node.type === "heading") {
      items.push({
        index: items.length,
        level: Math.min(6, Math.max(1, Number(node.depth) || 1)),
        text: nodeText(node).trim(),
        line: node.position?.start?.line ?? 1,
      });
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(markdownParser.parse(source) as unknown as MdastNode);
  return items;
}

const LATEX_HEADING =
  /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\]\s*)?\{/u;
const LATEX_LEVELS: Record<string, number> = {
  part: 1,
  chapter: 2,
  section: 3,
  subsection: 4,
  subsubsection: 5,
  paragraph: 6,
};

/** 从 `{` 起截取平衡花括号内的内容。 */
function braceContent(line: string, openIndex: number): string {
  let depth = 0;
  for (let index = openIndex; index < line.length; index += 1) {
    const char = line[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return line.slice(openIndex + 1, index);
    }
  }
  return line.slice(openIndex + 1);
}

function cleanLatexTitle(raw: string): string {
  return raw
    .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/gu, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function latexOutline(source: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const lines = source.split(/\r?\n/);
  for (const [lineIndex, line] of lines.entries()) {
    const match = LATEX_HEADING.exec(line);
    if (!match) continue;
    const command = match[1] ?? "section";
    const openIndex = match.index + match[0].length - 1;
    items.push({
      index: items.length,
      level: LATEX_LEVELS[command] ?? 3,
      text: cleanLatexTitle(braceContent(line, openIndex)),
      line: lineIndex + 1,
    });
  }
  return items;
}

/** 文档大纲：Markdown 取标题层级，LaTeX 取 `\section` 等章节命令。见 doc/design.md §15.1。 */
export function buildOutline(source: string, format: string): OutlineItem[] {
  if (format === "markdown") return markdownOutline(source);
  if (format === "latex") return latexOutline(source);
  return [];
}
