import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { WysiwygDiffModel, WysiwygGhost } from "../../diff/wysiwyg";
import { t } from "../../i18n";

/** 存储装饰集；文档变化时按位置映射，等新模型到达后再重建。 */
export const wysiwygDiffKey = new PluginKey<DecorationSet>("pandaWysiwygDiff");

interface TextRange {
  start: number;
  end: number;
}

function ghostNode(ghost: WysiwygGhost): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "diff-ghost pm-diff-ghost";
  wrapper.dataset["diffGhost"] = "true";
  wrapper.contentEditable = "false";
  wrapper.setAttribute("aria-label", t("已删除的内容"));

  const label = document.createElement("div");
  label.className = "diff-ghost-label";
  const text = document.createElement("span");
  text.textContent = t("已删除");
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "button small ghost";
  copy.textContent = t("复制原文");
  copy.addEventListener("mousedown", (event) => event.preventDefault());
  copy.addEventListener("click", () => {
    void navigator.clipboard?.writeText(ghost.text);
  });
  label.append(text, copy);

  const body = document.createElement("div");
  body.className = "pm-diff-ghost-body";
  body.innerHTML = ghost.html;

  wrapper.append(label, body);
  return wrapper;
}

function deletedNode(text: string): HTMLElement {
  const element = document.createElement("del");
  element.className = "diff-inline-del";
  element.textContent = text;
  return element;
}

function deletedLine(text: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "pm-diff-code-del";
  element.textContent = text;
  return element;
}

/** 按「顶层块 → 行/单元格 → 段落」路径定位文本块及其起始位置。 */
function resolvePath(doc: PMNode, path: number[]): { node: PMNode; pos: number } | null {
  let node = doc;
  // doc 没有起始 token，第一个子节点从 0 开始；其余节点的内容从 pos + 1 开始。
  let pos = -1;
  for (const index of path) {
    if (index < 0 || index >= node.childCount) return null;
    let childPos = pos + 1;
    for (let offset = 0; offset < index; offset += 1) childPos += node.child(offset).nodeSize;
    node = node.child(index);
    pos = childPos;
  }
  return { node, pos };
}

/** 代码块逐行标记：新增行加底色，删除行以幽灵行插入。 */
function appendCodeLines(
  decorations: Decoration[],
  pos: number,
  lines: Array<{ kind: "add" | "del" | "same"; text: string }>,
): void {
  let cursor = 0;
  for (const line of lines) {
    const from = cursor;
    const to = cursor + line.text.length;
    if (line.kind === "add") {
      decorations.push(
        Decoration.inline(pos + 1 + from, pos + 1 + to, { class: "pm-diff-code-add" }),
      );
    } else if (line.kind === "del") {
      // 删除行不在新文本里，只插入幽灵行，不推进光标。
      decorations.push(
        Decoration.widget(pos + 1 + from, () => deletedLine(line.text), { side: -1 }),
      );
      continue;
    }
    cursor = to + 1;
  }
}

function docPositionAt(ranges: TextRange[], offset: number): number {
  let consumed = 0;
  for (const range of ranges) {
    const length = range.end - range.start;
    if (offset <= consumed + length) return range.start + Math.min(length, offset - consumed);
    consumed += length;
  }
  return ranges[ranges.length - 1]?.end ?? 0;
}

function appendInline(
  decorations: Decoration[],
  node: PMNode,
  offset: number,
  segments: WysiwygDiffModel["inline"][number]["segments"],
): void {
  const ranges: TextRange[] = [];
  node.forEach((child, childOffset) => {
    if (!child.isText) return;
    const start = offset + 1 + childOffset;
    ranges.push({ start, end: start + child.nodeSize });
  });
  if (ranges.length === 0) return;

  const newLength = segments.reduce(
    (sum, segment) => (segment.kind === "del" ? sum : sum + segment.text.length),
    0,
  );
  if (newLength !== node.textContent.length) return;

  let cursor = 0;
  for (const segment of segments) {
    if (segment.kind === "same") {
      cursor += segment.text.length;
      continue;
    }
    if (segment.kind === "ins") {
      const from = cursor;
      const to = cursor + segment.text.length;
      let consumed = 0;
      for (const range of ranges) {
        const length = range.end - range.start;
        const rangeStart = consumed;
        const rangeEnd = consumed + length;
        if (rangeEnd > from && rangeStart < to) {
          decorations.push(
            Decoration.inline(
              range.start + Math.max(from, rangeStart) - rangeStart,
              range.start + Math.min(to, rangeEnd) - rangeStart,
              { class: "diff-inline-add" },
            ),
          );
        }
        consumed = rangeEnd;
      }
      cursor = to;
    } else {
      decorations.push(
        Decoration.widget(docPositionAt(ranges, cursor), () => deletedNode(segment.text), {
          side: -1,
        }),
      );
    }
  }
}

function buildDecorations(doc: PMNode, model: WysiwygDiffModel | null): DecorationSet {
  if (!model) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  const blockKinds = new Map(model.blocks.map((block) => [block.index, block.kind]));
  const ghostByBefore = new Map(model.ghosts.map((ghost) => [ghost.before, ghost]));

  let index = 0;
  doc.forEach((node, offset) => {
    const kind = blockKinds.get(index);
    if (kind) {
      decorations.push(
        Decoration.node(offset, offset + node.nodeSize, { class: `pm-diff-${kind}` }),
      );
    }

    const ghost = ghostByBefore.get(index);
    if (ghost) {
      decorations.push(Decoration.widget(offset, () => ghostNode(ghost), { side: -1 }));
    }
    index += 1;
  });

  for (const mark of model.inline) {
    const resolved = resolvePath(doc, mark.path);
    if (!resolved || !resolved.node.isTextblock) continue;
    appendInline(decorations, resolved.node, resolved.pos, mark.segments);
  }
  for (const mark of model.code) {
    const resolved = resolvePath(doc, mark.path);
    if (!resolved || resolved.node.type.name !== "code_block") continue;
    appendCodeLines(decorations, resolved.pos, mark.lines);
  }

  const tail = ghostByBefore.get(index);
  if (tail) {
    decorations.push(
      Decoration.widget(doc.content.size, () => ghostNode(tail), { side: 1 }),
    );
  }

  decorations.sort((a, b) => a.from - b.from || a.to - b.to);
  return DecorationSet.create(doc, decorations);
}

/** WYSIWYG 差异装饰：块级底色、行内 ins/del 与删除幽灵块。见 §21.5、§21.8。 */
export function wysiwygDiffPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: wysiwygDiffKey,
    state: {
      init: (_config, state) => buildDecorations(state.doc, null),
      apply: (transaction, value, _oldState, newState) => {
        const next = transaction.getMeta(wysiwygDiffKey) as WysiwygDiffModel | null | undefined;
        if (next !== undefined) return buildDecorations(newState.doc, next);
        return transaction.docChanged ? value.map(transaction.mapping, transaction.doc) : value;
      },
    },
    props: {
      decorations: (state) => wysiwygDiffKey.getState(state) ?? DecorationSet.empty,
    },
  });
}
