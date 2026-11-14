import DOMPurify from "dompurify";

/** 图表 SVG 中必须移除的元素：脚本与可嵌入 HTML/脚本的容器。见 §10.3、§13.6。 */
const FORBIDDEN_TAGS = new Set(["script", "foreignobject", "iframe", "object", "embed"]);

/** 允许保留的 URL 形式：内部片段与内联图片；其余（http、javascript、file）一律移除。 */
function isSafeUrl(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("#") || /^data:image\/(png|jpeg|jpg|gif|webp);base64,/iu.test(trimmed);
}

/** width 值是否为固定像素（纯数字或 Npx）；百分比等相对值不算。 */
function isFixedPixelWidth(value: string): boolean {
  return /^\s*\d+(\.\d+)?(px)?\s*$/iu.test(value);
}

/** 从内联 style 中提取 max-width 的像素值；Mermaid 以内联 max-width 编码图表自然宽度。 */
function extractMaxWidthPx(style: string): number | null {
  for (const declaration of style.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    if (property !== "max-width") continue;
    const match = /^(\d+(\.\d+)?)px$/iu.exec(declaration.slice(separator + 1).trim());
    const parsed = match ? Number.parseFloat(match[1]!) : Number.NaN;
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/** 移除内联 style 中的 max-width 声明，其余声明原样保留。 */
function removeMaxWidthDeclaration(style: string): string {
  const kept = style.split(";").filter((declaration) => {
    const separator = declaration.indexOf(":");
    if (separator < 0) return declaration.trim().length > 0;
    return declaration.slice(0, separator).trim().toLowerCase() !== "max-width";
  });
  return kept.join(";").trim();
}

/**
 * 解析 SVG 的自然宽度：优先固定像素 width 属性，其次 viewBox 宽度。
 * 缩放视图（独立图表预览与「放大查看」对话框）以该值作为 100% 基准。
 */
export function svgNaturalWidth(svg: string, fallback = 600): number {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const element = document.documentElement;
  if (element.tagName.toLowerCase() !== "svg" || document.querySelector("parsererror")) {
    return fallback;
  }
  const width = element.getAttribute("width");
  if (width && isFixedPixelWidth(width)) {
    const parsed = Number.parseFloat(width);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const viewBox = element.getAttribute("viewBox");
  if (viewBox) {
    const parsed = Number(viewBox.trim().split(/[\s,]+/u)[2]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
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
      if (name === "style" && element.tagName.toLowerCase() === "svg") {
        // Mermaid 在 svg 上以内联 max-width 编码自然宽度（width="100%"）：
        // 转写为固定 width 属性，缩放视图才能取到自然尺寸；其余声明原样保留。
        const natural = extractMaxWidthPx(attribute.value);
        const rest = removeMaxWidthDeclaration(attribute.value);
        if (rest) element.setAttribute("style", rest);
        else element.removeAttribute("style");
        const currentWidth = element.getAttribute("width");
        if (natural !== null && !(currentWidth && isFixedPixelWidth(currentWidth))) {
          element.setAttribute("width", `${natural}`);
        }
        continue;
      }
      if ((name === "href" || name === "xlink:href") && !isSafeUrl(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  return new XMLSerializer().serializeToString(document.documentElement);
}
