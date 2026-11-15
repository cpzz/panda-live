/**
 * 标题锚点生成：小写、去掉标点（保留字母/数字/空格/连字符）、空格转连字符；
 * 重复标题追加 `-1`、`-2`。解析 Markdown 与编辑器页内跳转共用，保证两边一致。
 */
export function createSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text: string) => {
    const base =
      text
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .replace(/\s+/g, "-") || "section";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}
