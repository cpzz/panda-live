/** 复制文本到系统剪贴板；剪贴板 API 不可用时回退到隐藏 textarea。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // file:// 等场景可能拒绝 Clipboard API，走回退路径。
  }

  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.left = "-2000px";
  area.style.top = "0";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  return copied;
}
