import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import {
  cellInlineStyle,
  sheetToTableHtml,
  workbookToSheetInfos,
} from "../../src/render/office/xlsx-html";

function makeWorkbook(): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["名称", "数量", "单价"],
    ["<script>alert(1)</script>", 2, 3.5],
    [null, 4, null],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, "Sheet 1");
  return wb;
}

describe("cellInlineStyle", () => {
  it("无样式返回空串", () => {
    expect(cellInlineStyle({})).toBe("");
    expect(cellInlineStyle({ s: undefined })).toBe("");
    expect(cellInlineStyle({ s: null })).toBe("");
  });

  it("组合字体/填充/对齐样式", () => {
    const css = cellInlineStyle({
      s: {
        font: { bold: true, italic: true, color: { rgb: "FF0000" }, sz: 12 },
        fill: { patternType: "solid", fgColor: { rgb: "FFFF00" } },
        alignment: { horizontal: "center" },
      },
    });
    expect(css).toContain("font-weight:600");
    expect(css).toContain("font-style:italic");
    expect(css).toContain("color:#FF0000");
    // 12pt → 16px
    expect(css).toContain("font-size:16px");
    expect(css).toContain("background:#FFFF00");
    expect(css).toContain("text-align:center");
  });

  it("白底与无填充图案不输出背景", () => {
    expect(cellInlineStyle({ s: { fill: { patternType: "none", fgColor: { rgb: "FF0000" } } } })).toBe("");
    expect(cellInlineStyle({ s: { fill: { fgColor: { rgb: "FFFFFF" } } } })).toBe("");
  });

  it("非法颜色值被忽略", () => {
    expect(cellInlineStyle({ s: { font: { color: { rgb: "not-a-color" } } } })).toBe("");
    expect(cellInlineStyle({ s: { font: { color: "FF0000" } } })).toBe("");
  });

  it("折行由全局开关控制，内联样式不输出 white-space", () => {
    // 折行显示改为 .office-xlsx-body.no-wrap 全局开关，cellInlineStyle 不再输出 white-space。
    expect(cellInlineStyle({ s: { alignment: { wrapText: true } } })).toBe("");
  });

  it("兼容 8 位 ARGB 颜色并输出黑底", () => {
    // 8 位 AARRGGBB 取后 6 位；黑底不再被剔除。
    expect(cellInlineStyle({ s: { fill: { patternType: "solid", fgColor: { rgb: "FFFF0000" } } } })).toContain("background:#FF0000");
    expect(cellInlineStyle({ s: { fill: { patternType: "solid", fgColor: { rgb: "FF000000" } } } })).toContain("background:#000000");
  });

  it("边框样式输出对应 border 边", () => {
    const css = cellInlineStyle({
      s: {
        border: {
          top: { style: "thin", color: { rgb: "0000FF" } },
          bottom: { style: "medium" },
        },
      },
    });
    expect(css).toContain("border-top:1px solid #0000FF");
    expect(css).toContain("border-bottom:1px solid var(--border)");
    expect(css).not.toContain("border-left");
  });
});

