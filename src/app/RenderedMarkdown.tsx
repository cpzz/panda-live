import { useEffect, useRef, useState } from "react";
import { clearPreviewDiff, applyPreviewDiff, type PreviewDiffModel } from "../diff/preview";
import { renderPreviewDiagrams } from "../render/markdown/diagram-preview";
import { highlightCodeBlocks } from "../render/code-highlight";
import { onThemeChange, resolveTheme, type AppTheme } from "../services/theme";
import type { DiffViewMode } from "../shared/diff";
import { resolveRelativePath } from "../utils/paths";

export interface RenderedMarkdownProps {
  html: string;
  /** 用于相对图片路径解析；null 表示不解析。 */
  filePath: string | null;
  /** 图表缓存与重建的标识（同一文档应保持稳定）。 */
  sourceKey: string;
  diff: PreviewDiffModel | null;
  onDiffModeChange?: (mode: DiffViewMode) => void;
  onDiffJump?: (line: number) => void;
  className?: string;
}

/**
 * 渲染后的 Markdown 容器：代码高亮、图表、差异装饰与复制清理。
 * 预览与 Git 差异面板共用，保证两种视图的渲染行为一致。见 §21.5、§21.8。
 */
export function RenderedMarkdown({
  html,
  filePath,
  sourceKey,
  diff,
  onDiffModeChange,
  onDiffJump,
  className,
}: RenderedMarkdownProps) {
  const hostRef = useRef<HTMLElement>(null);
  const [theme, setTheme] = useState<AppTheme>(resolveTheme);

  useEffect(() => onThemeChange(setTheme), []);

  // 超过 1 MB 的图片改为占位 + 手动加载。见 doc/design.md §14.3。
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !filePath) return;
    let cancelled = false;
    for (const image of [...host.querySelectorAll("img")]) {
      const src = image.getAttribute("src") ?? "";
      const resolved = resolveRelativePath(filePath, src);
      if (!resolved) continue;
      void window.panda.fs
        .stat({ path: resolved })
        .then((stats) => {
          if (cancelled || stats.size <= 1024 * 1024) return;
          const wrapper = globalThis.document.createElement("div");
          wrapper.className = "big-image-placeholder";
          const label = globalThis.document.createElement("span");
          label.textContent = `图片较大（${(stats.size / (1024 * 1024)).toFixed(1)} MB），未自动加载`;
          const button = globalThis.document.createElement("button");
          button.type = "button";
          button.className = "button small";
          button.textContent = "加载图片";
          button.addEventListener("click", () => {
            void window.panda.fs.readBase64({ path: resolved }).then((file) => {
              const loaded = globalThis.document.createElement("img");
              loaded.src = `data:${file.mime};base64,${file.data}`;
              wrapper.replaceWith(loaded);
            });
          });
          wrapper.append(label, button);
          image.replaceWith(wrapper);
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [html, filePath]);

  // 预览增强：图表围栏替换为 SVG，代码块高亮，最后应用差异装饰。见 §10.3、§14.2、§21.5。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // 先还原上一次的装饰（尤其是被逐行改写的代码块），避免重高亮读到删除行。
    clearPreviewDiff(host);
    let cancelled = false;
    void (async () => {
      await renderPreviewDiagrams(host, sourceKey, () => cancelled);
      if (cancelled) return;
      await highlightCodeBlocks(host, theme);
      if (cancelled) return;
      await applyPreviewDiff(host, diff, () => cancelled);
    })();
    return () => {
      cancelled = true;
    };
  }, [html, sourceKey, theme, diff]);

  // 片段视图的「返回全文」通过 DOM 事件通知上层切换粒度。
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !diff || !onDiffModeChange) return;
    const handleMode = (event: Event): void => {
      const mode = (event as CustomEvent<{ mode?: DiffViewMode }>).detail?.mode;
      if (mode) onDiffModeChange(mode);
    };
    host.addEventListener("panda-diff-mode", handleMode);
    return () => host.removeEventListener("panda-diff-mode", handleMode);
  }, [diff, onDiffModeChange]);

  // 复制时剥离删除幽灵块与 ins/del 标记，产物与未开启 diff 一致。见 §21.8.6。
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !diff) return;
    const onCopy = (event: ClipboardEvent): void => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      const container = document.createElement("div");
      for (let index = 0; index < selection.rangeCount; index += 1) {
        container.append(selection.getRangeAt(index).cloneContents());
      }
      for (const ghost of [...container.querySelectorAll("[data-diff-ghost]")]) ghost.remove();
      for (const row of [...container.querySelectorAll("[data-diff-before]")]) row.remove();
      for (const mark of [...container.querySelectorAll("del.diff-inline-del")]) mark.remove();
      for (const mark of [...container.querySelectorAll("ins.diff-inline-add")]) {
        mark.replaceWith(...[...mark.childNodes]);
      }
      event.clipboardData?.setData("text/plain", container.textContent ?? "");
      event.clipboardData?.setData("text/html", container.innerHTML);
      event.preventDefault();
    };
    host.addEventListener("copy", onCopy);
    return () => host.removeEventListener("copy", onCopy);
  }, [diff]);

  // 双击 ins/del 定位到源码对应行。见 §21.8.4。
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !diff || !onDiffJump) return;
    const onDoubleClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const mark = target.closest("ins.diff-inline-add, del.diff-inline-del");
      if (!mark) return;
      const block = mark.closest<HTMLElement>("[data-src-line]");
      if (!block) return;
      const start = Number(block.dataset["srcLine"]);
      if (!Number.isFinite(start) || start <= 0) return;
      const range = globalThis.document.createRange();
      range.selectNodeContents(block);
      range.setEndBefore(mark);
      const lines = (range.toString().match(/\n/g) ?? []).length;
      onDiffJump(start + lines);
    };
    host.addEventListener("dblclick", onDoubleClick);
    return () => host.removeEventListener("dblclick", onDoubleClick);
  }, [diff, onDiffJump]);

  return (
    <article
      className={className ? `markdown-body ${className}` : "markdown-body"}
      ref={hostRef}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
