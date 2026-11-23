import { describe, expect, it } from "vitest";
import {
  applyStructRoles,
  blocksToMarkdown,
  drawOpsToSegments,
  itemsToBlocks,
  itemsToMarkdown,
  isMonoFamily,
  joinCodeLine,
  mergeSplitTables,
  monoRatio,
  opListToDrawOps,
  structTreeToBlocks,
  type Block,
  type Line,
  type PdfDrawOp,
  type PdfStructNode,
  type PdfTextItem,
  type PdfTextStyle,
  type StructStreamEntry,
} from "../../src/services/pdf-to-markdown";

/** 测试用样式表：c1/c2 为等宽字体，f1 为比例字体。 */
const CODE_STYLES: Record<string, PdfTextStyle> = {
  c1: { fontFamily: "Courier" },
  c2: { fontFamily: "SourceCodePro-Regular" },
  f1: { fontFamily: "Helvetica" },
};

/** 等宽文本片段：字宽固定 6pt（width = 字符数 × 6），便于列对齐断言。 */
function codeItem(str: string, x: number, y: number, fontName = "c1"): PdfTextItem {
  return {
    str,
    transform: [0, 0, 0, 12, x, y],
    width: str.length * 6,
    height: 12,
    fontName,
  };
}

/** 构造一个文本片段：y 越大越靠上，size≈字号。 */
function item(str: string, x: number, y: number, size = 12, fontName = "f1"): PdfTextItem {
  return {
    str,
    transform: [0, 0, 0, size, x, y],
    width: str.length * size * 0.5,
    height: size,
    fontName,
  };
}

describe("itemsToMarkdown（几何回退）", () => {
  it("空输入返回空字符串", () => {
    expect(itemsToMarkdown([])).toBe("");
  });

  it("同一行按 x 排序拼接，英文片段间隙补空格", () => {
    // Hello 宽约 12.5，紧随其后的 world 从 x=14 开始（约一个词间距）
    const result = itemsToMarkdown([item("world", 14, 700, 5), item("Hello", 0, 700, 5)]);
    expect(result).toBe("Hello world");
  });

  it("中文相邻片段不插入空格", () => {
    const result = itemsToMarkdown([item("世界", 12, 700, 5), item("你好", 0, 700, 5)]);
    expect(result).toBe("你好世界");
  });

  it("按基线 y 从上到下排列成多行", () => {
    const result = itemsToMarkdown([item("第二行", 0, 680), item("第一行", 0, 700)]);
    expect(result).toBe("第一行\n第二行");
  });

  it("字号显著大于正文的行推断为标题", () => {
    const result = itemsToMarkdown([
      item("标题", 0, 720, 24),
      item("正文内容", 0, 700, 12),
      item("更多正文", 0, 680, 12),
    ]);
    expect(result).toBe("# 标题\n正文内容\n更多正文");
  });

  it("行间距明显偏大时插入空行分段", () => {
    const result = itemsToMarkdown([
      item("第一段", 0, 750, 12),
      item("第二段", 0, 700, 12),
    ]);
    expect(result).toBe("第一段\n\n第二段");
  });

  it("行首 '- ' 识别为无序列表", () => {
    const result = itemsToMarkdown([
      item("- 第一项", 0, 700, 12),
      item("- 第二项", 0, 680, 12),
    ]);
    expect(result).toBe("- 第一项\n- 第二项");
  });

  it("行首编号识别为列表", () => {
    const result = itemsToMarkdown([item("1. 步骤一", 0, 700, 12)]);
    expect(result).toBe("- 步骤一");
  });

  it("其他 Markdown 语法字符开头仍然转义", () => {
    const result = itemsToMarkdown([item("> 引用文本", 0, 700, 12)]);
    expect(result).toBe("\\> 引用文本");
  });

  it("fontFamily 含 Bold 时套用粗体标记", () => {
    const styles = { fb: { fontFamily: "Arial-BoldMT" } };
    expect(itemsToMarkdown([item("重点", 0, 700, 12, "fb")], styles)).toBe("**重点**");
  });

  it("fontFamily 含 Italic 时套用斜体标记", () => {
    const styles = { fi: { fontFamily: "Times-Italic" } };
    expect(itemsToMarkdown([item("强调", 0, 700, 12, "fi")], styles)).toBe("*强调*");
  });

  it("忽略空字符串片段", () => {
    const result = itemsToMarkdown([item("", 0, 700), item("内容", 0, 700)]);
    expect(result).toBe("内容");
  });
});

