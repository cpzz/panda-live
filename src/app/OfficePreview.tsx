/** Microsoft Office 只读预览：docx（docx-preview 渲染 DOM）、xlsx（SheetJS 解析 → HTML 表格）、
 * pptx（pptx-to-html → 幻灯片 HTML）。与 PDF/图片同属二进制只读族：readBase64 读盘，
 * 路径或修改时间变化（含外部更新）时自动重新加载。渲染库动态 import，保持初始包体。 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import { sanitizeHtml } from "../render/html";
import {
  DiagramZoomToolbar,
  measuredBaseWidth,
  useDiagramZoomShortcuts,
  usePreviewZoomMode,
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
  const { mode, markDefault, markFitWidth, markManual } = usePreviewZoomMode(bytes);
  /** 页宽显示后的实测校正标记：按真实渲染宽度修正测量误差，直到恰好铺满。 */
  const fitWidthPendingRef = useRef(false);

  /** 缩放动作共用同一套视口测量与基准页宽（优先取 docx-preview 渲染页面的实际宽度）。 */
  const applyZoomMode = useCallback(
    (mode: typeof zoomToContain | typeof zoomToFitWidth): void => {
      const viewer = bodyRef.current?.closest<HTMLElement>(".office-viewer") ?? null;
      const section =
        bodyRef.current?.querySelector<HTMLElement>(
          ".office-docx-wrapper > section.office-docx",
        ) ?? null;
      // docx-preview 的 style.width 不含页边距 padding，必须用渲染后的实际外宽反推基准。
      const baseWidth = measuredBaseWidth(section, zoom) ?? PAGE_BASE_WIDTH;
      const percent = mode(
        viewer,
        baseWidth,
        Math.round(ZOOM_MIN * 100),
        Math.round(ZOOM_MAX * 100),
      );
      if (percent !== null) setZoom(clampZoom(percent / 100));
    },
    [zoom],
  );

  /** 默认显示：页面宽度容纳在视口内（超过才缩小，不放大）。 */
  const applyDefault = useCallback((): void => {
    fitWidthPendingRef.current = false;
    applyZoomMode(zoomToContain);
    markDefault();
  }, [applyZoomMode, markDefault]);
  /** 页宽显示：页面宽度铺满视口（一次性动作）。 */
  const applyFitWidth = useCallback((): void => {
    fitWidthPendingRef.current = true;
    applyZoomMode(zoomToFitWidth);
    markFitWidth();
  }, [applyZoomMode, markFitWidth]);
  /** 手动缩放/快捷键取消页宽校正，避免覆盖用户选择的比例。 */
  const changeZoom = useCallback(
    (value: number): void => {
      fitWidthPendingRef.current = false;
      setZoom(clampZoom(value / 100));
      markManual();
    },
    [markManual],
  );
  useDiagramZoomShortcuts(Math.round(zoom * 100), changeZoom, {
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

  // 页宽显示应用后按真实渲染宽度校正：基准测量、CSS zoom 与滚动条预留都可能有偏差，
  // 这里以实际外宽与视口可用宽度的比值再校准一次，保证恰好铺满且不横向溢出。
  useLayoutEffect(() => {
    if (!fitWidthPendingRef.current) return;
    const viewer = bodyRef.current?.closest<HTMLElement>(".office-viewer") ?? null;
    const section = bodyRef.current?.querySelector<HTMLElement>(
      ".office-docx-wrapper > section.office-docx",
    );
    if (!viewer || !section) return;
    const style = getComputedStyle(viewer);
    const available =
      viewer.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight);
    const visual = section.getBoundingClientRect().width;
    if (!(available > 0) || !(visual > 0)) return;
    if (Math.abs(visual - available) <= 1) {
      fitWidthPendingRef.current = false;
      return;
    }
    setZoom(clampZoom((zoom * available) / visual));
  }, [zoom]);

  // docx-preview 的样式经独立容器注入，避免污染全局（见 README）。
  return (
    <>
      {/* 连续流式无页码：直接复用共用缩放工具栏（含边框与吸顶），动作组靠右。 */}
      <DiagramZoomToolbar
        className="office-toolbar"
        label={t("文档缩放")}
        mode={mode}
        zoom={Math.round(zoom * 100)}
        min={Math.round(ZOOM_MIN * 100)}
        max={Math.round(ZOOM_MAX * 100)}
        step={Math.round(ZOOM_STEP * 100)}
        onZoomChange={changeZoom}
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

/** 表头边缘多少像素内判定为「拖列宽 / 拖行高」，否则视为选中整列 / 整行。 */
const XLSX_RESIZE_EDGE = 6;

interface XlsxDragState {
  kind: "range" | "col-resize" | "row-resize";
  /** 框选起点（display 0 基行列）。 */
  anchorR: number;
  anchorC: number;
  startX: number;
  startY: number;
  /** 拖宽/拖高的起始尺寸。 */
  startWidth: number;
  startHeight: number;
  moved: boolean;
  /** 拖列宽的目标 <col>（只写 style.width，用 HTMLElement 即可）。 */
  col?: HTMLElement;
  /** 拖列宽所在的 <table>：列宽变化后需同步表格总宽（table-layout:fixed 依赖确定宽度）。 */
  table?: HTMLElement;
  tr?: HTMLTableRowElement;
}

/** xlsx 分支：HTML 表格 + 单元格/行列选择 + 拖拽框选 + 拖表头调宽/调高；sheet 标签吸底（贴近 Excel）。
 * 表格由纯函数 sheetToTableHtml 生成静态 HTML，交互层用事件委托 + 直接改 DOM 类，
 * 避免把大表重构成 React 状态树（只读预览，重渲染既重又会重置滚动）。 */
function XlsxBody({ sheets }: { sheets: OfficeSheetInfo[] }) {
  const [active, setActive] = useState(0);
  /** 公式栏展开态：展开时增高并换行显示选中格完整内容。 */
  const [expanded, setExpanded] = useState(false);
  /** 折行显示开关：选中=单元格内容超宽时折行；未选中=超出部分不显示（默认选中，贴近上一版行为）。 */
  const [wrap, setWrap] = useState(true);
  const index = Math.min(active, sheets.length - 1);
  const sheet = sheets[index];
  const bodyRef = useRef<HTMLDivElement>(null);
  const html = useMemo(() => (sheet ? sanitizeHtml(sheet.html) : ""), [sheet]);

  // 选择/拖拽状态放 ref，不触发 React 重渲染（选择直接改 DOM 类即可）。
  const dragRef = useRef<XlsxDragState | null>(null);
  // 顶部名称框 / 名称框右侧拖宽手柄 / 单元内容栏，选择与拖宽时直写 DOM。
  const nameBoxRef = useRef<HTMLSpanElement>(null);
  const nameBoxResizeRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  // 底部页签栏：可横向滚动条带 + ‹ › 翻页按钮。
  const tabStripRef = useRef<HTMLDivElement>(null);
  const navLeftRef = useRef<HTMLButtonElement>(null);
  const navRightRef = useRef<HTMLButtonElement>(null);

  const clearSelection = useCallback((): void => {
    const root = bodyRef.current;
    if (!root) return;
    root
      .querySelectorAll(".cell-selected, .row-selected, .col-selected, .range-selected")
      .forEach((el) => el.classList.remove("cell-selected", "row-selected", "col-selected", "range-selected"));
    root.querySelectorAll(".header-active").forEach((el) => el.classList.remove("header-active"));
  }, []);

  /** 遍历 tbody 数据单元格（display 0 基行列 + 元素）。 */
  const forEachCell = useCallback(
    (fn: (r: number, c: number, cell: HTMLTableCellElement) => void): void => {
      const root = bodyRef.current;
      if (!root) return;
      for (const tr of Array.from(root.querySelectorAll("tbody tr"))) {
        const r = Number(tr.querySelector(".office-xlsx-rowhead")?.getAttribute("data-r") ?? -1);
        if (r < 0) continue;
        for (const cell of Array.from(tr.children) as HTMLTableCellElement[]) {
          if (cell.tagName !== "TD") continue;
          const c = Number(cell.getAttribute("data-c") ?? -1);
          if (c < 0) continue;
          fn(r, c, cell);
        }
      }
    },
    [],
  );

  const markHeaders = useCallback((rows: number[], cols: number[]): void => {
    const root = bodyRef.current;
    if (!root) return;
    for (const r of rows)
      root.querySelector(`.office-xlsx-rowhead[data-r="${r}"]`)?.classList.add("header-active");
    for (const c of cols)
      root.querySelector(`.office-xlsx-colhead[data-c="${c}"]`)?.classList.add("header-active");
  }, []);

  /** 名称框显示选中格引用、单元内容栏显示其文本（直写 DOM，不重渲染）。 */
  const showCellRef = useCallback((r: number, c: number): void => {
    const root = bodyRef.current;
    const nameBox = nameBoxRef.current;
    const content = contentRef.current;
    if (!root) return;
    const colHead = root.querySelector(`.office-xlsx-colhead[data-c="${c}"]`);
    const rowHead = root.querySelector(`.office-xlsx-rowhead[data-r="${r}"]`);
    const cell = root.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
    if (nameBox && colHead && rowHead) {
      nameBox.textContent = `${colHead.textContent ?? ""}${rowHead.textContent ?? ""}`;
    }
    if (content) content.textContent = cell ? (cell.textContent ?? "") : "";
  }, []);

  /** 名称框显示范围引用（整行/整列/全选），单元内容栏清空。 */
  const showRangeRef = useCallback((range: string): void => {
    if (nameBoxRef.current) nameBoxRef.current.textContent = range;
    if (contentRef.current) contentRef.current.textContent = "";
  }, []);

  const selectCell = useCallback(
    (r: number, c: number): void => {
      clearSelection();
      forEachCell((rr, cc, cell) => {
        if (rr === r && cc === c) cell.classList.add("cell-selected");
      });
      markHeaders([r], [c]);
      showCellRef(r, c);
    },
    [clearSelection, forEachCell, markHeaders, showCellRef],
  );

  const selectRow = useCallback(
    (r: number): void => {
      clearSelection();
      forEachCell((rr, _cc, cell) => {
        if (rr === r) cell.classList.add("row-selected");
      });
      markHeaders([r], []);
      showRangeRef(`${r + 1}:${r + 1}`);
    },
    [clearSelection, forEachCell, markHeaders, showRangeRef],
  );

  const selectCol = useCallback(
    (c: number): void => {
      clearSelection();
      forEachCell((_rr, cc, cell) => {
        if (cc === c) cell.classList.add("col-selected");
      });
      markHeaders([], [c]);
      const letter =
        bodyRef.current?.querySelector(`.office-xlsx-colhead[data-c="${c}"]`)?.textContent ??
        String.fromCharCode(65 + c);
      showRangeRef(`${letter}:${letter}`);
    },
    [clearSelection, forEachCell, markHeaders, showRangeRef],
  );

  const selectAll = useCallback((): void => {
    const root = bodyRef.current;
    if (!root) return;
    root.querySelectorAll("tbody td").forEach((el) => el.classList.add("range-selected"));
    root
      .querySelectorAll(".office-xlsx-rowhead, .office-xlsx-colhead, .office-xlsx-corner")
      .forEach((el) => el.classList.add("header-active"));
    const cols = root.querySelectorAll(".office-xlsx-colhead");
    const rows = root.querySelectorAll(".office-xlsx-rowhead");
    const firstCol = cols[0]?.textContent ?? "A";
    const lastCol = cols[cols.length - 1]?.textContent ?? "A";
    const lastRow = rows[rows.length - 1]?.textContent ?? "1";
    showRangeRef(`${firstCol}1:${lastCol}${lastRow}`);
  }, [showRangeRef]);

  const applyRange = useCallback(
    (r0: number, r1: number, c0: number, c1: number): void => {
      clearSelection();
      forEachCell((rr, cc, cell) => {
        if (rr >= r0 && rr <= r1 && cc >= c0 && cc <= c1) cell.classList.add("range-selected");
      });
      const rows: number[] = [];
      for (let r = r0; r <= r1; r += 1) rows.push(r);
      const cols: number[] = [];
      for (let c = c0; c <= c1; c += 1) cols.push(c);
      markHeaders(rows, cols);
    },
    [clearSelection, forEachCell, markHeaders],
  );

  // 切换工作表时清空选择与拖拽状态（React 重写 innerHTML 已随之清除，这里兜底），并重置名称框/内容栏。
  useEffect(() => {
    dragRef.current = null;
    clearSelection();
    if (nameBoxRef.current) nameBoxRef.current.textContent = "A1";
    if (contentRef.current) contentRef.current.textContent = "";
  }, [sheet, clearSelection]);

  // ESC 取消选择并清空名称框/内容栏（输入框/可编辑区内不生效，避免干扰编辑）。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      clearSelection();
      if (nameBoxRef.current) nameBoxRef.current.textContent = "";
      if (contentRef.current) contentRef.current.textContent = "";
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearSelection]);

  // 底部页签：只在页签超出条带宽度时显示 ‹ › 箭头，滚到头禁用（直写 DOM，不重渲染）。
  useEffect(() => {
    const strip = tabStripRef.current;
    const left = navLeftRef.current;
    const right = navRightRef.current;
    if (!strip) return;
    const update = (): void => {
      const overflow = strip.scrollWidth > strip.clientWidth + 1;
      if (left) left.style.display = overflow ? "" : "none";
      if (right) right.style.display = overflow ? "" : "none";
      if (left) left.disabled = !overflow || strip.scrollLeft <= 0;
      if (right)
        right.disabled = !overflow || strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1;
    };
    update();
    strip.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(strip);
    return () => {
      strip.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [sheet]);

  // 名称框右侧「3 点」手柄：按住拖动调整名称框宽度（只写 style.width，不重渲染；宽度在切表时保留）。
  useEffect(() => {
    const grip = nameBoxResizeRef.current;
    if (!grip) return;
    const onDown = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      const nameBox = nameBoxRef.current;
      if (!nameBox) return;
      e.preventDefault();
      const startX = e.clientX;
      const startW = nameBox.offsetWidth;
      const onMove = (ev: MouseEvent): void => {
        const w = Math.max(56, Math.min(360, startW + (ev.clientX - startX)));
        nameBox.style.width = `${Math.round(w)}px`;
      };
      const onUp = (): void => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
    grip.addEventListener("mousedown", onDown);
    return () => grip.removeEventListener("mousedown", onDown);
  }, []);

  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;

    const onMove = (e: MouseEvent): void => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.kind === "col-resize" && drag.col) {
        const w = Math.max(8, drag.startWidth + (e.clientX - drag.startX));
        drag.col.style.width = `${Math.round(w)}px`;
        // 同步表格总宽 = 各列宽之和，保持 table-layout:fixed 严格按列渲染（窄列可裁剪、超宽触发横向滚动）。
        if (drag.table) {
          const cols = drag.table.querySelectorAll("colgroup col");
          const sum = Array.from(cols).reduce(
            (s, c) => s + (parseFloat((c as HTMLElement).style.width) || 0),
            0,
          );
          drag.table.style.width = `${Math.round(sum)}px`;
        }
      } else if (drag.kind === "row-resize" && drag.tr) {
        const h = Math.max(18, drag.startHeight + (e.clientY - drag.startY));
        drag.tr.style.height = `${Math.round(h)}px`;
      } else if (drag.kind === "range") {
        const el = e.target as Element | null;
        const cell = (el?.closest?.("td[data-r]") ?? null) as HTMLTableCellElement | null;
        if (!cell || !root.contains(cell)) return;
        const cr = Number(cell.getAttribute("data-r") ?? -1);
        const cc = Number(cell.getAttribute("data-c") ?? -1);
        if (cr < 0 || cc < 0) return;
        drag.moved = drag.moved || cr !== drag.anchorR || cc !== drag.anchorC;
        applyRange(
          Math.min(drag.anchorR, cr),
          Math.max(drag.anchorR, cr),
          Math.min(drag.anchorC, cc),
          Math.max(drag.anchorC, cc),
        );
        // 锚点格保留活动边框（Excel 框选时起点格的加粗边）。
        root
          .querySelector(`td[data-r="${drag.anchorR}"][data-c="${drag.anchorC}"]`)
          ?.classList.add("cell-selected");
        // 名称框/内容栏跟随框选起点格。
        showCellRef(drag.anchorR, drag.anchorC);
      }
    };

    const onUp = (): void => {
      const drag = dragRef.current;
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      // 纯点击（未拖动）落回单格选中。
      if (drag?.kind === "range" && !drag.moved) selectCell(drag.anchorR, drag.anchorC);
    };

    const onMouseDown = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (!root.contains(target)) return;

      // 列头：右缘拖列宽，否则整列选中。
      if (target.classList.contains("office-xlsx-colhead")) {
        const rect = target.getBoundingClientRect();
        const c = Number(target.getAttribute("data-c") ?? -1);
        const col =
          c >= 0
            ? (root.querySelector("table.office-xlsx-table colgroup")?.children[c + 1] as
                | HTMLElement
                | undefined)
            : undefined;
        if (c >= 0 && e.clientX >= rect.right - XLSX_RESIZE_EDGE && col) {
          dragRef.current = {
            kind: "col-resize",
            anchorR: 0,
            anchorC: 0,
            startX: e.clientX,
            startY: e.clientY,
            // 起点取 <col> 声明宽（精确列宽），避免表头 th 的 border-box 宽差 1-2px 导致首帧跳变。
            startWidth: parseFloat(col.style.width) || rect.width,
            startHeight: 0,
            moved: false,
            col,
            table: col.closest("table") ?? undefined,
          };
          e.preventDefault();
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
          return;
        }
        if (c >= 0) selectCol(c);
        return;
      }

      // 行头：下缘拖行高，否则整行选中。
      if (target.classList.contains("office-xlsx-rowhead")) {
        const rect = target.getBoundingClientRect();
        const r = Number(target.getAttribute("data-r") ?? -1);
        const tr = target.closest<HTMLTableRowElement>("tr");
        if (r >= 0 && e.clientY >= rect.bottom - XLSX_RESIZE_EDGE && tr) {
          dragRef.current = {
            kind: "row-resize",
            anchorR: 0,
            anchorC: 0,
            startX: e.clientX,
            startY: e.clientY,
            startWidth: 0,
            startHeight: tr.clientHeight,
            moved: false,
            tr,
          };
          e.preventDefault();
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
          return;
        }
        if (r >= 0) selectRow(r);
        return;
      }

      // 左上角格：全选。
      if (target.hasAttribute("data-corner")) {
        selectAll();
        return;
      }

      // 数据单元格：单格选中 / 拖拽框选矩形范围。
      // 文本包在 .office-xlsx-celltext span 里，点中文字时 e.target 是 span 而非 td，须用 closest 解析
      // （否则点在有内容的格上会「有时选中、有时没反应」，取决于是否点中文字）。
      const cellTarget = target.closest<HTMLTableCellElement>("td[data-r]");
      if (cellTarget) {
        const r = Number(cellTarget.getAttribute("data-r") ?? -1);
        const c = Number(cellTarget.getAttribute("data-c") ?? -1);
        if (r < 0 || c < 0) return;
        dragRef.current = {
          kind: "range",
          anchorR: r,
          anchorC: c,
          startX: e.clientX,
          startY: e.clientY,
          startWidth: 0,
          startHeight: 0,
          moved: false,
        };
        selectCell(r, c);
        e.preventDefault();
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      }
    };

    root.addEventListener("mousedown", onMouseDown);
    return () => {
      root.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [applyRange, selectCell, selectRow, selectCol, selectAll, showCellRef]);

  if (!sheet) return <p className="placeholder">{t("（空工作簿）")}</p>;

  return (
    <div className="office-xlsx-wrap">
      {/* 名称框（选中格引用）+ fx + 单元内容栏（选中格文本）+ 右端展开/折叠按钮，贴近 Excel 顶部。 */}
      <div
        className={`office-xlsx-formulabar${expanded ? " office-xlsx-formulabar--expanded" : ""}`}
      >
        <span className="office-xlsx-namebox" ref={nameBoxRef}>A1</span>
        <span className="office-xlsx-namebox-resize" ref={nameBoxResizeRef} aria-hidden="true">
          ⋮
        </span>
        <span className="office-xlsx-content" ref={contentRef} />
        <button
          type="button"
          className="office-xlsx-formulaexpand"
          aria-label={expanded ? "折叠公式栏" : "展开公式栏"}
          aria-expanded={expanded}
          title={expanded ? "折叠" : "展开查看完整内容"}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "▴" : "▾"}
        </button>
        {/* | 分隔栏：把「折行显示」开关与前面的「展开/折叠」按钮分开。 */}
        <span className="office-xlsx-bar-sep" aria-hidden="true"></span>
        {/* 折行显示开关：选中=超宽折行，未选中=超出部分不显示。 */}
        <button
          type="button"
          className={`office-xlsx-wraptoggle${wrap ? " active" : ""}`}
          aria-label="折行显示"
          aria-pressed={wrap}
          title={wrap ? "折行显示（已开启）" : "折行显示（已关闭）"}
          onClick={() => setWrap((value) => !value)}
        >
          ↵
        </button>
      </div>
      {sheet.truncated ? (
        <p className="placeholder office-xlsx-truncated">
          {t("表格过大，仅显示前 {0} 行 × {1} 列。", XLSX_PREVIEW_MAX_ROWS, XLSX_PREVIEW_MAX_COLS)}
        </p>
      ) : null}
      <div className="office-xlsx-scroll">
        <div
          className={`office-xlsx-body${wrap ? "" : " no-wrap"}`}
          ref={bodyRef}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
      {sheets.length > 1 ? (
        <div className="office-sheet-tabs" role="tablist">
          <button
            type="button"
            className="office-sheet-tabnav"
            ref={navLeftRef}
            aria-label="显示前面的工作表"
            onClick={() => tabStripRef.current?.scrollBy({ left: -240, behavior: "smooth" })}
          >
            ‹
          </button>
          <div className="office-sheet-tabstrip" ref={tabStripRef}>
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
          <button
            type="button"
            className="office-sheet-tabnav"
            ref={navRightRef}
            aria-label="显示后面的工作表"
            onClick={() => tabStripRef.current?.scrollBy({ left: 240, behavior: "smooth" })}
          >
            ›
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** pptx 分支：幻灯片竖排 + 页码标签，缩放工具栏与 PDF/图表/图片预览一致。 */
function PptxBody({ slides }: { slides: string[] }) {
  const [zoom, setZoom] = useState(1);
  const { mode, markDefault, markFitWidth, markManual } = usePreviewZoomMode(slides);
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
  const applyDefault = useCallback((): void => {
    applyZoomMode(zoomToContain);
    markDefault();
  }, [applyZoomMode, markDefault]);
  /** 页宽显示：基准页宽铺满视口。 */
  const applyFitWidth = useCallback((): void => {
    applyZoomMode(zoomToFitWidth);
    markFitWidth();
  }, [applyZoomMode, markFitWidth]);
  const changeZoom = useCallback(
    (value: number): void => {
      setZoom(clampZoom(value / 100));
      markManual();
    },
    [markManual],
  );
  useDiagramZoomShortcuts(Math.round(zoom * 100), changeZoom, {
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
        mode={mode}
        zoom={Math.round(zoom * 100)}
        min={Math.round(ZOOM_MIN * 100)}
        max={Math.round(ZOOM_MAX * 100)}
        step={Math.round(ZOOM_STEP * 100)}
        onZoomChange={changeZoom}
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
            // cellText 生成格式化文本 w；raw:false 让数字/日期取格式化值，避免显示成序列号或裸数字。
            workbook = XLSX.read(bytes, { type: "array", cellStyles: true, cellText: true, raw: false });
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
      <div className="office-viewer office-viewer-xlsx">
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
