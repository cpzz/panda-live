import { DiagramCache, IndexedDbDiagramStorage } from "./cache";
import { IframeSandboxPool } from "./pool";
import { DiagramRenderService } from "./service";
import type { DiagramTheme } from "./types";

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

export function currentDiagramTheme(): DiagramTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** 主题切换时通知调用方重渲染（主题参与缓存键）。 */
export function onDiagramThemeChange(listener: (theme: DiagramTheme) => void): () => void {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = (): void => listener(query.matches ? "dark" : "light");
  query.addEventListener("change", handler);
  return () => query.removeEventListener("change", handler);
}

/** 应用退出或测试清理时释放沙箱 iframe。 */
export function disposeDiagramSandbox(): void {
  pool?.dispose();
  pool = null;
  service = null;
}
