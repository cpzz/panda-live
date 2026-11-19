import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  buildSearchRegex,
  findMatches,
  type SearchOptions,
  type SearchRequest,
} from "../services/search";
import { DEFAULT_SEARCH_OPTIONS } from "../editor/search";
import { t } from "../i18n";
import { Icon } from "./icons";

const ALL_HIGHLIGHT = "panda-preview-search";
const ACTIVE_HIGHLIGHT = "panda-preview-search-active";

interface HighlightRegistryLike {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

interface HighlightApi {
  registry: HighlightRegistryLike;
  create(ranges: Range[]): unknown;
}

/** CSS Custom Highlight API：不修改渲染 DOM，避免与 React/预览增强互相覆盖。 */
function highlightApi(): HighlightApi | null {
  const registry =
    typeof CSS === "undefined"
      ? undefined
      : (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights;
  const HighlightCtor = (window as unknown as {
    Highlight?: new (...ranges: Range[]) => unknown;
  }).Highlight;
  if (!registry || !HighlightCtor) return null;
  return { registry, create: (ranges) => new HighlightCtor(...ranges) };
}

function clearHighlights(): void {
  const api = highlightApi();
  api?.registry.delete(ALL_HIGHLIGHT);
  api?.registry.delete(ACTIVE_HIGHLIGHT);
}

interface PreviewSearchPanelProps {
  containerRef: RefObject<HTMLDivElement | null>;
  request: SearchRequest | null;
  /** 渲染后的 HTML；变化时重新计算匹配。 */
  contentKey: string;
}

/** 预览模式查找：只查找，不提供替换（预览为只读）。见 doc/design.md §11.5。 */
export function PreviewSearchPanel({ containerRef, request, contentKey }: PreviewSearchPanelProps) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_SEARCH_OPTIONS);
  const [matches, setMatches] = useState<Range[]>([]);
  const [active, setActive] = useState(0);
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Ctrl+F/H 打开面板时待聚焦标记；由 ref callback 在 DOM 提交时同步消费。 */
  const pendingFocusRef = useRef(false);
  /** 已消费的请求 token；模式切换导致 request 变为 null 再恢复时不重放。 */
  const handledTokenRef = useRef(0);

  useEffect(() => {
    if (!request) {
      setOpen(false);
      clearHighlights();
      return;
    }
    if (request.token === handledTokenRef.current) return;
    handledTokenRef.current = request.token;
    // 只响应预览模式（含分栏右侧）发起的请求。
    if (request.editorMode && request.editorMode !== "preview" && request.editorMode !== "split") {
      return;
    }
    // 只响应预览面板的请求；分栏中焦点在源码时关闭预览面板。
    if (request.surface && request.surface !== "preview") {
      setOpen(false);
      clearHighlights();
      return;
    }
    setOpen(true);
    if (request.seed) setTerm(request.seed);
    if (request.options) setOptions(request.options);
    // 面板已挂载时立即聚焦；首次打开面板尚未挂载，交给 ref callback 同步聚焦——
    // 不用 requestAnimationFrame：窗口被遮挡节流时回调不执行，焦点会丢失。
    if (inputRef.current) {
      inputRef.current.focus();
    } else {
      pendingFocusRef.current = true;
    }
  }, [request]);

  /** 查找输入框的 ref callback：DOM 提交时同步消费待聚焦标记。 */
  const focusSearchInput = (el: HTMLInputElement | null): void => {
    inputRef.current = el;
    if (el && pendingFocusRef.current) {
      pendingFocusRef.current = false;
      el.focus();
    }
  };

