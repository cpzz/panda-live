import { useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { t } from "../i18n";
import { onThemeChange, resolveTheme, type AppTheme } from "../services/theme";
import {
  DiagramZoomToolbar,
  useDiagramZoomShortcuts,
  usePreviewZoomMode,
  zoomToContain,
  zoomToFitWidth,
} from "./DiagramViewerDialog";
import { Icon } from "./icons";

interface PageSlot {
  pageNumber: number;
  /** 高宽比，用于在渲染前预留版面，避免滚动跳动。 */
  ratio: number;
}

/** PDF 数据来源：TeX 编译产物走自定义协议，磁盘文档走内存字节。 */
export type PdfSource = { url: string } | { data: Uint8Array };

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;
/** 与 CSS `.pdf-page` 的 max-width 保持一致，缩放时同步放宽。 */
const PAGE_MAX_WIDTH = 820;

function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 10) / 10));
}

/**
 * PDF 预览：PDF.js 按需渲染。
 * worker 作为独立资源打包，切换文档或关闭预览时销毁文档实例以终止 worker。
 * 不渲染注释链接层，因此不存在外部链接自动跳转。见 doc/design.md §9.5、§13.4。
 */
export function PdfPreview({
  source,
  onConvert,
}: {
  source: PdfSource;
  /** 传入后才在工具栏显示「转 Markdown」按钮（磁盘 PDF 才提供，TeX 编译产物不提供）。 */
  onConvert?: () => Promise<void> | void;
}) {
  const [converting, setConverting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<ReturnType<typeof import("pdfjs-dist")["getDocument"]> | null>(null);
  const [slots, setSlots] = useState<PageSlot[]>([]);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  // 基准页宽（固定 px）= min(视口可用宽, 820)。必须用固定宽度而非 min(100%,820px)：
  // 百分比宽度与 CSS zoom 相乘时，超过页宽后视觉宽度会被视口封顶，继续放大不再变化。
  const [baseWidth, setBaseWidth] = useState<number>(PAGE_MAX_WIDTH);
  const { mode, markDefault, markFitWidth, markManual } = usePreviewZoomMode(source);
  const [pageInput, setPageInput] = useState("1");
  const [theme, setTheme] = useState<AppTheme>(resolveTheme);
  useEffect(() => onThemeChange(setTheme), []);
  // PDF 是固定白底位图，深色主题下自动反转，避免白纸刺眼。
  const invert = theme === "dark";
  const total = slots.length;

  useEffect(() => {
    let cancelled = false;
    setSlots([]);
    setProgress(0);
    setError(null);
    setZoom(1);
    setPageInput("1");

    const load = async (): Promise<void> => {
      const [pdfjs, workerModule] = await Promise.all([
        import("pdfjs-dist"),
        import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
      ]);
      pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;
      // data 源会被 pdfjs transfer 到 worker（buffer 变 detached），每次加载复制一份，保证 source 可复用。
      const params =
        "url" in source ? { url: source.url } : { data: new Uint8Array(source.data) };
      const loadingTask = pdfjs.getDocument({
        ...params,
        // 中文等 CID 字体需要 Adobe CMap 才能正确映射字形。
        cMapUrl: "panda-cmaps://local/",
        cMapPacked: true,
        disableAutoFetch: "url" in source,
      });
      loadingTaskRef.current = loadingTask;
      const pdf = await loadingTask.promise;
      if (cancelled) {
        void loadingTask.destroy();
        return;
      }
      documentRef.current = pdf;

      const dimensions: PageSlot[] = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const base = page.getViewport({ scale: 1 });
        dimensions.push({ pageNumber, ratio: base.height / base.width });
        if (cancelled) {
          void loadingTask.destroy();
          return;
        }
      }
      setSlots(dimensions);
      setProgress(pdf.numPages);
    };

    void load().catch((reason: unknown) => {
      if (cancelled) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    });

    return () => {
      cancelled = true;
      void documentRef.current?.cleanup();
      void loadingTaskRef.current?.destroy();
      documentRef.current = null;
      loadingTaskRef.current = null;
    };
  }, [source]);

  // 测量基准页宽 = min(视口可用宽, 820)，固定为 px 供 CSS zoom 连续缩放；
  // 分栏拖动 / 窗口变化时重新测量。视口宽度不随 zoom 改变，故无需监听 zoom。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = (): void => {
      const style = getComputedStyle(el);
      const available =
        el.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight);
      const base = Math.round(available > 0 ? Math.min(available, PAGE_MAX_WIDTH) : PAGE_MAX_WIDTH);
      setBaseWidth((prev) => (prev === base ? prev : base));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 占位元素渲染完成后再观察可见性；否则首帧 children 为空，页面永远不会绘制。
  // zoom 或基准宽变化时重跑：清除已渲染标记并按新宽度重绘（两者均参与依赖）。
  useEffect(() => {
    const host = pagesRef.current;
    const pdf = documentRef.current;
    if (!host || !pdf || slots.length === 0) return;

    let cancelled = false;
    const tasks = new Set<RenderTask>();

    const renderPage = async (target: HTMLElement): Promise<void> => {
      if (target.dataset.rendered) return;
      const pageNumber = Number(target.dataset.page);
      if (!pageNumber) return;
      target.dataset.rendered = "1";
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      // 版面宽度固定 820px，CSS zoom 负责显示缩放；位图按缩放后的实际宽度渲染以保持清晰。
      const width = Math.round((target.clientWidth || PAGE_MAX_WIDTH) * zoom);
      // 至少 2 倍超采样：PDF 内容为位图，按 CSS 像素 1:1 渲染后再放大会发虚。
      const pixelRatio = Math.max(window.devicePixelRatio || 1, 2);
      const scale = (width / page.getViewport({ scale: 1 }).width) * pixelRatio;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = "100%";
      canvas.style.display = "block";
      canvas.setAttribute("aria-label", t("第 {0} 页", pageNumber));
      const context = canvas.getContext("2d");
      if (!context) return;
      const task = page.render({ canvasContext: context, viewport, canvas });
      tasks.add(task);
      try {
        await task.promise;
      } catch (reason) {
        // 取消渲染（切换文档）属于正常流程。
        if (!cancelled) {
          target.dataset.rendered = "";
          console.warn("PDF 页面渲染失败", reason);
        }
        return;
      } finally {
        tasks.delete(task);
      }
      if (cancelled) return;
      target.replaceChildren(canvas);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const target = entry.target as HTMLElement;
          observer.unobserve(target);
          void renderPage(target);
        }
      },
      { root: scrollRef.current, rootMargin: "600px 0px" },
    );
    for (const slot of host.children) {
      const target = slot as HTMLElement;
      if (!target.dataset.page) continue;
      // 重跑（缩放变化）时清除渲染标记，让页面按新宽度重新绘制。
      target.dataset.rendered = "";
      observer.observe(target);
    }

    // 当前页跟踪：滚动时更新页码输入框，便于跳转。见 doc/design.md §13.4。
    const syncCurrentPage = (): void => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const scrollerTop = scroller.getBoundingClientRect().top;
      let current = 1;
      for (const child of host.children) {
        const element = child as HTMLElement;
        const page = Number(element.dataset.page);
        if (!page) continue;
        if (element.getBoundingClientRect().top - scrollerTop <= 96) current = page;
        else break;
      }
      // 滚动跟随：输入框始终显示视口顶部所在页（值不变时 React 跳过渲染）。
      setPageInput((prev) => (prev === String(current) ? prev : String(current)));
    };
    const scroller = scrollRef.current;
    scroller?.addEventListener("scroll", syncCurrentPage, { passive: true });
    syncCurrentPage();

    // 分栏拖动会改变页面宽度，按新宽度重绘已渲染页面，避免位图被拉伸。
    let lastWidth = host.clientWidth;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (cancelled) return;
      const width = host.clientWidth;
      if (Math.abs(width - lastWidth) < 24) return;
      lastWidth = width;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        if (cancelled) return;
        for (const slot of host.children) {
          const target = slot as HTMLElement;
          if (target.dataset.rendered !== "1") continue;
          target.dataset.rendered = "";
          void renderPage(target);
        }
      }, 200);
    });
    resizeObserver.observe(host);

    return () => {
      cancelled = true;
      observer.disconnect();
      resizeObserver.disconnect();
      scroller?.removeEventListener("scroll", syncCurrentPage);
      if (resizeTimer) clearTimeout(resizeTimer);
      for (const task of tasks) task.cancel();
      tasks.clear();
    };
  }, [slots, zoom, baseWidth]);

  const changeZoom = (value: number): void => {
    setZoom(clampZoom(value / 100));
    markManual();
  };

  /** 默认显示：基准页宽容纳在视口内（超过才缩小，不放大）。 */
  const applyDefault = (): void => {
    const percent = zoomToContain(
      scrollRef.current,
      baseWidth,
      Math.round(ZOOM_MIN * 100),
      Math.round(ZOOM_MAX * 100),
    );
    if (percent !== null) setZoom(clampZoom(percent / 100));
    markDefault();
  };

  // 缩放快捷键与工具栏一致：Ctrl += 放大、Ctrl -= 缩小、Ctrl+0 默认显示、Ctrl+滚轮缩放。
  useDiagramZoomShortcuts(
    Math.round(zoom * 100),
    changeZoom,
    {
      min: Math.round(ZOOM_MIN * 100),
      max: Math.round(ZOOM_MAX * 100),
      step: Math.round(ZOOM_STEP * 100),
      onReset: applyDefault,
    },
  );

  /** 页宽显示：按 PDF 视口可用宽度与基准页宽计算缩放（一次性动作）。 */
  const applyFitWidth = (): void => {
    const percent = zoomToFitWidth(
      scrollRef.current,
      baseWidth,
      Math.round(ZOOM_MIN * 100),
      Math.round(ZOOM_MAX * 100),
    );
    if (percent !== null) setZoom(clampZoom(percent / 100));
    markFitWidth();
  };

  /** 跳转到指定页（表单提交；越界夹取）。 */
  const goToPage = (raw: string): void => {
    const target = Number.parseInt(raw, 10);
    if (!Number.isFinite(target)) return;
    const bounded = Math.min(Math.max(1, target), Math.max(1, total));
    pagesRef.current
      ?.querySelector<HTMLElement>(`[data-page="${bounded}"]`)
      ?.scrollIntoView({ block: "start" });
    setPageInput(String(bounded));
  };

  if (error) {
    return (
      <div className="pdf-viewer">
        <p className="placeholder">{t("PDF 加载失败：{0}", error)}</p>
      </div>
    );
  }

  return (
    <div className="pdf-stack">
      {total > 0 && (
        <div className="pdf-toolbar">
          <form
            className="pdf-page-jump"
            onSubmit={(event) => {
              event.preventDefault();
              goToPage(pageInput);
            }}
          >
            <input
              type="number"
              min={1}
              max={total}
              value={pageInput}
              aria-label={t("跳转到页")}
              onChange={(event) => setPageInput(event.target.value)}
            />
            <span className="pdf-page-total">/ {total}</span>
          </form>
          {/* 缩放控件与其他预览一致（共用 .zoom-toolbar），位于工具栏右列。 */}
          <DiagramZoomToolbar
            className="pdf-zoom-controls"
            label={t("页面缩放")}
            mode={mode}
            zoom={Math.round(zoom * 100)}
            min={Math.round(ZOOM_MIN * 100)}
            max={Math.round(ZOOM_MAX * 100)}
            step={Math.round(ZOOM_STEP * 100)}
            onZoomChange={changeZoom}
            onFit={applyDefault}
            onFitWidth={applyFitWidth}
          />
          {/* 转换入口暂不展示：保留回调接线，工具栏只留页码与缩放。 */}
          {onConvert && (
            <>
              <span className="pdf-toolbar-divider" aria-hidden="true" hidden />
              <button
                type="button"
                className="icon-button pdf-convert-button"
                title={t("导出为 Markdown 文件")}
                aria-label={t("转 Markdown")}
                disabled={converting}
                hidden
                onClick={() => {
                  setConverting(true);
                  void Promise.resolve(onConvert()).finally(() => setConverting(false));
                }}
              >
                <Icon name="file-markdown" />
              </button>
            </>
          )}
        </div>
      )}
      <div className={`pdf-viewer${invert ? " pdf-invert" : ""}`} ref={scrollRef}>
        {progress === 0 && <p className="placeholder">{t("正在加载 PDF…")}</p>}
        <div className="pdf-pages" ref={pagesRef} style={{ width: baseWidth, zoom }}>
          {slots.map((slot) => (
            <div
              key={slot.pageNumber}
              className="pdf-page"
              data-page={slot.pageNumber}
              style={{ aspectRatio: `${1 / slot.ratio}` }}
            >
              <span className="pdf-page-label">{slot.pageNumber}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * 打开的 PDF 文档：经 fs.readBase64 读取磁盘字节后交给 PdfPreview 渲染。
 * 路径或修改时间变化（含外部更新）时自动重新加载。
 */
export function PdfDocumentPreview({
  path,
  mtimeMs,
  onConvert,
}: {
  path: string;
  mtimeMs: number;
  /** 转换回调，接收已加载的 PDF 字节，避免重复读盘。 */
  onConvert?: (data: Uint8Array) => Promise<void> | void;
}) {
  const [state, setState] = useState<{ data: Uint8Array } | { error: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    void (async () => {
      try {
        const file = await window.panda.fs.readBase64({ path });
        if (cancelled) return;
        // base64 → Uint8Array：pdfjs 的 data 源要求二进制。
        const binary = atob(file.data);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        setState({ data: bytes });
      } catch (reason) {
        if (!cancelled) {
          setState({ error: reason instanceof Error ? reason.message : String(reason) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, mtimeMs]);

  // 稳定 source 引用：bytes 加载完成后不再因父组件重渲染而重建。
  const source = useMemo<PdfSource | null>(
    () => (state && "data" in state ? { data: state.data } : null),
    [state],
  );

  // 与 source 同源的字节：供转换回调复用，避免重复读盘。
  const data = state && "data" in state ? state.data : null;

  if (!source || !data) {
    return (
      <div className="pdf-viewer">
        <p className="placeholder">
          {state && "error" in state ? t("PDF 加载失败：{0}", state.error) : t("正在加载 PDF…")}
        </p>
      </div>
    );
  }
  return (
    <PdfPreview source={source} onConvert={onConvert ? () => onConvert(data) : undefined} />
  );
}
