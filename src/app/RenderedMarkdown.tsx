import { useEffect, useRef, useState } from "react";
import { clearPreviewDiff, applyPreviewDiff, type PreviewDiffModel } from "../diff/preview";
import { renderPreviewDiagrams } from "../render/markdown/diagram-preview";
import { highlightCodeBlocks } from "../render/code-highlight";
import { onThemeChange, resolveTheme, type AppTheme } from "../services/theme";
import type { DiffViewMode } from "../shared/diff";
import { t } from "../i18n";
import { copyText } from "../utils/clipboard";
import { resolveRelativePath } from "../utils/paths";

/** 复制按钮图标：与全局线性图标（Lucide）风格一致。 */
const COPY_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>';
const CHECK_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>';

/** 移除现有复制按钮（重渲染增强前清理）。 */
function removeCopyButtons(host: HTMLElement): void {
  for (const existing of [...host.querySelectorAll(".preview-copy")]) existing.remove();
}

/**
 * 代码块复制按钮：悬停时显示在代码框外右上角，不遮挡代码内容；差异视图自带「复制原文」，不重复提供。
 * 按钮挂在 pre 外层 .code-block 包装上，避免随代码横向滚动。
 */
function attachCopyButtons(host: HTMLElement, withDiff: boolean): void {
  if (withDiff) return;
  for (const pre of [...host.querySelectorAll("pre")]) {
    const code = pre.querySelector("code");
    if (!code) continue;
    let wrapper = pre.parentElement;
    if (!wrapper || !wrapper.classList.contains("code-block")) {
      wrapper = globalThis.document.createElement("div");
      wrapper.className = "code-block";
      pre.replaceWith(wrapper);
      wrapper.append(pre);
    }
    const button = globalThis.document.createElement("button");
    button.type = "button";
    button.className = "preview-copy";
    button.setAttribute("aria-label", t("复制代码"));
    button.title = t("复制代码");
    button.innerHTML = COPY_ICON;
    button.addEventListener("click", () => {
      void copyText(code.innerText.replace(/\n$/, "")).then((copied) => {
        button.innerHTML = copied ? CHECK_ICON : COPY_ICON;
        button.classList.toggle("copied", copied);
        button.title = copied ? t("已复制") : t("复制失败");
        window.setTimeout(() => {
          button.innerHTML = COPY_ICON;
          button.classList.remove("copied");
          button.title = t("复制代码");
        }, 1200);
      });
    });
    wrapper.append(button);
  }
}

/**
 * 页内锚点跳转：`[标题](#id)` 滚动到对应元素并短暂高亮。
 * 找不到目标时返回 false，交给浏览器默认行为。
 */
function scrollToAnchor(host: HTMLElement, hash: string): boolean {
  const raw = hash.replace(/^#/, "");
  if (!raw) {
    host.scrollIntoView({ block: "start", behavior: "smooth" });
    return true;
  }
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // 非法百分号编码时按原值匹配。
  }
  const target =
    [...host.querySelectorAll<HTMLElement>("[id]")].find((element) => element.id === id) ??
    globalThis.document.getElementById(id);
  if (!target) return false;
  target.scrollIntoView({ block: "start", behavior: "smooth" });
  target.classList.add("anchor-target");
  window.setTimeout(() => target.classList.remove("anchor-target"), 900);
  return true;
}

export interface RenderedMarkdownProps {
  html: string;
  /** 用于相对图片与本地 link 解析；null 表示不解析。 */
  filePath: string | null;
  /** 图表缓存与重建的标识（同一文档应保持稳定）。 */
  sourceKey: string;
  diff: PreviewDiffModel | null;
  onDiffModeChange?: (mode: DiffViewMode) => void;
  onDiffJump?: (line: number) => void;
  className?: string;
  /**
   * 围栏块按纯文本显示：跳过图表渲染与代码高亮。
   * 预览对比用，保证改动前/后的围栏内容可直接比较。见 §21.15。
   */
  plainFences?: boolean;
  /**
   * Markdown link 点击：href 解析为本地文件路径后回调。
   * 不传时本地 link 被安全拦截（不跳），外部 URL 默认用系统默认处理器打开。
   */
  onOpenLocalFile?: (path: string) => void;
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
  plainFences = false,
  onOpenLocalFile,
}: RenderedMarkdownProps) {
  const hostRef = useRef<HTMLElement>(null);
  const [theme, setTheme] = useState<AppTheme>(resolveTheme);

  useEffect(() => onThemeChange(setTheme), []);

  // 相对图片按文档目录解析：超过 1 MB 的改为占位 + 手动加载；其余直接内联为 data URL。
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
          if (cancelled || !image.isConnected) return;
          if (stats.size <= 1024 * 1024) {
            return window.panda.fs.readBase64({ path: resolved }).then((file) => {
              if (cancelled || !image.isConnected) return;
              image.src = `data:${file.mime};base64,${file.data}`;
            });
          }
          const wrapper = globalThis.document.createElement("div");
          wrapper.className = "big-image-placeholder";
          const label = globalThis.document.createElement("span");
          label.textContent = t(
            "图片较大（{0} MB），未自动加载",
            (stats.size / (1024 * 1024)).toFixed(1),
          );
          const button = globalThis.document.createElement("button");
          button.type = "button";
          button.className = "button small";
          button.textContent = t("加载图片");
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

  // 预览增强：图表围栏替换为 SVG，代码块高亮，再应用差异装饰与复制按钮。见 §10.3、§14.2、§21.5。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // 先还原上一次的装饰（尤其是被逐行改写的代码块），避免重高亮读到删除行。
    clearPreviewDiff(host);
    removeCopyButtons(host);
    let cancelled = false;
    void (async () => {
      if (!plainFences) {
        await renderPreviewDiagrams(host, sourceKey, () => cancelled);
        if (cancelled) return;
        await highlightCodeBlocks(host, theme);
        if (cancelled) return;
      }
      await applyPreviewDiff(host, diff, () => cancelled);
      if (cancelled) return;
      attachCopyButtons(host, Boolean(diff));
    })();
    return () => {
      cancelled = true;
    };
  }, [html, sourceKey, theme, diff, plainFences]);

