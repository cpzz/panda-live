import katex from "katex";

export type MathRenderResult =
  | { ok: true; html: string }
  | { ok: false; error: string };

const CACHE_LIMIT = 500;
const cache = new Map<string, MathRenderResult>();

function cached(key: string, render: () => MathRenderResult): MathRenderResult {
  const hit = cache.get(key);
  if (hit !== undefined) {
    // LRU：命中后移到末尾。
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const result = render();
  cache.set(key, result);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return result;
}

/**
 * 解析用户设置中的宏定义文本：每行一条 `\命令 = 定义`（也接受 `:` 分隔），
 * 空行与 `%`、`#` 注释行忽略；非法行跳过。见 doc/design.md §9.2。
 */
export function parseKatexMacros(text: string): Record<string, string> {
  const macros: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("%") || line.startsWith("#")) continue;
    const match = /^(\\[a-zA-Z@]+)\s*[=:]\s*(.+)$/u.exec(line);
    if (!match) continue;
    macros[match[1] as string] = match[2]!.trim();
  }
  return macros;
}

export interface KatexRenderOptions {
  /** 用户自定义宏（`parseKatexMacros` 的产物）；参与缓存键。 */
  macros?: Record<string, string>;
}

/**
 * KaTeX 静态渲染，`htmlAndMathml` 输出保证可访问性（doc/design.md §4.4、附录 B）。
 * 渲染失败返回错误信息，由调用方保留源码并提示（FR-04）。
 */
export function renderKatex(
  source: string,
  displayMode: boolean,
  options: KatexRenderOptions = {},
): MathRenderResult {
  const macroKey = JSON.stringify(options.macros ?? {});
  const key = `${displayMode ? "b" : "i"}\u0000${macroKey}\u0000${source}`;
  return cached(key, () => {
    try {
      const html = katex.renderToString(source, {
        displayMode,
        output: "htmlAndMathml",
        throwOnError: true,
        strict: "warn",
        trust: false,
        ...(options.macros ? { macros: { ...options.macros } } : {}),
      });
      return { ok: true, html };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

/** 从 KaTeX 输出中提取 MathML 分支，用于「复制 MathML」。见 doc/design.md §9.4。 */
export function extractMathml(
  source: string,
  displayMode: boolean,
  options: KatexRenderOptions = {},
): string | null {
  const result = renderKatex(source, displayMode, options);
  if (!result.ok) return null;
  const template = document.createElement("template");
  template.innerHTML = result.html;
  const math = template.content.querySelector("math");
  return math ? new XMLSerializer().serializeToString(math) : null;
}
