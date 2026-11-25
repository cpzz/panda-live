# Panda Live UI 样式专业化方案

| 项目 | 内容 |
|---|---|
| 版本 | 0.2（已落地 · 合入 `src/styles/base.css`） |
| 日期 | 2026-11-25 |
| 范围 | **仅 UI 样式/材质/层次**，不改布局、不改功能、不改字号与配色 token |
| 基线 | 已完成字体控件优化与深色改蓝的真实 `dist/` 构建产物 |
| 关联 | `doc/ui-font-controls.md`、`doc/ui-dark-blue.md`（前两阶段已落地） |

> 本方案回答一个问题：在字体与配色已经优化过的前提下，继续从“样式”层面提升专业感，还能做什么？
>
> 结论：不重画布局、不换主题色，而是补足**边界、层次、聚焦和材质**四个维度，让工具栏/侧栏/标签/控件/弹层更像成熟的桌面 IDE，而不是一整片平面色块。

---

## 1. 证据来源（可复核）

| 证据 | 文件 | 说明 |
|---|---|---|
| 浅色现状 | `doc/ui-style-before.png` | 真实 `dist/index.html` + IPC 桩渲染的编辑态，1440×900 |
| 浅色优化后 | `doc/ui-style-after.png` | 同一页面追加 `doc/ui-style.css` 后截图 |
| 前后对比 | `doc/ui-style-compare.png` | 完整界面并排 + 工具栏/标签/侧栏局部放大 |
| 设置弹窗优化后 | `doc/ui-style-modal-after.png` | 真实设置对话框，检查浮层与表单控件 |
| 深色优化后 | `doc/ui-style-dark-after.png` | 深色主题下检查内高光与阴影是否过亮 |
| 覆盖样式 | `doc/ui-style.css` | 评审用覆盖层；规则已合入 `base.css`，此文件保留作回滚清单 |

渲染方式：无头浏览器加载真实构建产物 `dist/index.html`，注入等价 IPC 桩后等待应用完成初始化，因此截图中的 DOM、文案和布局均来自真实应用；仅追加评审用 CSS 覆盖层。

---

## 2. 现状问题（基于真实 base.css 观察）

### 2.1 框架层几乎全平面

`.toolbar`、`.sidebar`、`.tabstrip`、`.statusbar` 只靠 1px 边框分隔，区域之间没有微弱的高光/阴影层次。在浅色下显得单薄，在深色下边界容易糊在一起。

### 2.2 控件“可点性”主要靠背景变化

`.icon-button`、`.mode-button`、`.statusbar-button`、`.block-toolbar-button` 的 hover 只改变背景色。边框常态为 `1px solid transparent`，没有利用这 1px 建立明确的 hover 边界。

### 2.3 当前项强调方式单一

- `.tab-item.active` 只有顶部 2px 色条；
- `.tree-row.active` 只有背景色；
- `.sidebar-tab.active` 只有底部 2px 色条。

高密度界面下，当前项需要更强的“定位感”，但不能靠加粗边框或改尺寸（会导致布局位移）。

### 2.4 浮层缺少分层阴影

`.tab-menu`、`.input-popover`、`.toast`、`.modal` 统一使用同一个 `--shadow`。对话框与轻量菜单的层级没有拉开，弹窗背景也没有任何聚焦处理。

### 2.5 输入控件缺少材质感

设置面板、搜索框、块工具栏选择框等只有实底 + 边框，缺少轻微内凹与聚焦光环；键盘聚焦时部分控件只改边框颜色，辨识度有限。

---

## 3. 设计原则

1. **零布局位移**：冻结 `width / height / padding / margin / gap / flex / grid / position`，只改视觉属性。
2. **不重复前两阶段**：不改字号、字重、圆角、主题色、前景色；只做层次与材质。
3. **用内阴影代替外扩边框**：避免任何 1px 的尺寸变化。
4. **明暗主题各一套 token**：浅色用柔和灰蓝阴影，深色用更高透明度黑影 + 极弱白色内高光。
5. **可独立回滚**：所有规则集中在 `doc/ui-style.css` 覆盖层，评审通过后再合入 `base.css`。

---

## 4. 改动清单

### 4.1 新增样式 token

| Token | 用途 | 浅色 | 深色 |
|---|---|---|---|
| `--elev-1` | 交互控件轻投影 | 双层低透明灰蓝 | 黑影 + 1px 白色内高光 |
| `--elev-2` | 菜单/气泡/浮层 | 12px 扩散阴影 | 16px 扩散阴影 |
| `--elev-3` | 对话框 | 22px 扩散阴影 | 24px 扩散阴影 |
| `--surface-hi` | 控件顶部内高光 | `rgba(255,255,255,.72)` | `rgba(255,255,255,.06)` |
| `--surface-line` | 面板顶部发丝高光 | 同上 | 同上 |
| `--field-inset` | 输入框内凹 | 浅灰内阴影 | 黑色内阴影 |
| `--focus-halo` | 聚焦光环 | `0 0 0 3px var(--focus-ring)` | 同左，跟随蓝色焦点环 |

### 4.2 工作台框架

| 选择器 | 改动 | 视觉效果 |
|---|---|---|
| `.toolbar` / `.sidebar` / `.tabstrip` / `.statusbar` | 加 `inset 0 1px 0 var(--surface-line)` | 面板顶部出现 1px 发丝高光，层叠感增强 |

