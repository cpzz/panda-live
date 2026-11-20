# Panda Live

[English](README.md) | 简体中文

Panda Live 是一个本地优先的桌面文档编辑器。源码与渲染结果实时同步，保存时保留文件原有编码与换行符，草稿与文档不会被上传。

## 主要特性

- **多种视图模式** —— 源码（CodeMirror 6）、所见即所得（ProseMirror，支持顶部块级格式工具栏与斜杠命令）、分栏、渲染预览与只读 Git 差异视图。
- **渲染态 Git 差异** —— 可对比当前缓冲区与指定提交，或两个提交之间。Markdown 以渲染结果对比，提供块级、词级与删除幽灵块标记；其他文本格式提供并排、带语法高亮的源码差异。
- **Git 兼容参数** —— `-w`（忽略空白）、`--ignore-blank-lines`（忽略空行）与 `--ignore-cr-at-eol`（忽略行尾 CR）各自独立开关。
- **Git 工作流** —— 侧栏「Git」提供更改 / 历史 / 比较三个视图：暂存、取消暂存、提交与 Amend、分支切换与创建、获取 / 拉取 / 推送、领先/落后提示，以及任意两个提交（或提交 ⇄ 工作区）之间的文件级比较。拉取策略、fetch prune、网络超时、自动刷新与默认对比基线可在 **设置 → Git** 中调整。
- **Markdown 渲染管线** —— GFM、Front Matter、数学公式（KaTeX）、语法高亮（Shiki）、MyST 指令（tab-set / grid）与 HTML 净化。
- **LaTeX 预览** —— 支持 Tectonic、latexmk 或 xelatex 编译，诊断汇入问题面板。
- **图表** —— PlantUML 与 Mermaid 预览，支持缓存、明暗主题与缩放查看：独立文件预览与文档内嵌图表都可在工具栏或 Ctrl +/-、Ctrl+滚轮缩放，支持复位到自然宽度。
- **图片预览** —— PNG、APNG、JPEG/JFIF、GIF、WebP、BMP、ICO、AVIF 以只读方式打开，支持与图表一致的缩放查看。
- **中英文双语界面** —— 中文与英文可随时切换。
- **桌面集成** —— 工作区侧栏、大纲、崩溃恢复草稿、最近文件、可安装的格式扩展。模式条按格式提供导出入口：Markdown 为 HTML / PDF 下拉，PlantUML / Mermaid 直接导出 SVG。

## 支持的格式

| 类型 | 格式 |
|---|---|
| 文档 | Markdown、纯文本、PDF（只读预览） |
| 标记 / 数学 | LaTeX（`.tex`）、MathML、HTML、XML、SVG |
| 图表 | PlantUML、Mermaid |
| 图片 | PNG、APNG、JPEG/JFIF、GIF、WebP、BMP、ICO、AVIF（只读预览） |
| 代码 | C/C++、Java、JavaScript/TypeScript、JSON、YAML、CSS、Python、SQL、PHP、Rust、C#、Go、Ruby、Kotlin、Swift、R、Scala、Shell、Dart、Lua、Perl、Objective-C、INI、TOML |

扩展还可以贡献额外的格式、预览与命令。

## 界面语言

界面内置简体中文与英文，可在 **设置 → 外观 → 界面语言** 中选择：

- **中文** —— 始终使用中文
- **English** —— 始终使用英文
- **跟随系统** —— 根据操作系统语言自动选择

语言偏好保存在应用数据目录的 `settings.json` 中。

## 快速开始

源码运行与构建的环境要求：

- Node.js 22 及以上、npm 10 及以上
- Git 可选（用于基于仓库的差异对比，需系统安装）
- Tectonic、latexmk 或 xelatex 可选（用于 LaTeX 编译）

```bash
npm install
npm run dev        # 启动 Electron 与 Vite 开发服务器
```

构建生产版本：

```bash
npm run build
npm run win        # 运行构建后的应用
npm run package    # 构建并生成当前平台的安装包
```

### 打包产物

`npm run package` 在 Windows 上生成：

- `release/Panda Live Setup <version>.exe` —— NSIS 安装包，单个文件即可分发；向导式安装，可选择安装目录，桌面与开始菜单快捷方式自动创建；
- `release/win-unpacked/Panda Live.exe` —— 免安装版，必须保留整个 `win-unpacked` 目录（含 DLL、locales 与 resources）。

打包版自带 Electron 运行时、应用代码与当前平台的 Tectonic 可执行文件，**目标机器无需安装 Node.js / npm**。仍需注意：

- **Git** 不内置，需系统安装 `git`，或在 **设置 → Git** 指定绝对路径 / `wsl git`；缺少 Git 时编辑与导出照常，差异退化为「上次保存」；
- **LaTeX** 内置 Tectonic，但首次编译需联网下载 TeX bundle（之后缓存），也可改用本地 latexmk / xelatex；
- **Electron 二进制下载**：`npm run package` 检测到本地二进制缺失时会自动下载（默认 GitHub 直连）；下载失败时先设置镜像再执行：
  ```powershell
  $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
  npm run package
  ```
- 安装包只针对打包时的平台生成。

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 启动 Electron 与 Vite 开发服务器 |
| `npm run build` | 类型检查并构建渲染层与主进程 |
| `npm run win` | 运行构建后的应用 |
| `npm run package` | 构建并生成当前平台安装包（缺失 Electron 二进制时自动下载，内置 Tectonic） |
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
scripts/         打包与构建辅助脚本
test/            单元测试与 Playwright 测试
doc/             设计文档
```

## 许可证

Apache-2.0
