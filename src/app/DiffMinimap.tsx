import { useEffect, useMemo, useState, type MouseEvent } from "react";
import type { DiffHunk } from "../diff/compute";
import { t } from "../i18n";

/**
 * Git 差异右侧的改动概览（Minimap）：按新文档行号比例绘制改动色块，
 * 并叠加当前视口位置；点击色块跳到对应改动，点击空白轨道按比例滚动。
 * 见 doc/design.md §21.15。
 */
export function DiffMinimap({
  hunks,
  totalLines,
  activeIndex,
  scroller,
  onJump,
  onScrollRatio,
}: {
  hunks: readonly DiffHunk[];
  /** 新文档总行数，用于把行号映射为纵向比例。 */
  totalLines: number;
  /** 当前定位到的改动索引；-1 表示尚未定位。 */
  activeIndex: number;
  /** 视口对应的滚动容器；为空时只显示改动色块。 */
  scroller: HTMLElement | null;
  onJump(index: number): void;
  /** 点击空白轨道：按 0–1 比例滚动到文档对应位置。 */
  onScrollRatio(ratio: number): void;
}) {
  const [viewport, setViewport] = useState<{ top: number; height: number } | null>(null);

  const markers = useMemo(() => {
    const total = Math.max(1, totalLines);
    return hunks.map((hunk, index) => {
      const line = Math.max(1, hunk.newStart);
      return {
        index,
        kind: hunk.kind,
        line,
        top: ((line - 1) / total) * 100,
        height: Math.max(0.6, ((hunk.newCount || 1) / total) * 100),
      };
    });
  }, [hunks, totalLines]);

  useEffect(() => {
    if (!scroller) {
      setViewport(null);
      return;
    }
    const update = (): void => {
      const total = scroller.scrollHeight;
      if (total <= 0) {
        setViewport(null);
        return;
      }
      setViewport({
        top: (scroller.scrollTop / total) * 100,
        height: Math.min(100, (scroller.clientHeight / total) * 100),
      });
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [scroller]);

  const handleTrackClick = (event: MouseEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.height <= 0) return;
    onScrollRatio(Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)));
  };

  return (
    <div className="git-minimap" role="group" aria-label={t("改动概览")}>
      <div className="git-minimap-track" onClick={handleTrackClick}>
        {viewport && (
          <div
            className="git-minimap-viewport"
            aria-hidden="true"
            style={{ top: `${viewport.top}%`, height: `${viewport.height}%` }}
          />
        )}
        {markers.map((marker) => (
          <button
            key={`${marker.index}-${marker.kind}-${marker.line}`}
            type="button"
            className={
              marker.index === activeIndex
                ? `git-minimap-marker ${marker.kind} active`
                : `git-minimap-marker ${marker.kind}`
            }
            style={{ top: `${marker.top}%`, height: `${marker.height}%` }}
            title={t("第 {0} 行", marker.line)}
            aria-label={t("跳到第 {0} 行的改动", marker.line)}
            onClick={(event) => {
              event.stopPropagation();
              onJump(marker.index);
            }}
          />
        ))}
      </div>
    </div>
  );
}
