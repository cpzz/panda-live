import DOMPurify from "dompurify";

/**
 * 扩展 `renderPreview` 返回的 HTML 在插入前统一消毒：移除脚本、事件属性与可执行 URL。
 * 见 doc/design.md §7.6.3、§13.4。
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "base"],
    FORBID_ATTR: ["srcdoc"],
  });
}
