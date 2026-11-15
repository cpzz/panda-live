import DOMPurify from "dompurify";

/**
 * 粘贴 HTML 的消毒：只保留可映射到 schema 的标签与必要属性。
 * 外部样式、脚本、事件属性与不安全 URL 一律移除。见 doc/design.md §11.2。
 */
const ALLOWED_TAGS = [
  "p",
  "br",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "b",
  "em",
  "i",
  "s",
  "del",
  "strike",
  "code",
  "pre",
  "a",
  "img",
  "ul",
  "ol",
  "li",
  "blockquote",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "input",
];

const ALLOWED_ATTR = [
  "href",
  "src",
  "alt",
  "title",
  "colspan",
  "rowspan",
  "align",
  "start",
  "type",
  "checked",
  "data-checked",
  "data-language",
  "class",
];

/** 消毒后返回可交给 `DOMParser.fromSchema` 的容器；无内容时返回 null。 */
export function sanitizePastedHtml(html: string): HTMLElement | null {
  if (!html.trim()) return null;
  const purified = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "video", "audio", "svg", "math"],
    FORBID_ATTR: ["style"],
    KEEP_CONTENT: true,
    ALLOW_DATA_ATTR: true,
  });
  const doc = new window.DOMParser().parseFromString(
    `<div id="panda-paste-root">${purified}</div>`,
    "text/html",
  );
  const root = doc.getElementById("panda-paste-root");
  // 纯图片/表格等没有文本也允许；仅在完全为空时放弃。
  if (!root || root.children.length === 0) return null;
  return root;
}
