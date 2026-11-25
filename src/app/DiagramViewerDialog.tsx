import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
 * 当前缩放来源；工具栏据此禁用已生效的按钮。
 * - default：默认显示已生效（新打开的页面即处于此状态）
 * - fit-width：页宽显示已生效
 * - manual：用户手动设置过缩放比例（输入、滑块、±、快捷键、滚轮）
 */
export type PreviewZoomMode = "default" | "fit-width" | "manual";

/** 预览缩放模式：新页面从「默认显示」开始，文档标识变化时自动重置。 */
export function usePreviewZoomMode(resetKey?: unknown): {
  mode: PreviewZoomMode;
  markDefault(): void;
  markFitWidth(): void;
  markManual(): void;
} {
  const [mode, setMode] = useState<PreviewZoomMode>("default");
  useEffect(() => setMode("default"), [resetKey]);
  const markDefault = useCallback(() => setMode("default"), []);
  const markFitWidth = useCallback(() => setMode("fit-width"), []);
  const markManual = useCallback(() => setMode("manual"), []);
  return { mode, markDefault, markFitWidth, markManual };
}

/**
 * 页宽显示：按视口可用宽度与内容基准宽度算出百分比（含内边距扣减），夹取到 [min, max]。
 * 供 PDF/Office 等有固定基准页宽、以容器级缩放显示的视图复用；无法测量时返回 null。
 */
export function zoomToFitWidth(
  viewport: HTMLElement | null,
  baseWidth: number,
  min: number,
  max: number,
): number | null {
  if (!viewport || !(baseWidth > 0)) return null;
  const style = getComputedStyle(viewport);
  const available =
    viewport.clientWidth -
    Number.parseFloat(style.paddingLeft) -
    Number.parseFloat(style.paddingRight);
  if (!(available > 0)) return null;
  return Math.min(max, Math.max(min, Math.round((available / baseWidth) * 100)));
}

/**
 * 从渲染后的可视宽度反推 100% 基准宽度。CSS zoom 会缩放 getBoundingClientRect，
 * 因此必须除以当前 zoom；行内 style.width 可能只含内容区（如 docx 页面不含页边距），
 * 不能直接当基准宽度用。
 */
export function measuredBaseWidth(content: HTMLElement | null, currentZoom: number): number | null {
  if (!content || !(currentZoom > 0)) return null;
  const visual = content.getBoundingClientRect().width;
  if (!(visual > 0)) return null;
  return visual / currentZoom;
}

/**
 * 默认显示：按基准宽度「容纳」在视口内——内容超过视口时缩小到刚好不溢出，
 * 不超过时保持 100%（不放大）。与页宽显示共用同一套视口测量与夹取规则。
 */
export function zoomToContain(
  viewport: HTMLElement | null,
  baseWidth: number,
  min: number,
  max: number,
): number | null {
  const fit = zoomToFitWidth(viewport, baseWidth, min, max);
  if (fit === null) return null;
  return Math.min(max, Math.max(min, Math.min(100, fit)));
}

/**
 * 图表/图片缩放快捷键：Ctrl+= 放大、Ctrl+- 缩小、Ctrl+0 默认显示、Ctrl+滚轮缩放。
 * 仅在调用方挂载期间生效；对话框传 capture=true 抢占事件，避免底层预览同时响应。
 */
export interface DiagramZoomShortcutOptions {
  /** Ctrl+0 的默认显示动作；未提供时回到 100%。 */
  onReset?(): void;
  /** 抢占事件（对话框用），避免底层视图同时响应。 */
  capture?: boolean;
  /** 缩放下限（百分比），默认 30。 */
  min?: number;
  /** 缩放上限（百分比），默认 1000。 */
  max?: number;
  /** 缩放步进（百分比），默认 10。 */
  step?: number;
}

