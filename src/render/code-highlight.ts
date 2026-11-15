import type { BundledLanguage, Highlighter } from "shiki";

const THEMES = { light: "github-light", dark: "github-dark" } as const;

/** 常见围栏别名 → Shiki 语言 id。 */
const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
};

let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLanguages = new Set<string>();

/** 从 `language-xxx` class 读取围栏语言。 */
export function codeLanguage(element: HTMLElement): string | null {
  for (const name of element.classList) {
    if (name.startsWith("language-")) return name.slice("language-".length).toLowerCase();
  }
  return null;
}

async function ensureHighlighter(): Promise<Highlighter> {
  const shiki = await import("shiki");
  highlighterPromise ??= shiki.createHighlighter({
    themes: [THEMES.light, THEMES.dark],
    langs: [],
  });
  return highlighterPromise;
}

/**
 * 单块源码高亮：返回 Shiki 生成的 `<pre>` HTML 字符串；语言或高亮器不可用时返回 null。
 * 预览与 WYSIWYG 代码块共用同一份高亮器缓存。
 */
export async function highlightCodeToHtml(
  code: string,
  language: string,
  theme: "light" | "dark",
): Promise<string | null> {
  try {
    const highlighter = await ensureHighlighter();
    const resolved = LANGUAGE_ALIASES[language.toLowerCase()] ?? language.toLowerCase();
    if (!loadedLanguages.has(resolved)) {
      await highlighter.loadLanguage(resolved as BundledLanguage);
      loadedLanguages.add(resolved);
    }
    return highlighter.codeToHtml(code, { lang: resolved as BundledLanguage, theme: THEMES[theme] });
  } catch {
    return null;
  }
}

/**
 * 预览内代码块语法高亮：Shiki 按需加载语言，主题跟随明暗。
 * 语言或高亮器不可用时保留原文，不影响渲染。见 doc/design.md §14.2。
 */
export async function highlightCodeBlocks(root: HTMLElement, theme: "light" | "dark"): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>("pre")];
  if (blocks.length === 0) return;

  for (const pre of blocks) {
    const code = pre.firstElementChild;
    if (code?.tagName !== "CODE") continue;
    const language = codeLanguage(code as HTMLElement) ?? (pre.dataset.language || null);
    if (!language) continue;
    const html = await highlightCodeToHtml(code.textContent ?? "", language, theme);
    if (!html) continue;
    const template = document.createElement("template");
    template.innerHTML = html;
    const next = template.content.firstElementChild;
    if (!(next instanceof HTMLElement)) continue;
    next.dataset.highlighted = "true";
    // 保留语言与源行号，供主题切换重新高亮与渲染态差异定位。
    next.dataset.language = language.toLowerCase();
    for (const attribute of ["data-src-line", "data-src-end-line"]) {
      const value = pre.getAttribute(attribute);
      if (value !== null) next.setAttribute(attribute, value);
    }
    pre.replaceWith(next);
  }
}
