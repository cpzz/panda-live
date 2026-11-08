import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

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

  useEffect(() => {
    let cancelled = false;
    let observer: IntersectionObserver | null = null;
    const tasks = new Set<RenderTask>();
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

      const renderPage = async (host: HTMLElement): Promise<void> => {
        if (host.dataset.rendered) return;
        const pageNumber = Number(host.dataset.page);
        if (!pageNumber) return;
        host.dataset.rendered = "1";
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const width = host.clientWidth || 600;
        const scale = (width / page.getViewport({ scale: 1 }).width) * (window.devicePixelRatio || 1);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = "100%";
        canvas.style.display = "block";
        canvas.setAttribute("aria-label", `第 ${pageNumber} 页`);
        const context = canvas.getContext("2d");
        if (!context) return;
        const task = page.render({ canvasContext: context, viewport, canvas });
        tasks.add(task);
        try {
          await task.promise;
        } catch (reason) {
          // 取消渲染（切换文档）属于正常流程。
          if (!cancelled) {
            host.dataset.rendered = "";
            console.warn("PDF 页面渲染失败", reason);
          }
          return;
        } finally {
          tasks.delete(task);
        }
        if (cancelled) return;
        host.replaceChildren(canvas);
      };

      const host = pagesRef.current;
      if (!host) return;
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const target = entry.target as HTMLElement;
            observer?.unobserve(target);
            void renderPage(target);
          }
        },
        { root: scrollRef.current, rootMargin: "600px 0px" },
      );
      for (const slot of host.children) {
        if ((slot as HTMLElement).dataset.page) observer.observe(slot);
      }
    };

    void load().catch((reason: unknown) => {
      if (cancelled) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    });

    return () => {
      cancelled = true;
      observer?.disconnect();
      for (const task of tasks) task.cancel();
      tasks.clear();
      void documentRef.current?.cleanup();
      void loadingTaskRef.current?.destroy();
      documentRef.current = null;
      loadingTaskRef.current = null;
    };
  }, [pdfKey]);

  if (error) {
    return (
      <div className="preview-pane">
        <p className="placeholder">PDF 加载失败：{error}</p>
      </div>
    );
  }

  return (
    <div className="pdf-viewer" ref={scrollRef}>
      {progress === 0 && <p className="placeholder">正在加载 PDF…</p>}
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
