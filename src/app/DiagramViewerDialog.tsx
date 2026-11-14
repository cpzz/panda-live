import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { svgNaturalWidth } from "../render/diagram/sanitize";
import { settingsStore } from "../services/settings-store";
import { t } from "../i18n";
import { useFocusTrap } from "./useFocusTrap";
import { Icon } from "./icons";

/** 图表/图片缩放范围（百分比）；100% = 自然尺寸，这是缩放基准。 */
export const DIAGRAM_ZOOM_MIN = 30;
export const DIAGRAM_ZOOM_MAX = 1000;
const ZOOM_STEP = 10;

export function clampDiagramZoom(value: number): number {
  return Math.min(DIAGRAM_ZOOM_MAX, Math.max(DIAGRAM_ZOOM_MIN, Math.round(value)));
}

/**
 * 图表/图片缩放快捷键：Ctrl+= 放大、Ctrl+- 缩小、Ctrl+0 重置为 100%、Ctrl+滚轮缩放。
 * 仅在调用方挂载期间生效；对话框传 capture=true 抢占事件，避免底层预览同时响应。
 */
export function useDiagramZoomShortcuts(
  zoom: number,
  onZoomChange: (zoom: number) => void,
  capture = false,
): void {
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const changeRef = useRef(onZoomChange);
  changeRef.current = onZoomChange;

  useEffect(() => {
    const step = (delta: number): void => {
      changeRef.current(clampDiagramZoom(zoomRef.current + delta));
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key;
      if (key === "=" || key === "+") {
        event.preventDefault();
        if (capture) event.stopPropagation();
        step(ZOOM_STEP);
      } else if (key === "-" || key === "_") {
        event.preventDefault();
        if (capture) event.stopPropagation();
        step(-ZOOM_STEP);
      } else if (key === "0") {
        event.preventDefault();
        if (capture) event.stopPropagation();
        changeRef.current(100);
      }
    };
    const onWheel = (event: WheelEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      if (capture) event.stopPropagation();
      step(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
    };
    window.addEventListener("keydown", onKeyDown, capture);
    window.addEventListener("wheel", onWheel, { passive: false, capture });
    return () => {
      window.removeEventListener("keydown", onKeyDown, capture);
      window.removeEventListener("wheel", onWheel, capture);
    };
  }, [capture]);
}

/** 缩放视图的内容宽度：自然尺寸 × 缩放百分比；超出视口时由视口滚动。 */
export function diagramViewerWidth(natural: number, zoom: number): string {
  return `${Math.round((natural * zoom) / 100)}px`;
}

export interface DiagramZoomControls {
  /** 缩放百分比；100 = 自然尺寸。 */
  zoom: number;
  onZoomChange(zoom: number): void;
  /** 适配宽度（一次性动作）：恢复自然宽度显示且不超过视口宽度，超宽图表按比例缩小。 */
  onFit(): void;
}

/**
 * 缩放工具栏（右对齐）：百分比输入框、滑块、放大/缩小图标按钮与适配宽度动作按钮。
 * 独立图表/图片预览与「放大查看」对话框共用。
 */
export function DiagramZoomToolbar({ zoom, onZoomChange, onFit }: DiagramZoomControls) {
  const [input, setInput] = useState(String(zoom));
  // 外部 zoom 变化（滑块/±/适配）时同步输入框；输入过程中以本地文本为准。
  useEffect(() => setInput(String(zoom)), [zoom]);

  const commit = (): void => {
    const parsed = Number(input);
    if (input.trim() !== "" && Number.isFinite(parsed)) {
      onZoomChange(clampDiagramZoom(parsed));
    } else {
      setInput(String(zoom));
    }
  };

  return (
    <div className="diagram-viewer-toolbar">
      <input
        type="number"
        className="diagram-zoom-input"
        min={DIAGRAM_ZOOM_MIN}
        max={DIAGRAM_ZOOM_MAX}
        value={input}
        aria-label={t("图表缩放")}
        onChange={(event) => setInput(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      />
      <span className="diagram-zoom-label">%</span>
      <input
        type="range"
        className="diagram-zoom-range"
        min={DIAGRAM_ZOOM_MIN}
        max={DIAGRAM_ZOOM_MAX}
        step={10}
        value={zoom}
        aria-label={t("图表缩放")}
        onChange={(event) => onZoomChange(Number(event.target.value))}
      />
      <button
        type="button"
        className="icon-button"
        aria-label={t("放大")}
        title={t("放大")}
        disabled={zoom >= DIAGRAM_ZOOM_MAX}
        onClick={() => onZoomChange(clampDiagramZoom(zoom + ZOOM_STEP))}
      >
        <Icon name="zoom-in" />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={t("缩小")}
        title={t("缩小")}
        disabled={zoom <= DIAGRAM_ZOOM_MIN}
        onClick={() => onZoomChange(clampDiagramZoom(zoom - ZOOM_STEP))}
      >
        <Icon name="zoom-out" />
      </button>
      <button type="button" className="icon-button" aria-label={t("适配宽度")} title={t("适配宽度")} onClick={onFit}>
        <Icon name="fit-width" />
      </button>
    </div>
  );
}

interface DiagramViewerDialogProps {
  /** 已消毒的 SVG 字符串；由图表服务统一产出。 */
  svg: string;
  /** 对话框标题（通常为文档名）。 */
  title: string;
  onClose(): void;
}

/**
 * 「放大查看」对话框：应用内模态窗口，可拖拽调整大小、可最大化。
 * 缩放基准 100% = 自然尺寸；适配宽度为一次性动作，初始是否自动适配取全局设置。见 doc/design.md §10.3。
 */
export function DiagramViewerDialog({ svg, title, onClose }: DiagramViewerDialogProps) {
  const dialogRef = useFocusTrap(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(100);
  const [maximized, setMaximized] = useState(false);
  const natural = useMemo(() => svgNaturalWidth(svg), [svg]);
  // 对话框独占缩放快捷键，避免底层预览同时响应。
  useDiagramZoomShortcuts(zoom, setZoom, true);

  /** 适配宽度：按视口可用宽度与自然宽度计算缩放比（≤100%），之后缩放仍可自由放大。 */
  const applyFit = useCallback((): void => {
    const body = bodyRef.current;
    if (!body || natural <= 0) return;
    const style = getComputedStyle(body);
    const available =
      body.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
    if (!(available > 0)) return;
    setZoom(clampDiagramZoom(Math.min(100, Math.round((available / natural) * 100))));
  }, [natural]);

  // 打开时按「设置 → 外观 → 图表适配宽度」自动适配一次。
  useEffect(() => {
    if (natural > 0 && settingsStore.getState().appearance.diagramFitWidth) applyFit();
  }, [natural, applyFit]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className={`modal diagram-viewer-modal${maximized ? " maximized" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={t("图表查看")}
        style={maximized ? { width: "100vw", height: "100vh", maxHeight: "100vh" } : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2>{title || t("图表")}</h2>
          <div className="modal-header-actions">
            <button
              type="button"
              className="icon-button"
              onClick={() => setMaximized((value) => !value)}
              aria-label={maximized ? t("还原") : t("最大化")}
              title={maximized ? t("还原") : t("最大化")}
            >
              <Icon name={maximized ? "minimize" : "maximize"} />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={onClose}
              aria-label={t("关闭")}
              title={t("关闭")}
            >
              <Icon name="close" />
            </button>
          </div>
        </header>
        <DiagramZoomToolbar zoom={zoom} onZoomChange={setZoom} onFit={applyFit} />
        <div className="diagram-viewer-body" ref={bodyRef}>
          <div
            className="diagram-viewer-sizing"
            style={natural > 0 ? { width: diagramViewerWidth(natural, zoom) } : undefined}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </div>
    </div>
  );
}
