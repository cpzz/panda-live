import { useEffect, useState } from "react";
import { diagramCacheStats } from "../render/diagram";

interface Metrics {
  fps: number;
  longTasks: number;
  longTaskMs: number;
  heapMb: number | null;
  cacheHits: number;
  cacheMisses: number;
  cacheEntries: number;
}

function heapUsedMb(): number | null {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? memory.usedJSHeapSize / (1024 * 1024) : null;
}

/**
 * 开发模式性能浮层：FPS、长任务、图表缓存命中率与 JS 堆占用。
 * 仅开发环境挂载；发布版不启用。见 doc/design.md §14.4。
 */
export function PerformanceOverlay({ onClose }: { onClose(): void }) {
  const [metrics, setMetrics] = useState<Metrics>({
    fps: 0,
    longTasks: 0,
    longTaskMs: 0,
    heapMb: null,
    cacheHits: 0,
    cacheMisses: 0,
    cacheEntries: 0,
  });

  useEffect(() => {
    let frames = 0;
    let last = performance.now();
    let longTasks = 0;
    let longTaskMs = 0;
    let frame = 0;
    let observer: PerformanceObserver | null = null;

    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks += 1;
          longTaskMs += entry.duration;
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // 不支持 longtask 观测的环境静默跳过。
    }

    const tick = (now: number): void => {
      frames += 1;
      if (now - last >= 1000) {
        const fps = (frames * 1000) / (now - last);
        frames = 0;
        last = now;
        setMetrics((current) => ({ ...current, fps }));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    const timer = setInterval(() => {
      const cache = diagramCacheStats();
      setMetrics((current) => ({
        ...current,
        longTasks,
        longTaskMs,
        heapMb: heapUsedMb(),
        cacheHits: cache?.hits ?? 0,
        cacheMisses: cache?.misses ?? 0,
        cacheEntries: cache?.entries ?? 0,
      }));
    }, 1000);

    return () => {
      cancelAnimationFrame(frame);
      clearInterval(timer);
      observer?.disconnect();
    };
  }, []);

  const cacheTotal = metrics.cacheHits + metrics.cacheMisses;
  const hitRate = cacheTotal > 0 ? `${Math.round((metrics.cacheHits / cacheTotal) * 100)}%` : "—";

  return (
    <aside className="perf-overlay" aria-label="性能浮层">
      <header className="perf-overlay-head">
        <span>性能</span>
        <button type="button" className="button small ghost" onClick={onClose}>
          关闭
        </button>
      </header>
      <dl className="perf-overlay-grid">
        <dt>FPS</dt>
        <dd>{metrics.fps.toFixed(0)}</dd>
        <dt>长任务</dt>
        <dd>
          {metrics.longTasks} 次 / {Math.round(metrics.longTaskMs)} ms
        </dd>
        <dt>图表缓存</dt>
        <dd>
          {hitRate}（{metrics.cacheEntries} 项）
        </dd>
        <dt>JS 堆</dt>
        <dd>{metrics.heapMb === null ? "—" : `${metrics.heapMb.toFixed(1)} MB`}</dd>
      </dl>
    </aside>
  );
}
