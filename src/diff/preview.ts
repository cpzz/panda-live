import { diffLines, diffWordsWithSpace } from "diff";
import { renderMarkdownToHtml } from "../formats/markdown/preview";
import type { DiffViewMode } from "../shared/diff";
import type { DiffHunk, LineDiff, WordSegment } from "./compute";

export interface PreviewDiffModel {
  /** 基线文本；删除幽灵块与词级比较使用。 */
  oldText: string;
  /** 当前文本；仅用于识别 frontmatter / 引用定义等不可见区域。 */
  newText: string;
  diff: LineDiff;
  mode: DiffViewMode;
}

const INLINE_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "DIV"]);
const UNSAFE_INLINE_SELECTOR =
  "pre, table, img, svg, math, .katex, .katex-display, .diagram-svg, .diff-ghost";

const oldHtmlCache = new Map<string, string>();
const OLD_HTML_CACHE_LIMIT = 4;
/** 代码块逐行视图会重写 `code` 内容，这里保留原始 HTML 供清理时还原。 */
const codeOriginals = new WeakMap<HTMLElement, string>();

async function renderOldAnnotated(text: string): Promise<string> {
  const cached = oldHtmlCache.get(text);
  if (cached !== undefined) return cached;
  const html = await renderMarkdownToHtml(text, { annotateSource: true });
  oldHtmlCache.set(text, html);
  if (oldHtmlCache.size > OLD_HTML_CACHE_LIMIT) {
    const oldest = oldHtmlCache.keys().next().value;
    if (oldest !== undefined) oldHtmlCache.delete(oldest);
  }
  return html;
}

