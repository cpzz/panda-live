import { useEffect, useRef, useState } from "react";
import { buildSearchRegex, type SearchOptions } from "../services/search";
import { DEFAULT_SEARCH_OPTIONS } from "../editor/search";
import type { PandaEditor } from "../editor/editor";

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
      <input
        ref={inputRef}
        className="search-input"
        placeholder="查找"
        value={term}
        aria-label="查找内容"
        onChange={(event) => setTerm(event.target.value)}
      />
      <input
        className="search-input"
        placeholder="替换为"
        value={replacement}
        aria-label="替换内容"
        onChange={(event) => setReplacement(event.target.value)}
      />
      <label className="search-option">
        <input
          type="checkbox"
          checked={options.caseSensitive}
          onChange={(event) => setOptions({ ...options, caseSensitive: event.target.checked })}
        />
        区分大小写
      </label>
      <label className="search-option">
        <input
          type="checkbox"
          checked={options.regex}
          onChange={(event) => setOptions({ ...options, regex: event.target.checked })}
        />
        正则
      </label>
      <label className="search-option">
        <input
          type="checkbox"
          checked={options.wholeWord}
          onChange={(event) => setOptions({ ...options, wholeWord: event.target.checked })}
        />
        全词
      </label>
      <span className="search-count" aria-live="polite">
        {regexInvalid ? "正则无效" : `${info.active} / ${info.total}`}
      </span>
      <button
        type="button"
        className="button small"
        disabled={info.total === 0}
        onClick={() => editor && setInfo(editor.findNext(-1))}
      >
        上一个
      </button>
      <button
        type="button"
        className="button small"
        disabled={info.total === 0}
        onClick={() => editor && setInfo(editor.findNext(1))}
      >
        下一个
      </button>
      <button
        type="button"
        className="button small"
        disabled={info.total === 0}
        onClick={() => {
          if (!editor) return;
          editor.replaceCurrent(replacement);
          setInfo(editor.search(term, options));
        }}
      >
        替换
      </button>
      <button
        type="button"
        className="button small"
        disabled={info.total === 0}
        onClick={() => {
          if (!editor) return;
          editor.replaceAll(replacement);
          setInfo(editor.search(term, options));
        }}
      >
        全部替换
      </button>
      <button type="button" className="button small ghost" onClick={close}>
        关闭
      </button>
    </div>
  );
}
