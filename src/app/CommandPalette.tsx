import { useEffect, useRef, useState } from "react";

export interface CommandItem {
  id: string;
  title: string;
  /** 快捷键提示文本，仅用于展示。 */
  shortcut?: string;
  run(): void | Promise<void>;
}

function matches(command: CommandItem, query: string): boolean {
  if (!query) return true;
  return command.title.toLowerCase().includes(query) || command.id.toLowerCase().includes(query);
}

/**
 * 命令面板：`Ctrl+Shift+P` 打开，支持过滤、上下键选择、Enter 执行、Esc 关闭。
 * 应用命令与扩展贡献命令共用同一列表。见 doc/design.md §15.1。
 */
export function CommandPalette({
  open,
  commands,
  onClose,
  onRun,
}: {
  open: boolean;
  commands: CommandItem[];
  onClose(): void;
  onRun(command: CommandItem): void | Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const filtered = commands.filter((command) => matches(command, query.trim().toLowerCase()));

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const container = listRef.current;
    const item = container?.querySelectorAll<HTMLElement>(".palette-item")[active];
    item?.scrollIntoView({ block: "nearest" });
  }, [active, open, query]);

  if (!open) return null;

  const runAt = (index: number): void => {
    const command = filtered[index];
    if (!command) return;
    onClose();
    void onRun(command);
  };

  return (
    <div className="palette-backdrop" role="presentation" onClick={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          autoFocus
          className="palette-input"
          placeholder="输入命令名称或标识…"
          aria-label="命令搜索"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => Math.min(filtered.length - 1, index + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(0, index - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              runAt(active);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {filtered.map((command, index) => (
            <button
              key={command.id}
              type="button"
              className={index === active ? "palette-item active" : "palette-item"}
              onMouseEnter={() => setActive(index)}
              onClick={() => runAt(index)}
            >
              <span className="palette-title">{command.title}</span>
              {command.shortcut && <span className="palette-key">{command.shortcut}</span>}
            </button>
          ))}
          {filtered.length === 0 && <p className="palette-empty">无匹配命令</p>}
        </div>
      </div>
    </div>
  );
}
