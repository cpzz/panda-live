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
 * KaTeX 静态渲染，`htmlAndMathml` 输出保证可访问性（doc/design.md §4.4、附录 B）。
 * 渲染失败返回错误信息，由调用方保留源码并提示（FR-04）。
 */
export function renderKatex(source: string, displayMode: boolean): MathRenderResult {
  const key = `${displayMode ? "b" : "i"}${source}`;
  return cached(key, () => {
    try {
      const html = katex.renderToString(source, {
        displayMode,
        output: "htmlAndMathml",
        throwOnError: true,
        strict: "warn",
        trust: false,
      });
      return { ok: true, html };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
