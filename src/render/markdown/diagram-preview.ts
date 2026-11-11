import { t } from "../../i18n";
import { currentDiagramTheme, getDiagramService } from "../diagram";
import type { DiagramKind } from "../diagram/types";

const DIAGRAM_LANGUAGES: Record<string, DiagramKind> = {
  plantuml: "plantuml",
  puml: "plantuml",
  uml: "plantuml",
  mermaid: "mermaid",
  mmd: "mermaid",
};

/** 围栏语言是否对应图表；与 §10.2 的别名保持一致。 */
export function diagramKindForLanguage(language: string | null): DiagramKind | null {
  if (!language) return null;
  return DIAGRAM_LANGUAGES[language.toLowerCase()] ?? null;
}

function codeLanguageOf(code: HTMLElement): string | null {
  for (const name of code.classList) {
    if (name.startsWith("language-")) return name.slice("language-".length);
  }
  return null;
}

/**
 * 把 Markdown 预览中的 PlantUML/Mermaid 围栏替换为沙箱渲染的 SVG。
 * SVG 由图表服务在父窗口消毒；失败时展示错误卡片。见 doc/design.md §10.3。
 */
export async function renderPreviewDiagrams(
  root: HTMLElement,
  idPrefix: string,
  isCancelled: () => boolean,
): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>("pre > code")];
  for (const code of blocks) {
    const kind = diagramKindForLanguage(codeLanguageOf(code));
    if (!kind) continue;
    const pre = code.parentElement;
    if (!pre) continue;
    const host = document.createElement("div");
    host.className = "preview-diagram";
    host.dataset.kind = kind;
    // 保留源码，主题切换时可重新渲染。
    host.dataset.source = code.textContent ?? "";
    host.textContent = t("正在渲染图表…");
    pre.replaceWith(host);
  }

  const hosts = [...root.querySelectorAll<HTMLElement>(".preview-diagram[data-kind][data-source]")];
  for (const [index, host] of hosts.entries()) {
    if (isCancelled()) return;
    const kind = host.dataset.kind as DiagramKind;
    const result = await getDiagramService().render({
      id: `${idPrefix}:${index}`,
      kind,
      source: host.dataset.source ?? "",
      theme: currentDiagramTheme(),
    });
    if (isCancelled()) return;
    if (result.ok) {
      host.classList.add("diagram-svg-preview");
      host.innerHTML = result.svg;
    } else if (result.code !== "E_CANCELLED") {
      host.textContent = t("图表渲染失败：{0}", result.error);
      host.classList.add("preview-diagram-error");
    }
  }
}
