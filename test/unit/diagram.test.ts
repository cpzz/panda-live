import { describe, expect, it } from "vitest";
import { LruCache, DiagramCache, type DiagramCacheStorage } from "../../src/render/diagram/cache";
import { sha256Hex } from "../../src/render/diagram/hash";
import { normalizeDiagramSource } from "../../src/render/diagram/normalize";
import type { DiagramRenderer } from "../../src/render/diagram/service";
import { DiagramRenderService } from "../../src/render/diagram/service";
import { MAX_DIAGRAM_SOURCE_LENGTH, type RenderRequest, type RenderResponse } from "../../src/render/diagram/types";

class FakeRenderer implements DiagramRenderer {
  readonly calls: RenderRequest[] = [];
  handler: (request: RenderRequest, signal: AbortSignal) => Promise<RenderResponse>;

  constructor(handler?: (request: RenderRequest, signal: AbortSignal) => Promise<RenderResponse>) {
    this.handler =
      handler ??
      ((request) => Promise.resolve({ id: request.id, ok: true, svg: "<svg><circle/></svg>" }));
  }

  render(request: RenderRequest, signal: AbortSignal): Promise<RenderResponse> {
    this.calls.push(request);
    return this.handler(request, signal);
  }
}

function createService(options: {
  renderer: FakeRenderer;
  timeoutMs?: number;
  cache?: DiagramCache;
  sanitize?: (svg: string) => string;
}): DiagramRenderService {
  return new DiagramRenderService({
    renderer: options.renderer,
    cache: options.cache ?? new DiagramCache(),
    timeoutMs: options.timeoutMs ?? 15000,
    sanitize: options.sanitize ?? ((svg) => svg),
  });
}

describe("SHA-256", () => {
  it("与标准测试向量一致", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("图表源码规范化", () => {
  it("PlantUML 自动补齐 @startuml/@enduml", () => {
    const result = normalizeDiagramSource("plantuml", "A -> B");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("@startuml\nA -> B\n@enduml\n");
    }
  });

  it("PlantUML 拒绝 !include 与远程 URL", () => {
    expect(normalizeDiagramSource("plantuml", "!include /etc/passwd").ok).toBe(false);
    expect(normalizeDiagramSource("plantuml", "A -> B\nnote right: https://example.com").ok).toBe(false);
  });

  it("Mermaid 拒绝 click 外链", () => {
    expect(normalizeDiagramSource("mermaid", 'click A href "https://example.com"').ok).toBe(false);
    expect(normalizeDiagramSource("mermaid", "click A javascript:alert(1)").ok).toBe(false);
  });

  it("空源码与超长源码被拒绝", () => {
    expect(normalizeDiagramSource("mermaid", "   \n").ok).toBe(false);
    expect(normalizeDiagramSource("mermaid", "a".repeat(MAX_DIAGRAM_SOURCE_LENGTH + 1)).ok).toBe(false);
  });
});

describe("图表渲染服务", () => {
  it("成功结果写入缓存，第二次请求命中缓存不再调用渲染器", async () => {
    const renderer = new FakeRenderer();
    const service = createService({ renderer });
    const input = { id: "n1", kind: "mermaid" as const, source: "graph TD\nA --> B", theme: "light" as const };

    const first = await service.render(input);
    expect(first.ok).toBe(true);
    const second = await service.render({ ...input, id: "n2" });
    expect(second.ok).toBe(true);
    expect(renderer.calls).toHaveLength(1);
  });

  it("超时返回 E_RENDER_TIMEOUT", async () => {
    const renderer = new FakeRenderer(
      (_request, signal) =>
        new Promise<RenderResponse>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const service = createService({ renderer, timeoutMs: 30 });
    const result = await service.render({ id: "slow", kind: "mermaid", source: "graph TD", theme: "light" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("E_RENDER_TIMEOUT");
    }
  });

  it("引擎错误携带诊断信息", async () => {
    const renderer = new FakeRenderer((request) =>
      Promise.resolve({ id: request.id, ok: false, error: "Parse error on line 2", line: 2 }),
    );
    const service = createService({ renderer });
    const result = await service.render({ id: "bad", kind: "mermaid", source: "graph TD", theme: "light" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("E_RENDER_FAILED");
      expect(result.line).toBe(2);
    }
  });

  it("取消后返回 E_CANCELLED", async () => {
    const renderer = new FakeRenderer(
      (_request, signal) =>
        new Promise<RenderResponse>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const service = createService({ renderer, timeoutMs: 500 });
    const pending = service.render({ id: "n3", kind: "mermaid", source: "graph TD", theme: "light" });
    service.cancel("n3");
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("E_CANCELLED");
  });

  it("消毒失败时不进入缓存", async () => {
    const renderer = new FakeRenderer();
    const service = createService({ renderer, sanitize: () => "" });
    const result = await service.render({ id: "n4", kind: "mermaid", source: "graph TD", theme: "light" });
    expect(result.ok).toBe(false);
    expect(renderer.calls).toHaveLength(1);
  });
});

describe("图表缓存", () => {
  it("LRU 超出容量淘汰最久未使用项", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  it("运行中调整容量：保留现有条目并立即淘汰超额项", () => {
    const cache = new LruCache<number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.setCapacity(2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    cache.setCapacity(5);
    cache.set("d", 4);
    expect(cache.get("d")).toBe(4);
    const diagramCache = new DiagramCache(undefined, 1);
    void diagramCache.set("x", "<svg/>");
    diagramCache.setMemoryCapacity(2);
    void diagramCache.set("y", "<svg2/>");
    expect(diagramCache.stats().entries).toBe(2);
  });

  it("持久层未命中时回填内存缓存", async () => {
    const map = new Map<string, string>();
    const storage: DiagramCacheStorage = {
      get: (key) => Promise.resolve(map.get(key) ?? null),
      set: (key, svg) => {
        map.set(key, svg);
        return Promise.resolve();
      },
    };
    map.set("k", "<svg/>");
    const cache = new DiagramCache(storage);

    expect(await cache.get("k")).toBe("<svg/>");
    await cache.set("k2", "<svg2/>");
    expect(await cache.get("k2")).toBe("<svg2/>");
    expect(map.get("k2")).toBe("<svg2/>");
  });

  it("持久层抛错时静默降级", async () => {
    const storage: DiagramCacheStorage = {
      get: () => Promise.reject(new Error("idb unavailable")),
      set: () => Promise.reject(new Error("idb unavailable")),
    };
    const cache = new DiagramCache(storage);
    expect(await cache.get("missing")).toBeNull();
    await cache.set("k", "<svg/>");
    expect(await cache.get("k")).toBe("<svg/>");
  });

  it("统计命中率与条目数", async () => {
    const cache = new DiagramCache();
    expect(cache.stats()).toEqual({ hits: 0, misses: 0, entries: 0 });
    expect(await cache.get("x")).toBeNull();
    await cache.set("x", "<svg/>");
    expect(await cache.get("x")).toBe("<svg/>");
    const stats = cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.entries).toBe(1);
  });
});
