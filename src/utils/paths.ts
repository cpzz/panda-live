/** 解析相对资源路径（导出/预览图片/Markdown link）；拒绝绝对路径与协议 URL。 */
export function resolveRelativePath(baseFilePath: string, src: string): string | null {
  // Markdown 渲染器会把非 ASCII 字符 URL 编码（如 "我的文档.md" → "%E6%88%91%E7%9A%84%E6%96%87%E6%A1%A3.md"）。
  // 这里先 decode，保证拼出来的路径与磁盘一致。decodeURIComponent 对非法输入会抛，用 try/catch 兜底。
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    decoded = src;
  }
  const cleaned = decoded.split(/[?#]/)[0] ?? "";
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

/**
 * 路径身份归一化：统一分隔符、去尾分隔符，Windows 盘符小写。
 * 用于判断两个路径字符串是否指向同一文件——工作区树与 Git 面板对同一文件
 * 可能拼出字符串不同的路径（Git 根来自 rev-parse，分隔符/盘符大小写与对话框不同）。
 */
export function pathKey(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/u, "");
  return /^[a-zA-Z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
}
