// Graphviz 布局引擎是 UMD：打包进 ESM 时不会挂到 globalThis，必须按经典脚本加载。
// 同源静态资源由 sandbox CSP 的 `script-src 'self'` 放行。
import vizAssetUrl from "@plantuml/core/viz-global.js?url";
import { renderToString as renderPlantUml } from "@plantuml/core";
import mermaid from "mermaid";
import type { DiagramTheme, RenderRequest, RenderResponse } from "../render/diagram/types";

let vizPromise: Promise<void> | null = null;

function ensureViz(): Promise<void> {
  vizPromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL(vizAssetUrl, window.location.href).href;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Graphviz 布局引擎（viz-global.js）加载失败"));
    document.head.append(script);
  });
  return vizPromise;
}

const parentOrigin = document.referrer ? new URL(document.referrer).origin : null;

function isTrusted(event: MessageEvent): boolean {
  // 生产环境主窗口为 file://（origin "null"），开发模式同源；其余来源一律拒绝。
  if (parentOrigin === null) return true;
  return event.origin === parentOrigin;
}

function post(response: RenderResponse, targetOrigin: string): void {
  if (targetOrigin === "null") {
    // file:// 页面没有可用的 targetOrigin，只能广播；响应内容不含敏感信息。
    window.parent.postMessage(response, "*");
    return;
  }
  window.parent.postMessage(response, targetOrigin);
}

function isRenderRequest(value: unknown): value is RenderRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<RenderRequest>;
  return (
    typeof request.id === "string" &&
    typeof request.kind === "string" &&
    typeof request.source === "string" &&
    (request.theme === "light" || request.theme === "dark") &&
    typeof request.engineVersion === "string"
  );
}

async function renderPlantumlSvg(source: string, theme: DiagramTheme): Promise<string> {
  await ensureViz();
  return new Promise<string>((resolve, reject) => {
    renderPlantUml(
      source.split("\n"),
      (svg) => resolve(svg),
      (message) => reject(new Error(message)),
      { dark: theme === "dark", maxSvgSize: 8192 },
    );
  });
}

async function renderMermaidSvg(source: string, theme: DiagramTheme): Promise<string> {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    theme: theme === "dark" ? "dark" : "default",
    // Mermaid 的 default 主题会给 subgraph 固定浅黄底（#ffffde），改为跟随应用配色。
    themeVariables:
      theme === "dark"
        ? { clusterBkg: "#252526", clusterBorder: "#454545" }
        : { clusterBkg: "#f3f3f3", clusterBorder: "#c9ced6" },
  });
  const id = `panda-diagram-${Math.random().toString(36).slice(2, 10)}`;
  const { svg } = await mermaid.render(id, source);
  return svg;
}

async function handle(request: RenderRequest): Promise<RenderResponse> {
  try {
    const svg =
      request.kind === "plantuml"
        ? await renderPlantumlSvg(request.source, request.theme)
        : request.kind === "mermaid"
          ? await renderMermaidSvg(request.source, request.theme)
          : null;
    if (!svg) return { id: request.id, ok: false, error: `不支持的图表类型：${request.kind}` };
    return { id: request.id, ok: true, svg };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lineMatch = /on line (\d+)/iu.exec(message);
    return {
      id: request.id,
      ok: false,
      error: message,
      ...(lineMatch ? { line: Number(lineMatch[1]) } : {}),
    };
  }
}

window.addEventListener("message", (event) => {
  if (!isTrusted(event)) return;
  const data = event.data as { type?: string; request?: unknown } | null;
  if (!data || data.type !== "render" || !isRenderRequest(data.request)) return;
  const targetOrigin = event.origin;
  void handle(data.request).then((response) => post(response, targetOrigin));
});

// 通知父窗口「就绪」，父窗口凭此判定该 iframe 可接收任务。
window.parent.postMessage({ type: "sandbox-ready" }, parentOrigin === null || parentOrigin === "null" ? "*" : parentOrigin);