describe("itemsToBlocks 表格几何检测", () => {
  const tableItems = [
    // 第 1 行：两列，x 间隔明显
    item("姓名", 0, 700, 12),
    item("年龄", 100, 700, 12),
    // 第 2 行
    item("张三", 0, 680, 12),
    item("20", 100, 680, 12),
  ];

  it("连续多列行生成 table 块", () => {
    const blocks = itemsToBlocks(tableItems);
    expect(blocks.some((b) => b.kind === "table")).toBe(true);
  });

  it("渲染为 Markdown 表格", () => {
    const blocks = itemsToBlocks(tableItems);
    expect(blocksToMarkdown(blocks)).toBe(
      "| 姓名 | 年龄 |\n| --- | --- |\n| 张三 | 20 |",
    );
  });

  it("单元格内的竖线被转义", () => {
    const blocks = itemsToBlocks([
      item("A|B", 0, 700, 12),
      item("X", 100, 700, 12),
      item("C", 0, 680, 12),
      item("D", 100, 680, 12),
    ]);
    expect(blocksToMarkdown(blocks)).toContain("A\\|B");
  });

  it("单行多列退化为普通文本", () => {
    const blocks = itemsToBlocks([item("甲", 0, 700, 12), item("乙", 100, 700, 12)]);
    expect(blocks.some((b) => b.kind === "table")).toBe(false);
  });
});

/** 模拟 pdfjs 的 OPS 数值常量（仅本次用到的操作码）。 */
const OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  rectangle: 19,
  moveTo: 13,
  lineTo: 14,
  closePath: 18,
  stroke: 20,
  closeStroke: 21,
  fill: 22,
  eoFill: 23,
  fillStroke: 24,
  eoFillStroke: 25,
  closeFillStroke: 26,
  closeEOFillStroke: 27,
  endPath: 28,
  clip: 29,
  eoClip: 30,
  constructPath: 91,
};

describe("drawOpsToSegments（矢量框线提取）", () => {
  it("rectangle 展开为四条边", () => {
    const segments = drawOpsToSegments([
      { kind: "rect", x: 0, y: 0, width: 100, height: 50 },
    ]);
    expect(segments).toHaveLength(4);
    expect(segments[0]).toEqual({ x1: 0, y1: 0, x2: 100, y2: 0 });
  });

  it("应用 CTM 平移变换", () => {
    const segments = drawOpsToSegments([
      { kind: "transform", matrix: [1, 0, 0, 1, 50, 100] },
      { kind: "rect", x: 0, y: 0, width: 10, height: 10 },
    ]);
    expect(segments[0]).toEqual({ x1: 50, y1: 100, x2: 60, y2: 100 });
  });

  it("save/restore 恢复 CTM", () => {
    const segments = drawOpsToSegments([
      { kind: "save" },
      { kind: "transform", matrix: [1, 0, 0, 1, 50, 0] },
      { kind: "restore" },
      { kind: "rect", x: 0, y: 0, width: 10, height: 10 },
    ]);
    expect(segments[0]).toEqual({ x1: 0, y1: 0, x2: 10, y2: 0 });
  });

  it("moveTo/lineTo 路径在 flush(draw=true) 时输出边", () => {
    const segments = drawOpsToSegments([
      { kind: "moveTo", x: 0, y: 0 },
      { kind: "lineTo", x: 100, y: 0 },
      { kind: "flush", draw: true },
    ]);
    expect(segments).toEqual([{ x1: 0, y1: 0, x2: 100, y2: 0 }]);
  });

  it("clip 路径（draw=false）被丢弃", () => {
    const segments = drawOpsToSegments([
      { kind: "moveTo", x: 0, y: 0 },
      { kind: "lineTo", x: 100, y: 0 },
      { kind: "flush", draw: false },
    ]);
    expect(segments).toEqual([]);
  });
});

