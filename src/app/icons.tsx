import type { ReactNode, SVGProps } from "react";
import type { OutlineSymbol } from "../formats/outline";

/*
 * 图标参考 markdown-viewer 的 Lucide 图标：24×24 viewBox、描边 2px。
 * 保持同一套线性风格，便于在两个应用中辨识。
 */
const ICONS = {
  /** 侧栏可见：面板 + 向左收起箭头 */
  "sidebar-close": (
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="m16 15-3-3 3-3" />
    </>
  ),
  /** 侧栏隐藏：面板 + 向右展开箭头 */
  "sidebar-open": (
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="m14 9 3 3-3 3" />
    </>
  ),
  file: (
    <>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
    </>
  ),
  /** 文本/Markdown 文档 */
  "file-text": (
    <>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M9 13h6" />
      <path d="M9 17h6" />
    </>
  ),
  /** LaTeX / MathML 等代码型文档 */
  "file-code": (
    <>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="m10 13-2 2 2 2" />
      <path d="m14 13 2 2-2 2" />
    </>
  ),
  /** PDF 文档：文件轮廓 + 字母 P */
  "file-pdf": (
    <>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M9 18v-6h2.5a1.75 1.75 0 0 1 0 3.5H9" />
    </>
  ),
  /** Markdown 导出：文件轮廓 + 字母 M + 导出箭头 */
  "file-markdown": (
    <>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M9 18v-6l2 3.2 2-3.2v6" />
      <path d="M17 12v6" />
      <path d="M14.5 15.5 17 18l2.5-2.5" />
    </>
  ),
  /** Word 文档：文件轮廓 + 字母 W */
  "file-word": (
    <>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M8 12l1.3 6 1.7-3.4L12.7 18 14 12" />
    </>
  ),
  /** Excel 表格：文件轮廓 + 字母 X */
  "file-excel": (
    <>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M9 12l6 6" />
      <path d="M15 12l-6 6" />
    </>
  ),
  /** PowerPoint 演示：文件轮廓 + 演示屏与播放三角 */
  "file-pptx": (
    <>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M7.5 12h9v5.5h-9z" />
      <path d="M11 13.6v2.3l2-1.15z" />
    </>
  ),
  /** HTML 文档：文件轮廓 + 尖括号与斜线 */
  "file-html": (
    <>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="m9.5 13-1.8 2 1.8 2" />
      <path d="m14.5 13 1.8 2-1.8 2" />
      <path d="m12.8 12.2-0.6 6" />
    </>
  ),
  /** PlantUML / Mermaid 图表文档 */
  diagram: (
    <>
      <rect x="3" y="3" width="6" height="5" rx="1" />
      <rect x="15" y="16" width="6" height="5" rx="1" />
      <path d="M6 8v4a3 3 0 0 0 3 3h4" />
      <path d="m11 13 2 2-2 2" />
    </>
  ),
  "file-plus": (
    <>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M9 15h6" />
      <path d="M12 18v-6" />
    </>
  ),
  /** 加入（Git 暂存）：独立的加号，避免与「新建文件」共用 file-plus。 */
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  /** 移出（Git 取消暂存）：与 plus 成对的减号。 */
  minus: (
    <path d="M5 12h14" />
  ),
  folder: (
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  ),
  "folder-open": (
    <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
  ),
  "folder-plus": (
    <>
      <path d="M12 10v6" />
      <path d="M9 13h6" />
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </>
  ),
  save: (
    <>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  /** 导出：下载到本地。 */
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="15" y2="3" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 16h5v5" />
    </>
  ),
  /** 拉取：从远程下载引用与提交（git pull）。 */
  "cloud-download": (
    <>
      <path d="M12 13v8" />
      <path d="m8 17 4 4 4-4" />
      <path d="M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284" />
    </>
  ),
  /** 推送：向远程上传引用（git push）。 */
  "cloud-upload": (
    <>
      <path d="M12 21v-8" />
      <path d="m8 17 4-4 4 4" />
      <path d="M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284" />
    </>
  ),
  pencil: (
    <>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" x2="10" y1="11" y2="17" />
      <line x1="14" x2="14" y1="11" y2="17" />
    </>
  ),
  reveal: (
    <>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </>
  ),
  copy: (
    <>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </>
  ),
  close: (
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>
  ),
  /** 成功结果：同步完成的状态图标。 */
  check: <path d="M20 6 9 17l-5-5" />,
  /** 风险警示：强制推送的风险提示。 */
  "alert-triangle": (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
  "chevron-up": <polyline points="18 15 12 9 6 15" />,
  "chevron-down": <polyline points="6 9 12 15 18 9" />,
  "chevron-left": <path d="m15 18-6-6 6-6" />,
  "chevron-right": <path d="m9 18 6-6-6-6" />,
  /** PDF 预览工具栏 */
  "zoom-in": (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
      <path d="M11 8v6" />
      <path d="M8 11h6" />
    </>
  ),
  "zoom-out": (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
      <path d="M8 11h6" />
    </>
  ),
  /** 图表查看工具栏：最大化 / 还原 / 适配宽度 */
  maximize: (
    <>
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </>
  ),
  minimize: (
    <>
      <path d="M4 14h6v6" />
      <path d="M20 10h-6V4" />
      <path d="m14 10 7-7" />
      <path d="m3 21 7-7" />
    </>
  ),
  /** Git 面板：重置改动 */
  reset: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
  /** 缩放工具栏：默认显示（1:1 实际尺寸），用比例字标替代晦涩的旗形。 */
  "default-view": (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <text
        x="12"
        y="15.6"
        textAnchor="middle"
        fontSize="8.5"
        fontWeight="700"
        fill="currentColor"
        stroke="none"
      >
        1:1
      </text>
    </>
  ),
  /** 缩放工具栏：页宽显示（页面边界内的横向双箭头） */
  "fit-width": (
    <>
      <path d="M4 5h16" />
      <path d="M4 19h16" />
      <path d="M7 12h10" />
      <path d="m10 9-3 3 3 3" />
      <path d="m14 9 3 3-3 3" />
    </>
  ),
  /** 固定标签的图钉（Lucide pin） */
  pin: (
    <>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </>
  ),
  /** 普通列表（标签溢出菜单等） */
  list: (
    <>
      <path d="M3 5h18" />
      <path d="M3 12h18" />
      <path d="M3 19h18" />
    </>
  ),
  /** 大纲/目录树：层级缩进 + 节点圆点，与平面列表区分。 */
  "list-tree": (
    <>
      <path d="M3 6h18" />
      <path d="M7 12h14" />
      <path d="M7 18h14" />
      <circle cx="4" cy="12" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="4" cy="18" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  "more-vertical": (
    <>
      <path d="M12 5h.01" />
      <path d="M12 12h.01" />
      <path d="M12 19h.01" />
    </>
  ),
  "arrow-up": (
    <>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </>
  ),
  "arrow-down": (
    <>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </>
  ),
  replace: (
    <>
      <path d="M14 4a1 1 0 0 1 1-1" />
      <path d="M15 10a1 1 0 0 1-1-1" />
      <path d="M21 4a1 1 0 0 0-1-1" />
      <path d="M21 9a1 1 0 0 1-1 1" />
      <path d="m3 7 3 3 3-3" />
      <path d="M6 10V5a2 2 0 0 1 2-2h2" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </>
  ),
  "replace-all": (
    <>
      <path d="M14 14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1" />
      <path d="M14 4a1 1 0 0 1 1-1" />
      <path d="M15 10a1 1 0 0 1-1-1" />
      <path d="M19 14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1" />
      <path d="M21 4a1 1 0 0 0-1-1" />
      <path d="M21 9a1 1 0 0 1-1 1" />
      <path d="m3 7 3 3 3-3" />
      <path d="M6 10V5a2 2 0 0 1 2-2h2" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </>
  ),
  code: (
    <>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </>
  ),
  split: (
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M12 3v18" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </>
  ),
  activity: (
    <>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </>
  ),
  /** 性能浮层：仪表盘 + 指针，比心电线更贴近性能指标语义。 */
  gauge: (
    <>
      <path d="M3 18a9 9 0 0 1 18 0" />
      <path d="M12 18l4-7" />
      <circle cx="12" cy="18" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  /** 分支本身：两个提交节点 + 分叉线，用于「本地分支」标签。 */
  branch: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="7" r="2.5" />
      <path d="M6 8.5v7" />
      <path d="M18 9.5c0 3.5-3.6 4.2-7.4 4.9" />
    </>
  ),
  git: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <path d="M6 8.5v7" />
      <path d="M18 10.5c0 3.2-3.5 3.6-7 4" />
    </>
  ),
  /** 设置远程地址：本地仓库与远程地址之间的连接（链）。 */
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </>
  ),
  compare: (
    <>
      <rect x="3" y="4" width="7" height="16" rx="1" />
      <rect x="14" y="4" width="7" height="16" rx="1" />
      <path d="M5 8h3M5 12h3M5 16h3" />
      <path d="M16 8h3M16 12h3M16 16h3" />
    </>
  ),
  /** 文档差异开关：左侧减号、右侧加号，与「对比视图」的双栏 compare 区分。 */
  diff: (
    <>
      <path d="M4 4v16" />
      <path d="M20 4v16" />
      <path d="M7 9h4" />
      <path d="M13 15h4" />
      <path d="M15 13v4" />
    </>
  ),
  /* 预览对比：diff 加减号（上一行新增、下一行删除），与「预览」眼睛图标区分。 */
  previewDiff: (
    <>
      <path d="M2.5 8h5M5 5.5v5" />
      <path d="M12 8h9" />
      <path d="M2.5 16h5" />
      <path d="M12 16h9" />
    </>
  ),
  whitespace: (
    <>
      <path d="M4 6h16" />
      <path d="M4 10h8" />
      <circle cx="6.5" cy="15" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10.5" cy="15" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="15" r="0.9" fill="currentColor" stroke="none" />
      <path d="M4 20h16" />
    </>
  ),
  blankLines: (
    <>
      <path d="M4 5h16" />
      <path d="M4 9h16" />
      <path d="M4 14h16" strokeDasharray="2 3" />
      <path d="M4 19h16" />
    </>
  ),
  carriageReturn: (
    <>
      <path d="M20 5v6a3 3 0 0 1-3 3H7" />
      <path d="m11 10-4 4 4 4" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

const TEXT_FILE_EXT = /\.(md|markdown|mdown|mkd|qmd|rmd|mdx|myst|mst|adoc|txt)$/i;
const CODE_FILE_EXT = /\.(tex|latex|mml|mathml)$/i;
const DIAGRAM_FILE_EXT = /\.(puml|plantuml|mmd|mermaid)$/i;
const PDF_FILE_EXT = /\.pdf$/i;
const WORD_FILE_EXT = /\.(docx|docm|dotx|dotm|doc)$/i;
const EXCEL_FILE_EXT = /\.(xlsx|xlsm|xlsb|xls)$/i;
const PPTX_FILE_EXT = /\.(pptx|pptm|potx|potm|ppt)$/i;

/** 按文件扩展名挑选标签页/文件树使用的文档图标。 */
export function fileIconForPath(filePath: string | null | undefined): IconName {
  if (!filePath) return "file";
  if (PDF_FILE_EXT.test(filePath)) return "file-pdf";
  if (WORD_FILE_EXT.test(filePath)) return "file-word";
  if (EXCEL_FILE_EXT.test(filePath)) return "file-excel";
  if (PPTX_FILE_EXT.test(filePath)) return "file-pptx";
  if (DIAGRAM_FILE_EXT.test(filePath)) return "diagram";
  if (CODE_FILE_EXT.test(filePath)) return "file-code";
  if (TEXT_FILE_EXT.test(filePath)) return "file-text";
  return "file";
}

/**
 * 具体语法类型 → 英文首字母，用于「文件图标 + 字母」组合标记。
 * 例如 类 → C、枚举 → E、函数 → F。未知类型留空，只显示文件轮廓。
 */
const OUTLINE_SYMBOL_LETTERS: Record<OutlineSymbol, string> = {
  标题: "H",
  类: "C",
  结构体: "S",
  接口: "I",
  枚举: "E",
  命名空间: "N",
  模块: "M",
  包: "P",
  特质: "T",
  实现: "I",
  类型别名: "T",
  记录: "R",
  混入: "X",
  协议: "P",
  扩展: "X",
  注解: "A",
  单例对象: "O",
  函数: "F",
  方法: "M",
  构造函数: "C",
  子程序: "S",
  键: "K",
  节: "S",
  标签: "T",
  选择器: "S",
  "@ 规则": "R",
  表: "T",
  视图: "V",
  索引: "I",
  存储过程: "P",
  触发器: "T",
  数据库: "D",
  序列: "Q",
  图: "G",
  子图: "G",
  参与者: "A",
  图标题: "T",
};

/**
 * 大纲子项图标：文件轮廓 + 类型英文首字母（类 → C、枚举 → E）。
 * 用 text 元素叠加字母，避免为 37 种类型各画一套 SVG 路径。
 */
export function OutlineSymbolIcon({
  symbol,
  size = 13,
  ...props
}: { symbol: OutlineSymbol; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  const letter = OUTLINE_SYMBOL_LETTERS[symbol] ?? "";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      {letter && (
        <text
          x="11"
          y="16.5"
          textAnchor="middle"
          fontSize="9"
          fontWeight="700"
          fill="currentColor"
          stroke="none"
        >
          {letter}
        </text>
      )}
    </svg>
  );
}

/** 熊猫品牌标识：纯 SVG，可随尺寸缩放，浅色/深色下均可见。 */
export function PandaMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8.4" cy="9" r="5.4" fill="#2f353b" />
      <circle cx="23.6" cy="9" r="5.4" fill="#2f353b" />
      <circle cx="16" cy="17.8" r="11.2" fill="#ffffff" stroke="#c9d1d8" strokeWidth="0.9" />
      <ellipse cx="11.3" cy="16.3" rx="3.4" ry="4.3" transform="rotate(-18 11.3 16.3)" fill="#2f353b" />
      <ellipse cx="20.7" cy="16.3" rx="3.4" ry="4.3" transform="rotate(18 20.7 16.3)" fill="#2f353b" />
      <circle cx="11.9" cy="15.6" r="1.2" fill="#ffffff" />
      <circle cx="20.1" cy="15.6" r="1.2" fill="#ffffff" />
      <ellipse cx="16" cy="20.5" rx="2" ry="1.5" fill="#2f353b" />
      <path
        d="M13.6 22.6c.9 1.1 1.7 1.5 2.4 1.5s1.5-.4 2.4-1.5"
        fill="none"
        stroke="#2f353b"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Icon({
  name,
  size = 16,
  ...props
}: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {ICONS[name]}
    </svg>
  );
}
