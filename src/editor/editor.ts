import { EditorState, TextSelection, type Command, type Transaction } from "prosemirror-state";
import {
  DOMParser as PMDOMParser,
  Fragment,
  Slice,
  type Mark,
  type MarkType,
  type Node as PMNode,
} from "prosemirror-model";
import { EditorView } from "prosemirror-view";
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  cellAround,
  deleteColumn,
  deleteRow,
  deleteTable,
  TableMap,
} from "prosemirror-tables";
import { BlockToolbar, createBlockActions } from "./block-toolbar";
import { InputPopover } from "./input-popover";
import { sanitizePastedHtml } from "./paste";
import { SlashMenu } from "./slash-menu";
import { markdownSchema } from "./schema";
import { MathNodeView } from "./nodeviews/math";
import { MathmlNodeView } from "./nodeviews/mathml";
import { DiagramNodeView } from "./nodeviews/diagram";
import { ImageNodeView, type ImageResolveResult } from "./nodeviews/image";
import { CodeBlockNodeView } from "./nodeviews/code-block";
import { GridNodeView, TabSetNodeView } from "./nodeviews/directive";
import type { PMJson } from "./schema";
import { createWysiwygState } from "./state";
import { wysiwygDiffKey } from "./plugins/diff";
import { anchorHighlightKey } from "./plugins/anchor";
import type { WysiwygDiffModel } from "../diff/wysiwyg";
import {
  clearSearch,
  findNextMatch,
  getSearchState,
  replaceAllMatches,
  replaceCurrentMatch,
  setSearch,
} from "./search";
import type { SearchOptions } from "../services/search";
import { createSlugger } from "../shared/slug";
import { parseMarkdown } from "../formats/markdown/parse";
import { t } from "../i18n";

export interface PandaEditorOptions {
  parent: HTMLElement;
  docJson: PMJson;
  readOnly: boolean;
  /** 所属文档 ID，用于把节点级诊断汇入问题面板。 */
  documentId: string;
  /** 文档变化后回调 ProseMirror JSON；序列化由调用方负责。 */
  onChange(docJson: PMJson): void;
  /** 轻量提示（如当前位置不支持插入代码块）；不打断编辑。 */
  onNotice?(message: string): void;
  /** 纯文本粘贴时按 Markdown 解析（读取当前设置值）。 */
  pasteAsMarkdown?: () => boolean;
  /** 粘贴/拖入的图片写入文档目录 assets/，返回 Markdown 中使用的相对路径。 */
  onImportImage?: (file: { data: Uint8Array; mime: string; fileName: string }) => Promise<string | null>;
  /** 把图片 src 解析为可直接显示的地址（相对路径 → data URL）；返回 null 表示保持原值。 */
  resolveImage?: (src: string) => Promise<ImageResolveResult | null>;
  /** 块级工具栏的挂载容器（模式条左侧）；为空时挂在编辑器上方。 */
  toolbarHost?: HTMLElement | null;
}

/** 与光标同列的整列对齐；序列化时以表头对齐为准，因此需要同时更新表头单元格。 */
function setColumnAlign(align: "left" | "center" | "right"): Command {
  return (state, dispatch) => {
    const $cell = cellAround(state.selection.$from);
    if (!$cell) return false;
    if (!dispatch) return true;

    const table = $cell.node(-1);
    const tableStart = $cell.start(-1);
    const map = TableMap.get(table);
    const column = map.findCell($cell.pos - tableStart).left;
    const tr = state.tr;
    for (let row = 0; row < map.height; row += 1) {
      const offset = map.map[row * map.width + column];
      if (offset === undefined) continue;
      const node = tr.doc.nodeAt(tableStart + offset);
      if (!node) continue;
      tr.setNodeMarkup(tableStart + offset, undefined, { ...node.attrs, align });
    }
    dispatch(tr);
    return true;
  };
}