export function useDiagramZoomShortcuts(
  zoom: number,
  onZoomChange: (zoom: number) => void,
  options: DiagramZoomShortcutOptions = {},
): void {
  const {
    capture = false,
    min = DIAGRAM_ZOOM_MIN,
    max = DIAGRAM_ZOOM_MAX,
    step = ZOOM_STEP,
    onReset,
  } = options;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const changeRef = useRef(onZoomChange);
  changeRef.current = onZoomChange;
  const resetRef = useRef(onReset);
  resetRef.current = onReset;

  useEffect(() => {
    const clamp = (value: number): number => Math.min(max, Math.max(min, Math.round(value)));
    const stepBy = (delta: number): void => {
      changeRef.current(clamp(zoomRef.current + delta));
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key;
      if (key === "=" || key === "+") {
        event.preventDefault();
        if (capture) event.stopPropagation();
        stepBy(step);
      } else if (key === "-" || key === "_") {
        event.preventDefault();
        if (capture) event.stopPropagation();
        stepBy(-step);
      } else if (key === "0") {
        event.preventDefault();
        if (capture) event.stopPropagation();
        if (resetRef.current) resetRef.current();
        else changeRef.current(clamp(100));
      }
    };
    const onWheel = (event: WheelEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      if (capture) event.stopPropagation();
      stepBy(event.deltaY < 0 ? step : -step);
    };
    window.addEventListener("keydown", onKeyDown, capture);
    window.addEventListener("wheel", onWheel, { passive: false, capture });
    return () => {
      window.removeEventListener("keydown", onKeyDown, capture);
      window.removeEventListener("wheel", onWheel, capture);
    };
  }, [capture, min, max, step]);
}

/** 缩放视图的内容宽度：自然尺寸 × 缩放百分比；超出视口时由视口滚动。 */
export function diagramViewerWidth(natural: number, zoom: number): string {
  return `${Math.round((natural * zoom) / 100)}px`;
}

export interface DiagramZoomControls {
  /** 缩放百分比；100 = 自然尺寸。 */
  zoom: number;
  onZoomChange(zoom: number): void;
  /** 默认显示（一次性动作）：基准宽度不超过视口时 100%，超过时缩小到刚好不溢出（不放大）。 */
  onFit(): void;
  /** 页宽显示（一次性动作）：按视口可用宽度计算缩放，内容恰好铺满可视区域（可放大）。 */
  onFitWidth(): void;
  /** 缩放下限（百分比），默认 30。 */
  min?: number;
  /** 缩放上限（百分比），默认 1000。 */
  max?: number;
  /** 缩放步进（百分比），默认 10。 */
  step?: number;
  /** 当前缩放模式；已生效的动作按钮会被禁用。默认新页面为「默认显示」。 */
  mode?: PreviewZoomMode;
  /** 工具栏容器类名；PDF 等复用时传入自己的布局类。 */
  className?: string;
  /** 缩放控件的无障碍标签（默认「图表缩放」）。 */
  label?: string;
  /** 工具栏左侧附加内容（如 PPT 页数），与缩放主控件同组靠左。 */
  leading?: ReactNode;
}

/**
 * 缩放工具栏：左侧为主控件（百分比输入框、%、滑块、放大/缩小），右侧为动作（复位、页宽显示）。
 * 独立图表/图片预览、「放大查看」对话框、PDF 与 Office 预览共用。
 */
