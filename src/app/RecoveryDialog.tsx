import type { DraftEntry } from "../shared/ipc";

interface RecoveryDialogProps {
  entries: DraftEntry[];
  onRestore(entry: DraftEntry): void;
  onDiscard(entry: DraftEntry): void;
  onClose(): void;
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

/** 启动时的崩溃恢复提示。见 doc/design.md §12.4、§16.3（场景 6）。 */
export function RecoveryDialog({ entries, onRestore, onDiscard, onClose }: RecoveryDialogProps) {
  if (entries.length === 0) return null;

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label="恢复未保存的草稿">
        <header className="modal-header">
          <h2>发现未保存的草稿</h2>
        </header>
        <div className="modal-body">
          <p className="settings-note">
            应用上次未正常退出。可以恢复草稿，或丢弃以使用磁盘上的内容。
          </p>
          <ul className="draft-list">
            {entries.map((entry) => (
              <li key={entry.key} className="draft-item">
                <div className="draft-meta">
                  <strong>{entry.path ?? "未命名文档"}</strong>
                  <span>{formatTime(entry.savedAt)}</span>
                </div>
                <div className="draft-actions">
                  <button type="button" className="button small primary" onClick={() => onRestore(entry)}>
                    恢复
                  </button>
                  <button type="button" className="button small" onClick={() => onDiscard(entry)}>
                    丢弃
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <footer className="modal-footer">
          <button type="button" className="button ghost" onClick={onClose}>
            稍后处理
          </button>
        </footer>
      </div>
    </div>
  );
}
