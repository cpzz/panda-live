import { DEFAULT_SETTINGS, patchSettings, type Settings } from "../shared/settings";

/**
 * 渲染进程设置仓库：启动时从主进程加载，变更后立即应用 CSS 变量并广播。
 * 见 doc/design.md §15.2、§15.3。
 */
export class SettingsStore {
  private state: Settings = DEFAULT_SETTINGS;
  private readonly listeners = new Set<() => void>();
  private loaded = false;

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

  private apply(): void {
    const root = document.documentElement;
    const { theme, fontSize, lineWidth, lineWidthUnit } = this.state.appearance;
    if (theme === "system") {
      delete root.dataset["theme"];
    } else {
      root.dataset["theme"] = theme;
    }
    root.style.setProperty("--editor-font-size", `${fontSize}px`);
    root.style.setProperty("--prose-font-size", `${fontSize}px`);
    root.style.setProperty(
      "--prose-max-width",
      lineWidthUnit === "percent" ? `${lineWidth}%` : `${lineWidth}px`,
    );
    root.style.setProperty("--cm-tab-size", String(this.state.editor.tabSize));
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const settingsStore = new SettingsStore();
