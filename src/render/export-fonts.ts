import katexCss from "katex/dist/katex.min.css?raw";

/** 构建时由 `inlineBinaryAssets` 插件展开为 data URL。 */
const fonts = import.meta.glob("/node_modules/katex/dist/fonts/*", {
  eager: true,
  query: "?inline-binary",
  import: "default",
}) as Record<string, string>;

let cached: string | null = null;

/** 把 KaTeX CSS 中的字体引用替换为内联 data URL，导出文件可离线显示数学公式。 */
export function katexCssInline(): string {
  if (cached) return cached;
  cached = katexCss.replace(/url\(([^)]+)\)/g, (match, raw: string) => {
    const cleaned = raw.replace(/["']/g, "").trim();
    const name = cleaned.replace(/^fonts\//, "");
    if (!cleaned.startsWith("fonts/")) return match;
    const key = Object.keys(fonts).find((item) => item.endsWith(`/${name}`));
    const dataUrl = key ? fonts[key] : undefined;
    return dataUrl ? `url(${dataUrl})` : match;
  });
  return cached;
}
