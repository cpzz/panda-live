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

/**
 * 预览内代码块语法高亮：Shiki 按需加载语言，主题跟随明暗。
 * 语言或高亮器不可用时保留原文，不影响渲染。见 doc/design.md §14.2。
 */
export async function highlightCodeBlocks(root: HTMLElement, theme: "light" | "dark"): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>("pre")];
  if (blocks.length === 0) return;

  try {
    const shiki = await import("shiki");
    highlighterPromise ??= shiki.createHighlighter({
      themes: [THEMES.light, THEMES.dark],
      langs: [],
    });
    const highlighter = await highlighterPromise;

    for (const pre of blocks) {
      const code = pre.firstElementChild;
      if (code?.tagName !== "CODE") continue;
      const language = codeLanguage(code as HTMLElement) ?? (pre.dataset.language || null);
      if (!language) continue;
      const text = code.textContent ?? "";
      const resolved = LANGUAGE_ALIASES[language.toLowerCase()] ?? language.toLowerCase();
      try {
        if (!loadedLanguages.has(resolved)) {
          await highlighter.loadLanguage(resolved as BundledLanguage);
          loadedLanguages.add(resolved);
        }
        const html = highlighter.codeToHtml(text, {
          lang: resolved as BundledLanguage,
          theme: THEMES[theme],
        });
        const template = document.createElement("template");
        template.innerHTML = html;
        const next = template.content.firstElementChild;
        if (!(next instanceof HTMLElement)) continue;
        next.dataset.highlighted = "true";
        // 保留语言，主题切换时可重新高亮。
        next.dataset.language = resolved;
        pre.replaceWith(next);
      } catch {
        // 语言别名不支持或加载失败时保留未高亮的代码块。
      }
    }
  } catch {
    // Shiki 初始化失败时静默降级。
  }
}
