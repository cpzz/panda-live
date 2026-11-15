import type { MarkType } from "prosemirror-model";
import type { EditorState } from "prosemirror-state";

/** 选区（或光标处）是否已应用指定 mark。 */
export function isMarkActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return Boolean(type.isInSet(state.storedMarks ?? $from.marks()));
  return state.doc.rangeHasMark(from, to, type);
}
