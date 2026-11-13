import { DEFAULT_SETTINGS, patchSettings, type Settings } from "../shared/settings";

/**
 * 渲染进程设置仓库：启动时从主进程加载，变更后立即应用 CSS 变量并广播。
 * 见 doc/design.md §15.2、§15.3。
 */
export class SettingsStore {
  private state: Settings = DEFAULT_SETTINGS;
  private readonly listeners = new Set<() => void>();
  private loaded = false;
  /** 状态栏「当前显示」宽度覆盖；null 跟随全局设置。仅影响 CSS 变量，不落盘。 */
  private viewWidthOverride: number | null = null;
  private systemDarkQuery: MediaQueryList | null = null;
  private readonly onSystemThemeChange = (): void => {
    if (this.state.appearance.theme === "system") this.apply();
  };

  constructor() {
    // 主题单源：无论显式还是 system 都解析为 data-theme 写到根元素。
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      this.systemDarkQuery = window.matchMedia("(prefers-color-scheme: dark)");
      this.systemDarkQuery.addEventListener("change", this.onSystemThemeChange);
    }
  }

  readonly getState = (): Settings => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async load(): Promise<Settings> {
    if (this.loaded) return this.state;
    try {
      this.state = await window.panda.settings.get();
    } catch {
      this.state = DEFAULT_SETTINGS;
    }
    this.loaded = true;
    this.apply();
    this.emit();
    return this.state;
  }

  async update(patch: unknown): Promise<Settings> {
    const merged = patchSettings(this.state, patch);
    try {
      this.state = await window.panda.settings.update(merged);
    } catch {
      // 写入失败时仍应用本地值，避免界面回退；下次启动会重新读取磁盘设置。
      this.state = merged;
    }
    this.apply();
    this.emit();
    return this.state;
  }

  /**
   * 状态栏 / Ctrl+滚轮的宽度调整只作用于当前显示（会话内），不写入全局设置。
   * 传 null 恢复跟随「设置 → 外观 → 内容宽度」。见 doc/design.md §21.15 说明。
   */
  setViewWidthOverride(value: number | null): void {
    const next = value === null ? null : Math.min(1000, Math.max(30, Math.round(value)));
    if (next === this.viewWidthOverride) return;
    this.viewWidthOverride = next;
    this.apply();
  }

  private apply(): void {
    // Node 环境（单元测试）无 DOM，跳过 CSS 应用。
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const { theme, fontSize } = this.state.appearance;
    const width = this.viewWidthOverride ?? this.state.appearance.lineWidth;
    const dark = theme === "dark" || (theme === "system" && this.systemDarkQuery?.matches);
    root.dataset["theme"] = dark ? "dark" : "light";
    root.style.setProperty("--editor-font-size", `${fontSize}px`);
    root.style.setProperty("--prose-font-size", `${fontSize}px`);
    root.style.setProperty("--prose-max-width", `${width}%`);
    root.style.setProperty("--cm-tab-size", String(this.state.editor.tabSize));
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const settingsStore = new SettingsStore();
