import { baseKeymap, toggleMark } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { history, redo, undo } from "prosemirror-history";
import { inputRules, textblockTypeInputRule, wrappingInputRule, type InputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import { EditorState, type Plugin } from "prosemirror-state";
import { tableEditing } from "prosemirror-tables";
import { markdownSchema, type PMJson } from "./schema";
import { nodeIdPlugin } from "./plugins/node-id";

function buildInputRules(): InputRule[] {
  const heading = markdownSchema.nodes["heading"];
  const bulletList = markdownSchema.nodes["bullet_list"];
  const orderedList = markdownSchema.nodes["ordered_list"];
  const blockquote = markdownSchema.nodes["blockquote"];
  const codeBlock = markdownSchema.nodes["code_block"];
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
  if (blockquote) rules.push(wrappingInputRule(/^\s*>\s$/, blockquote));
  if (codeBlock) {
    rules.push(
      textblockTypeInputRule(/^```([\w-]*)$/, codeBlock, (match) => ({ language: match[1] ?? "" })),
    );
  }
  return rules;
}

/** 编辑器插件集合：撤销、键位、输入规则、表格与 nodeId。见 doc/design.md §11.2。 */
export function buildEditorPlugins(): Plugin[] {
  const marks = markdownSchema.marks;
  return [
    history(),
    keymap({
      "Mod-z": undo,
      "Mod-y": redo,
      "Mod-Shift-z": redo,
      "Mod-b": toggleMark(marks["strong"]),
      "Mod-i": toggleMark(marks["em"]),
    }),
    keymap(baseKeymap),
    dropCursor(),
    gapCursor(),
    tableEditing(),
    inputRules({ rules: buildInputRules() }),
    nodeIdPlugin(),
  ];
}

export function createWysiwygState(docJson: PMJson): EditorState {
  return EditorState.create({
    doc: markdownSchema.nodeFromJSON(docJson),
    plugins: buildEditorPlugins(),
  });
}
