import { lift, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { liftListItem, wrapInList } from "prosemirror-schema-list";
import { cellAround } from "prosemirror-tables";
import { TextSelection } from "prosemirror-state";
import type { Command, EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { isMarkActive } from "./marks";
import { markdownSchema } from "./schema";
import { TOOLBAR_ICONS, toolbarIconSvg } from "./toolbar-icons";
import { t } from "../i18n";

export interface BlockAction {
  label: string;
  title: string;
  command: Command;
  /** 当前块是否已处于该格式；用于工具栏高亮（斜杠菜单不使用）。 */
  isActive?(state: EditorState): boolean;
}

type ListTypeName = "bullet_list" | "ordered_list";

/** 光标是否在表格单元内：表格内不允许再插入表格或分割线。 */
function inTable(state: EditorState): boolean {
  return Boolean(cellAround(state.selection.$from));
}

/** 选区起点是否位于指定节点内。 */
function inAncestor(state: EditorState, name: string): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === name) return true;
  }
  return false;
}

/** 当前所在的列表类型；不在列表内返回 null。 */
function currentList(state: EditorState): ListTypeName | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name;
    if (name === "bullet_list" || name === "ordered_list") return name;
  }
  return null;
}

/**
 * 列表切换：在目标列表内再次执行时提升列表项退出列表；
 * 在另一种列表内直接替换列表类型；不在列表内则包裹成目标列表。
 */
export function toggleList(listTypeName: ListTypeName): Command {
  return (state, dispatch) => {
    const listType = markdownSchema.nodes[listTypeName];
    const itemType = markdownSchema.nodes["list_item"];
    if (!listType || !itemType) return false;
    const current = currentList(state);
    if (current === listTypeName) {
      return liftListItem(itemType)(state, dispatch);
    }
    if (current) {
      if (!dispatch) return true;
      const { $from } = state.selection;
      for (let depth = $from.depth; depth > 0; depth -= 1) {
        const node = $from.node(depth);
        if (node.type.name !== current) continue;
        const attrs =
          listTypeName === "ordered_list"
            ? { nodeId: node.attrs["nodeId"] ?? null, start: 1 }
            : { nodeId: node.attrs["nodeId"] ?? null };
        dispatch(state.tr.setNodeMarkup($from.before(depth), listType, attrs));
        return true;
      }
    }
    return wrapInList(listType)(state, dispatch);
  };
}

/** 当前列表项是否为任务项。 */
function inTaskItem(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === "list_item") return typeof node.attrs["checked"] === "boolean";
  }
  return false;
}

/** 任务列表切换：列表项内切换勾选状态；非列表段落先转为任务项。 */
export function toggleTaskList(): Command {
  return (state, dispatch) => {
    const bulletList = markdownSchema.nodes["bullet_list"];
    const itemType = markdownSchema.nodes["list_item"];
    if (!bulletList || !itemType) return false;
    const { $from } = state.selection;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      const node = $from.node(depth);
      if (node.type.name !== "list_item") continue;
      if (!dispatch) return true;
      const checked = typeof node.attrs["checked"] === "boolean" ? null : false;
      dispatch(state.tr.setNodeMarkup($from.before(depth), undefined, { ...node.attrs, checked }));
      return true;
    }
    return wrapInList(bulletList)(state, (tr) => {
      const $pos = tr.selection.$from;
      for (let depth = $pos.depth; depth > 0; depth -= 1) {
        const node = $pos.node(depth);
        if (node.type.name !== "list_item") continue;
        tr.setNodeMarkup($pos.before(depth), undefined, { ...node.attrs, checked: false });
        break;
      }
      dispatch?.(tr.scrollIntoView());
    });
  };
}

