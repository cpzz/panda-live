import type { DiagramKind } from "./types";
import { MAX_DIAGRAM_SOURCE_LENGTH } from "./types";

export type NormalizeResult = { ok: true; source: string } | { ok: false; error: string; code: string };

/** PlantUML 禁止的命令：外部文件引用会读取本地/远程内容。见 §10.2、§13.6。 */
const PLANTUML_FORBIDDEN = /^\s*!(?:include|import|inc)\b/iu;
const REMOTE_URL = /\b(?:https?|ftp|file):\/\//iu;
/** Mermaid 禁止 `click` 外链，防止点击跳转外站或执行脚本。 */
const MERMAID_CLICK_LINK = /^\s*click\s+[^\n]*\b(?:href\s+)?["']?(?:https?|javascript|data):/iu;

/**
 * 图表源码规范化与安全校验。见 doc/design.md §10.2：
 * PlantUML 自动补齐 `@startuml`/`@enduml` 并拒绝 include/远程 URL；
 * Mermaid 去除首尾空行并禁止 `click` 外链。
 */
export function normalizeDiagramSource(kind: DiagramKind, source: string): NormalizeResult {
  if (source.length > MAX_DIAGRAM_SOURCE_LENGTH) {
    return {
      ok: false,
      error: `图表源码超过 ${MAX_DIAGRAM_SOURCE_LENGTH / 1024} KB，已拒绝渲染`,
      code: "E_PAYLOAD_INVALID",
    };
  }

  const lines = source.replace(/\r\n?/g, "\n").split("\n");

  if (kind === "plantuml") {
    for (const [index, line] of lines.entries()) {
      if (PLANTUML_FORBIDDEN.test(line)) {
        return {
          ok: false,
          error: `第 ${index + 1} 行：不允许 !include / !import，请将依赖内容内联`,
          code: "E_DIAGRAM_UNTRUSTED",
        };
      }
      if (REMOTE_URL.test(line)) {
        return {
          ok: false,
          error: `第 ${index + 1} 行：不允许远程 URL 引用`,
          code: "E_DIAGRAM_UNTRUSTED",
        };
      }
    }
    const trimmed = lines.join("\n").trim();
    if (!trimmed) return { ok: false, error: "图表源码为空", code: "E_DIAGRAM_EMPTY" };
    if (/^\s*@start/imu.test(trimmed)) return { ok: true, source: `${trimmed}\n` };
    return { ok: true, source: `@startuml\n${trimmed}\n@enduml\n` };
  }

  if (kind === "mermaid") {
    for (const [index, line] of lines.entries()) {
      if (MERMAID_CLICK_LINK.test(line)) {
        return {
          ok: false,
          error: `第 ${index + 1} 行：不允许 click 外链`,
          code: "E_DIAGRAM_UNTRUSTED",
        };
      }
    }
    const trimmed = lines.join("\n").trim();
    if (!trimmed) return { ok: false, error: "图表源码为空", code: "E_DIAGRAM_EMPTY" };
    return { ok: true, source: `${trimmed}\n` };
  }

  // 扩展注册的 kind 由扩展自身校验；此处只做长度与空内容检查。
  const trimmed = source.trim();
  if (!trimmed) return { ok: false, error: "图表源码为空", code: "E_DIAGRAM_EMPTY" };
  return { ok: true, source: trimmed };
}