describe("opListToDrawOps（operator list 归一化）", () => {
  it("把 pdfjs 的 fnArray/argsArray 转为绘图操作", () => {
    const ops = opListToDrawOps(
      [OPS.transform, OPS.rectangle, OPS.stroke],
      [[1, 0, 0, 1, 10, 20], [0, 0, 50, 30], []],
      OPS,
    );
    expect(ops).toEqual([
      { kind: "transform", matrix: [1, 0, 0, 1, 10, 20] },
      { kind: "rect", x: 0, y: 0, width: 50, height: 30 },
      { kind: "flush", draw: true },
    ]);
  });

  it("解析 pdfjs 6 的 constructPath（扁平命令数组）", () => {
    const ops = opListToDrawOps(
      [OPS.constructPath],
      // [绘制操作码=stroke, 命令数组(moveTo→lineTo→closePath), bbox]
      [[OPS.stroke, [0, 10, 20, 1, 30, 20, 4], { 0: 10, 1: 20, 2: 30, 3: 20 }]],
      OPS,
    );
    expect(ops).toEqual([
      { kind: "moveTo", x: 10, y: 20 },
      { kind: "lineTo", x: 30, y: 20 },
      { kind: "closePath" },
      { kind: "flush", draw: true },
    ]);
  });

  it("constructPath 的 clip 路径被丢弃（draw=false）", () => {
    const ops = opListToDrawOps(
      [OPS.constructPath],
      [[OPS.clip, [0, 0, 0, 1, 10, 0], {}]],
      OPS,
    );
    expect(ops).toEqual([
      { kind: "moveTo", x: 0, y: 0 },
      { kind: "lineTo", x: 10, y: 0 },
      { kind: "flush", draw: false },
    ]);
  });
});

/** 构造一个 2×2 表格的框线：外框 + 一条中线竖线 + 一条中线横线。 */
function tableSegments(): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const ops: PdfDrawOp[] = [
    { kind: "rect", x: 0, y: 680, width: 200, height: 40 },
    { kind: "moveTo", x: 100, y: 680 },
    { kind: "lineTo", x: 100, y: 720 },
    { kind: "flush", draw: true },
    { kind: "moveTo", x: 0, y: 700 },
    { kind: "lineTo", x: 200, y: 700 },
    { kind: "flush", draw: true },
  ];
  return drawOpsToSegments(ops);
}

describe("itemsToBlocks（Lattice 框线表格）", () => {
  const cells = [
    item("姓名", 10, 710, 12),
    item("年龄", 110, 710, 12),
    item("张三", 10, 690, 12),
    item("20", 110, 690, 12),
  ];

  it("框线 + 文本重建为 Markdown 表格", () => {
    const blocks = itemsToBlocks(cells, {}, tableSegments());
    expect(blocksToMarkdown(blocks)).toBe(
      "| 姓名 | 年龄 |\n| --- | --- |\n| 张三 | 20 |",
    );
  });

  it("表格外的文本按位置保持在表格前后", () => {
    const items = [
      item("表格标题", 10, 760, 12),
      ...cells,
      item("表格后面的段落", 10, 640, 12),
    ];
    const md = blocksToMarkdown(itemsToBlocks(items, {}, tableSegments()));
    expect(md).toContain("表格标题");
    expect(md).toContain("表格后面的段落");
    const titleIdx = md.indexOf("表格标题");
    const tableIdx = md.indexOf("| 姓名");
    const afterIdx = md.indexOf("表格后面的段落");
    expect(titleIdx).toBeLessThan(tableIdx);
    expect(tableIdx).toBeLessThan(afterIdx);
  });

  it("无框线段时退化为几何检测（行为不变）", () => {
    const blocks = itemsToBlocks(cells, {}, []);
    expect(blocksToMarkdown(blocks)).toBe(
      "| 姓名 | 年龄 |\n| --- | --- |\n| 张三 | 20 |",
    );
  });

  it("框线存在但文本不在框内时不生成表格", () => {
    const outside = [item("正文", 300, 710, 12), item("更多", 300, 690, 12)];
    const md = blocksToMarkdown(itemsToBlocks(outside, {}, tableSegments()));
    expect(md).not.toContain("| --- |");
  });
});

