import { useEffect, useRef, useState } from "react";
import { buildSearchRegex, type SearchOptions } from "../services/search";
import { DEFAULT_SEARCH_OPTIONS } from "../editor/search";
import type { PandaEditor } from "../editor/editor";
import { Icon } from "./icons";

interface SearchPanelProps {
  editor: PandaEditor | null;
  /** 每次递增表示“打开查找面板”。 */
  openSignal: number;
  onClose(): void;
}

/** WYSIWYG 查找替换面板：匹配高亮由 ProseMirror 插件提供。见 doc/design.md §11.5。 */
export function SearchPanel({ editor, openSignal, onClose }: SearchPanelProps) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [replacement, setReplacement] = useState("");
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_SEARCH_OPTIONS);
  const [info, setInfo] = useState({ active: 0, total: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (openSignal === 0) return;
    setOpen(true);
    inputRef.current?.focus();
  }, [openSignal]);

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
      if (editor) {
        const result = editor.findNext(event.shiftKey ? -1 : 1);
        setInfo(result);
      }
    }
  };

  return (
    <div className="search-panel" role="search" onKeyDown={onKeyDown}>
      <div className="search-row">
        <input
          ref={inputRef}
          className="search-input"
          placeholder="查找"
          value={term}
          aria-label="查找内容"
          onChange={(event) => setTerm(event.target.value)}
        />
        <button
          type="button"
          className={options.caseSensitive ? "find-toggle active" : "find-toggle"}
          aria-label="区分大小写"
          aria-pressed={options.caseSensitive}
          title="区分大小写"
          onClick={() => setOptions({ ...options, caseSensitive: !options.caseSensitive })}
        >
          Aa
        </button>
        <button
          type="button"
          className={options.regex ? "find-toggle active" : "find-toggle"}
          aria-label="正则"
          aria-pressed={options.regex}
          title="使用正则表达式"
          onClick={() => setOptions({ ...options, regex: !options.regex })}
        >
          .*
        </button>
        <button
          type="button"
          className={options.wholeWord ? "find-toggle active" : "find-toggle"}
          aria-label="全词"
          aria-pressed={options.wholeWord}
          title="全词匹配"
          onClick={() => setOptions({ ...options, wholeWord: !options.wholeWord })}
        >
          ab
        </button>
        <span className="search-count" aria-live="polite">
          {regexInvalid ? "正则无效" : `${info.active} / ${info.total}`}
        </span>
        <button
          type="button"
          className="find-icon"
          aria-label="上一个"
          title="上一个（Shift+Enter）"
          disabled={info.total === 0}
          onClick={() => editor && setInfo(editor.findNext(-1))}
        >
          <Icon name="arrow-up" size={14} />
        </button>
        <button
          type="button"
          className="find-icon"
          aria-label="下一个"
          title="下一个（Enter）"
          disabled={info.total === 0}
          onClick={() => editor && setInfo(editor.findNext(1))}
        >
          <Icon name="arrow-down" size={14} />
        </button>
        <button type="button" className="find-icon" aria-label="关闭查找" title="关闭" onClick={close}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="search-row">
        <input
          className="search-input"
          placeholder="替换为"
          value={replacement}
          aria-label="替换内容"
          onChange={(event) => setReplacement(event.target.value)}
        />
        <button
          type="button"
          className="find-icon"
          aria-label="替换"
          title="替换"
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
          aria-label="全部替换"
          title="全部替换"
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
    </div>
  );
}
