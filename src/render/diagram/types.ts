/** 图表渲染协议与结果类型。见 doc/design.md §10.1。 */

export type BuiltinDiagramKind = "plantuml" | "mermaid";

export type DiagramKind = BuiltinDiagramKind | (string & {});

export type DiagramTheme = "light" | "dark";

export interface RenderRequest {
  id: string;
  kind: DiagramKind;
  source: string;
  theme: DiagramTheme;
  engineVersion: string;
}

export type RenderResponse =
  | { id: string; ok: true; svg: string }
  | { id: string; ok: false; error: string; line?: number };

export type DiagramResult =
  | { ok: true; svg: string }
  | { ok: false; error: string; line?: number; code: string };

/** 源码长度上限 1 MB。见 doc/design.md §13.6。 */
export const MAX_DIAGRAM_SOURCE_LENGTH = 1024 * 1024;

/** 渲染硬超时 15 s。见 doc/design.md §10.1、FR-06。 */
export const DIAGRAM_RENDER_TIMEOUT_MS = 15000;

/** 引擎版本参与缓存键计算；升级引擎时需同步更新。 */
export const DIAGRAM_ENGINE_VERSION = "mermaid@11+plantuml@1.2026.9";

export function isBuiltinDiagramKind(value: string): value is BuiltinDiagramKind {
  return value === "plantuml" || value === "mermaid";
}