describe("applyStructRoles（结构树优先）", () => {
  const blocks = itemsToBlocks([
    item("标题", 0, 720, 24),
    item("正文", 0, 700, 12),
  ]);

  it("无结构树时返回 null 以触发几何回退", () => {
    expect(applyStructRoles(blocks, null)).toBeNull();
  });

  it("无 H1-H6 role 时返回 null", () => {
    const tree: PdfStructNode = { role: "Document", children: [{ role: "P" }] };
    expect(applyStructRoles(blocks, tree)).toBeNull();
  });

  it("H2 role 覆盖标题层级", () => {
    const tree: PdfStructNode = {
      role: "Document",
      children: [{ role: "H2" }, { role: "P" }],
    };
    const result = applyStructRoles(blocks, tree);
    expect(result).not.toBeNull();
    expect(blocksToMarkdown(result!)).toBe("## 标题\n正文");
  });

  it("多个标题 role 按顺序应用", () => {
    const multi = itemsToBlocks([
      item("一级", 0, 740, 24),
      item("正文", 0, 720, 12),
      item("二级", 0, 700, 20),
    ]);
    const tree: PdfStructNode = {
      role: "Document",
      children: [{ role: "H1" }, { role: "P" }, { role: "H3" }],
    };
    expect(blocksToMarkdown(applyStructRoles(multi, tree)!)).toBe("# 一级\n正文\n### 二级");
  });
});

