import { DiagramCache } from "./cache";
import { sha256Hex } from "./hash";
import { normalizeDiagramSource } from "./normalize";
import { sanitizeDiagramSvg } from "./sanitize";
import {
  DIAGRAM_ENGINE_VERSION,
  DIAGRAM_RENDER_TIMEOUT_MS,
  type DiagramKind,
  type DiagramResult,
  type DiagramTheme,
  type RenderRequest,
  type RenderResponse,
} from "./types";

/** 渲染后端（iframe 沙箱池或测试替身）。实现需在 abort 时释放资源。 */
export interface DiagramRenderer {
  render(request: RenderRequest, signal: AbortSignal): Promise<RenderResponse>;
}

export interface DiagramRenderInput {
  /** 节点 ID；同一 ID 的新请求会取消旧请求。 */
  id: string;
  kind: DiagramKind;
  source: string;
  theme: DiagramTheme;
  engineVersion?: string;
}

export interface DiagramServiceOptions {
  renderer: DiagramRenderer;
  cache?: DiagramCache;
  timeoutMs?: number;
  /** 默认为父窗口 DOMPurify 消毒；单元测试可注入替身。 */
  sanitize?: (svg: string) => string;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError";
}

/**
 * 图表渲染调度：规范化 → 缓存 → 超时控制 → 消毒 → 回填缓存。
 * 缓存键 `sha256(kind + theme + engineVersion + normalizedSource)`。见 doc/design.md §10.3。
 */
export class DiagramRenderService {
  private readonly cache: DiagramCache;
  private readonly timeoutMs: number;
  private readonly sanitize: (svg: string) => string;
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly options: DiagramServiceOptions) {
    this.cache = options.cache ?? new DiagramCache();
    this.timeoutMs = options.timeoutMs ?? DIAGRAM_RENDER_TIMEOUT_MS;
    this.sanitize = options.sanitize ?? sanitizeDiagramSvg;
  }

  async render(input: DiagramRenderInput): Promise<DiagramResult> {
    this.cancel(input.id);

    const normalized = normalizeDiagramSource(input.kind, input.source);
    if (!normalized.ok) {
      return { ok: false, error: normalized.error, code: normalized.code };
    }

    const engineVersion = input.engineVersion ?? DIAGRAM_ENGINE_VERSION;
    const cacheKey = sha256Hex(
      [input.kind, input.theme, engineVersion, normalized.source].join("\u0000"),
    );

    // 先登记取消控制器，再等待缓存：这样同步调用 cancel() 也能中断后续渲染。
    const controller = new AbortController();
    this.controllers.set(input.id, controller);
    const timer = setTimeout(() => controller.abort("timeout"), this.timeoutMs);

    try {
      if (controller.signal.aborted) return this.abortResult(controller);

      const cached = await this.cache.get(cacheKey);
      if (cached) return { ok: true, svg: cached };
      if (controller.signal.aborted) return this.abortResult(controller);

      const request: RenderRequest = {
        id: input.id,
        kind: input.kind,
        source: normalized.source,
        theme: input.theme,
        engineVersion,
      };

      const response = await this.options.renderer.render(request, controller.signal);
      if (!response.ok) {
        return { ok: false, error: response.error, line: response.line, code: "E_RENDER_FAILED" };
      }
      const svg = this.sanitize(response.svg);
      if (!svg) {
        return { ok: false, error: "图表输出未通过安全消毒，已丢弃", code: "E_RENDER_FAILED" };
      }
      void this.cache.set(cacheKey, svg);
      return { ok: true, svg };
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        return this.abortResult(controller);
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message, code: "E_RENDER_FAILED" };
    } finally {
      clearTimeout(timer);
      if (this.controllers.get(input.id) === controller) {
        this.controllers.delete(input.id);
      }
    }
  }

  private abortResult(controller: AbortController): DiagramResult {
    if (controller.signal.reason === "cancelled") {
      return { ok: false, error: "渲染已取消", code: "E_CANCELLED" };
    }
    return {
      ok: false,
      error: `图表渲染超时（${Math.round(this.timeoutMs / 1000)} s），已重建渲染沙箱`,
      code: "E_RENDER_TIMEOUT",
    };
  }

  /** 开发模式性能浮层读取图表缓存命中情况。见 doc/design.md §14.4。 */
  cacheStats(): { hits: number; misses: number; entries: number } {
    return this.cache.stats();
  }

  /** 节点移除或来源/主题变化时取消排队任务并丢弃结果。 */
  cancel(id: string): void {
    const controller = this.controllers.get(id);
    if (controller && !controller.signal.aborted) controller.abort("cancelled");
    this.controllers.delete(id);
  }
}
