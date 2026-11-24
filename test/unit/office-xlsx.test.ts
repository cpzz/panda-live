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
    // 首行只有 2 个 td（A 合并占 B）
    const firstRow = info.html.split("</tr>")[0];
    expect(firstRow).not.toContain(">B</td>");
  });

  it("超过行列上限时截断并标记", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ]);
    const info = sheetToTableHtml(ws, { rows: 2, cols: 2 });
    expect(info.truncated).toBe(true);
    const rowCount = info.html.match(/<tr>/gu)?.length ?? 0;
    expect(rowCount).toBe(2);
    const cellsInFirstRow = (info.html.split("</tr>")[0] ?? "").match(/<td/gu)?.length ?? 0;
    expect(cellsInFirstRow).toBe(2);
  });

  it("列宽映射到 colgroup", () => {
    const ws = XLSX.utils.aoa_to_sheet([["A", "B"]]);
    ws["!cols"] = [{ wch: 20 }, { wch: 5 }];
    const info = sheetToTableHtml(ws);
    expect(info.html).toContain('<col style="width:140px" />');
    expect(info.html).toContain('<col style="width:35px" />');
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