describe("sheetToTableHtml", () => {
  it("转义单元格文本并输出数值", () => {
    const wb = makeWorkbook();
    const info = sheetToTableHtml(wb.Sheets["Sheet 1"] as XLSX.WorkSheet);
    expect(info.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(info.html).not.toContain("<script>");
    expect(info.html).toContain("3.5");
    expect(info.truncated).toBe(false);
  });

  it("空工作表输出占位提示", () => {
    const info = sheetToTableHtml({} as XLSX.WorkSheet);
    expect(info.html).toContain("（空工作表）");
    expect(info.truncated).toBe(false);
  });

  it("合并单元格：左上角带跨度，成员格跳过", () => {
    const ws = XLSX.utils.aoa_to_sheet([["A", "B", "C"], ["D", "E", "F"]]);
    ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
    const info = sheetToTableHtml(ws);
    expect(info.html).toContain('rowspan="1" colspan="2"');
    // 首个数据行只有 2 个 td（A 合并占 B）；取 tbody 内首行以避开列字母表头。
    const firstBodyRow = (info.html.split("<tbody>")[1] ?? "").split("</tr>")[0] ?? "";
    expect(firstBodyRow).not.toContain(">B</td>");
  });

  it("超过行列上限时截断并标记", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ]);
    const info = sheetToTableHtml(ws, { rows: 2, cols: 2 });
    expect(info.truncated).toBe(true);
    const tbody = info.html.split("<tbody>")[1] ?? "";
    const rowCount = tbody.match(/<tr>/gu)?.length ?? 0;
    expect(rowCount).toBe(2);
    const firstBodyRow = tbody.split("</tr>")[0] ?? "";
    const cellsInFirstRow = firstBodyRow.match(/<td/gu)?.length ?? 0;
    expect(cellsInFirstRow).toBe(2);
  });

  it("列宽映射到 colgroup", () => {
    const ws = XLSX.utils.aoa_to_sheet([["A", "B"]]);
    ws["!cols"] = [{ wch: 20 }, { wch: 5 }];
    const info = sheetToTableHtml(ws);
    expect(info.html).toContain('<col style="width:145px" />');
    expect(info.html).toContain('<col style="width:40px" />');
  });

  it("列宽优先取源文件像素宽 wpx", () => {
    const ws = XLSX.utils.aoa_to_sheet([["A", "B"]]);
    ws["!cols"] = [{ wpx: 120, wch: 19 }, { wpx: 200 }];
    const info = sheetToTableHtml(ws);
    expect(info.html).toContain('<col style="width:120px" />');
    expect(info.html).toContain('<col style="width:200px" />');
  });

  it("数据列按绝对列号取 !cols 宽度（数据不从 A 列起不错位）", () => {
    // !ref 从 C 列起：首个显示列 C（绝对列号 2）应取 !cols[2]，而非 !cols[0]。
    const ws = {} as XLSX.WorkSheet;
    ws["!ref"] = "C1:C2";
    ws["C1"] = { t: "s", v: "x", w: "x" };
    ws["C2"] = { t: "s", v: "y", w: "y" };
    ws["!cols"] = [{ wpx: 111 }, { wpx: 222 }, { wpx: 333 }];
    const info = sheetToTableHtml(ws);
    // 首个显示列（C 列）宽度 = !cols[2].wpx = 333px（旧实现误取 !cols[0]=111）。
    expect(info.html).toContain('<col style="width:333px" />');
    // 未显示的 A/B 列（!cols[0]/[1]）不应作为显示列宽出现。
    expect(info.html).not.toContain('<col style="width:111px" />');
  });

  it("表格输出确定宽度（table-layout:fixed 依赖确定宽度才能严格按 <col> 渲染）", () => {
    const ws = XLSX.utils.aoa_to_sheet([["A", "B"]]);
    const info = sheetToTableHtml(ws);
    expect(info.html).toMatch(/<table class="office-xlsx-table" style="width:\d+px">/u);
  });

  it("输出列字母表头与行号（含交互定位 data-*）", () => {
    const ws = XLSX.utils.aoa_to_sheet([["A", "B"], ["C", "D"]]);
    const info = sheetToTableHtml(ws);
    expect(info.html).toContain('<th class="office-xlsx-colhead" data-c="0">A</th>');
    expect(info.html).toContain('<th class="office-xlsx-colhead" data-c="1">B</th>');
    expect(info.html).toContain('<th class="office-xlsx-rowhead" data-r="0">1</th>');
    expect(info.html).toContain('<th class="office-xlsx-rowhead" data-r="1">2</th>');
    // 角格在表头首格
    expect(info.html).toContain('<th class="office-xlsx-corner" data-corner></th>');
    // 数据单元格带 display 0 基行列，供选择/框选/调宽命中。
    // 文本包一层块级 span（折行/裁剪作用在其上），td 直接内容即该 span。
    expect(info.html).toContain('<td data-r="0" data-c="0"><span class="office-xlsx-celltext">A</span></td>');
    expect(info.html).toContain('<td data-r="1" data-c="1"><span class="office-xlsx-celltext">D</span></td>');
  });

  it("数据稀疏时也铺满默认行列（空列/空行显示表头与网格）", () => {
    // 仅 A1 一个数据格：仍应显示到默认最小列 Q（第 17 列）与默认最小行 30。
    const ws = XLSX.utils.aoa_to_sheet([["x"]]);
    const info = sheetToTableHtml(ws);
    expect(info.truncated).toBe(false);
    expect(info.html).toContain('<th class="office-xlsx-colhead" data-c="16">Q</th>');
    expect(info.html).toContain('<th class="office-xlsx-rowhead" data-r="29">30</th>');
    // 数据之外是空单元格，保留网格线。
    const tbody = info.html.split("<tbody>")[1] ?? "";
    const cellsInFirstRow = (tbody.split("</tr>")[0] ?? "").match(/<td/gu)?.length ?? 0;
    expect(cellsInFirstRow).toBe(17);
  });
});

describe("workbookToSheetInfos", () => {
  it("按工作表顺序输出并携带名称", () => {
    const wb = makeWorkbook();
    const empty = XLSX.utils.aoa_to_sheet([]);
    XLSX.utils.book_append_sheet(wb, empty, "Empty");
    const infos = workbookToSheetInfos(wb);
    expect(infos.map((item) => item.name)).toEqual(["Sheet 1", "Empty"]);
    expect(infos[1]?.html).toContain("（空工作表）");
  });
});
