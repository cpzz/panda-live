/** 解析相对资源路径（导出/预览图片）；拒绝绝对路径与协议 URL。 */
export function resolveRelativePath(baseFilePath: string, src: string): string | null {
  const cleaned = src.split(/[?#]/)[0] ?? "";
  if (!cleaned || cleaned.startsWith("/") || cleaned.startsWith("\\") || /^[a-z]+:/i.test(cleaned)) {
    return null;
  }
  const separator = baseFilePath.includes("\\") ? "\\" : "/";
  const stack = baseFilePath.split(/[\\/]/);
  stack.pop();
  for (const segment of cleaned.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return null;
      stack.pop();
    } else {
      stack.push(segment);
    }
  }
  return stack.join(separator);
}
