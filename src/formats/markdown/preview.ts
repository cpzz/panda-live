import DOMPurify from "dompurify";
import rehypeKatex from "rehype-katex";
import rehypeStringify from "rehype-stringify";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { katexMacros, singleDollarEnabled } from "../../services/math-settings";

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: { start: { line: number }; end: { line: number } };
}

/** 仅给块级元素标注源行号，避免内联节点产生大量属性。见 doc/design.md §21.5。 */
const BLOCK_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "table",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
  "hr",
  "img",
  "figure",
  "figcaption",
  "div",
  "details",
  "summary",
  "section",
  "dl",
  "dt",
  "dd",
]);

function annotateSourceLines(node: HastNode): void {
  if (node.type === "element" && node.position && node.tagName && BLOCK_TAGS.has(node.tagName)) {
    node.properties = {
      ...node.properties,
      "data-src-line": node.position.start.line,
      "data-src-end-line": node.position.end.line,
    };
  }
  for (const child of node.children ?? []) annotateSourceLines(child);
}

function rehypeSourceLines() {
  return (tree: HastNode): void => annotateSourceLines(tree);
}

interface BuiltProcessors {
  base: ReturnType<typeof buildProcessor>;
  annotated: ReturnType<typeof buildProcessor>;
}

/** 处理器按数学设置（宏、单美元开关）缓存；设置变化时重建。见 doc/design.md §9.2、§15.3。 */
let builtProcessors: BuiltProcessors | null = null;
let builtSignature = "";

function buildProcessor(annotate: boolean, singleDollar: boolean) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkMath, { singleDollarTextMath: singleDollar })
    // 允许原始 HTML 进入 hast 并原样输出（含内嵌 MathML、`<a id>` 锚点），
    // 输出前由 DOMPurify 白名单过滤，因此不会引入脚本或事件属性。
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeKatex, { macros: katexMacros() });
  return annotate
    ? processor.use(rehypeSourceLines).use(rehypeStringify, { allowDangerousHtml: true })
    : processor.use(rehypeStringify, { allowDangerousHtml: true });
}

function getProcessors(): BuiltProcessors {
  const signature = `${singleDollarEnabled() ? "1" : "0"}\u0000${JSON.stringify(katexMacros())}`;
  if (!builtProcessors || builtSignature !== signature) {
    builtProcessors = {
      base: buildProcessor(false, singleDollarEnabled()),
      annotated: buildProcessor(true, singleDollarEnabled()),
    };
    builtSignature = signature;
  }
  return builtProcessors;
}

export interface RenderMarkdownOptions {
  /** 为块级元素附加 `data-src-line` / `data-src-end-line`，供差异装饰定位。 */
  annotateSource?: boolean;
}

/**
 * Markdown → 消毒后的 HTML。数学公式经 KaTeX 渲染，内嵌 MathML 原生渲染，
 * 统一经 DOMPurify 白名单过滤。见 doc/design.md §12、§13.4。
 */
export async function renderMarkdownToHtml(
  markdown: string,
  options: RenderMarkdownOptions = {},
): Promise<string> {
  const processor = options.annotateSource ? getProcessors().annotated : getProcessors().base;
  const file = await processor.process(markdown);
  return DOMPurify.sanitize(String(file), {
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "base"],
    FORBID_ATTR: ["srcdoc"],
    ADD_ATTR: ["target", "data-src-line", "data-src-end-line"],
  });
}
