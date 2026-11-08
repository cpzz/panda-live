import DOMPurify from "dompurify";

/** 图表 SVG 中必须移除的元素：脚本与可嵌入 HTML/脚本的容器。见 §10.3、§13.6。 */
const FORBIDDEN_TAGS = new Set(["script", "foreignobject", "iframe", "object", "embed"]);

/** 允许保留的 URL 形式：内部片段与内联图片；其余（http、javascript、file）一律移除。 */
function isSafeUrl(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("#") || /^data:image\/(png|jpeg|jpg|gif|webp);base64,/iu.test(trimmed);
}

/**
 * 父窗口侧 SVG 消毒：DOMPurify SVG profile + 显式结构清理。
 * 引擎输出视为不可信数据，禁止 script/foreignObject/事件属性/外部 URL。见 doc/design.md §10.3。
 */
export function sanitizeDiagramSvg(svg: string): string {
  const purified = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["script", "foreignObject", "iframe", "object", "embed"],
    ALLOW_DATA_ATTR: false,
  });

  // DOMPurify 在 XML 命名空间下对 xlink:href 的外部链接过滤并不完备，再做一次结构遍历。
  const parser = new DOMParser();
  const document = parser.parseFromString(purified, "image/svg+xml");
  if (document.querySelector("parsererror")) return "";

  const elements = Array.from(document.querySelectorAll("*"));
  for (const element of elements) {
    if (FORBIDDEN_TAGS.has(element.tagName.toLowerCase())) {
      element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if ((name === "href" || name === "xlink:href") && !isSafeUrl(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  return new XMLSerializer().serializeToString(document.documentElement);
}