/**
 * 外部 http(s) 链接信任记忆（localStorage，避免频繁弹 confirm）。
 * `"1"` 表示总是信任（不再提示）；未设置或其他值表示每次都弹 confirm。
 */
const EXTERNAL_TRUST_KEY = "panda.preview.trustExternalLinks";

/** 协议分类结果。 */
type LinkKind = "anchor" | "local" | "external" | "system" | "denied";

function classifyHref(href: string): LinkKind {
  if (href.startsWith("#")) return "anchor";
  // 协议判断前先尝试 decode——Markdown 渲染器会把非 ASCII 字符 URL 编码，
  // scheme 前缀不会受影响，但 pathname 里可能有编码字符。
  try {
    href = decodeURIComponent(href);
  } catch {
    // 非法 URI（如孤立 %），保持原值让后续分类拒绝。
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
    try {
      const protocol = new URL(href).protocol.toLowerCase();
      if (protocol === "http:" || protocol === "https:") return "external";
      if (protocol === "mailto:" || protocol === "tel:" || protocol === "file:") return "system";
      return "denied";
    } catch {
      return "denied";
    }
  }
  // / 开头的"绝对路径"（相对文档根）在 Markdown 预览中不支持，安全起见 denied。
  if (href.startsWith("/") || href.startsWith("\\")) return "denied";
  return "local";
}

/** 提示用户打开外部 http(s) 链接；第一次提示后记住，后续静默打开。 */
function confirmOpenExternal(url: string): boolean {
  if (localStorage.getItem(EXTERNAL_TRUST_KEY) === "1") return true;
  const proceed = window.confirm(
    `即将用默认浏览器打开：\n${url}\n\n点击"确定"打开，此偏好将被记住；"取消"则不打开。`,
  );
  if (proceed) localStorage.setItem(EXTERNAL_TRUST_KEY, "1");
  return proceed;
}

/** 统一拦截预览中的 <a> 点击，分流为锚点滚动 / 本地文件打开 / 外部 URL。 */
function handleLinkClick(
  event: MouseEvent,
  host: HTMLElement,
  filePath: string | null,
  onOpenLocalFile?: (path: string) => void,
): void {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const link = target.closest("a[href]");
  if (!(link instanceof HTMLAnchorElement)) return;
  const href = link.getAttribute("href") ?? "";
  if (!href) return;
  const kind = classifyHref(href);
  switch (kind) {
    case "anchor":
      if (scrollToAnchor(host, href)) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    case "local": {
      if (!filePath || !onOpenLocalFile) return;
      const resolved = resolveRelativePath(filePath, href);
      if (!resolved) return;
      event.preventDefault();
      event.stopPropagation();
      onOpenLocalFile(resolved);
      return;
    }
    case "external": {
      event.preventDefault();
      event.stopPropagation();
      if (confirmOpenExternal(href)) {
        void window.panda.shell.openExternal(href);
      }
      return;
    }
    case "system": {
      event.preventDefault();
      event.stopPropagation();
      void window.panda.shell.openExternal(href);
      return;
    }
    case "denied":
    default:
      // 未知或被禁止的 href：统一拦截，不交给浏览器。
      event.preventDefault();
      event.stopPropagation();
  }
}

  // 页内目录与 Markdown link：统一拦截 <a[href]>，分流为锚点滚动 / 本地文件打开 / 外部 URL。
  // 主进程已对 window.open 与 will-navigate 做 deny 兜底，这里再做 renderer 层分流。见 §12.5。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onClick = (event: MouseEvent): void => {
      handleLinkClick(event, host, filePath, onOpenLocalFile);
    };
    host.addEventListener("click", onClick);
    return () => host.removeEventListener("click", onClick);
  }, [html, filePath, onOpenLocalFile]);

  // MyST 预览页签：点击页签按钮切换激活项，机制与 WYSIWYG 一致（data-active 索引）。见 §8.2。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLElement>(".myst-tab-button");
      const bar = button?.parentElement;
      if (!button || !bar || !bar.classList.contains("myst-tab-bar")) return;
      const set = bar.closest<HTMLElement>(".myst-tab-set");
      if (!set) return;
      const index = [...bar.children].indexOf(button);
      if (index < 0) return;
      set.setAttribute("data-active", String(index));
      [...bar.children].forEach((child, childIndex) => {
        const item = child as HTMLElement;
        item.classList.toggle("active", childIndex === index);
        item.setAttribute("aria-selected", String(childIndex === index));
      });
    };
    host.addEventListener("click", onClick);
    return () => host.removeEventListener("click", onClick);
  }, [html]);

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
