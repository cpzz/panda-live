/** 应用主题解析：显式设置优先，否则跟随系统。 */
export type AppTheme = "light" | "dark";

export function resolveTheme(): AppTheme {
  const explicit = document.documentElement.dataset["theme"];
  if (explicit === "light" || explicit === "dark") return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** 监听主题变化：系统主题切换或用户显式切换都会触发。 */
export function onThemeChange(listener: (theme: AppTheme) => void): () => void {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = (): void => listener(resolveTheme());
  query.addEventListener("change", handler);
  const observer = new MutationObserver(handler);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => {
    query.removeEventListener("change", handler);
    observer.disconnect();
  };
}
