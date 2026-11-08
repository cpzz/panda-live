import DOMPurify from "dompurify";
import rehypeKatex from "rehype-katex";
import rehypeStringify from "rehype-stringify";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkMath)
  // 允许原始 HTML 进入 hast（含内嵌 MathML），输出前由 DOMPurify 白名单过滤。
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeKatex)
  .use(rehypeStringify);

/**
 * Markdown → 消毒后的 HTML。数学公式经 KaTeX 渲染，内嵌 MathML 原生渲染，
 * 统一经 DOMPurify 白名单过滤。见 doc/design.md §12、§13.4。
 */
export async function renderMarkdownToHtml(markdown: string): Promise<string> {
  const file = await processor.process(markdown);
  return DOMPurify.sanitize(String(file), {
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    ADD_ATTR: ["target"],
  });
}