function elementChildren(root: ParentNode): HTMLElement[] {
  return [...root.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
}

/** 递归收集列表项，保证嵌套列表内部的改动也能被标记。 */
function pushListUnits(list: HTMLElement, units: HTMLElement[]): void {
  for (const item of elementChildren(list).filter((element) => element.tagName === "LI")) {
    units.push(item);
    for (const nested of elementChildren(item)) {
      if (nested.tagName === "UL" || nested.tagName === "OL") pushListUnits(nested, units);
    }
  }
}

/** 顶层块与容器内子块（li / tr / blockquote > p）作为独立 diff 单元。见 §21.5。 */
function unitElements(root: ParentNode): HTMLElement[] {
  const units: HTMLElement[] = [];
  for (const child of elementChildren(root)) {
    if (child.tagName === "UL" || child.tagName === "OL") {
      pushListUnits(child, units);
      continue;
    }
    if (child.tagName === "TABLE") {
      const rows = [...child.querySelectorAll("tr")];
      if (rows.length > 0) {
        units.push(...rows);
        continue;
      }
    }
    if (child.tagName === "BLOCKQUOTE") {
      const paragraphs = elementChildren(child).filter((element) => element.tagName === "P");
      if (paragraphs.length > 0) {
        units.push(...paragraphs);
        continue;
      }
    }
    units.push(child);
  }
  return units;
}

interface UnitRange {
  start: number;
  end: number;
}

function rangeOf(element: HTMLElement): UnitRange | null {
  const start = Number(element.dataset["srcLine"]);
  const end = Number(element.dataset["srcEndLine"] ?? element.dataset["srcLine"]);
  if (!Number.isFinite(start) || start <= 0) return null;
  return { start, end: Number.isFinite(end) && end >= start ? end : start };
}

function intersects(range: UnitRange, start: number, count: number): boolean {
  if (count <= 0) return false;
  return range.start <= start + count - 1 && range.end >= start;
}

/** 移除上一次应用的所有装饰，保证基线、粒度或开关变化时不残留。 */
export function clearPreviewDiff(host: HTMLElement): void {
  // 片段视图把块移进了卡片，先放回顶层，再按锚点还原原始顺序。
  for (const card of [...host.querySelectorAll(".diff-fragment-card")]) {
    const body = card.querySelector(".diff-fragment-body");
    if (body) {
      for (const child of [...body.children]) host.insertBefore(child, card);
    }
  }
  for (const element of [...host.querySelectorAll("[data-anchor-ref]")]) {
    const reference = element.getAttribute("data-anchor-ref");
    const anchor = reference
      ? host.querySelector<HTMLElement>(`[data-anchor="${reference}"]`)
      : null;
    if (anchor) anchor.before(element);
    element.removeAttribute("data-anchor-ref");
  }
  for (const card of [...host.querySelectorAll(".diff-fragment-card")]) card.remove();
  for (const anchor of [...host.querySelectorAll(".diff-fragment-anchor")]) anchor.remove();
  for (const element of [...host.querySelectorAll(".diff-hidden")]) {
    element.classList.remove("diff-hidden");
    element.removeAttribute("hidden");
  }
  for (const bar of [...host.querySelectorAll(".diff-collapse-bar")]) bar.remove();
  for (const notice of [...host.querySelectorAll(".diff-notice")]) notice.remove();
  for (const ghost of [...host.querySelectorAll("[data-diff-ghost]")]) ghost.remove();
  // 「改动前」行是旧行克隆，重算或关闭差异时移除。
  for (const row of [...host.querySelectorAll("[data-diff-before]")]) row.remove();
  for (const row of [...host.querySelectorAll(".diff-row-after, .diff-format-only")]) {
    row.classList.remove("diff-row-after", "diff-format-only");
  }
  // 代码块逐行视图会替换 `code` 内容，先还原再清理其它标记。
  for (const code of [...host.querySelectorAll<HTMLElement>("code.diff-code")]) {
    const original = codeOriginals.get(code);
    if (original !== undefined) {
      code.innerHTML = original;
      codeOriginals.delete(code);
    } else {
      for (const line of [...code.querySelectorAll(".diff-code-line")]) {
        line.replaceWith(...line.childNodes);
      }
    }
    code.classList.remove("diff-code");
  }
  for (const mark of [...host.querySelectorAll("ins.diff-inline-add, del.diff-inline-del")]) {
    // 删除标记内的文本不属于新文档，直接移除；新增标记只去掉外壳。
    if (mark.tagName === "DEL") {
      mark.remove();
      continue;
    }
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  }
  for (const element of [...host.querySelectorAll<HTMLElement>(".diff-add, .diff-change")]) {
    element.classList.remove("diff-add", "diff-change");
    if (element.dataset["diffTitle"]) {
      element.removeAttribute("title");
      delete element.dataset["diffTitle"];
    }
  }
  host.normalize();
}

function describeHunk(hunk: DiffHunk): string {
  if (hunk.kind === "add") return `新增 ${hunk.newCount} 行`;
  if (hunk.kind === "delete") return `删除 ${hunk.oldCount} 行`;
  return `修改 ${hunk.newCount} 行`;
}

/** 悬浮提示中的源码摘要：压平空白并截断，避免超长行撑爆 tooltip。 */
function shortSource(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
}

function markBlocks(host: HTMLElement, diff: LineDiff): void {
  for (const unit of unitElements(host)) {
    const range = rangeOf(unit);
    if (!range) continue;
    let kind: "add" | "change" | null = null;
    const matched: DiffHunk[] = [];
    for (const hunk of diff.hunks) {
      if (hunk.kind === "delete" || !intersects(range, hunk.newStart, hunk.newCount)) continue;
      matched.push(hunk);
      if (hunk.kind === "change") kind = "change";
      else if (kind === null) kind = "add";
    }
    if (!kind) continue;
    unit.classList.add(`diff-${kind}`);
    // 悬停提示改动规模与对应源码行，便于确认黄线到底改了什么。见 §21.8.4。
    if (matched.length > 0) {
      const summary = [...new Set(matched.map(describeHunk))].join("；");
      const details = matched
        .slice(0, 2)
        .map((hunk) =>
          [
            hunk.oldText.trim() ? `− ${shortSource(hunk.oldText)}` : "",
            hunk.newText.trim() ? `+ ${shortSource(hunk.newText)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        )
        .filter(Boolean)
        .join("\n");
      unit.title = details ? `${summary}\n${details}` : summary;
      unit.dataset["diffTitle"] = "true";
    }
  }
}

function canInline(element: HTMLElement): boolean {
  if (!INLINE_TAGS.has(element.tagName)) return false;
  if (element.classList.contains("diff-ghost")) return false;
  // 列表项内含子列表时整项文本会混入子项，只做块级标记。
  if (element.tagName === "LI" && element.querySelector("ul, ol")) return false;
  if (element.querySelector(UNSAFE_INLINE_SELECTOR)) return false;
  return (element.textContent ?? "").length > 0;
}

function canInlineCell(element: HTMLElement): boolean {
  if (element.tagName !== "TD" && element.tagName !== "TH") return false;
  if (element.querySelector(UNSAFE_INLINE_SELECTOR)) return false;
  return (element.textContent ?? "").length > 0;
}

function textNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

function wrapInserted(root: HTMLElement, start: number, end: number): void {
  const targets: Array<{ node: Text; from: number; to: number }> = [];
  let consumed = 0;
  for (const node of textNodes(root)) {
    const nodeStart = consumed;
    const nodeEnd = consumed + node.length;
    if (nodeEnd > start && nodeStart < end) {
      targets.push({
        node,
        from: Math.max(start, nodeStart) - nodeStart,
        to: Math.min(end, nodeEnd) - nodeStart,
      });
    }
    consumed = nodeEnd;
  }
  for (const target of targets) {
    if (target.to <= target.from) continue;
    const range = document.createRange();
    range.setStart(target.node, target.from);
    range.setEnd(target.node, target.to);
    const mark = document.createElement("ins");
    mark.className = "diff-inline-add";
    range.surroundContents(mark);
  }
}

function insertDeleted(root: HTMLElement, offset: number, text: string): void {
  const mark = document.createElement("del");
  mark.className = "diff-inline-del";
  mark.textContent = text;
  let consumed = 0;
  for (const node of textNodes(root)) {
    const nodeEnd = consumed + node.length;
    if (offset <= nodeEnd) {
      const local = Math.max(0, Math.min(node.length, offset - consumed));
      const parent = node.parentNode;
      if (!parent) return;
      if (local >= node.length) parent.insertBefore(mark, node.nextSibling);
      else if (local <= 0) parent.insertBefore(mark, node);
      else parent.insertBefore(mark, node.splitText(local));
      return;
    }
    consumed = nodeEnd;
  }
  root.appendChild(mark);
}

/** 从后向前应用片段，插入删除文本不会影响更早的偏移。 */
function decorateInline(block: HTMLElement, segments: WordSegment[]): void {
  type Operation =
    | { kind: "ins"; start: number; end: number }
    | { kind: "del"; at: number; text: string };

  const operations: Operation[] = [];
  let cursor = 0;
  for (const segment of segments) {
    const length = segment.text.length;
    if (segment.kind === "same") {
      cursor += length;
    } else if (segment.kind === "ins") {
      operations.push({ kind: "ins", start: cursor, end: cursor + length });
      cursor += length;
    } else {
      // 删除片段不属于新文本，位置固定在当前光标处。
      operations.push({ kind: "del", at: cursor, text: segment.text });
    }
  }

  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const operation = operations[index]!;
    if (operation.kind === "del") insertDeleted(block, operation.at, operation.text);
    else wrapInserted(block, operation.start, operation.end);
  }
}

function toSegments(parts: Array<{ value: string; added?: boolean; removed?: boolean }>): WordSegment[] {
  return parts.map((part) => ({
    kind: part.added ? "ins" : part.removed ? "del" : "same",
    text: part.value,
  }));
}

function decorateRow(oldRow: HTMLElement, newRow: HTMLElement): void {
  const oldCells = elementChildren(oldRow).filter(
    (cell) => cell.tagName === "TD" || cell.tagName === "TH",
  );
  const newCells = elementChildren(newRow).filter(
    (cell) => cell.tagName === "TD" || cell.tagName === "TH",
  );
  const count = Math.min(oldCells.length, newCells.length);
  let sameText = true;
  let marked = false;
  for (let index = 0; index < count; index += 1) {
    const source = oldCells[index]!;
    const target = newCells[index]!;
    if (!canInlineCell(source) || !canInlineCell(target)) {
      sameText = false;
      continue;
    }
    const oldValue = source.textContent ?? "";
    const newValue = target.textContent ?? "";
    if (oldValue !== newValue) sameText = false;
    if (oldValue.length === 0 || newValue.length === 0) continue;
    decorateInline(target, toSegments(diffWordsWithSpace(oldValue, newValue)));
    if (target.querySelector("ins.diff-inline-add, del.diff-inline-del")) marked = true;
  }

  if (sameText && !marked) {
    // 渲染文本完全相同：只是源码格式变化，给出明确标签而不是只有黄线。
    newRow.classList.add("diff-format-only");
    newRow.title = `${newRow.title ? `${newRow.title}\n` : ""}仅格式变化：渲染内容与改动前相同`;
    return;
  }

  if (!marked) {
    // 词级标记不可用时，把旧行作为「改动前」显式放在新行上方。
    const before = oldRow.cloneNode(true) as HTMLElement;
    before.classList.remove("diff-add", "diff-change", "diff-format-only", "diff-row-after");
    before.classList.add("diff-row-before");
    before.dataset["diffBefore"] = "true";
    before.removeAttribute("title");
    before.removeAttribute("data-diff-title");
    newRow.classList.add("diff-row-after");
    newRow.before(before);
  }
}

/** 文本相似度：公共前后缀占比，用于结构变化时避免按顺序错配块。 */
function textSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const max = Math.max(left.length, right.length);
  if (max === 0) return 1;
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return (prefix + suffix) / max;
}

/** 新旧单元数量一致时按顺序配对；否则按文本相似度贪心配对。 */
function pairUnits(
  oldUnits: HTMLElement[],
  newUnits: HTMLElement[],
): Array<[HTMLElement, HTMLElement]> {
  if (oldUnits.length === newUnits.length) {
    return oldUnits.map((unit, index) => [unit, newUnits[index]!] as [HTMLElement, HTMLElement]);
  }
  const pairs: Array<[HTMLElement, HTMLElement]> = [];
  const used = new Set<number>();
  for (const newUnit of newUnits) {
    const newText = newUnit.textContent ?? "";
    let best = -1;
    let bestScore = -1;
    oldUnits.forEach((oldUnit, index) => {
      if (used.has(index)) return;
      const score = textSimilarity(oldUnit.textContent ?? "", newText);
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    });
    if (best < 0) continue;
    used.add(best);
    pairs.push([oldUnits[best]!, newUnit]);
  }
  return pairs;
}

async function applyInline(
  host: HTMLElement,
  diff: LineDiff,
  oldText: string,
  isCancelled: () => boolean,
): Promise<void> {
  const changeHunks = diff.hunks.filter((hunk) => hunk.kind === "change" && hunk.words);
  if (changeHunks.length === 0 || oldText.trim().length === 0) return;

  const oldHtml = await renderOldAnnotated(oldText);
  if (isCancelled()) return;
  const template = document.createElement("template");
  template.innerHTML = oldHtml;
  const oldUnits = unitElements(template.content).filter(
    (unit) => unit.tagName === "TR" || canInline(unit),
  );
  const newUnits = unitElements(host).filter(
    (unit) => unit.tagName === "TR" || canInline(unit),
  );

  for (const hunk of changeHunks) {
    const oldCandidates = oldUnits.filter((unit) => {
      const range = rangeOf(unit);
      return range !== null && intersects(range, hunk.oldStart, hunk.oldCount);
    });
    const newCandidates = newUnits.filter((unit) => {
      const range = rangeOf(unit);
      return range !== null && intersects(range, hunk.newStart, hunk.newCount);
    });
    const pairs = pairUnits(oldCandidates, newCandidates);
    for (const [oldUnit, newUnit] of pairs) {
      if (oldUnit.tagName === "TR" && newUnit.tagName === "TR") {
        decorateRow(oldUnit, newUnit);
        continue;
      }
      if (oldUnit.tagName === "TR" || newUnit.tagName === "TR") continue;
      if (newUnit.querySelector("ins.diff-inline-add, del.diff-inline-del")) continue;
      const oldValue = oldUnit.textContent ?? "";
      const newValue = newUnit.textContent ?? "";
      if (oldValue.length === 0 || newValue.length === 0) continue;
      decorateInline(newUnit, toSegments(diffWordsWithSpace(oldValue, newValue)));
    }
  }
}

function codeLines(value: string): string[] {
  return value.replace(/\n$/, "").split("\n");
}

function appendCodeLine(code: HTMLElement, kind: "add" | "del" | "same", text: string): void {
  const span = document.createElement("span");
  span.className = `diff-code-line ${kind}`;
  span.textContent = text;
  code.append(span);
}

/** 成对的删除/新增行再叠加词级标记，便于看出行内具体改了什么。 */
function appendCodeWordLine(
  code: HTMLElement,
  kind: "add" | "del",
  segments: WordSegment[],
): void {
  const span = document.createElement("span");
  span.className = `diff-code-line ${kind}`;
  for (const segment of segments) {
    if (segment.kind === "same") {
      span.append(segment.text);
      continue;
    }
    // 删除行只保留 del 片段，新增行只保留 ins 片段。
    if (segment.kind !== (kind === "add" ? "ins" : "del")) continue;
    const mark = document.createElement("span");
    mark.className = `diff-code-word ${kind}`;
    mark.textContent = segment.text;
    span.append(mark);
  }
  code.append(span);
}

/** 代码块改写为逐行视图，成对行再做词级标注。见 §21.9。 */
function applyCodeDiff(pre: HTMLElement, oldCode: string, newCode: string): void {
  if (oldCode === newCode) return;
  const parts = diffLines(
    `${oldCode.replace(/\n+$/, "")}\n`,
    `${newCode.replace(/\n+$/, "")}\n`,
  );
  const code = pre.querySelector<HTMLElement>("code") ?? pre;
  if (!codeOriginals.has(code)) codeOriginals.set(code, code.innerHTML);
  code.textContent = "";
  code.classList.add("diff-code");

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const next = parts[index + 1];
    if (part.removed && next?.added) {
      const oldLines = codeLines(part.value);
      const newLines = codeLines(next.value);
      const count = Math.max(oldLines.length, newLines.length);
      for (let line = 0; line < count; line += 1) {
        const oldLine = oldLines[line];
        const newLine = newLines[line];
        if (oldLine !== undefined && newLine !== undefined) {
          const segments = toSegments(diffWordsWithSpace(oldLine, newLine));
          appendCodeWordLine(code, "del", segments);
          appendCodeWordLine(code, "add", segments);
          continue;
        }
        if (oldLine !== undefined) appendCodeLine(code, "del", oldLine);
        if (newLine !== undefined) appendCodeLine(code, "add", newLine);
      }
      index += 1;
      continue;
    }
    const kind = part.added ? "add" : part.removed ? "del" : "same";
    for (const line of codeLines(part.value)) appendCodeLine(code, kind, line);
  }
}

async function applyCodeBlocks(
  host: HTMLElement,
  diff: LineDiff,
  oldText: string,
  isCancelled: () => boolean,
): Promise<void> {
  const changeHunks = diff.hunks.filter((hunk) => hunk.kind === "change");
  if (changeHunks.length === 0 || !oldText.trim()) return;

  const oldHtml = await renderOldAnnotated(oldText);
  if (isCancelled()) return;
  const template = document.createElement("template");
  template.innerHTML = oldHtml;
  const oldPres = [...template.content.querySelectorAll("pre")];
  const newPres = [...host.querySelectorAll("pre")].filter(
    (element) => element.closest("[data-diff-ghost]") === null,
  );

  for (const hunk of changeHunks) {
    const oldCandidates = oldPres.filter((element) => {
      const range = rangeOf(element);
      return range !== null && intersects(range, hunk.oldStart, hunk.oldCount);
    });
    const newCandidates = newPres.filter((element) => {
      const range = rangeOf(element);
      return range !== null && intersects(range, hunk.newStart, hunk.newCount);
    });
    const count = Math.min(oldCandidates.length, newCandidates.length);
    for (let index = 0; index < count; index += 1) {
      applyCodeDiff(
        newCandidates[index]!,
        oldCandidates[index]!.textContent ?? "",
        newCandidates[index]!.textContent ?? "",
      );
    }
  }
}

/** 删除的表格行缺少表头时补一个骨架，避免幽灵块退化成竖线文本。 */
function tableGhostText(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0 || !lines.every((line) => /^\s*\|.*\|\s*$/.test(line))) return text;
  const columns = Math.max(...lines.map((line) => Math.max(0, line.split("|").length - 2)));
  if (columns <= 0) return text;
  const header = `|${Array.from({ length: columns }, () => " ").join("|")}|`;
  const divider = `|${Array.from({ length: columns }, () => "---").join("|")}|`;
  return `${header}\n${divider}\n${lines.join("\n")}\n`;
}

/**
 * 删除的列表项 / 表格行优先插回相邻容器，保持原有结构（§21.5）。
 * 返回 false 时由调用方按顶层幽灵块插入。
 */
function insertGhostIntoContainer(
  host: HTMLElement,
  wrapper: HTMLElement,
  hunk: DiffHunk,
): boolean {
  const blocks = elementChildren(host);
  const anchor = blocks.find((block) => {
    const range = rangeOf(block);
    return range !== null && range.start >= hunk.newStart;
  });
  const previous = anchor
    ? (anchor.previousElementSibling as HTMLElement | null)
    : (blocks[blocks.length - 1] ?? null);
  const candidates = [anchor, previous].filter(
    (item): item is HTMLElement => item instanceof HTMLElement,
  );
  const label = wrapper.querySelector(".diff-ghost-label");
  if (!label) return false;

  const ghostTable = wrapper.querySelector("table");
  if (ghostTable) {
    const table = candidates.find((item) => item.tagName === "TABLE");
    if (table) {
      const tbody = table.querySelector("tbody") ?? table;
      const anchorRow = [...table.querySelectorAll("tr")].find((row) => {
        const range = rangeOf(row as HTMLElement);
        return range !== null && range.start >= hunk.newStart;
      });
      const rows = [...ghostTable.querySelectorAll("tbody tr")].filter(
        (row) => row.closest("thead") === null,
      );
      if (rows.length > 0) {
        const labelRow = document.createElement("tr");
        labelRow.className = "diff-ghost-row diff-ghost-label-row";
        labelRow.dataset["diffGhost"] = "true";
        const cell = document.createElement("td");
        cell.colSpan = Math.max(1, rows[0]!.children.length);
        cell.append(label);
        labelRow.append(cell);
        tbody.insertBefore(labelRow, anchorRow ?? null);
        for (const row of rows) {
          row.classList.add("diff-ghost-row");
          (row as HTMLElement).dataset["diffGhost"] = "true";
          tbody.insertBefore(row, anchorRow ?? null);
        }
        return true;
      }
    }
  }

  const ghostList = wrapper.querySelector("ul, ol");
  if (ghostList) {
    const list = candidates.find((item) => item.tagName === "UL" || item.tagName === "OL");
    if (list) {
      const anchorItem = [...list.children].find((item) => {
        const range = rangeOf(item as HTMLElement);
        return range !== null && range.start >= hunk.newStart;
      });
      const labelItem = document.createElement("li");
      labelItem.className = "diff-ghost-item diff-ghost-label-item";
      labelItem.dataset["diffGhost"] = "true";
      labelItem.append(label);
      list.insertBefore(labelItem, anchorItem ?? null);
      for (const item of [...ghostList.children]) {
        item.classList.add("diff-ghost-item");
        (item as HTMLElement).dataset["diffGhost"] = "true";
        list.insertBefore(item, anchorItem ?? null);
      }
      return true;
    }
  }
  return false;
}

async function appendGhosts(
  host: HTMLElement,
  diff: LineDiff,
  isCancelled: () => boolean,
): Promise<void> {
  for (const hunk of diff.hunks) {
    if (hunk.kind !== "delete") continue;
    const html = await renderMarkdownToHtml(tableGhostText(hunk.oldText), {
      annotateSource: true,
    });
    if (isCancelled()) return;

    const wrapper = document.createElement("div");
    wrapper.className = "diff-ghost";
    wrapper.dataset["diffGhost"] = "true";
    wrapper.setAttribute("aria-label", "已删除的内容");
    wrapper.innerHTML = html;

    const label = document.createElement("div");
    label.className = "diff-ghost-label";
    const text = document.createElement("span");
    text.textContent = "已删除";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "button small ghost";
    copy.textContent = "复制原文";
    copy.addEventListener("click", () => {
      void navigator.clipboard?.writeText(hunk.oldText);
    });
    label.append(text, copy);
    wrapper.prepend(label);

    if (insertGhostIntoContainer(host, wrapper, hunk)) continue;

    const topBlocks = elementChildren(host);
    const anchor = topBlocks.find((block) => {
      const range = rangeOf(block);
      return range !== null && range.start >= hunk.newStart;
    });
    host.insertBefore(wrapper, anchor ?? null);
  }
}

function frontmatterRange(text: string): UnitRange | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (!/^---\s*$/.test(lines[0] ?? "")) return null;
  for (let index = 1; index < lines.length; index += 1) {
    if (/^---\s*$/.test(lines[index] ?? "")) return { start: 1, end: index + 1 };
  }
  return null;
}

function hunkTouches(hunk: DiffHunk, range: UnitRange): boolean {
  if (hunk.kind === "delete") {
    return hunk.newStart >= range.start && hunk.newStart <= range.end;
  }
  return intersects(range, hunk.newStart, hunk.newCount);
}

/** 旧文档一侧的相交判断；用于识别「整个 frontmatter 被删除」。 */
function hunkTouchesOld(hunk: DiffHunk, range: UnitRange): boolean {
  if (hunk.kind === "add") {
    return hunk.oldStart >= range.start && hunk.oldStart <= range.end;
  }
  return intersects(range, hunk.oldStart, hunk.oldCount);
}

/** 跳过围栏代码块后再匹配引用定义，避免代码示例误报。 */
function hasReferenceDefinitionLine(text: string): boolean {
  let fence: string | null = null;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
      continue;
    }
    if (fence === null && /^\s{0,3}\[[^\]]+\]:\s+\S+/.test(line)) return true;
  }
  return false;
}

function hasReferenceDefinitionChange(diff: LineDiff): boolean {
  return diff.hunks.some(
    (hunk) => hasReferenceDefinitionLine(hunk.newText) || hasReferenceDefinitionLine(hunk.oldText),
  );
}

/** frontmatter / 引用定义在渲染中不可见，给出提示并引导到源码。见 §21.9。 */
function appendInvisibleNotice(host: HTMLElement, model: PreviewDiffModel): void {
  const newRange = frontmatterRange(model.newText);
  const oldRange = frontmatterRange(model.oldText);
  const frontmatterChanged =
    (newRange !== null && model.diff.hunks.some((hunk) => hunkTouches(hunk, newRange))) ||
    (oldRange !== null && model.diff.hunks.some((hunk) => hunkTouchesOld(hunk, oldRange)));
  if (!frontmatterChanged && !hasReferenceDefinitionChange(model.diff)) return;

  const notice = document.createElement("div");
  notice.className = "diff-notice";
  const parts: string[] = [];
  if (frontmatterChanged) parts.push("元数据（frontmatter）");
  if (hasReferenceDefinitionChange(model.diff)) parts.push("引用定义");
  notice.textContent = `${parts.join("、")}有改动，属于不可见内容，切换到源码查看。`;
  host.prepend(notice);
}

/** 容器（列表、表格、引用）本身未打标，需检查内部是否有改动单元。 */
function isChangedBlock(element: HTMLElement): boolean {
  if (
    element.classList.contains("diff-add") ||
    element.classList.contains("diff-change") ||
    element.hasAttribute("data-diff-ghost")
  ) {
    return true;
  }
  return element.querySelector(".diff-add, .diff-change, [data-diff-ghost]") !== null;
}

/** 连续未改动块折叠为一条横条，保留改动前后各 2 块上下文。 */
function applyCollapseMode(host: HTMLElement, contextBlocks: number): void {
  const blocks = elementChildren(host).filter((element) => !element.classList.contains("diff-notice"));
  const changed = blocks.map(isChangedBlock);
  if (!changed.some(Boolean)) return;

  let index = 0;
  while (index < blocks.length) {
    if (changed[index]) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < blocks.length && !changed[index]) index += 1;
    const end = index; // exclusive
    const beforeChanged = start > 0 && changed[start - 1];
    const afterChanged = end < blocks.length && changed[end];
    const keepBefore = beforeChanged ? contextBlocks : 0;
    const keepAfter = afterChanged ? contextBlocks : 0;
    const keep = keepBefore + keepAfter;
    if (end - start <= keep + 1) continue;

    const hidden = blocks.slice(start + keepBefore, end - keepAfter);
    if (hidden.length === 0) continue;
    const bar = document.createElement("div");
    bar.className = "diff-collapse-bar";
    bar.setAttribute("role", "button");
    bar.tabIndex = 0;
    bar.textContent = `… ${hidden.length} 个未改动块 …`;
    const expand = (): void => {
      for (const element of hidden) {
        element.classList.remove("diff-hidden");
        element.removeAttribute("hidden");
      }
      bar.remove();
    };
    bar.addEventListener("click", expand);
    bar.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        expand();
      }
    });
    blocks[start + keepBefore]!.before(bar);
    for (const element of hidden) {
      element.classList.add("diff-hidden");
      element.hidden = true;
    }
  }
}

interface FragmentGroup {
  elements: HTMLElement[];
  breadcrumb: string;
}

function collectHeadingBreadcrumb(headings: Array<{ level: number; text: string }>): string {
  return headings.map((heading) => heading.text).join(" › ") || "文档开头";
}

/** 仅改动片段：把连续改动块包成卡片并隐藏其余内容。 */
function applyFragmentsMode(host: HTMLElement): void {
  const blocks = elementChildren(host).filter((element) => !element.classList.contains("diff-notice"));
  const headings: Array<{ level: number; text: string }> = [];
  const groups: FragmentGroup[] = [];

  for (const element of blocks) {
    const headingMatch = /^H([1-6])$/.exec(element.tagName);
    if (headingMatch) {
      const level = Number(headingMatch[1]);
      while (headings.length > 0 && headings[headings.length - 1]!.level >= level) headings.pop();
      headings.push({ level, text: (element.textContent ?? "").trim() });
    }
    if (!isChangedBlock(element)) continue;
    const breadcrumb = collectHeadingBreadcrumb(headings);
    const last = groups[groups.length - 1];
    if (last && last.breadcrumb === breadcrumb && last.elements.at(-1)?.nextElementSibling === element) {
      last.elements.push(element);
    } else {
      groups.push({ elements: [element], breadcrumb });
    }
  }
  if (groups.length === 0) return;

  const cards: HTMLElement[] = groups.map((group, index) => {
    const card = document.createElement("section");
    card.className = "diff-fragment-card";
    card.setAttribute("aria-label", `改动片段 ${index + 1}`);

    const header = document.createElement("div");
    header.className = "diff-fragment-header";
    const breadcrumb = document.createElement("span");
    breadcrumb.className = "diff-fragment-breadcrumb";
    breadcrumb.textContent = group.breadcrumb;
    const count = document.createElement("span");
    count.className = "diff-fragment-count";
    count.textContent = `第 ${index + 1} 处 / 共 ${groups.length} 处`;
    const actions = document.createElement("span");
    actions.className = "diff-fragment-actions";
    const previous = document.createElement("button");
    previous.type = "button";
    previous.className = "button small ghost";
    previous.textContent = "上一处";
    const next = document.createElement("button");
    next.type = "button";
    next.className = "button small ghost";
    next.textContent = "下一处";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "button small ghost";
    back.textContent = "返回全文";
    back.addEventListener("click", () => {
      host.dispatchEvent(
        new CustomEvent("panda-diff-mode", { bubbles: true, detail: { mode: "full" } }),
      );
    });
    actions.append(previous, next, back);
    header.append(breadcrumb, count, actions);

    const body = document.createElement("div");
    body.className = "diff-fragment-body";
    for (const element of group.elements) {
      // 在原始位置留锚点，退出片段视图时恢复顺序。
      const anchor = document.createElement("span");
      anchor.className = "diff-fragment-anchor";
      anchor.dataset["anchor"] = `a${index}-${body.children.length}`;
      anchor.hidden = true;
      element.dataset["anchorRef"] = anchor.dataset["anchor"]!;
      element.before(anchor);
      body.append(element);
    }
    card.append(header, body);
    return card;
  });

  const placementAnchor = host.querySelector<HTMLElement>('[data-anchor="a0-0"]');
  if (placementAnchor) placementAnchor.after(cards[0]!);
  else host.prepend(cards[0]!);
  for (let index = 1; index < cards.length; index += 1) {
    cards[index - 1]!.after(cards[index]!);
  }
  // 卡片内部已经承载改动块，其余顶层内容全部隐藏。
  for (const element of elementChildren(host)) {
    if (element.classList.contains("diff-fragment-card") || element.classList.contains("diff-notice")) {
      continue;
    }
    element.classList.add("diff-hidden");
    element.hidden = true;
  }

  const scrollToCard = (target: HTMLElement): void => {
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  cards.forEach((card, index) => {
    const buttons = card.querySelectorAll("button");
    const [previous, next] = buttons;
    previous?.addEventListener("click", () => {
      const target = cards[(index - 1 + cards.length) % cards.length];
      if (target) scrollToCard(target);
    });
    next?.addEventListener("click", () => {
      const target = cards[(index + 1) % cards.length];
      if (target) scrollToCard(target);
    });
  });
}

function applyViewMode(host: HTMLElement, mode: DiffViewMode): void {
  if (mode === "collapse") applyCollapseMode(host, 2);
  else if (mode === "fragments") applyFragmentsMode(host);
}

/**
 * 只有几乎整篇重写（覆盖 80% 以上）才退化为块级标注。
 * 大文档局部大改仍应保留词级标记；短文档从不降级。见 §21.5。
 */
function isRewrite(diff: LineDiff, newText: string): boolean {
  const total = textLineCount(newText);
  if (total < 20) return false;
  const covered = diff.hunks.reduce(
    (sum, hunk) => (hunk.kind === "delete" ? sum : sum + hunk.newCount),
    0,
  );
  return covered / total > 0.8;
}

function textLineCount(text: string): number {
  if (!text) return 1;
  return text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").length;
}

/**
 * 在已渲染的预览 DOM 上应用差异装饰：块级底色、词级 ins/del、删除幽灵块，
 * 以及折叠/片段两种视图粒度。调用前需保证 host 是本次渲染的新 DOM。见 §21.5–§21.8。
 */
export async function applyPreviewDiff(
  host: HTMLElement,
  model: PreviewDiffModel | null,
  isCancelled: () => boolean,
): Promise<void> {
  clearPreviewDiff(host);
  if (!model) return;
  markBlocks(host, model.diff);
  const rewrite = isRewrite(model.diff, model.newText);
  if (!rewrite) {
    await applyInline(host, model.diff, model.oldText, isCancelled);
    if (isCancelled()) return;
    await applyCodeBlocks(host, model.diff, model.oldText, isCancelled);
    if (isCancelled()) return;
  }
  await appendGhosts(host, model.diff, isCancelled);
  if (isCancelled()) return;
  appendInvisibleNotice(host, model);
  if (rewrite) {
    const notice = document.createElement("div");
    notice.className = "diff-notice";
    notice.textContent = "本次改动覆盖全文 40% 以上，仅显示块级标注。";
    host.prepend(notice);
  }
  applyViewMode(host, model.mode);
}
