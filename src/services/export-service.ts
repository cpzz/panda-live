import { renderMarkdownToHtml } from "../formats/markdown/preview";
import { getDiagramService } from "../render/diagram";
import { katexCssInline } from "../render/export-fonts";
import { resolveRelativePath } from "../utils/paths";
import type { DocumentState } from "../services/document-manager";

const EXPORT_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

const EXPORT_STYLES = `
body { margin: 0; background: #ffffff; color: #1f2328; font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
.markdown-body { max-width: 860px; margin: 0 auto; padding: 48px 32px 96px; font-size: 15px; line-height: 1.75; }
.markdown-body h1, .markdown-body h2 { border-bottom: 1px solid #e3e6ea; padding-bottom: 0.3em; }
.markdown-body pre { background: #f2f4f6; padding: 14px 16px; border-radius: 8px; overflow-x: auto; }
.markdown-body code { background: #f2f4f6; padding: 0.15em 0.35em; border-radius: 4px; font-family: ui-monospace, Consolas, monospace; font-size: 0.9em; }
.markdown-body pre code { background: transparent; padding: 0; }
.markdown-body table { border-collapse: collapse; }
.markdown-body th, .markdown-body td { border: 1px solid #d0d7de; padding: 6px 12px; }
.markdown-body img { max-width: 100%; }
.markdown-body .diagram-export { text-align: center; margin: 16px 0; }
.markdown-body .diagram-export svg { max-width: 100%; height: auto; }
`;

function escapeTitle(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 把预览 HTML 中的图表代码块替换为消毒后的 SVG。见 doc/design.md §12.8。 */
async function inlineDiagrams(html: string, theme: "light" | "dark"): Promise<string> {
  const document = new DOMParser().parseFromString(html, "text/html");
  const codes = [...document.querySelectorAll("pre > code")];
  let index = 0;
  for (const code of codes) {
    const className = code.className;
    const kind = /language-(plantuml|puml)/.test(className)
      ? ("plantuml" as const)
      : /language-(mermaid|mmd)/.test(className)
        ? ("mermaid" as const)
        : null;
    if (!kind) continue;
    const source = code.textContent ?? "";
    if (!source.trim()) continue;
    const result = await getDiagramService().render({
      id: `export:${index++}`,
      kind,
      source,
      theme,
    });
    if (!result.ok) continue;
    const wrapper = document.createElement("div");
    wrapper.className = "diagram-export";
    wrapper.innerHTML = result.svg;
    code.parentElement?.replaceWith(wrapper);
  }
  return document.body.innerHTML;
}

export interface HtmlExportOptions {
  theme: "light" | "dark";
}

/** 把相对图片内联为 data URL，保证导出文件离线可用。见 §12.8。 */
async function inlineImages(html: string, baseFilePath: string | null): Promise<string> {
  if (!baseFilePath) return html;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  for (const image of [...parsed.querySelectorAll("img")]) {
    const src = image.getAttribute("src") ?? "";
    const resolved = resolveRelativePath(baseFilePath, src);
    if (!resolved) continue;
    try {
      const file = await window.panda.fs.readBase64({ path: resolved });
      image.setAttribute("src", `data:${file.mime};base64,${file.data}`);
    } catch {
      // 读取失败时保留原始引用
    }
  }
  return parsed.body.innerHTML;
}

/**
 * 生成独立 HTML：内联 KaTeX 字体、消毒图表 SVG、内联图片、写入 CSP，不含脚本。
 */
export async function buildDocumentHtml(
  document: DocumentState,
  options: HtmlExportOptions,
): Promise<string> {
  const rendered = await renderMarkdownToHtml(document.content);
  const body = await inlineImages(await inlineDiagrams(rendered, options.theme), document.path);
  const title = escapeTitle(document.name.replace(/\.(md|markdown|mdown|mkd|qmd|rmd|mdx)$/i, ""));
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${katexCssInline()}${EXPORT_STYLES}</style>
</head>
<body>
<article class="markdown-body">
${body}
</article>
</body>
</html>`;
}

/** 把导出 HTML 写入用户选择的位置。 */
export async function saveHtml(document: DocumentState, html: string): Promise<string | null> {
  const suggestedName = `${document.name.replace(/\.(md|markdown|mdown|mkd|qmd|rmd|mdx)$/i, "")}.html`;
  const ref = await window.panda.dialog.saveAs({
    suggestedName,
    filters: [{ name: "HTML", extensions: ["html"] }],
  });
  if (!ref) return null;
  await window.panda.fs.writeText({ path: ref.path, content: html, baseHash: "" });
  return ref.path;
}

/** 导出当前图表文档的 SVG（仅 .puml/.mmd）。 */
export async function exportDiagramSvg(document: DocumentState): Promise<string | null> {
  if (!document.path || document.format === "markdown") return null;
  const kind = document.format === "mermaid" ? "mermaid" : "plantuml";
  const result = await getDiagramService().render({
    id: `export-svg:${document.id}`,
    kind,
    source: document.content,
    theme: "light",
  });
  if (!result.ok) throw new Error(result.error);
  const base = document.name.replace(/\.\w+$/, "");
  const ref = await window.panda.dialog.saveAs({
    suggestedName: `${base}.svg`,
    filters: [{ name: "SVG", extensions: ["svg"] }],
  });
  if (!ref) return null;
  await window.panda.fs.writeText({ path: ref.path, content: result.svg, baseHash: "" });
  return ref.path;
}
