import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { t } from "../i18n";
import { onThemeChange, resolveTheme, type AppTheme } from "../services/theme";

interface PageSlot {
  pageNumber: number;
  /** 高宽比，用于在渲染前预留版面，避免滚动跳动。 */
  ratio: number;
}

/**
 * TeX 编译产物预览：PDF.js 按需渲染。
 * worker 作为独立资源打包，切换文档或关闭预览时销毁文档实例以终止 worker。
 * 不渲染注释链接层，因此不存在外部链接自动跳转。见 doc/design.md §9.5、§13.4。
 */
export function PdfPreview({ pdfKey }: { pdfKey: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<ReturnType<typeof import("pdfjs-dist")["getDocument"]> | null>(null);
  const [slots, setSlots] = useState<PageSlot[]>([]);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<AppTheme>(resolveTheme);
  useEffect(() => onThemeChange(setTheme), []);
  // PDF 是固定白底位图，深色主题下自动反转，避免白纸刺眼。
  const invert = theme === "dark";

  useEffect(() => {
    let cancelled = false;
    setSlots([]);
    setProgress(0);
    setError(null);

    const load = async (): Promise<void> => {
      const [pdfjs, workerModule] = await Promise.all([
        import("pdfjs-dist"),
        import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
      ]);
      pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;
      const loadingTask = pdfjs.getDocument({
        url: `panda-pdf://${pdfKey}`,
        // 中文等 CID 字体需要 Adobe CMap 才能正确映射字形。
        cMapUrl: "panda-cmaps://local/",
        cMapPacked: true,
        disableAutoFetch: true,
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
  }, [pdfKey]);

  // 占位元素渲染完成后再观察可见性；否则首帧 children 为空，页面永远不会绘制。
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
      const width = target.clientWidth || 600;
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
      if ((slot as HTMLElement).dataset.page) observer.observe(slot);
    }

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
      if (resizeTimer) clearTimeout(resizeTimer);
      for (const task of tasks) task.cancel();
      tasks.clear();
    };
  }, [slots]);

  if (error) {
    return (
      <div className="preview-pane">
        <p className="placeholder">{t("PDF 加载失败：{0}", error)}</p>
      </div>
    );
  }

  return (
    <div className={`pdf-viewer${invert ? " pdf-invert" : ""}`} ref={scrollRef}>
      {progress === 0 && <p className="placeholder">{t("正在加载 PDF…")}</p>}
      <div className="pdf-pages" ref={pagesRef}>
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
  );
}