describe("structTreeToBlocks（结构树语义重建）", () => {
  const begin = (id: string | null): StructStreamEntry => ({ kind: "mc-begin", id });
  const end: StructStreamEntry = { kind: "mc-end" };
  const text = (str: string, x: number, y: number, size = 12): StructStreamEntry => ({
    kind: "text",
    item: item(str, x, y, size),
  });

  it("按树顺序生成标题/段落/表格/列表块，且层级精确", () => {
    const tree: PdfStructNode = {
      role: "Root",
      children: [
        { role: "H1", children: [{ type: "content", id: "c0" }] },
        { role: "H2", children: [{ type: "content", id: "c1" }] },
        { role: "P", children: [{ type: "content", id: "c2" }] },
        {
          role: "Table",
          children: [
            {
              role: "TR",
              children: [
                { role: "TD", children: [{ type: "content", id: "c3" }] },
                { role: "TD", children: [{ type: "content", id: "c4" }] },
              ],
            },
            {
              role: "TR",
              children: [
                { role: "TD", children: [{ type: "content", id: "c5" }] },
                { role: "TD", children: [{ type: "content", id: "c6" }] },
              ],
            },
          ],
        },
        {
          role: "L",
          children: [
            { role: "LI", children: [{ role: "LBody", children: [{ type: "content", id: "c7" }] }] },
            { role: "LI", children: [{ role: "LBody", children: [{ type: "content", id: "c8" }] }] },
          ],
        },
      ],
    };
    const stream: StructStreamEntry[] = [
      begin("c0"), text("标题甲", 0, 720, 20), end,
      begin("c1"), text("标题乙", 0, 700, 16), end,
      begin("c2"), text("正文段落", 0, 680), end,
      begin("c3"), text("表头一", 0, 640), end,
      begin("c4"), text("表头二", 100, 640), end,
      begin("c5"), text("数据一", 0, 620), end,
      begin("c6"), text("数据二", 100, 620), end,
      begin("c7"), text("列表项一", 0, 580), end,
      begin("c8"), text("列表项二", 0, 560), end,
    ];
    const blocks = structTreeToBlocks(tree, stream, {});
    expect(blocks).not.toBeNull();
    const md = blocksToMarkdown(blocks!);
    expect(md).toBe(
      [
        "# 标题甲",
        "",
        "## 标题乙",
        "",
        "正文段落",
        "",
        "| 表头一 | 表头二 |",
        "| --- | --- |",
        "| 数据一 | 数据二 |",
        "",
        "- 列表项一",
        "- 列表项二",
      ].join("\n"),
    );
  });

  it("单元格多行文本用 <br> 连接", () => {
    const tree: PdfStructNode = {
      role: "Root",
      children: [
        {
          role: "Table",
          children: [
            {
              role: "TR",
              children: [
                {
                  role: "TD",
                  children: [
                    { role: "P", children: [{ type: "content", id: "c0" }] },
                    { role: "P", children: [{ type: "content", id: "c1" }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const stream: StructStreamEntry[] = [
      begin("c0"), text("第一行", 0, 640), end,
      begin("c1"), text("第二行", 0, 620), end,
    ];
    const md = blocksToMarkdown(structTreeToBlocks(tree, stream, {})!);
    expect(md).toBe("| 第一行<br>第二行 |\n| --- |");
  });

  it("单元格内的列表项逐项保留", () => {
    const tree: PdfStructNode = {
      role: "Root",
      children: [
        {
          role: "Table",
          children: [
            {
              role: "TR",
              children: [
                {
                  role: "TD",
                  children: [
                    {
                      role: "L",
                      children: [
                        { role: "LI", children: [{ role: "LBody", children: [{ type: "content", id: "c0" }] }] },
                        { role: "LI", children: [{ role: "LBody", children: [{ type: "content", id: "c1" }] }] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const stream: StructStreamEntry[] = [
      begin("c0"), text("步骤一", 0, 640), end,
      begin("c1"), text("步骤二", 0, 620), end,
    ];
    const md = blocksToMarkdown(structTreeToBlocks(tree, stream, {})!);
    expect(md).toBe("| 步骤一<br>步骤二 |\n| --- |");
  });

  it("null id 的 marked content（页眉/页脚）被剔除", () => {
    const tree: PdfStructNode = {
      role: "Root",
      children: [{ role: "P", children: [{ type: "content", id: "c0" }] }],
    };
    const stream: StructStreamEntry[] = [
      begin(null), text("T/TAF 页眉", 0, 800), end,
      begin("c0"), text("正文", 0, 700), end,
      begin(null), text("页码 4", 300, 50), end,
    ];
    const md = blocksToMarkdown(structTreeToBlocks(tree, stream, {})!);
    expect(md).toBe("正文");
  });

  it("content 覆盖率低于 50% 时返回 null 以回退几何路径", () => {
    const tree: PdfStructNode = {
      role: "Root",
      children: [
        { role: "P", children: [{ type: "content", id: "c0" }] },
        { role: "P", children: [{ type: "content", id: "c1" }] },
        { role: "P", children: [{ type: "content", id: "c2" }] },
        { role: "P", children: [{ type: "content", id: "c3" }] },
      ],
    };
    const stream: StructStreamEntry[] = [begin("c0"), text("仅一条", 0, 700), end];
    expect(structTreeToBlocks(tree, stream, {})).toBeNull();
  });

  it("P 嵌套 Table 时，P 自身文本与表格各自独立生成", () => {
    const tree: PdfStructNode = {
      role: "Root",
      children: [
        {
          role: "P",
          children: [
            { type: "content", id: "c0" },
            {
              role: "Table",
              children: [
                { role: "TR", children: [{ role: "TD", children: [{ type: "content", id: "c1" }] }] },
              ],
            },
          ],
        },
      ],
    };
    const stream: StructStreamEntry[] = [
      begin("c0"), text("引导文字", 0, 700), end,
      begin("c1"), text("单元格", 0, 660), end,
    ];
    const md = blocksToMarkdown(structTreeToBlocks(tree, stream, {})!);
    expect(md).toBe("引导文字\n\n| 单元格 |\n| --- |");
  });

  it("单项纯条款编号列表并入紧随其后的段落首行（术语 3.1）", () => {
    const tree: PdfStructNode = {
      role: "Root",
      children: [
        { role: "H1", children: [{ type: "content", id: "c0" }] },
        { role: "P", children: [{ type: "content", id: "c1" }] },
        {
          role: "L",
          children: [
            { role: "LI", children: [{ role: "LBody", children: [{ type: "content", id: "c2" }] }] },
          ],
        },
        { role: "P", children: [{ type: "content", id: "c3" }] },
        { role: "P", children: [{ type: "content", id: "c4" }] },
      ],
    };
    const stream: StructStreamEntry[] = [
      begin("c0"), text("术语和定义", 0, 720, 20), end,
      begin("c1"), text("下列术语和定义适用于本文件。", 0, 700), end,
      begin("c2"), text("3.1", 0, 680), end,
      begin("c3"), text("以太无损交换机", 0, 660), end,
      // 宽行撑大页宽，避免段落合并干扰断言
      begin("c4"), text("填充行".repeat(20), 0, 640), end,
    ];
    const md = blocksToMarkdown(structTreeToBlocks(tree, stream, {})!);
    expect(md).toBe(
      [
        "# 术语和定义",
        "",
        "下列术语和定义适用于本文件。",
        "",
        "3.1 以太无损交换机",
        "",
        "填充行".repeat(20),
      ].join("\n"),
    );
  });

  it("多列表项的 L 不受条款编号吸收影响", () => {
    const tree: PdfStructNode = {
      role: "Root",
      children: [
        {
          role: "L",
          children: [
            { role: "LI", children: [{ role: "LBody", children: [{ type: "content", id: "c0" }] }] },
            { role: "LI", children: [{ role: "LBody", children: [{ type: "content", id: "c1" }] }] },
          ],
        },
        { role: "P", children: [{ type: "content", id: "c2" }] },
      ],
    };
    const stream: StructStreamEntry[] = [
      begin("c0"), text("[1] 参考文献一", 0, 700), end,
      begin("c1"), text("[2] 参考文献二", 0, 680), end,
      begin("c2"), text("后续段落", 0, 660), end,
    ];
    const md = blocksToMarkdown(structTreeToBlocks(tree, stream, {})!);
    expect(md).toBe("- [1] 参考文献一\n- [2] 参考文献二\n\n后续段落");
  });

  it("纯符号超短段落（装饰残留）不输出", () => {
    const tree: PdfStructNode = {
      role: "Root",
      children: [
        { role: "P", children: [{ type: "content", id: "c0" }] },
        { role: "P", children: [{ type: "content", id: "c1" }] },
        { role: "Figure", children: [{ type: "content", id: "c2" }] },
      ],
    };
    const stream: StructStreamEntry[] = [
      begin("c0"), text("*", 100, 400), end,
      begin("c1"), text("正文文本", 0, 700), end,
      begin("c2"), text("。", 100, 300), end,
    ];
    const md = blocksToMarkdown(structTreeToBlocks(tree, stream, {})!);
    expect(md).toBe("正文文本");
  });
});

describe("mergeSplitTables（跨页拆断表格合并）", () => {
  it("续页首行是表格中段行（首格标签与上表不同）时并入", () => {
    const pages: Block[][] = [
      [{ kind: "table", rows: [["测试编号", "21"]] }],
      [{ kind: "table", rows: [["测试项目", "吞吐率"], ["判定原则", "相符"]] }],
    ];
    mergeSplitTables(pages);
    expect(pages[0]).toHaveLength(1);
    expect(pages[1]).toHaveLength(0);
    const table = pages[0]![0]!;
    if (table.kind !== "table") throw new Error("应为表格块");
    expect(table.rows).toEqual([
      ["测试编号", "21"],
      ["测试项目", "吞吐率"],
      ["判定原则", "相符"],
    ]);
  });

  it("同模板相邻两张新表（首行标签相同）不合并", () => {
    const pages: Block[][] = [
      [{ kind: "table", rows: [["测试编号", "1"], ["判定原则", "相符"]] }],
      [{ kind: "table", rows: [["测试编号", "2"], ["判定原则", "相符"]] }],
    ];
    mergeSplitTables(pages);
    expect(pages[0]).toHaveLength(1);
    expect(pages[1]).toHaveLength(1);
  });

  it("重复表头行仍合并且去重", () => {
    const pages: Block[][] = [
      [{ kind: "table", rows: [["名称", "值"], ["甲", "1"]] }],
      [{ kind: "table", rows: [["名称", "值"], ["乙", "2"]] }],
    ];
    mergeSplitTables(pages);
    expect(pages[1]).toHaveLength(0);
    const table = pages[0]![0]!;
    if (table.kind !== "table") throw new Error("应为表格块");
    expect(table.rows).toEqual([
      ["名称", "值"],
      ["甲", "1"],
      ["乙", "2"],
    ]);
  });

  it("非表格首尾块不受影响", () => {
    const pages: Block[][] = [
      [{ kind: "paragraph", text: "段落" }],
      [{ kind: "table", rows: [["甲", "1"]] }],
    ];
    mergeSplitTables(pages);
    expect(pages[1]).toHaveLength(1);
  });
});

describe("blocksToMarkdown（编号列表续接）", () => {
  it("续接编号段落并入前置编号列表（参考文献 [3][4]）", () => {
    const blocks: Block[] = [
      { kind: "list", text: "[1] YD/T 1141—2022" },
      { kind: "list", text: "[2] YD/T 1628—2007" },
      { kind: "break" },
      { kind: "paragraph", text: "[3] IETF RFC 2544" },
      { kind: "paragraph", text: "[4] IETF RFC 2474" },
    ];
    expect(blocksToMarkdown(blocks)).toBe(
      "- [1] YD/T 1141—2022\n- [2] YD/T 1628—2007\n- [3] IETF RFC 2544\n- [4] IETF RFC 2474",
    );
  });

  it("编号不连续或前置非编号列表时不合并", () => {
    const blocks: Block[] = [
      { kind: "list", text: "[1] 条目一" },
      { kind: "break" },
      { kind: "paragraph", text: "[3] 跳号" },
      { kind: "break" },
      { kind: "list", text: "普通列表" },
      { kind: "break" },
      { kind: "paragraph", text: "[1] 重新编号" },
    ];
    expect(blocksToMarkdown(blocks)).toBe("- [1] 条目一\n\n[3] 跳号\n\n- 普通列表\n\n[1] 重新编号");
  });
});

/* ------------------------------------------------------------------ *
 * 代码块识别：等宽字体检测、列对齐重建、两路径识别
 * ------------------------------------------------------------------ */

describe("isMonoFamily / monoRatio（等宽字体检测）", () => {
  it("常见等宽字体命中，比例字体不命中", () => {
    expect(isMonoFamily("Courier")).toBe(true);
    expect(isMonoFamily("Courier New PS MT")).toBe(true);
    expect(isMonoFamily("Menlo")).toBe(true);
    expect(isMonoFamily("Consolas")).toBe(true);
    expect(isMonoFamily("SourceCodePro-Regular")).toBe(true);
    expect(isMonoFamily("Source Code Pro")).toBe(true);
    expect(isMonoFamily("DejaVu Sans Mono")).toBe(true);
    expect(isMonoFamily("Nimbus Mono PS")).toBe(true);
    expect(isMonoFamily("Helvetica")).toBe(false);
    expect(isMonoFamily("NotoSansSC-Regular")).toBe(false);
    expect(isMonoFamily(undefined)).toBe(false);
  });

  it("按字符数计占比（≥0.8 判为代码）", () => {
    expect(monoRatio([codeItem("abcd", 0, 700)], CODE_STYLES)).toBe(1);
    // 4 个等宽字符 + 5 个比例字符 = 4/9 ≈ 0.44
    const mixed = [codeItem("abcd", 0, 700), item("12345", 60, 700)];
    expect(monoRatio(mixed, CODE_STYLES)).toBeCloseTo(4 / 9);
  });
});

/** 由片段组装 Line（等价 normalize 的产出，带上 x/y/size）。 */
function codeLineOf(...items: PdfTextItem[]): Line {
  const positioned = items.map((it) => ({
    ...it,
    x: Number(it.transform[4]) || 0,
    y: Number(it.transform[5]) || 0,
    size: 12,
  }));
  return {
    y: Math.max(...positioned.map((i) => i.y)),
    size: 12,
    x: Math.min(...positioned.map((i) => i.x)),
    items: positioned,
  };
}

describe("joinCodeLine（列对齐重建）", () => {
  it("x 坐标换算列号，还原行内间距", () => {
    // 列布局：i n t _ _ x _ = _ 1 ;（字宽 6pt，x 坐标 = 列号 × 6）
    const line = codeLineOf(codeItem("int", 0, 700), codeItem("x", 30, 700), codeItem("= 1;", 42, 700));
    expect(joinCodeLine(line, 0)).toBe("int  x = 1;");
  });

  it("以页面左缘为基准保留行首缩进", () => {
    const line = codeLineOf(codeItem("return a;", 12, 690));
    expect(joinCodeLine(line, 0)).toBe("  return a;");
    // 不传基准时相对行内首个片段（无缩进）
    expect(joinCodeLine(line)).toBe("return a;");
  });

  it("字宽缺失时退化为空格拼接", () => {
    const line = codeLineOf(
      { str: "aa", transform: [0, 0, 0, 12, 0, 690], width: 0, height: 12, fontName: "c1" },
      { str: "bb", transform: [0, 0, 0, 12, 20, 690], width: 0, height: 12, fontName: "c1" },
    );
    expect(joinCodeLine(line, 0)).toBe("aa bb");
  });
});

describe("itemsToBlocks（代码块识别）", () => {
  it("连续等宽行合成代码块，周边正文保留", () => {
    const items = [
      item("正文段落一", 0, 700),
      codeItem("int main() {", 0, 680),
      codeItem("return 0;", 12, 668),
      codeItem("}", 0, 656),
      item("正文段落二", 0, 630),
    ];
    const md = blocksToMarkdown(itemsToBlocks(items, CODE_STYLES));
    expect(md).toBe("正文段落一\n```\nint main() {\n  return 0;\n}\n```\n\n正文段落二");
  });

  it("孤立单行等宽退化为普通段落", () => {
    const items = [
      item("正文段落一", 0, 700),
      codeItem("Version 1.2", 0, 680),
      item("正文段落二", 0, 660),
    ];
    const blocks = itemsToBlocks(items, CODE_STYLES);
    expect(blocks.some((b) => b.kind === "code")).toBe(false);
    expect(blocksToMarkdown(blocks)).toContain("Version 1.2");
  });

  it("代码行内大列隙不误判为表格", () => {
    const items = [
      codeItem("int a = 1;", 0, 680),
      codeItem("int b = 2;", 120, 680),
      codeItem("int c = 3;", 0, 668),
      codeItem("int d = 4;", 120, 668),
    ];
    const blocks = itemsToBlocks(items, CODE_STYLES);
    expect(blocks.some((b) => b.kind === "table")).toBe(false);
    const code = blocks.find((b) => b.kind === "code");
    expect(code).toBeDefined();
    expect((code as { text: string }).text).toBe(
      "int a = 1;          int b = 2;\nint c = 3;          int d = 4;",
    );
  });
});

describe("structTreeToBlocks（代码块识别）", () => {
  const begin = (id: string | null): StructStreamEntry => ({ kind: "mc-begin", id });
  const end: StructStreamEntry = { kind: "mc-end" };
  const cText = (str: string, x: number, y: number): StructStreamEntry => ({
    kind: "text",
    item: codeItem(str, x, y),
  });

  it("P 节点几乎全等宽 → 代码块（缩进保留），后续正文独立", () => {
    const tree: PdfStructNode = {
      role: "Root",
      children: [
        { role: "P", children: [{ type: "content", id: "c0" }] },
        { role: "P", children: [{ type: "content", id: "c1" }] },
      ],
    };
    const stream: StructStreamEntry[] = [
      begin("c0"),
      cText("int main() {", 72, 700),
      cText("return 0;", 84, 688),
      cText("}", 72, 676),
      end,
      begin("c1"),
      { kind: "text", item: item("正文段落", 72, 650) },
      end,
    ];
    const md = blocksToMarkdown(structTreeToBlocks(tree, stream, CODE_STYLES)!);
    expect(md).toBe("```\nint main() {\n  return 0;\n}\n```\n\n正文段落");
  });

  it("连续代码段（多个 P 节点）合并为一个代码块", () => {
    const tree: PdfStructNode = {
      role: "Root",
      children: [
        { role: "P", children: [{ type: "content", id: "c0" }] },
        { role: "P", children: [{ type: "content", id: "c1" }] },
      ],
    };
    const stream: StructStreamEntry[] = [
      begin("c0"), cText("line one", 72, 700), end,
      begin("c1"), cText("line two", 72, 688), end,
    ];
    const blocks = structTreeToBlocks(tree, stream, CODE_STYLES);
    expect(blocks).not.toBeNull();
    expect(blocks!.filter((b) => b.kind === "code")).toHaveLength(1);
    expect(blocksToMarkdown(blocks!)).toBe("```\nline one\nline two\n```");
  });

  it("混排字体（等宽 <0.8）保持普通段落", () => {
    const tree: PdfStructNode = {
      role: "Root",
      children: [{ role: "P", children: [{ type: "content", id: "c0" }] }],
    };
    const stream: StructStreamEntry[] = [
      begin("c0"),
      cText("abc", 72, 700),
      { kind: "text", item: item("def ghi jkl", 100, 700) },
      end,
    ];
    const blocks = structTreeToBlocks(tree, stream, CODE_STYLES);
    expect(blocks).not.toBeNull();
    expect(blocks!.some((b) => b.kind === "code")).toBe(false);
    expect(blocksToMarkdown(blocks!)).toContain("abc");
  });
});

describe("blocksToMarkdown（代码块渲染）", () => {
  it("围栏包裹，内部换行保留", () => {
    const blocks: Block[] = [
      { kind: "paragraph", text: "上文" },
      { kind: "break" },
      { kind: "code", text: "a = 1\nb = 2" },
      { kind: "break" },
      { kind: "paragraph", text: "下文" },
    ];
    expect(blocksToMarkdown(blocks)).toBe("上文\n\n```\na = 1\nb = 2\n```\n\n下文");
  });
});
