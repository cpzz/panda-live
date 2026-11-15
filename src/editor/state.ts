import { baseKeymap, chainCommands, lift, toggleMark, wrapIn } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { history, redo, undo } from "prosemirror-history";
import { InputRule, inputRules, textblockTypeInputRule, wrappingInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { MarkType, NodeType } from "prosemirror-model";
import { EditorState, type Command, type Plugin } from "prosemirror-state";
import { liftListItem, sinkListItem, splitListItem } from "prosemirror-schema-list";
import { tableEditing } from "prosemirror-tables";
import { markdownSchema, type PMJson } from "./schema";
import { anchorHighlightPlugin } from "./plugins/anchor";
import { wysiwygDiffPlugin } from "./plugins/diff";
import { nodeIdPlugin } from "./plugins/node-id";
import { searchPlugin } from "./search";

/**
 * 行内 mark 输入规则：输入 `**粗体**`、`*斜体*`、`` `代码` ``、`~~删除~~` 后自动转成 mark。
 * 只删除首尾标记字符，前缀普通文字保留；代码块内不生效。
 */
function markInputRule(regexp: RegExp, markType: MarkType, markerLength = 1): InputRule {
  return new InputRule(regexp, (state, match, start, end) => {
    if (state.selection.$from.parent.type.name === "code_block") return null;
    const text = match[1];
    if (!text) return null;
    const textStart = start + match[0].indexOf(text);
    const textEnd = textStart + text.length;
    const tr = state.tr;
    if (textEnd < end) tr.delete(textEnd, end);
    tr.delete(textStart - markerLength, textStart);
    const markStart = textStart - markerLength;
    tr.addMark(markStart, markStart + text.length, markType.create());
    return tr;
  });
}

/**
 * 任务项输入规则：列表项开头输入 `[ ] ` / `[x] ` 转为任务项。
 * 用户先输入 `- ` 已被列表输入规则转换为无序列表项，故此处只需匹配剩余标记。
 */
function taskItemInputRule(itemType: NodeType): InputRule {
  return new InputRule(/^\[([ xX])\]\s$/, (state, match, start, end) => {
    const $start = state.doc.resolve(start);
    for (let depth = $start.depth; depth > 0; depth -= 1) {
      const node = $start.node(depth);
      if (node.type.name !== itemType.name) continue;
      const tr = state.tr.delete(start, end);
      tr.setNodeMarkup($start.before(depth), undefined, {
        ...node.attrs,
        checked: (match[1] ?? "").toLowerCase() === "x",
      });
      return tr;
    }
    return null;
  });
}

function buildInputRules(): InputRule[] {
  const heading = markdownSchema.nodes["heading"];
  const bulletList = markdownSchema.nodes["bullet_list"];
  const orderedList = markdownSchema.nodes["ordered_list"];
  const blockquote = markdownSchema.nodes["blockquote"];
  const codeBlock = markdownSchema.nodes["code_block"];
  const marks = markdownSchema.marks;
  const rules: InputRule[] = [];
  if (heading) {
    rules.push(
      textblockTypeInputRule(/^(#{1,6})\s$/, heading, (match) => ({
        level: (match[1] ?? "#").length,
      })),
    );
  }
  if (bulletList) rules.push(wrappingInputRule(/^\s*([-+*])\s$/, bulletList));
  if (orderedList) {
    rules.push(
      wrappingInputRule(/^\s*(\d+)\.\s$/, orderedList, (match) => ({
        start: Number(match[1] ?? 1) || 1,
      })),
    );
  }
  const listItemType = markdownSchema.nodes["list_item"];
  if (listItemType) rules.push(taskItemInputRule(listItemType));
  if (blockquote) rules.push(wrappingInputRule(/^\s*>\s$/, blockquote));
  if (codeBlock) {
    // 需要尾随空格才转换，否则键入 ```js 时会在第三个反引号处提前变成空语言代码块。
    // 行尾 Enter 的路径由编辑器 keydown 处理。
    rules.push(
      textblockTypeInputRule(/^```([\w+#.-]*)\s$/, codeBlock, (match) => ({
        language: match[1] ?? "",
      })),
    );
  }
  // 行内 mark：先匹配双字符标记（粗体/删除线），再匹配单字符（行内代码/斜体）。
  if (marks["strong"]) rules.push(markInputRule(/\*\*([^*]+)\*\*$/, marks["strong"], 2));
  if (marks["strikethrough"]) rules.push(markInputRule(/~~([^~]+)~~$/, marks["strikethrough"], 2));
  if (marks["code"]) rules.push(markInputRule(/`([^`]+)`$/, marks["code"]));
  if (marks["em"]) {
    rules.push(markInputRule(/(?:^|[^*])\*([^*]+)\*$/, marks["em"]));
    rules.push(markInputRule(/(?:^|[^_\w])_([^_]+)_$/, marks["em"]));
  }
  return rules;
}

/** 仅在列表项内生效的缩进命令；非列表内返回 false，避免 Tab 抢走焦点。 */
function listIndent(itemType: NodeType | null, mode: "sink" | "lift"): Command {
  return (state, dispatch) => {
    if (!itemType) return false;
    const command = mode === "sink" ? sinkListItem : liftListItem;
    const { $from } = state.selection;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if ($from.node(depth).type.name === "list_item") {
        return command(itemType)(state, dispatch);
      }
    }
    return false;
  };
}

/** 引用层级：仅在引用内生效；sink 包裹内层引用，lift 退出一层。 */
function quoteIndent(mode: "sink" | "lift"): Command {
  return (state, dispatch) => {
    const blockquote = markdownSchema.nodes["blockquote"];
    if (!blockquote) return false;
    const { $from } = state.selection;
    let inQuote = false;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if ($from.node(depth).type.name === "blockquote") {
        inQuote = true;
        break;
      }
    }
    if (!inQuote) return false;
    return mode === "sink" ? wrapIn(blockquote)(state, dispatch) : lift(state, dispatch);
  };
}

/** 代码块内 Tab 插入两个空格；Shift+Tab 删除行首最多两个空格。 */
function codeBlockIndent(mode: "in" | "out"): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    if ($from.parent.type.name !== "code_block") return false;
    if (!dispatch) return true;
    if (mode === "in") {
      dispatch(state.tr.insertText("  "));
      return true;
    }
    const before = $from.parent.textContent.slice(0, $from.parentOffset);
    const line = before.slice(before.lastIndexOf("\n") + 1);
    if (!/^[ \t]*$/.test(line)) return false;
    const count = line.endsWith("\t") ? 1 : Math.min(2, line.length);
    if (count === 0) return false;
    dispatch(state.tr.delete($from.pos - count, $from.pos));
    return true;
  };
}

