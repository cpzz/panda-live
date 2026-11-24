/** Microsoft Office 只读预览：docx（docx-preview 渲染 DOM）、xlsx（SheetJS 解析 → HTML 表格）、
 * pptx（pptx-to-html → 幻灯片 HTML）。与 PDF/图片同属二进制只读族：readBase64 读盘，
 * 路径或修改时间变化（含外部更新）时自动重新加载。渲染库动态 import，保持初始包体。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import { sanitizeHtml } from "../render/html";
import {
  DiagramZoomToolbar,
  useDiagramZoomShortcuts,
  zoomToContain,
  zoomToFitWidth,
} from "./DiagramViewerDialog";
import {
  buildDocxOutlineFromDom,
  readDocxDocumentXml,
  readDocxStylesXml,
} from "../render/office/docx-outline";
import type { OutlineItem } from "../formats/outline";
import { base64ToBytes, sniffOfficeContainer } from "../render/office/sniff";
import { workbookToSheetInfos, XLSX_PREVIEW_MAX_COLS, XLSX_PREVIEW_MAX_ROWS } from "../render/office/xlsx-html";
import type { OfficeSheetInfo } from "../render/office/xlsx-html";
import { pptxToSlideHtml } from "../render/office/pptx-html";
import type { WorkBook } from "xlsx";

type OfficeFormat = "docx" | "xlsx" | "pptx";

/** 幻灯片/Word 缩放范围，与 PDF 预览一致。 */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;
/** 页宽显示的基准宽度：与 CSS `.office-pptx-slide` / PDF `.pdf-page` 的 max-width 一致。 */
const PAGE_BASE_WIDTH = 820;

function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 10) / 10));
}

const OFFICE_LABEL: Record<OfficeFormat, string> = {
  docx: "Word",
  xlsx: "Excel",
  pptx: "PowerPoint",
};

type OfficePhase =
  | { kind: "loading" }
  | { kind: "legacy"; extension: string }
  | { kind: "invalid"; message: string }
  | { kind: "docx"; bytes: Uint8Array }
  | { kind: "xlsx"; sheets: OfficeSheetInfo[] }
  | { kind: "pptx"; slides: string[] };

/** 各格式对应的「另存为新格式」提示目标扩展名。 */
const OFFICE_SAVE_HINT: Record<OfficeFormat, string> = {
  docx: ".docx",
  xlsx: ".xlsx",
  pptx: ".pptx",
};

function OfficeLoading({ format }: { format: OfficeFormat }) {
  return (
    <div className="office-viewer">
      <p className="placeholder">{t("正在加载 {0}…", OFFICE_LABEL[format])}</p>
    </div>
  );
}

function OfficeMessage({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="office-viewer">
      <div className="office-message">
        <p>{title}</p>
        {hint ? <p className="placeholder">{hint}</p> : null}
      </div>
    </div>
  );
}

/** docx 分支：容器挂载后调 docx-preview renderAsync 直接渲染 DOM；缩放工具栏与 PPT/PDF 一致。
 * 渲染完成后按 styles.xml 的标题层级提取大纲并上报侧栏。 */
