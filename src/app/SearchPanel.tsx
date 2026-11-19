import { useEffect, useRef, useState } from "react";
import { buildSearchRegex, type SearchMode, type SearchOptions, type SearchRequest } from "../services/search";
import { DEFAULT_SEARCH_OPTIONS } from "../editor/search";
import type { PandaEditor } from "../editor/editor";
import { t } from "../i18n";
import { Icon } from "./icons";

interface SearchPanelProps {
  editor: PandaEditor | null;
  /** 查找/替换请求；token 递增表示重新聚焦，mode 决定是否显示替换行。 */
  request: SearchRequest | null;
  onClose(): void;
}

/** WYSIWYG 查找替换面板：匹配高亮由 ProseMirror 插件提供。见 doc/design.md §11.5。 */
export function SearchPanel({ editor, request, onClose }: SearchPanelProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<SearchMode>("find");
  const [term, setTerm] = useState("");
  const [replacement, setReplacement] = useState("");
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_SEARCH_OPTIONS);
  const [info, setInfo] = useState({ active: 0, total: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  /** Ctrl+F/H 打开面板时待聚焦标记；由 ref callback 在 DOM 提交时同步消费。 */
  const pendingFocusRef = useRef(false);
  /** 已消费的请求 token；模式切换导致 request 变为 null 再恢复时不重放。 */
  const handledTokenRef = useRef(0);

  useEffect(() => {
    if (!request) return;
    if (request.token === handledTokenRef.current) return;
    handledTokenRef.current = request.token;
    // 请求只在发起它的编辑模式生效，避免切换模式后重放。
    if (request.editorMode && request.editorMode !== "wysiwyg") return;
    if (request.surface && request.surface !== "wysiwyg") return;
    setOpen(true);
    setMode(request.mode);
    // 选中的文本作为查找源；没有选区时保留上一次的查找词。
    if (request.seed) setTerm(request.seed);
    if (request.replacement !== undefined) setReplacement(request.replacement);
    if (request.options) setOptions(request.options);
    // Ctrl+F / Ctrl+H 打开时都聚焦查找框，替换框由展开按钮或 Tab 进入。
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

  // 模式切换时 request 变为 null：关闭面板，避免切回该模式时重新出现。
  useEffect(() => {
    if (request || !open) return;
    editor?.clearSearch();
    setOpen(false);
  }, [request, open, editor]);

  // Esc 不依赖输入框焦点：窗口任意位置都能关闭查找面板。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      editor?.clearSearch();
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, editor]);

  useEffect(() => {
    if (!open || !editor) return;
    const timer = setTimeout(() => {
      setInfo(editor.search(term, options));
    }, 120);
    return () => {
      clearTimeout(timer);
    };
  }, [open, editor, term, options]);

  if (!open) return null;

  const regexInvalid = options.regex && term.length > 0 && buildSearchRegex(term, options) === null;

  const close = (): void => {
    editor?.clearSearch();
    setOpen(false);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!editor) return;
      // 查找框 Enter 跳到下一个匹配；替换框 Enter 替换当前匹配。
      if (event.target === replaceInputRef.current) {
        editor.replaceCurrent(replacement);
        setInfo(editor.search(term, options));
      } else {
        setInfo(editor.findNext(event.shiftKey ? -1 : 1));
      }
    }
  };

  return (
    <div className="search-panel" role="search" onKeyDown={onKeyDown}>
      <div className="search-row">
        <button
          type="button"
          className="find-toggle"
          aria-label={mode === "replace" ? t("收起替换") : t("展开替换")}
          aria-expanded={mode === "replace"}
          title={
            mode === "replace"
              ? t("收起替换（Ctrl+F）")
              : navigator.platform.startsWith("Mac")
                ? t("展开替换")
                : t("展开替换（Ctrl+H）")
          }
          onClick={() => {
            const next = mode === "replace" ? "find" : "replace";
            setMode(next);
            // 展开后聚焦替换框，收起后回到查找框。
            requestAnimationFrame(() => {
              (next === "replace" ? replaceInputRef.current : inputRef.current)?.focus();
            });
          }}
        >
          <Icon name={mode === "replace" ? "chevron-down" : "chevron-right"} size={14} />
        </button>
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
          {regexInvalid ? t("正则无效") : `${info.active} / ${info.total}`}
        </span>
        <button
          type="button"
          className="find-icon"
          aria-label={t("上一个")}
          title={t("上一个（Shift+Enter）")}
          disabled={info.total === 0}
          onClick={() => editor && setInfo(editor.findNext(-1))}
        >
          <Icon name="arrow-up" size={14} />
        </button>
        <button
          type="button"
          className="find-icon"
          aria-label={t("下一个")}
          title={t("下一个（Enter）")}
          disabled={info.total === 0}
          onClick={() => editor && setInfo(editor.findNext(1))}
        >
          <Icon name="arrow-down" size={14} />
        </button>
      </div>
      {mode === "replace" && (
        <div className="search-row search-replace-row">
          <span className="search-spacer" aria-hidden="true" />
          <div className="search-field">
            <input
              ref={replaceInputRef}
              className="search-input"
              placeholder={t("替换为")}
              value={replacement}
              aria-label={t("替换内容")}
              onChange={(event) => setReplacement(event.target.value)}
            />
            <button
              type="button"
              className="find-clear"
              aria-label={t("清除")}
              title={t("清除")}
              disabled={replacement.length === 0}
              onClick={() => {
                setReplacement("");
                replaceInputRef.current?.focus();
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
          <button
            type="button"
            className="find-icon"
            aria-label={t("替换")}
            title={t("替换（Enter）")}
            disabled={info.total === 0}
            onClick={() => {
              if (!editor) return;
              editor.replaceCurrent(replacement);
              setInfo(editor.search(term, options));
            }}
          >
            <Icon name="replace" size={14} />
          </button>
          <button
            type="button"
            className="find-icon"
            aria-label={t("全部替换")}
            title={t("全部替换")}
            disabled={info.total === 0}
            onClick={() => {
              if (!editor) return;
              editor.replaceAll(replacement);
              setInfo(editor.search(term, options));
            }}
          >
            <Icon name="replace-all" size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