export function DiagramZoomToolbar({
  zoom,
  onZoomChange,
  onFit,
  onFitWidth,
  min = DIAGRAM_ZOOM_MIN,
  max = DIAGRAM_ZOOM_MAX,
  step = ZOOM_STEP,
  mode = "default",
  className = "diagram-viewer-toolbar",
  label = t("图表缩放"),
  leading,
}: DiagramZoomControls) {
  const [input, setInput] = useState(String(zoom));
  // 外部 zoom 变化（滑块/±/适配）时同步输入框；输入过程中以本地文本为准。
  useEffect(() => setInput(String(zoom)), [zoom]);

  const clamp = (value: number): number => Math.min(max, Math.max(min, Math.round(value)));

  const commit = (): void => {
    const parsed = Number(input);
    if (input.trim() !== "" && Number.isFinite(parsed)) {
      onZoomChange(clamp(parsed));
    } else {
      setInput(String(zoom));
    }
  };

  return (
    <div className={`zoom-toolbar ${className}`}>
      <div className="diagram-zoom-primary">
        {leading ? <span className="zoom-toolbar-leading">{leading}</span> : null}
        <span className="diagram-zoom-value">
          <input
            type="number"
            className="diagram-zoom-input"
            min={min}
            max={max}
            value={input}
            aria-label={label}
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
        </span>
        <input
          type="range"
          className="diagram-zoom-range"
          min={min}
          max={max}
          step={step}
          value={zoom}
          aria-label={label}
          onChange={(event) => onZoomChange(clamp(Number(event.target.value)))}
        />
        <button
          type="button"
          className="icon-button zoom-step-button"
          aria-label={t("放大")}
          title={t("放大")}
          disabled={zoom >= max}
          onClick={() => onZoomChange(clamp(zoom + step))}
        >
          <Icon name="zoom-in" />
        </button>
        <button
          type="button"
          className="icon-button zoom-step-button"
          aria-label={t("缩小")}
          title={t("缩小")}
          disabled={zoom <= min}
          onClick={() => onZoomChange(clamp(zoom - step))}
        >
          <Icon name="zoom-out" />
        </button>
      </div>
      <div className="diagram-zoom-actions">
        <button
          type="button"
          className="icon-button zoom-action-button"
          aria-label={t("默认显示")}
          title={t("默认显示")}
          disabled={mode === "default"}
          onClick={onFit}
        >
          <Icon name="default-view" />
        </button>
        <button
          type="button"
          className="icon-button zoom-action-button"
          aria-label={t("页宽显示")}
          title={t("页宽显示")}
          disabled={mode === "fit-width"}
          onClick={onFitWidth}
        >
          <Icon name="fit-width" />
        </button>
      </div>
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
  const { mode, markDefault, markFitWidth, markManual } = usePreviewZoomMode(svg);
  const natural = useMemo(() => svgNaturalWidth(svg), [svg]);
  const changeZoom = useCallback(
    (value: number): void => {
      markManual();
      setZoom(value);
    },
    [markManual],
  );
  /** 默认显示：自然尺寸容纳在对话框视口内（超过才缩小，不放大）。 */
  const applyDefault = useCallback((): void => {
    const percent = zoomToContain(bodyRef.current, natural, DIAGRAM_ZOOM_MIN, DIAGRAM_ZOOM_MAX);
    if (percent !== null) setZoom(percent);
    markDefault();
  }, [natural, markDefault]);
  // 对话框独占缩放快捷键；Ctrl+0 与「默认显示」一致。
  useDiagramZoomShortcuts(zoom, changeZoom, { capture: true, onReset: applyDefault });

  /** 打开对话框时的自动适配（设置项）：与默认显示一致，只缩小不放宽。 */
  const applyAutoFit = useCallback((): void => applyDefault(), [applyDefault]);
  /** 页宽显示：按视口可用宽度铺满内容（小图也会放大）。 */
  const applyFitWidth = useCallback((): void => {
    const percent = zoomToFitWidth(bodyRef.current, natural, DIAGRAM_ZOOM_MIN, DIAGRAM_ZOOM_MAX);
    if (percent !== null) setZoom(percent);
    markFitWidth();
  }, [natural, markFitWidth]);

  // 打开时按「设置 → 外观 → 图表适配宽度」自动适配一次。
  useEffect(() => {
    if (natural > 0 && settingsStore.getState().appearance.diagramFitWidth) applyAutoFit();
  }, [natural, applyAutoFit]);

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
              <Icon name="close" size={14} />
            </button>
          </div>
        </header>
        <DiagramZoomToolbar
          zoom={zoom}
          mode={mode}
          onZoomChange={changeZoom}
          onFit={applyDefault}
          onFitWidth={applyFitWidth}
        />
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