function DocxBody({
  bytes,
  onOutline,
}: {
  bytes: Uint8Array;
  onOutline?: (items: OutlineItem[]) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  /** 缩放动作共用同一套视口测量与基准页宽（优先取 docx-preview 渲染页面的实际宽度）。 */
  const applyZoomMode = useCallback(
    (mode: typeof zoomToContain | typeof zoomToFitWidth): void => {
      const viewer = bodyRef.current?.closest<HTMLElement>(".office-viewer") ?? null;
      const section = bodyRef.current?.querySelector<HTMLElement>(
        ".office-docx-wrapper > section.office-docx",
      );
      const baseWidth = Number.parseFloat(section?.style.width ?? "") || PAGE_BASE_WIDTH;
      const percent = mode(
        viewer,
        baseWidth,
        Math.round(ZOOM_MIN * 100),
        Math.round(ZOOM_MAX * 100),
      );
      if (percent !== null) setZoom(clampZoom(percent / 100));
    },
    [],
  );

  /** 默认显示：页面宽度容纳在视口内（超过才缩小，不放大）。 */
  const applyDefault = useCallback((): void => applyZoomMode(zoomToContain), [applyZoomMode]);
  /** 页宽显示：页面宽度铺满视口（一次性动作）。 */
  const applyFitWidth = useCallback((): void => applyZoomMode(zoomToFitWidth), [applyZoomMode]);
  useDiagramZoomShortcuts(Math.round(zoom * 100), (value) => setZoom(clampZoom(value / 100)), {
    min: Math.round(ZOOM_MIN * 100),
    max: Math.round(ZOOM_MAX * 100),
    step: Math.round(ZOOM_STEP * 100),
    onReset: applyDefault,
  });

  useEffect(() => {
    let cancelled = false;
    const body = bodyRef.current;
    const style = styleRef.current;
    if (!body || !style) return;
    body.innerHTML = "";
    void (async () => {
      try {
        const { renderAsync } = await import("docx-preview");
        if (cancelled || !bodyRef.current) return;
        bodyRef.current.innerHTML = "";
        // 样式包解析与渲染并行；渲染完再按真实 DOM 提取大纲，保证索引与展示顺序一一对齐。
        const stylesPromise = readDocxStylesXml(bytes);
        const documentPromise = readDocxDocumentXml(bytes);
        await renderAsync(bytes, bodyRef.current, style, {
          className: "office-docx",
          inWrapper: true,
          // 连续流式布局：不分页、无页面块，避免「像图片」的观感，接近网页式阅读。
          breakPages: false,
          renderHeaders: false,
          renderFooters: false,
          renderFootnotes: true,
          renderEndnotes: true,
        });
        if (cancelled || !bodyRef.current) return;
        const items = buildDocxOutlineFromDom(
          bodyRef.current,
          await stylesPromise,
          undefined,
          await documentPromise,
        );
        if (!cancelled) onOutline?.(items);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bytes, onOutline]);

  // docx-preview 的样式经独立容器注入，避免污染全局（见 README）。
  return (
    <>
      {/* 连续流式无页码：直接复用共用缩放工具栏（含边框与吸顶），动作组靠右。 */}
      <DiagramZoomToolbar
        className="office-toolbar"
        label={t("文档缩放")}
        zoom={Math.round(zoom * 100)}
        min={Math.round(ZOOM_MIN * 100)}
        max={Math.round(ZOOM_MAX * 100)}
        step={Math.round(ZOOM_STEP * 100)}
        onZoomChange={(value) => setZoom(clampZoom(value / 100))}
        onFit={applyDefault}
        onFitWidth={applyFitWidth}
      />
      {/* CSS zoom 同步缩放版面（Chromium 布局级缩放，与 PPT/HTML 预览同机制）。 */}
      <div className="office-docx-pages" style={{ zoom }}>
        <div ref={styleRef} className="office-style-host" aria-hidden="true" />
        {error ? <p className="placeholder">{t("Word 渲染失败：{0}", error)}</p> : null}
        <div ref={bodyRef} className="office-docx-body" />
      </div>
    </>
  );
}

/** xlsx 分支：sheet 标签切换 + HTML 表格。 */
function XlsxBody({ sheets }: { sheets: OfficeSheetInfo[] }) {
  const [active, setActive] = useState(0);
  const index = Math.min(active, sheets.length - 1);
  const sheet = sheets[index];
  const html = useMemo(() => (sheet ? sanitizeHtml(sheet.html) : ""), [sheet]);
  if (!sheet) return <p className="placeholder">{t("（空工作簿）")}</p>;
  return (
    <div className="office-xlsx-wrap">
      {sheets.length > 1 ? (
        <div className="office-sheet-tabs" role="tablist">
          {sheets.map((item, itemIndex) => (
            <button
              key={`${item.name}-${itemIndex}`}
              type="button"
              role="tab"
              aria-selected={itemIndex === index}
              className={`office-sheet-tab${itemIndex === index ? " active" : ""}`}
              onClick={() => setActive(itemIndex)}
            >
              {item.name || t("Sheet {0}", itemIndex + 1)}
            </button>
          ))}
        </div>
      ) : null}
      {sheet.truncated ? (
        <p className="placeholder office-xlsx-truncated">
          {t("表格过大，仅显示前 {0} 行 × {1} 列。", XLSX_PREVIEW_MAX_ROWS, XLSX_PREVIEW_MAX_COLS)}
        </p>
      ) : null}
      <div className="office-xlsx-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

/** pptx 分支：幻灯片竖排 + 页码标签，缩放工具栏与 PDF/图表/图片预览一致。 */
function PptxBody({ slides }: { slides: string[] }) {
  const [zoom, setZoom] = useState(1);
  const pagesRef = useRef<HTMLDivElement>(null);

  /** 默认显示与页宽显示共用同一视口测量和基准页宽。 */
  const applyZoomMode = useCallback(
    (mode: typeof zoomToContain | typeof zoomToFitWidth): void => {
      const percent = mode(
        pagesRef.current?.parentElement ?? null,
        PAGE_BASE_WIDTH,
        Math.round(ZOOM_MIN * 100),
        Math.round(ZOOM_MAX * 100),
      );
      if (percent !== null) setZoom(clampZoom(percent / 100));
    },
    [],
  );
  /** 默认显示：基准页宽容纳在视口内（超过才缩小，不放大）。 */
  const applyDefault = useCallback((): void => applyZoomMode(zoomToContain), [applyZoomMode]);
  /** 页宽显示：基准页宽铺满视口。 */
  const applyFitWidth = useCallback((): void => applyZoomMode(zoomToFitWidth), [applyZoomMode]);
  useDiagramZoomShortcuts(Math.round(zoom * 100), (value) => setZoom(clampZoom(value / 100)), {
    min: Math.round(ZOOM_MIN * 100),
    max: Math.round(ZOOM_MAX * 100),
    step: Math.round(ZOOM_STEP * 100),
    onReset: applyDefault,
  });

  const htmls = useMemo(() => slides.map((slide) => sanitizeHtml(slide)), [slides]);
  if (slides.length === 0) return <p className="placeholder">{t("（无幻灯片）")}</p>;
  return (
    <>
      <DiagramZoomToolbar
        className="office-toolbar"
        label={t("幻灯片缩放")}
        leading={<span className="office-toolbar-title">{t("幻灯片 {0} 页", slides.length)}</span>}
        zoom={Math.round(zoom * 100)}
        min={Math.round(ZOOM_MIN * 100)}
        max={Math.round(ZOOM_MAX * 100)}
        step={Math.round(ZOOM_STEP * 100)}
        onZoomChange={(value) => setZoom(clampZoom(value / 100))}
        onFit={applyDefault}
        onFitWidth={applyFitWidth}
      />
      {/* CSS zoom 同步缩放版面（Chromium 布局级缩放，与 HTML 预览 iframe 的 zoom 同机制）。 */}
      <div className="office-pptx-pages" ref={pagesRef} style={{ zoom }}>
        {htmls.map((html, index) => (
          <div key={index} className="office-pptx-slide">
            <span className="office-pptx-label">{index + 1}</span>
            <div className="office-pptx-body" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * 打开的 Office 文档：readBase64 读取磁盘字节后按格式分流渲染。
 * 旧版二进制（.doc/.ppt，OLE2 容器）不支持解析，给出另存为新格式的提示。
 */
export function OfficeDocumentPreview({
  path,
  mtimeMs,
  format,
  onOutline,
}: {
  path: string;
  mtimeMs: number;
  format: OfficeFormat;
  /** Word 渲染完成后上报大纲项，供侧栏大纲面板复用。 */
  onOutline?: (items: OutlineItem[]) => void;
}) {
  const [phase, setPhase] = useState<OfficePhase>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: "loading" });
    void (async () => {
      try {
        const file = await window.panda.fs.readBase64({ path });
        if (cancelled) return;
        const bytes = base64ToBytes(file.data);
        // Excel 族（含 .xls/.xlsb）由 SheetJS 自动识别容器，无需魔数判定。
        if (format !== "xlsx") {
          const container = sniffOfficeContainer(bytes);
          if (container === "ole2") {
            setPhase({ kind: "legacy", extension: OFFICE_SAVE_HINT[format] });
            return;
          }
          if (container === "unknown") {
            setPhase({ kind: "invalid", message: t("无法识别的文件内容，可能已损坏或不是有效的 {0} 文件。", OFFICE_LABEL[format]) });
            return;
          }
        }
        if (format === "docx") {
          setPhase({ kind: "docx", bytes });
          return;
        }
        if (format === "xlsx") {
          const XLSX = await import("xlsx");
          if (cancelled) return;
          let workbook: WorkBook;
          try {
            workbook = XLSX.read(bytes, { type: "array", cellStyles: true });
          } catch (reason) {
            setPhase({ kind: "invalid", message: reason instanceof Error ? reason.message : String(reason) });
            return;
          }
          setPhase({ kind: "xlsx", sheets: workbookToSheetInfos(workbook) });
          return;
        }
        const slides = await pptxToSlideHtml(bytes.buffer);
        if (cancelled) return;
        setPhase({ kind: "pptx", slides });
      } catch (reason) {
        if (!cancelled) {
          setPhase({ kind: "invalid", message: reason instanceof Error ? reason.message : String(reason) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, mtimeMs, format]);

  if (phase.kind === "loading") return <OfficeLoading format={format} />;
  if (phase.kind === "legacy") {
    return (
      <OfficeMessage
        title={t("不支持旧版 {0} 二进制格式", OFFICE_LABEL[format])}
        hint={t("请用 Microsoft Office 将文件另存为 {0} 后重新打开。", phase.extension)}
      />
    );
  }
  if (phase.kind === "invalid") {
    return <OfficeMessage title={t("{0} 打开失败", OFFICE_LABEL[format])} hint={phase.message} />;
  }
  if (phase.kind === "docx") {
    return (
      <div className="office-viewer office-viewer-docx">
        <DocxBody bytes={phase.bytes} onOutline={onOutline} />
      </div>
    );
  }
  if (phase.kind === "xlsx") {
    return (
      <div className="office-viewer">
        <XlsxBody sheets={phase.sheets} />
      </div>
    );
  }
  return (
    <div className="office-viewer">
      <PptxBody slides={phase.slides} />
    </div>
  );
}