> **不碰背景色本体**，因此不会破坏上一阶段完成的“Windows 系统标题栏与工具栏同色”效果。

### 4.3 控件

| 选择器 | 改动 | 视觉效果 |
|---|---|---|
| `.button`、`.icon-button`、`.mode-button`、`.statusbar-button`、`.block-toolbar-button`、`.tab-close`、`.tree-action`、`.find-toggle`、`.toast-close` 等 | 仅把 hover 时的透明边框显影为 `var(--border)`，并加 `--elev-1` + 内高光 | 鼠标悬停时有明确的按键边界，不再只是变色 |
| 同类控件的 active | 加 `--field-inset` | 按下时有“陷入”反馈 |
| `.button.primary` | `--elev-1` + 内高光；hover 升到 `--elev-2` | 主按钮从纯色块变成有层次的实体 |
| `.mode-switch` | 边框显影 + `--field-inset` | 模式切换器像一个真实的分段控件 |
| `.mode-button.active` / `.icon-button.active` / `.statusbar-button.active` | 加内高光/轻投影 | 选中态更立体 |

### 4.4 标签与目录树

| 选择器 | 改动 | 视觉效果 |
|---|---|---|
| `.tab-item:hover:not(.active)` | `inset 0 -1px 0 var(--border-strong)` | 悬停标签底部出现发丝线 |
| `.tab-item.active` | 保留顶部 2px 主色条，增加底部 1px 分隔线 | 活动标签与内容区连接更自然 |
| `.sidebar-tab.active` | 加顶部内高光 | 侧栏标签不再只是色块 |
| `.tree-row:hover` | `inset 2px 0 0 var(--border-strong)` | 悬停行有左侧定位线 |
| `.tree-row.active` | `inset 2px 0 0 var(--accent)` | 当前文件有明确主色定位线 |

### 4.5 输入控件

| 选择器组 | 改动 | 视觉效果 |
|---|---|---|
| `.search-input`、设置面板 input/select/textarea、`.input-popover-input`、`.block-toolbar-select`、`.files-folder-select`、Git/跳转/提示符输入等 | 加 `--field-inset` | 输入框有轻微内凹材质 |
| 上述控件的 focus | 边框改 `var(--accent)`，追加 `--focus-halo`，去掉默认 outline | 键盘聚焦更醒目，且不产生位移 |

### 4.6 浮层与对话框

| 选择器 | 改动 | 视觉效果 |
|---|---|---|
| `.tab-menu` / `.input-popover` / `.notice-popover` / `.statusbar-popover` / `.slash-menu` / `.source-search-panel` / `.toast` | 边框显影 + `--elev-2` + 顶部内高光 | 菜单和气泡从工作台上“浮起” |
| `.modal` | `--elev-3` + 顶部内高光 | 对话框成为明确的最高层级 |
| `.modal-backdrop` | `rgba(10,12,14,.48)` + `backdrop-filter: blur(2px)` | 背景轻微虚化，聚焦对话框 |
| `.modal-header` / `.modal-footer` | 顶部内高光 | 对话框上下区域有材质分隔 |

### 4.7 细节

| 选择器 | 改动 | 视觉效果 |
|---|---|---|
| `.notice-badge` / `.sidebar-rail-badge` / `.sidebar-tab-badge` | 轻投影 + 内高光 | 徽标不再像贴纸 |
| `::-webkit-scrollbar-thumb:hover/:active` | hover 用 `--border-strong`，active 用 `--accent` | 滚动条交互反馈更明确 |

---

## 5. 零布局位移验证

在真实构建产物上，同一页面分别测量追加覆盖层前后各元素的 `x / y / width / height / borderTopWidth`：

| 场景 | 测量元素 | 结果 |
|---|---|---|
| 浅色主界面 | 6 个结构区域 + 10 个关键控件 | 全部 `0 0 0 0 0` |
| 浅色设置弹窗 | 弹窗/头/脚/导航/面板/设置行/输入框 | 全部 `0 0 0 0 0` |
| 深色主界面 | 6 个结构区域 + 10 个关键控件 | 全部 `0 0 0 0 0` |

结论：本方案只改变视觉属性，未产生任何几何或边框宽度变化。

合入 `base.css` 后重新构建并用同一 IPC 桩复核：浅色与深色的计算样式均已生效（面板内高光、活动标签双内阴影、目录树主色定位线、明暗主题 token 各自正确），截图与评审稿一致。

---

## 6. 主题适配

- **浅色**：以低透明灰蓝阴影为主，内高光较强，保持干净、克制。
- **深色**：阴影透明度更高，内高光降至 4%~6%，避免“发白”和荧光感。
- 主色、前景色、背景色均沿用已落地 token，因此浅色仍是深绿主色，深色仍是蓝色主色。

---

## 7. 落地方式（已完成）

1. 已将 `doc/ui-style.css` 的 token 与规则原样合入 `src/styles/base.css` 末尾（新增 211 行）；未新增 CSS 文件、未改任何 TSX。
2. 验证通过：`lint`、`test`（42 个测试文件，355 通过 / 1 跳过）、`typecheck`、`vite build`。
3. 用同一 IPC 桩在真实构建产物上复核浅色与深色界面，计算样式生效、视觉与评审稿一致。

---

## 8. 回滚

已合入后：删除 `src/styles/base.css` 末尾「UI 样式专业化（视觉层，零布局位移）」整段即可完全回滚，不影响功能与布局；`doc/ui-style.css` 保留作逐条对照清单。
