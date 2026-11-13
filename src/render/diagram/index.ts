import { DiagramCache, IndexedDbDiagramStorage } from "./cache";
import { IframeSandboxPool } from "./pool";
import { DiagramRenderService } from "./service";
import type { DiagramTheme } from "./types";
import { settingsStore } from "../../services/settings-store";
import { onThemeChange, resolveTheme } from "../../services/theme";

let service: DiagramRenderService | null = null;
let pool: IframeSandboxPool | null = null;
let cache: DiagramCache | null = null;

function isDevServer(): boolean {
  return window.location.protocol === "http:" || window.location.protocol === "https:";
}

function sandboxUrl(): string {
  // 开发模式由 Vite dev server 同源提供；生产走跨源隔离的自定义协议。见 doc/design.md §10.1。
  return isDevServer()
    ? new URL("/src/render-sandbox/index.html", window.location.href).href
    : "panda-sandbox://render/index.html";
}

/** 渲染进程内共享的图表渲染服务（单例）。 */
export function getDiagramService(): DiagramRenderService {
  if (!service) {
    pool = new IframeSandboxPool({ sandboxUrl: sandboxUrl(), size: 2 });
    cache = new DiagramCache(
      new IndexedDbDiagramStorage(),
      settingsStore.getState().diagram.memoryCacheLimit,
    );
    service = new DiagramRenderService({ renderer: pool, cache });
  }
  return service;
}

/** 图表渲染主题：设置覆盖（light/dark）优先，`auto` 跟随应用主题。见 doc/design.md §15.3。 */
export function currentDiagramTheme(): DiagramTheme {
  const override = settingsStore.getState().diagram.theme;
  return override === "light" || override === "dark" ? override : resolveTheme();
}

/** 图表主题变化（应用主题或设置覆盖）时通知调用方重渲染；主题参与缓存键。 */
export function onDiagramThemeChange(listener: (theme: DiagramTheme) => void): () => void {
  const offTheme = onThemeChange(listener);
  // 设置覆盖变化（auto ↔ light ↔ dark）不伴随应用主题变化，也需通知。
  let previous = currentDiagramTheme();
  const offSettings = settingsStore.subscribe(() => {
    const next = currentDiagramTheme();
    if (next !== previous) {
      previous = next;
      listener(next);
    }
  });
  return () => {
    offTheme();
    offSettings();
  };
}

/** 设置变更时同步内存缓存上限；服务尚未创建时记录待用值即可。 */
export function applyDiagramMemoryLimit(): void {
  cache?.setMemoryCapacity(settingsStore.getState().diagram.memoryCacheLimit);
}

/** 开发模式性能浮层读取缓存统计；服务尚未创建时返回 null，避免提前初始化沙箱。 */
export function diagramCacheStats(): { hits: number; misses: number; entries: number } | null {
  return service ? service.cacheStats() : null;
}

/** 应用退出或测试清理时释放沙箱 iframe。 */
export function disposeDiagramSandbox(): void {
  pool?.dispose();
  pool = null;
  service = null;
  cache = null;
}