  // 输入、选项或预览内容变化后重算匹配。
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      const host = containerRef.current;
      const regexInvalid = Boolean(term) && options.regex && buildSearchRegex(term, options) === null;
      setInvalid(regexInvalid);
      if (!host || !term || regexInvalid) {
        setMatches([]);
        setActive(0);
        clearHighlights();
        return;
      }
      const ranges: Range[] = [];
      const walker = window.document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || parent.closest("script, style, .preview-copy")) continue;
        const text = node.nodeValue ?? "";
        for (const match of findMatches(text, term, options)) {
          const range = window.document.createRange();
          range.setStart(node, match.start);
          range.setEnd(node, match.end);
          ranges.push(range);
        }
      }
      setMatches(ranges);
      setActive(0);
      const api = highlightApi();
      api?.registry.set(ALL_HIGHLIGHT, api.create(ranges));
    }, 80);
    return () => clearTimeout(timer);
  }, [open, term, options, contentKey, containerRef]);

  // 当前匹配单独高亮，并滚动到可视区。
  useEffect(() => {
    if (!open || matches.length === 0) {
      highlightApi()?.registry.delete(ACTIVE_HIGHLIGHT);
      return;
    }
    const range = matches[Math.min(active, matches.length - 1)];
    if (!range) return;
    const api = highlightApi();
    api?.registry.set(ACTIVE_HIGHLIGHT, api.create([range]));
    (range.startContainer.parentElement ?? containerRef.current)?.scrollIntoView({
      block: "center",
    });
  }, [open, active, matches, containerRef]);

  useEffect(() => clearHighlights, []);

  // 预览面板的 Esc 不依赖输入框焦点：窗口任意位置按 Esc 都能关闭。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      clearHighlights();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  const step = (direction: 1 | -1): void => {
    if (matches.length === 0) return;
    setActive((current) => (current + direction + matches.length) % matches.length);
  };

  const close = (): void => {
    setOpen(false);
    clearHighlights();
  };

  if (!open) return null;

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
  };

  return (
    <div className="search-panel preview-search-panel" role="search" onKeyDown={onKeyDown}>
      <div className="search-row">
        <div className="search-field">
          <input
            ref={focusSearchInput}
            className="search-input"
            placeholder={t("查找")}
            value={term}
            aria-label={t("查找内容")}
            onChange={(event) => setTerm(event.target.value)}
          />
          <button
            type="button"
            className="find-clear"
            aria-label={t("清除")}
            title={t("清除")}
            disabled={term.length === 0}
            onClick={() => {
              setTerm("");
              inputRef.current?.focus();
            }}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
        <button
          type="button"
          className={options.caseSensitive ? "find-toggle active" : "find-toggle"}
          aria-label={t("区分大小写")}
          aria-pressed={options.caseSensitive}
          title={t("区分大小写")}
          onClick={() => setOptions({ ...options, caseSensitive: !options.caseSensitive })}
        >
          Aa
        </button>
        <button
          type="button"
          className={options.regex ? "find-toggle active" : "find-toggle"}
          aria-label={t("正则")}
          aria-pressed={options.regex}
          title={t("使用正则表达式")}
          onClick={() => setOptions({ ...options, regex: !options.regex })}
        >
          .*
        </button>
        <button
          type="button"
          className={options.wholeWord ? "find-toggle active" : "find-toggle"}
          aria-label={t("全词")}
          aria-pressed={options.wholeWord}
          title={t("全词匹配")}
          onClick={() => setOptions({ ...options, wholeWord: !options.wholeWord })}
        >
          ab
        </button>
        <span className="search-count" aria-live="polite">
          {invalid ? t("正则无效") : `${matches.length === 0 ? 0 : active + 1} / ${matches.length}`}
        </span>
        <button
          type="button"
          className="find-icon"
          aria-label={t("上一个")}
          title={t("上一个（Shift+Enter）")}
          disabled={matches.length === 0}
          onClick={() => step(-1)}
        >
          <Icon name="arrow-up" size={14} />
        </button>
        <button
          type="button"
          className="find-icon"
          aria-label={t("下一个")}
          title={t("下一个（Enter）")}
          disabled={matches.length === 0}
          onClick={() => step(1)}
        >
          <Icon name="arrow-down" size={14} />
        </button>
      </div>
    </div>
  );
}
