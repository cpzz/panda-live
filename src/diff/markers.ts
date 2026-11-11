import type { DiffLineMarker } from "../source/codemirror";
import type { LineDiff } from "./compute";

/** 旧文本一侧的行标记：修改与删除。用于并排源码差异的左侧。 */
export function oldLineMarkers(diff: LineDiff): DiffLineMarker[] {
  const markers: DiffLineMarker[] = [];
  for (const hunk of diff.hunks) {
    if (hunk.kind === "change") {
      for (let line = 0; line < hunk.oldCount; line += 1) {
        markers.push({ line: hunk.oldStart + line, kind: "change" });
      }
    } else if (hunk.kind === "delete") {
      for (let line = 0; line < hunk.oldCount; line += 1) {
        markers.push({ line: hunk.oldStart + line, kind: "delete" });
      }
    }
  }
  return markers;
}

/** 新文本一侧的行标记：新增与修改。用于并排源码差异的右侧。 */
export function newLineMarkers(diff: LineDiff): DiffLineMarker[] {
  const markers: DiffLineMarker[] = [];
  for (const hunk of diff.hunks) {
    if (hunk.kind === "delete") continue;
    for (let line = 0; line < hunk.newCount; line += 1) {
      markers.push({
        line: hunk.newStart + line,
        kind: hunk.kind === "change" ? "change" : "add",
      });
    }
  }
  return markers;
}