/** 插入代码块；列表项首段等内容模型不能直接替换时，在块后插入。 */
export function insertCodeBlock(language = "", onUnsupported?: () => void): Command {
  return (state, dispatch) => {
    const codeBlock = markdownSchema.nodes["code_block"];
    if (!codeBlock) return false;
    const { selection } = state;
    const { $from } = selection;
    // 顶层原子节点被选中时 $from 位于 doc，直接在选区后插入。
    if ($from.depth < 1) {
      const pos = selection.to;
      if (!dispatch) return true;
      const tr = state.tr.insert(pos, codeBlock.create({ language, meta: "" }));
      tr.setSelection(TextSelection.create(tr.doc, pos + 1));
      dispatch(tr.scrollIntoView());
      return true;
    }
    if ($from.parent.type.name === "code_block") return false;
    const parent = $from.node(-1);
    const canReplace = parent.canReplaceWith($from.index(-1), $from.indexAfter(-1), codeBlock);
    const canInsert = parent.canReplaceWith($from.indexAfter(-1), $from.indexAfter(-1), codeBlock);
    if (!canReplace && !canInsert) {
      // 表格单元等单元格内容模型只允许段落，无法容纳代码块；仅在实际执行时提示。
      if (dispatch) onUnsupported?.();
      return false;
    }
    if (!dispatch) return true;
    if (canReplace) {
      return setBlockType(codeBlock, { language, meta: "" })(state, dispatch);
    }
    const pos = $from.after($from.depth);
    const tr = state.tr.insert(pos, codeBlock.create({ language, meta: "" }));
    tr.setSelection(TextSelection.create(tr.doc, pos + 1));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** 引用切换：已在引用内则提升一级退出，否则包裹为引用。 */
export function toggleBlockquote(): Command {
  const blockquote = markdownSchema.nodes["blockquote"];
  return (state, dispatch) => {
    if (inAncestor(state, "blockquote")) return lift(state, dispatch);
    return blockquote ? wrapIn(blockquote)(state, dispatch) : false;
  };
}

/** 在光标处插入 N×M 空表格（单元格含空段落）。 */
export function insertTable(rows = 3, columns = 3): Command {
  return (state, dispatch) => {
    if (inTable(state)) return false;
    const table = markdownSchema.nodes["table"];
    const row = markdownSchema.nodes["table_row"];
    const cell = markdownSchema.nodes["table_cell"];
    const paragraph = markdownSchema.nodes["paragraph"];
    if (!table || !row || !cell || !paragraph) return false;
    if (!dispatch) return true;
    const rowsNodes = Array.from({ length: rows }, () =>
      row.create(
        null,
        Array.from({ length: columns }, () => cell.create(null, paragraph.create())),
      ),
    );
    dispatch(state.tr.replaceSelectionWith(table.create({ nodeId: null }, rowsNodes)));
    return true;
  };
}

/** 在光标处插入水平分割线；表格内不可用。 */
export const insertHorizontalRule: Command = (state, dispatch) => {
  if (inTable(state)) return false;
  const rule = markdownSchema.nodes["horizontal_rule"];
  if (!rule) return false;
  if (dispatch) dispatch(state.tr.replaceSelectionWith(rule.create()));
  return true;
};

/** 块级操作集合；斜杠菜单使用（文字标签）。 */
export function createBlockActions(onImage: () => void, onUnsupported?: () => void): BlockAction[] {
  const heading = markdownSchema.nodes["heading"];
  const bulletList = markdownSchema.nodes["bullet_list"];
  const orderedList = markdownSchema.nodes["ordered_list"];
  const blockquote = markdownSchema.nodes["blockquote"];
  const codeBlock = markdownSchema.nodes["code_block"];
  const paragraph = markdownSchema.nodes["paragraph"];
  const actions: BlockAction[] = [];
  if (paragraph) {
    actions.push({ label: "¶", title: t("正文"), command: setBlockType(paragraph) });
  }
  if (heading) {
    for (const level of [1, 2, 3] as const) {
      actions.push({
        label: `H${level}`,
        title: t("标题 {0}", level),
        command: setBlockType(heading, { level }),
      });
    }
  }
  if (bulletList) {
    actions.push({ label: "•", title: t("无序列表"), command: toggleList("bullet_list") });
  }
  if (orderedList) {
    actions.push({ label: "1.", title: t("有序列表"), command: toggleList("ordered_list") });
  }
  actions.push({ label: "☑", title: t("任务列表"), command: toggleTaskList() });
  if (blockquote) {
    actions.push({ label: "❝", title: t("引用"), command: toggleBlockquote() });
  }
  if (codeBlock) {
    actions.push({ label: "</>", title: t("代码块"), command: insertCodeBlock("", onUnsupported) });
  }
  actions.push({ label: "―", title: t("分割线"), command: insertHorizontalRule });
  actions.push({ label: "▦", title: t("插入表格"), command: insertTable() });
  actions.push({
    label: "🖼",
    title: t("插入图片"),
    command: () => {
      onImage();
      return true;
    },
  });
  return actions;
}

/**
 * 顶部工具栏（Word 风格）：段落样式下拉、行内格式、列表、块结构与插入，按 `|` 分组。
 * 所有行内格式命令都走这里的同一组 mark 命令。见 doc/design.md §11.2。
 */
export class BlockToolbar {
  readonly dom: HTMLDivElement;
  private readonly select: HTMLSelectElement;
  private readonly markEntries: Array<{ button: HTMLButtonElement; mark: "strong" | "em" | "code" | "strikethrough" }> = [];
  private readonly actionEntries: Array<{ button: HTMLButtonElement; isActive?: (state: EditorState) => boolean }> = [];
  private readonly linkButton: HTMLButtonElement;
  private groupCount = 0;

  constructor(
    private readonly view: EditorView,
    private readonly isReadOnly: () => boolean,
    onImage: () => void,
    onLink: () => void,
    private readonly onNotice: (message: string) => void = () => undefined,
  ) {
    this.dom = document.createElement("div");
    this.dom.className = "block-toolbar";
    this.dom.setAttribute("role", "toolbar");
    this.dom.setAttribute("aria-label", t("段落格式"));

    // 段落样式
    const styleGroup = this.addGroup();
    this.select = document.createElement("select");
    this.select.className = "block-toolbar-select";
    this.select.setAttribute("aria-label", t("段落样式"));
    this.select.append(new Option(t("正文"), "paragraph"));
    for (let level = 1; level <= 6; level += 1) {
      this.select.append(new Option(t("标题 {0}", level), `h${level}`));
    }
    // 代码块也作为一种「块样式」，光标在代码块内时下拉不会误显示为「正文」。
    this.select.append(new Option(t("代码块"), "code_block"));
    this.select.addEventListener("change", () => {
      const value = this.select.value;
      const paragraph = markdownSchema.nodes["paragraph"];
      const heading = markdownSchema.nodes["heading"];
      const codeBlock = markdownSchema.nodes["code_block"];
      if (value === "paragraph" && paragraph) {
        setBlockType(paragraph)(this.view.state, this.view.dispatch, this.view);
      } else if (heading && value.startsWith("h")) {
        setBlockType(heading, { level: Number(value.slice(1)) })(
          this.view.state,
          this.view.dispatch,
          this.view,
        );
      } else if (codeBlock && value === "code_block") {
        insertCodeBlock("", () => this.onNotice(t("当前位置不能插入代码块（例如表格单元格内）")))(
          this.view.state,
          this.view.dispatch,
          this.view,
        );
      }
      this.view.focus();
      this.update();
    });
    styleGroup.append(this.select);

    // 行内格式
    const inlineGroup = this.addGroup();
    this.addMark(inlineGroup, "strong", TOOLBAR_ICONS.bold, t("粗体"), "Ctrl+B");
    this.addMark(inlineGroup, "em", TOOLBAR_ICONS.italic, t("斜体"), "Ctrl+I");
    this.addMark(
      inlineGroup,
      "strikethrough",
      TOOLBAR_ICONS.strikethrough,
      t("删除线"),
      "Ctrl+Shift+X",
    );
    this.addMark(inlineGroup, "code", TOOLBAR_ICONS.code, t("行内代码"), "Ctrl+E");
    this.linkButton = this.createButton(TOOLBAR_ICONS.link, t("链接"), () => onLink(), "Ctrl+K");
    inlineGroup.append(this.linkButton);

    // 列表
    const listGroup = this.addGroup();
    this.addAction(listGroup, TOOLBAR_ICONS.bulletList, t("无序列表"), toggleList("bullet_list"), (state) => currentList(state) === "bullet_list");
    this.addAction(listGroup, TOOLBAR_ICONS.orderedList, t("有序列表"), toggleList("ordered_list"), (state) => currentList(state) === "ordered_list");
    this.addAction(listGroup, TOOLBAR_ICONS.taskList, t("任务列表"), toggleTaskList(), inTaskItem);

    // 块结构
    const blockGroup = this.addGroup();
    this.addAction(
      blockGroup,
      TOOLBAR_ICONS.quote,
      t("引用（再次点击取消）"),
      toggleBlockquote(),
      (state) => inAncestor(state, "blockquote"),
    );
    const codeBlock = markdownSchema.nodes["code_block"];
    if (codeBlock) {
      this.addAction(
        blockGroup,
        TOOLBAR_ICONS.codeBlock,
        t("代码块"),
        insertCodeBlock("", () => this.onNotice(t("当前位置不能插入代码块（例如表格单元格内）"))),
        (state) => state.selection.$from.parent.type.name === "code_block",
      );
    }
    this.addAction(blockGroup, TOOLBAR_ICONS.horizontalRule, t("分割线"), insertHorizontalRule);

    // 插入
    const insertGroup = this.addGroup();
    this.addAction(insertGroup, TOOLBAR_ICONS.table, t("插入表格"), insertTable());
    this.addAction(insertGroup, TOOLBAR_ICONS.image, t("插入图片"), () => {
      onImage();
      return true;
    });

    this.update();
  }

  private addGroup(): HTMLDivElement {
    if (this.groupCount > 0) {
      const divider = document.createElement("span");
      divider.className = "block-toolbar-divider";
      divider.setAttribute("aria-hidden", "true");
      this.dom.append(divider);
    }
    this.groupCount += 1;
    const group = document.createElement("div");
    group.className = "block-toolbar-group";
    this.dom.append(group);
    return group;
  }

  private createButton(
    icon: string,
    title: string,
    onClick: () => void,
    shortcut?: string,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "block-toolbar-button";
    // 与应用工具栏一致：使用 data-tip 浮层而不是原生 title。
    button.setAttribute("data-tip", shortcut ? `${title} (${shortcut})` : title);
    button.setAttribute("aria-label", title);
    button.innerHTML = toolbarIconSvg(icon);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      onClick();
      this.view.focus();
      this.update();
    });
    return button;
  }

  private addMark(
    group: HTMLElement,
    name: "strong" | "em" | "code" | "strikethrough",
    icon: string,
    title: string,
    shortcut?: string,
  ): void {
    const button = this.createButton(
      icon,
      title,
      () => {
        const mark = markdownSchema.marks[name];
        if (mark) toggleMark(mark)(this.view.state, this.view.dispatch, this.view);
      },
      shortcut,
    );
    group.append(button);
    this.markEntries.push({ button, mark: name });
  }

  private addAction(
    group: HTMLElement,
    icon: string,
    title: string,
    command: Command,
    isActive?: (state: EditorState) => boolean,
  ): void {
    const button = this.createButton(icon, title, () => {
      command(this.view.state, this.view.dispatch, this.view);
    });
    group.append(button);
    this.actionEntries.push({ button, isActive });
  }

  /** 只读文档隐藏工具栏；否则同步禁用态、段落样式与当前格式高亮。 */
  update(): void {
    const disabled = this.isReadOnly();
    this.dom.hidden = disabled;
    const state = this.view.state;

    const parent = state.selection.$from.parent;
    this.select.value =
      parent.type.name === "heading"
        ? `h${Number(parent.attrs["level"]) || 1}`
        : parent.type.name === "code_block"
          ? "code_block"
          : "paragraph";
    this.select.disabled = disabled;

    for (const { button, mark } of this.markEntries) {
      button.disabled = disabled;
      const type = markdownSchema.marks[mark];
      button.setAttribute(
        "aria-pressed",
        String(!disabled && Boolean(type) && isMarkActive(state, type!)),
      );
    }
    const link = markdownSchema.marks["link"];
    this.linkButton.disabled = disabled;
    this.linkButton.setAttribute(
      "aria-pressed",
      String(!disabled && Boolean(link) && isMarkActive(state, link!)),
    );

    for (const { button, isActive } of this.actionEntries) {
      button.disabled = disabled;
      if (disabled || !isActive) {
        button.removeAttribute("aria-pressed");
        continue;
      }
      button.setAttribute("aria-pressed", String(isActive(state)));
    }
  }
}
