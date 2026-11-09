import { DiagramCache, IndexedDbDiagramStorage } from "./cache";
import { IframeSandboxPool } from "./pool";
import { DiagramRenderService } from "./service";
import type { DiagramTheme } from "./types";
import { onThemeChange, resolveTheme } from "../../services/theme";

let service: DiagramRenderService | null = null;
let pool: IframeSandboxPool | null = null;

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
    service = new DiagramRenderService({
      renderer: pool,
      cache: new DiagramCache(new IndexedDbDiagramStorage()),
    });
  }
  return service;
}

/** 图表渲染主题与应用主题保持一致，保证源码与渲染同步。 */
export function currentDiagramTheme(): DiagramTheme {
  return resolveTheme();
}

/** 主题切换时通知调用方重渲染（主题参与缓存键）。 */
export function onDiagramThemeChange(listener: (theme: DiagramTheme) => void): () => void {
  return onThemeChange(listener);
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
}
