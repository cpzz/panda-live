# Panda Live

[English](README.md) | 简体中文

Panda Live 是一个本地优先的桌面文档编辑器。源码与渲染结果实时同步，保存时保留文件原有编码与换行符，草稿与文档不会被上传。

## 主要特性

- **多种视图模式** —— 源码（CodeMirror 6）、所见即所得（ProseMirror，支持顶部块级格式工具栏与斜杠命令）、分栏、渲染预览与只读 Git 差异视图。
- **渲染态 Git 差异** —— 可对比当前缓冲区与指定提交，或两个提交之间。Markdown 以渲染结果对比，提供块级、词级与删除幽灵块标记；其他文本格式提供并排、带语法高亮的源码差异。
- **Git 兼容参数** —— `-w`（忽略空白）、`--ignore-blank-lines`（忽略空行）与 `--ignore-cr-at-eol`（忽略行尾 CR）各自独立开关。
- **Markdown 渲染管线** —— GFM、Front Matter、数学公式（KaTeX）、语法高亮（Shiki）与 HTML 净化。
- **LaTeX 预览** —— 支持 Tectonic、latexmk 或 xelatex 编译，诊断汇入问题面板。
- **图表** —— PlantUML 与 Mermaid 预览，支持缓存、明暗主题与缩放查看：独立文件预览与文档内嵌图表都可在工具栏或 Ctrl +/-、Ctrl+滚轮缩放，支持复位到自然宽度。
- **图片预览** —— PNG、JPEG、GIF、WebP、BMP 以只读方式打开，支持与图表一致的缩放查看。
- **中英文双语界面** —— 中文与英文可随时切换。
- **桌面集成** —— 工作区侧栏、大纲、崩溃恢复草稿、最近文件、HTML/PDF/SVG 导出与可安装的格式扩展。

## 支持的格式

| 类型 | 格式 |
|---|---|
| 文档 | Markdown、纯文本、PDF（只读预览） |
| 标记 / 数学 | LaTeX（`.tex`）、MathML、HTML、XML |
| 图表 | PlantUML、Mermaid |
| 图片 | PNG、JPEG、GIF、WebP、BMP（只读预览） |
| 代码 | C/C++、Java、JavaScript/TypeScript、JSON、YAML、CSS、Python、SQL、PHP、Rust、C#、Go、Ruby、Kotlin、Swift、R、Scala、Shell、Dart、Lua、Perl、Objective-C、INI、TOML |

扩展还可以贡献额外的格式、预览与命令。

## 界面语言

界面内置简体中文与英文。点击工具栏的语言图标即可即时切换，也可以在 **设置 → 外观 → 界面语言** 中选择：

- **中文** —— 始终使用中文
- **English** —— 始终使用英文
- **跟随系统** —— 根据操作系统语言自动选择

语言偏好保存在应用数据目录的 `settings.json` 中。

## 快速开始

环境要求：

- Node.js 22 及以上、npm 10 及以上
- Git 可选（用于基于仓库的差异对比）
- Tectonic、latexmk 或 xelatex 可选（用于 LaTeX 编译）

```bash
npm install
npm run dev        # 启动 Electron 与 Vite 开发服务器
```

构建生产版本：

```bash
npm run build
npm run win        # 运行构建后的应用
npm run package    # 生成安装包
```

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 启动 Electron 与 Vite 开发服务器 |
| `npm run build` | 类型检查并构建渲染层与主进程 |
| `npm test` | 运行单元测试（Vitest） |
| `npm run test:e2e` | 运行 Playwright 端到端测试 |
| `npm run lint` | 使用 ESLint 检查 |
| `npm run typecheck` | 仅做类型检查 |
| `npm run verify` | 依次执行 lint、单元测试与构建 |

## 目录结构

```
electron/        主进程：窗口、IPC、文件、Git、LaTeX、扩展
src/app/         React 界面：工具栏、编辑区、对话框与面板
src/i18n/        界面翻译（中文源文案 + 英文 JSON 词典）
src/diff/        行/词差异、预览模型与源码行标记
src/editor/      ProseMirror 所见即所得编辑器
src/source/      CodeMirror 源码编辑器与语言支持
src/formats/     Markdown/LaTeX/图表解析与序列化
src/render/      渲染管线、图表服务与导出辅助
src/services/    文档管理、设置、工作区、搜索与草稿
src/shared/      共享类型与 IPC 契约
test/            单元测试与 Playwright 测试
doc/             设计文档
```

## 许可证

Apache-2.0