/** 列表项内 Enter 新建项；任务项拆出的新项重置为未完成。 */
function splitListItemResettingTask(itemType: NodeType): Command {
  const split = splitListItem(itemType);
  return (state, dispatch) => {
    if (!dispatch) return split(state, dispatch);
    return split(state, (tr) => {
      const $from = tr.selection.$from;
      for (let depth = $from.depth; depth > 0; depth -= 1) {
        const node = $from.node(depth);
        if (node.type.name !== itemType.name) continue;
        if (typeof node.attrs["checked"] === "boolean") {
          tr.setNodeMarkup($from.before(depth), undefined, { ...node.attrs, checked: false });
        }
        break;
      }
      dispatch(tr);
    });
  };
}

/** 编辑器插件集合：撤销、键位、输入规则、表格与 nodeId。见 doc/design.md §11.2。 */
export function buildEditorPlugins(): Plugin[] {
  const marks = markdownSchema.marks;
  const listItem = markdownSchema.nodes["list_item"];
  return [
    history(),
    keymap({
      "Mod-z": undo,
      "Mod-y": redo,
      "Mod-Shift-z": redo,
      "Mod-b": toggleMark(marks["strong"]),
      "Mod-i": toggleMark(marks["em"]),
      "Mod-e": toggleMark(marks["code"]),
      "Mod-Shift-x": toggleMark(marks["strikethrough"]),
      // 列表内 Enter 新建列表项；其余块由 baseKeymap 处理。
      Enter: listItem ? splitListItemResettingTask(listItem) : () => false,
      // 代码块缩进优先，其次列表缩进，再其次引用层级。
      Tab: chainCommands(
        codeBlockIndent("in"),
        listIndent(listItem ?? null, "sink"),
        quoteIndent("sink"),
      ),
      "Shift-Tab": chainCommands(
        codeBlockIndent("out"),
        listIndent(listItem ?? null, "lift"),
        quoteIndent("lift"),
      ),
    }),
    keymap(baseKeymap),
    dropCursor(),
    gapCursor(),
    tableEditing(),
    inputRules({ rules: buildInputRules() }),
    nodeIdPlugin(),
    anchorHighlightPlugin(),
    wysiwygDiffPlugin(),
    searchPlugin(),
  ];
}

export function createWysiwygState(docJson: PMJson): EditorState {
  return EditorState.create({
    doc: markdownSchema.nodeFromJSON(docJson),
    plugins: buildEditorPlugins(),
  });
}