/** 原始 HTML 中是否声明了指定 `id` / `name` 锚点。 */
function hasHtmlAnchor(raw: string, id: string): boolean {
  // 前面要求空白/标签边界，避免把 `data-id="..."` 误判成锚点。
  const pattern = /(?:^|[\s"'<])(?:id|name)\s*=\s*(["'])(.*?)\1/giu;
  for (const match of raw.matchAll(pattern)) {
    if (match[2] === id) return true;
  }
  return false;
}

/**
 * 标题锚点文本：与解析期 mdast textContent 保持一致。
 * 原文中的行内 HTML 与公式在 WYSIWYG 中是原子节点（无文本），需取回其原始源码参与 slug。
 */
function headingSlugText(node: PMNode): string {
  let text = "";
  node.descendants((child) => {
    if (child.isText) {
      text += child.text ?? "";
      return false;
    }
    const name = child.type.name;
    if (name === "html_inline" || name === "raw_inline") {
      text += String(child.attrs["raw"] ?? "");
      return false;
    }
    if (name === "math_inline") {
      text += String(child.attrs["source"] ?? "");
      return false;
    }
    return true;
  });
  return text;
}

/** 引用式链接标识符规范化（CommonMark 大小写不敏感、空白折叠、反斜杠转义还原）。 */
function normalizeLinkIdentifier(value: string): string {
  return value
    .replace(/\\([\\\[\]])/gu, "$1")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, " ");
}

/** 链接目标写入 Markdown 定义行：含空白或尖括号时用 `<...>` 包裹。 */
function formatLinkDestination(href: string): string {
  const value = href.trim();
  if (!value) return "<>";
  return /[\s<>]/u.test(value) ? `<${value}>` : value;
}

/** ProseMirror 编辑器封装；不依赖 React，也不直接读写文件。见 doc/design.md §11. */
export class PandaEditor {
  private readonly view: EditorView;
  private readonly tableToolbar: HTMLDivElement;
  private readonly blockToolbar: BlockToolbar;
  private readonly inputPopover: InputPopover;
  private readonly slashMenu: SlashMenu;
  private linkRange: { from: number; to: number } | null = null;
  /** 当前编辑的链接若为引用式写法，记录其标签（改地址时更新定义行）。 */
  private linkReference: string | null = null;
  /** 图片 NodeView 集合：文档路径变化（另存为）后重新解析相对路径。 */
  private readonly imageViews = new Set<ImageNodeView>();
  private anchorHighlightTimer: number | null = null;
  private readOnly: boolean;

  constructor(private readonly options: PandaEditorOptions) {
    this.readOnly = options.readOnly;
    this.view = new EditorView(options.parent, {
      state: createWysiwygState(options.docJson),
      attributes: { class: "markdown-body prose-editor", spellcheck: "false" },
      editable: () => !this.readOnly,
      nodeViews: {
        code_block: (node, view, getPos) =>
          new CodeBlockNodeView(node, view, getPos, () => this.readOnly),
        math_inline: (node, view, getPos) => new MathNodeView(node, view, getPos, false, options.documentId),
        math_block: (node, view, getPos) => new MathNodeView(node, view, getPos, true, options.documentId),
        mathml_inline: (node) => new MathmlNodeView(node, false),
        mathml_block: (node) => new MathmlNodeView(node, true),
        diagram_block: (node, view, getPos) =>
          new DiagramNodeView(node, view, getPos, options.documentId, () => this.readOnly),
        image: (node) => {
          const nodeView: ImageNodeView = new ImageNodeView(
            node,
            (src) => this.options.resolveImage?.(src) ?? Promise.resolve(null),
            () => this.imageViews.delete(nodeView),
          );
          this.imageViews.add(nodeView);
          return nodeView;
        },
        tab_set: (node) => new TabSetNodeView(node),
        grid: (node) => new GridNodeView(node),
      },
      handleKeyDown: (view, event) => this.handleKeyDown(view, event),
      handlePaste: (view, event) => this.handlePaste(view, event),
      handleDrop: (view, event) => this.handleDrop(view, event),
      handleDOMEvents: {
        mousedown: (view, event) => this.handleTaskCheckbox(view, event),
      },
      dispatchTransaction: (transaction) => {
        const state = this.view.state.apply(transaction);
        this.view.updateState(state);
        this.updateTableToolbar();
        this.blockToolbar?.update();
        if (transaction.docChanged) {
          this.options.onChange(state.doc.toJSON() as PMJson);
        }
      },
    });

    // 块级工具栏默认在编辑器上方；传入 toolbarHost 时挂到固定模式条左侧。
    this.blockToolbar = new BlockToolbar(
      this.view,
      () => this.readOnly,
      () => this.openImageEditor(),
      () => this.openLinkEditor(),
      (message) => this.notify(message),
    );
    if (options.toolbarHost) options.toolbarHost.append(this.blockToolbar.dom);
    else options.parent.insertBefore(this.blockToolbar.dom, this.view.dom);

    this.inputPopover = new InputPopover();
    this.slashMenu = new SlashMenu(this.view);
    document.body.append(this.inputPopover.dom, this.slashMenu.dom);

    this.tableToolbar = this.buildTableToolbar();
    options.parent.append(this.tableToolbar);
    window.addEventListener("scroll", this.handleViewportChange, true);
    window.addEventListener("resize", this.handleViewportChange);
    this.view.dom.addEventListener("blur", this.handleEditorBlur);
  }

  get state(): EditorState {
    return this.view.state;
  }

  private readonly handleViewportChange = (): void => {
    this.updateTableToolbar();
  };

  private readonly handleEditorBlur = (): void => {
    this.tableToolbar.hidden = true;
    this.slashMenu?.hide();
  };

  /**
   * 原生 Home/End、Ctrl+End、Shift+End 等选区移动由浏览器触发异步的 `selectionchange`，
   * ProseMirror 依赖该事件同步选区，可能晚于紧随其后的按键。按键处理前按 DOM 选区
   * 重建 EditorState 选区，避免斜杠菜单、Mod-k 等快捷键基于过期选区判断。
   * 只使用公开 API（`window.getSelection` + `view.posAtDOM`），不依赖 `view.domObserver` 内部实现。
   */
  private syncDomSelection(view: EditorView): void {
    const current = view.state.selection;
    // NodeSelection / AllSelection 由 ProseMirror 自己处理，这里只同步文本选区。
    if (!(current instanceof TextSelection)) return;
    const domSelection = window.getSelection();
    if (!domSelection || domSelection.rangeCount === 0) return;
    const { anchorNode, anchorOffset, focusNode, focusOffset } = domSelection;
    if (!focusNode || !view.dom.contains(focusNode)) return;
    try {
      const from = view.posAtDOM(anchorNode ?? focusNode, anchorOffset);
      const to = view.posAtDOM(focusNode, focusOffset);
      const $fromPos = view.state.doc.resolve(from);
      const $toPos = view.state.doc.resolve(to);
      // 只接受落在文本块内的位置；节点边界等交给默认处理。
      if (!$fromPos.parent.isTextblock || !$toPos.parent.isTextblock) return;
      if (from === current.from && to === current.to) return;
      const selection =
        from === to
          ? TextSelection.create(view.state.doc, from)
          : TextSelection.create(view.state.doc, from, to);
      view.dispatch(view.state.tr.setSelection(selection));
    } catch {
      // 选区落在原子节点或渲染器 DOM 等无法定位的位置时保持现状，交给 ProseMirror 默认处理。
    }
  }

  /**
   * 粘贴：图片写入 assets、HTML 消毒后按 schema 解析、纯文本按设置决定是否解析为 Markdown。
   * 目标位置内容模型不接受时（如表格单元）回退默认粘贴，避免丢内容。
   */
  private handlePaste(view: EditorView, event: ClipboardEvent): boolean {
    if (this.readOnly) return false;
    // 代码块内只接受纯文本，避免把块级片段插进 text* 内容。
    if (view.state.selection.$from.parent.type.name === "code_block") return false;
    const clipboard = event.clipboardData;
    if (!clipboard) return false;

    // 截图或复制的图片文件优先转存，插入相对路径。
    const images = [...clipboard.files].filter((file) => file.type.startsWith("image/"));
    if (images.length > 0 && this.options.onImportImage) {
      event.preventDefault();
      void this.importImages(images);
      return true;
    }

    const html = clipboard.getData("text/html");
    if (html) {
      const root = sanitizePastedHtml(html);
      if (root) {
        let slice;
        try {
          slice = PMDOMParser.fromSchema(markdownSchema).parseSlice(root);
        } catch {
          slice = null;
        }
        if (slice && slice.content.size > 0) {
          try {
            const transaction = view.state.tr.replaceSelection(slice).scrollIntoView();
            event.preventDefault();
            view.dispatch(transaction);
            return true;
          } catch {
            // 目标位置不接受该片段（如表格单元），继续尝试纯文本粘贴。
          }
        }
      }
    }

    const text = clipboard.getData("text/plain");
    if (text && this.options.pasteAsMarkdown?.()) {
      try {
        const parsed = markdownSchema.nodeFromJSON(parseMarkdown(text).doc);
        const single = parsed.childCount === 1 ? parsed.firstChild : null;
        // 单段落文本按行内内容插入，避免把光标所在段落拆开。
        const slice = new Slice(
          single && single.type.name === "paragraph" ? single.content : parsed.content,
          0,
          0,
        );
        if (slice.content.size > 0) {
          const transaction = view.state.tr.replaceSelection(slice).scrollIntoView();
          event.preventDefault();
          view.dispatch(transaction);
          return true;
        }
      } catch {
        // 解析失败时回退到默认纯文本粘贴。
      }
    }
    return false;
  }

  /** 把图片文件写入文档目录的 assets/ 并插入相对路径；失败时由调用方提示。 */
  private async importImages(files: File[]): Promise<void> {
    const importImage = this.options.onImportImage;
    const image = markdownSchema.nodes["image"];
    if (!importImage || !image) return;
    const nodes: PMNode[] = [];
    for (const file of files) {
      try {
        const data = new Uint8Array(await file.arrayBuffer());
        const src = await importImage({ data, mime: file.type, fileName: file.name || "image" });
        if (!src) continue;
        nodes.push(image.create({ src, alt: file.name.replace(/\.[^.]+$/u, "") }));
      } catch {
        // 单个文件失败时跳过，继续处理其余图片。
      }
    }
    if (nodes.length === 0 || this.view.isDestroyed) return;
    try {
      const transaction = this.view.state.tr
        .replaceSelection(new Slice(Fragment.fromArray(nodes), 0, 0))
        .scrollIntoView();
      this.view.dispatch(transaction);
      this.view.focus();
    } catch {
      // 当前选区（如整块节点）不接受行内图片时提示，而不是静默失败。
      this.notify(t("图片插入失败，请先把光标放到正文中"));
    }
  }

  /** 拖入图片文件：与粘贴共用 assets 转存逻辑。 */
  private handleDrop(view: EditorView, event: DragEvent): boolean {
    if (this.readOnly || !this.options.onImportImage) return false;
    if (view.state.selection.$from.parent.type.name === "code_block") return false;
    const files = [...(event.dataTransfer?.files ?? [])].filter((file) =>
      file.type.startsWith("image/"),
    );
    if (files.length === 0) return false;
    event.preventDefault();
    void this.importImages(files);
    return true;
  }

  /** 点击任务项左侧勾选框切换完成状态；点击正文不拦截。 */
  private handleTaskCheckbox(view: EditorView, event: MouseEvent): boolean {
    if (this.readOnly || event.button !== 0 || !event.target) return false;
    const target = (event.target as HTMLElement).closest?.("li.task-item");
    if (!(target instanceof HTMLElement)) return false;
    // 勾选框由 ::before 绘制在列表项左外侧（约 -1.4em），只在该留白区响应。
    const rect = target.getBoundingClientRect();
    if (event.clientX > rect.left - 2 || event.clientX < rect.left - 32) return false;
    const pos = view.posAtDOM(target, 0);
    const $pos = view.state.doc.resolve(pos);
    if ($pos.depth < 1 || $pos.parent.type.name !== "list_item") return false;
    event.preventDefault();
    view.dispatch(
      view.state.tr.setNodeMarkup($pos.before($pos.depth), undefined, {
        ...$pos.parent.attrs,
        checked: target.getAttribute("data-checked") !== "true",
      }),
    );
    view.focus();
    return true;
  }

  /** 编辑器按键：斜杠菜单导航、Mod-k 链接。返回 true 表示已消费。 */
  private handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
    if (this.readOnly) return false;
    this.syncDomSelection(view);
    if (this.slashMenu?.handleKey(event)) return true;
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === "k"
    ) {
      if (view.state.selection.empty) return false;
      event.preventDefault();
      this.openLinkEditor();
      return true;
    }
    if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const { selection } = view.state;
      const { $from } = selection;
      // 仅空段落触发，避免影响标题、表格与正文中的斜杠。
      if (
        selection.empty &&
        $from.parent.type.name === "paragraph" &&
        $from.parent.content.size === 0
      ) {
        event.preventDefault();
        const coords = view.coordsAtPos(selection.from);
        this.slashMenu?.open(
          createBlockActions(
            () => this.openImageEditor(),
            () => this.notify(t("当前位置不能插入代码块（例如表格单元格内）")),
          ),
          {
            left: coords.left,
            top: coords.bottom + 4,
          },
        );
        return true;
      }
    }
    // 段落内输入 ```js 后回车：创建带语言的代码块（输入规则只处理尾随空格）。
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const { selection } = view.state;
      const { $from } = selection;
      if (
        selection.empty &&
        $from.parent.type.name === "paragraph" &&
        $from.parentOffset === $from.parent.content.size
      ) {
        const match = /^```([\w+#.-]*)$/.exec($from.parent.textContent);
        // createCodeBlock 在无法转换（如列表项首段、表格单元）时返回 false，交回默认 Enter，避免删掉文本。
        if (match && this.createCodeBlock(match[1] ?? "")) {
          event.preventDefault();
          return true;
        }
      }
    }
    return false;
  }

  /** 把当前段落（含 ``` 围栏标记）转换为带语言的代码块；无法转换时返回 false。 */
  private createCodeBlock(language: string): boolean {
    const codeBlock = markdownSchema.nodes["code_block"];
    if (!codeBlock) return false;
    const { $from } = this.view.state.selection;
    const parent = $from.node(-1);
    const canReplace = parent.canReplaceWith($from.index(-1), $from.indexAfter(-1), codeBlock);
    // 表格单元（cellContent 只有 paragraph）无法容纳代码块，保持原文不变。
    const canInsert =
      !canReplace && parent.canReplaceWith($from.indexAfter(-1), $from.indexAfter(-1), codeBlock);
    if (!canReplace && !canInsert) {
      // 与工具栏一致：表格单元等无法容纳代码块的位置给出提示，而不是静默失败。
      this.notify(t("当前位置不能插入代码块（例如表格单元格内）"));
      return false;
    }
    const start = $from.pos - $from.parent.textContent.length;
    const tr = this.view.state.tr.delete(start, $from.pos);
    if (canReplace) {
      tr.setBlockType(start, start, codeBlock, { language, meta: "" });
    } else {
      // 列表项首段等内容模型不允许替换首段，改为在段落之后插入代码块。
      const insertAt = start + 1;
      tr.insert(insertAt, codeBlock.create({ language, meta: "" }));
      tr.setSelection(TextSelection.create(tr.doc, insertAt + 1));
    }
    this.view.dispatch(tr.scrollIntoView());
    this.view.focus();
    return true;
  }

  /** 轻量提示：交给调用方的提示条（未配置时静默忽略）。 */
  private notify(message: string): void {
    this.options.onNotice?.(message);
  }

  /** 选区下方坐标：输入弹层锚点。 */
  private selectionAnchor(): { left: number; top: number } {
    const { from, to } = this.view.state.selection;
    try {
      const start = this.view.coordsAtPos(from);
      const end = this.view.coordsAtPos(to);
      return {
        left: Math.min(start.left, end.left),
        top: Math.max(start.bottom, end.bottom) + 6,
      };
    } catch {
      return { left: 8, top: 64 };
    }
  }

  private openLinkEditor(): void {
    const { state } = this.view;
    const link = markdownSchema.marks["link"];
    if (!link) return;
    const { from, to, empty, $from } = state.selection;
    // `$from.marks()` 在选区边界可能为空，统一按选区内容判断已有链接。
    const existing = empty
      ? (link.isInSet(state.storedMarks ?? $from.marks()) ?? null)
      : (this.firstLinkMark(from, to) ?? null);
    // 光标在链接内（未选中文字）时，扩展到整条链接，便于修改或移除。
    if (empty && !existing) return;
    let rangeFrom = from;
    let rangeTo = to;
    if (empty) {
      while (rangeFrom > 0 && state.doc.rangeHasMark(rangeFrom - 1, rangeFrom, link)) {
        rangeFrom--;
      }
      while (rangeTo < state.doc.content.size && state.doc.rangeHasMark(rangeTo, rangeTo + 1, link)) {
        rangeTo++;
      }
      if (rangeFrom === rangeTo) return;
    }
    this.linkRange = { from: rangeFrom, to: rangeTo };
    const reference = existing?.attrs["reference"];
    this.linkReference = typeof reference === "string" && reference ? reference : null;
    this.inputPopover.show(
      {
        label: t("链接地址"),
        placeholder: "https://",
        initialValue: existing ? String(existing.attrs["href"] ?? "") : "",
        removeLabel: t("移除链接"),
        onRemove: existing ? () => this.removeLink() : undefined,
        onApply: (value) => this.applyLink(value),
      },
      this.selectionAnchor(),
    );
  }

  /** 选区范围内出现的第一个链接 mark（用于回填地址与显示移除）。 */
  private firstLinkMark(from: number, to: number): Mark | undefined {
    const link = markdownSchema.marks["link"];
    if (!link) return undefined;
    let found: Mark | undefined;
    this.view.state.doc.nodesBetween(from, to, (node) => {
      if (found || !node.isText) return;
      found = link.isInSet(node.marks);
    });
    return found;
  }

  private applyLink(href: string): void {
    const link = markdownSchema.marks["link"];
    const range = this.linkRange;
    if (!link || !range) return;
    const { from, to } = range;
    const reference = this.linkReference;
    this.linkReference = null;
    const tr = this.view.state.tr;
    // 引用式链接：改地址等于改定义行，保留 `[文字][id]` 写法。
    if (reference && this.updateReferenceDefinition(tr, reference, href)) {
      this.updateReferenceLinks(tr, link, reference, href);
      this.view.dispatch(tr);
      this.view.focus();
      return;
    }
    this.view.dispatch(tr.removeMark(from, to, link).addMark(from, to, link.create({ href })));
    this.view.focus();
  }

  /** 把定义行 `[id]: url` 的目标替换为新地址；找不到定义时返回 false。 */
  private updateReferenceDefinition(tr: Transaction, label: string, href: string): boolean {
    const identifier = normalizeLinkIdentifier(label);
    let changed = false;
    tr.doc.descendants((node, pos) => {
      if (changed) return false;
      if (node.type.name !== "raw_markdown") return true;
      if (String(node.attrs["reason"] ?? "") !== "definition") return true;
      const raw = String(node.attrs["raw"] ?? "");
      // 标签允许转义字符；目标支持 `<...>` 与普通 URL；标题等其余部分原样保留。
      const match = /^([ \t]{0,3}\[((?:[^\]\\]|\\.)+)\]:[ \t]*)(<[^>]*>|\S+)([\s\S]*)$/u.exec(raw);
      if (!match || normalizeLinkIdentifier(match[2] ?? "") !== identifier) return true;
      const next = `${match[1]}${formatLinkDestination(href)}${match[4] ?? ""}`;
      if (next === raw) return false;
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, raw: next });
      changed = true;
      return false;
    });
    return changed;
  }

  /** 同一标签的所有引用式链接共享定义，改地址后同步全部出现处的 href。 */
  private updateReferenceLinks(
    tr: Transaction,
    link: MarkType,
    reference: string,
    href: string,
  ): void {
    const targets: Array<{ from: number; to: number; mark: Mark }> = [];
    tr.doc.descendants((node, pos) => {
      if (!node.isText) return;
      const mark = link.isInSet(node.marks);
      // 标签大小写不敏感（CommonMark），同一标签的所有出现处一起更新。
      if (
        mark &&
        normalizeLinkIdentifier(String(mark.attrs["reference"] ?? "")) ===
          normalizeLinkIdentifier(reference)
      ) {
        targets.push({ from: pos, to: pos + node.nodeSize, mark });
      }
    });
    for (const target of targets) {
      tr.removeMark(target.from, target.to, link);
      tr.addMark(target.from, target.to, link.create({ ...target.mark.attrs, href }));
    }
  }

  private removeLink(): void {
    const link = markdownSchema.marks["link"];
    const range = this.linkRange;
    if (!link || !range) return;
    this.view.dispatch(this.view.state.tr.removeMark(range.from, range.to, link));
    this.view.focus();
  }

  /** 插入图片：打开地址输入弹层，确认后在光标处插入行内图片。 */
  private openImageEditor(): void {
    this.inputPopover.show(
      {
        label: t("图片地址"),
        placeholder: "https:// 或相对路径",
        onApply: (value) => this.insertImage(value),
      },
      this.selectionAnchor(),
    );
  }

  private insertImage(src: string): void {
    const image = markdownSchema.nodes["image"];
    if (!image) return;
    this.view.dispatch(this.view.state.tr.replaceSelectionWith(image.create({ src, alt: "" })));
    this.view.focus();
  }

  private buildTableToolbar(): HTMLDivElement {
    const toolbar = document.createElement("div");
    toolbar.className = "table-toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", t("表格操作"));
    toolbar.hidden = true;

    const actions: Array<{ label: string; title: string; command: Command }> = [
      { label: t("↑行"), title: t("在上方插入行"), command: addRowBefore },
      { label: t("↓行"), title: t("在下方插入行"), command: addRowAfter },
      { label: t("←列"), title: t("在左侧插入列"), command: addColumnBefore },
      { label: t("→列"), title: t("在右侧插入列"), command: addColumnAfter },
      { label: t("删行"), title: t("删除行"), command: deleteRow },
      { label: t("删列"), title: t("删除列"), command: deleteColumn },
      { label: t("左"), title: t("左对齐"), command: setColumnAlign("left") },
      { label: t("中"), title: t("居中"), command: setColumnAlign("center") },
      { label: t("右"), title: t("右对齐"), command: setColumnAlign("right") },
      { label: t("删表"), title: t("删除表格"), command: deleteTable },
    ];

    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "table-toolbar-button";
      button.textContent = action.label;
      button.title = action.title;
      button.setAttribute("aria-label", action.title);
      // 保持编辑器焦点，避免失焦时工具条消失。
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        action.command(this.view.state, this.view.dispatch, this.view);
        this.view.focus();
      });
      toolbar.append(button);
    }
    return toolbar;
  }

  /** 找到包含当前选区的表格节点位置。 */
  private findTablePos(): number | null {
    const { $from } = this.view.state.selection;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if ($from.node(depth).type.name === "table") return $from.before(depth);
    }
    return null;
  }

  /** 选区在表格内且编辑器聚焦时，在表格上方显示行列工具条。见 doc/design.md §15.1。 */
  private updateTableToolbar(): void {
    if (!this.readOnly && this.view.hasFocus()) {
      const tablePos = this.findTablePos();
      const tableDom = tablePos === null ? null : this.view.nodeDOM(tablePos);
      if (tableDom instanceof HTMLElement) {
        this.tableToolbar.hidden = false;
        const rect = tableDom.getBoundingClientRect();
        const toolbarRect = this.tableToolbar.getBoundingClientRect();
        const height = toolbarRect.height || 30;
        const width = toolbarRect.width || 360;
        let top = rect.top - height - 6;
        if (top < 8) top = rect.bottom + 6;
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
        this.tableToolbar.style.left = `${Math.round(left)}px`;
        this.tableToolbar.style.top = `${Math.round(top)}px`;
        return;
      }
    }
    this.tableToolbar.hidden = true;
  }

  /** 恢复标签页维度的编辑器状态（保留撤销历史）。 */
  setState(state: EditorState): void {
    this.view.updateState(state);
    this.updateTableToolbar();
    this.blockToolbar?.update();
  }

  /** 用新内容重建状态并建立新的撤销基线（模式切换、外部重载）。 */
  reset(docJson: PMJson, readOnly: boolean): void {
    this.readOnly = readOnly;
    this.view.updateState(createWysiwygState(docJson));
    this.updateTableToolbar();
    this.blockToolbar?.update();
  }

  /** 把块级工具栏挂到模式条容器；传 null 时回到编辑器上方。 */
  setToolbarHost(host: HTMLElement | null): void {
    if (!this.blockToolbar) return;
    if (host) {
      if (this.blockToolbar.dom.parentElement !== host) host.append(this.blockToolbar.dom);
      return;
    }
    if (this.blockToolbar.dom.parentElement !== this.options.parent) {
      this.options.parent.insertBefore(this.blockToolbar.dom, this.view.dom);
    }
  }

  /** 文档路径变化（另存为/重命名）后重新解析相对图片。 */
  refreshImages(): void {
    for (const nodeView of this.imageViews) nodeView.reload();
  }

  focus(): void {
    this.view.focus();
  }

  /** 滚动到第 index 个标题（从 0 开始），用于大纲跳转。见 doc/design.md §15.1。 */
  scrollToHeading(index: number): void {
    let count = 0;
    let target: number | null = null;
    this.view.state.doc.descendants((node, pos) => {
      if (target !== null) return false;
      if (node.type.name !== "heading") return true;
      if (count === index) {
        target = pos;
        return false;
      }
      count += 1;
      return true;
    });
    if (target === null) return;
    this.scrollToPosition(target + 1);
  }

  /**
   * 滚动到页内锚点：标题按实时文本计算 slug（编辑标题后仍然有效），
   * 其次匹配原始 HTML 锚点（`id` / `name`）。
   * 用于 Markdown 目录跳转；WYSIWYG 不保留锚点元素，因此按节点 raw 属性匹配。
   */
  scrollToAnchorId(id: string): boolean {
    const slugger = createSlugger();
    let target: number | null = null;
    this.view.state.doc.descendants((node, pos) => {
      if (target !== null) return false;
      if (node.type.name === "heading") {
        // 与解析时同一套 slug 规则，新建/改名的标题也能命中；保留解析得到的 id 作为兜底。
        const slug = slugger(headingSlugText(node));
        if (slug === id || String(node.attrs["id"] ?? "") === id) {
          target = pos;
          return false;
        }
        return true;
      }
      if (node.type.name !== "html_block" && node.type.name !== "html_inline") return true;
      if (!hasHtmlAnchor(String(node.attrs["raw"] ?? ""), id)) return true;
      target = pos;
      return false;
    });
    if (target === null) return false;
    const dom = this.view.nodeDOM(target);
    if (!(dom instanceof HTMLElement)) return false;
    dom.scrollIntoView({ block: "center", behavior: "smooth" });
    // 高亮用 Decoration，直接改节点 class 会被 ProseMirror 的 DOM 观察还原。
    this.view.dispatch(this.view.state.tr.setMeta(anchorHighlightKey, target));
    if (this.anchorHighlightTimer !== null) window.clearTimeout(this.anchorHighlightTimer);
    this.anchorHighlightTimer = window.setTimeout(() => {
      this.anchorHighlightTimer = null;
      if (!this.view.isDestroyed) {
        this.view.dispatch(this.view.state.tr.setMeta(anchorHighlightKey, null));
      }
    }, 900);
    return true;
  }

  /** 应用或清除差异装饰；传 null 清除。见 doc/design.md §21.5。 */
  setDiffModel(model: WysiwygDiffModel | null): void {
    this.view.dispatch(this.view.state.tr.setMeta(wysiwygDiffKey, model));
  }

  /** 滚动到第 index 个顶层块，用于改动导航。 */
  scrollToBlockIndex(index: number): void {
    let target: number | null = null;
    let count = 0;
    this.view.state.doc.forEach((_node, offset) => {
      if (target !== null) return;
      if (count === index) {
        target = offset;
        return;
      }
      count += 1;
    });
    if (target === null) return;
    this.scrollToPosition(target + 1, true);
  }

  private scrollToPosition(pos: number, flash = false): void {
    const dom = this.view.domAtPos(pos);
    const element = dom.node.nodeType === 1 ? (dom.node as HTMLElement) : dom.node.parentElement;
    if (!element) return;
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    if (flash) {
      element.classList.add("diff-target");
      setTimeout(() => element.classList.remove("diff-target"), 600);
    }
  }

  /** 查找：返回当前匹配序号（从 1 开始）与总数。见 doc/design.md §11.5。 */
  search(term: string, options: SearchOptions): { active: number; total: number } {
    const state = setSearch(this.view, term, options);
    return {
      active: state.ranges.length > 0 ? state.active + 1 : 0,
      total: state.ranges.length,
    };
  }

  findNext(direction: 1 | -1): { active: number; total: number } {
    const index = findNextMatch(this.view, direction);
    const state = getSearchState(this.view);
    return { active: index >= 0 ? index + 1 : 0, total: state?.ranges.length ?? 0 };
  }

  replaceCurrent(replacement: string): number {
    return replaceCurrentMatch(this.view, replacement);
  }

  replaceAll(replacement: string): number {
    return replaceAllMatches(this.view, replacement);
  }

  clearSearch(): void {
    clearSearch(this.view);
  }

  destroy(): void {
    if (this.anchorHighlightTimer !== null) window.clearTimeout(this.anchorHighlightTimer);
    window.removeEventListener("scroll", this.handleViewportChange, true);
    window.removeEventListener("resize", this.handleViewportChange);
    this.view.dom.removeEventListener("blur", this.handleEditorBlur);
    this.tableToolbar.remove();
    this.blockToolbar.dom.remove();
    this.imageViews.clear();
    this.inputPopover.destroy();
    this.slashMenu.destroy();
    this.view.destroy();
  }
}
