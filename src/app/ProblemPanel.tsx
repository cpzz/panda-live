import type { Problem, ProblemSource } from "../services/problem-store";

const SOURCE_LABELS: Record<ProblemSource, string> = {
  markdown: "解析",
  latex: "LaTeX",
  extension: "扩展",
  diagram: "图表",
  math: "公式",
};

const SEVERITY_LABELS: Record<Problem["severity"], string> = {
  error: "错误",
  warning: "警告",
  info: "提示",
};

const SEVERITY_ORDER: Record<Problem["severity"], number> = { error: 0, warning: 1, info: 2 };

function sortProblems(problems: readonly Problem[]): Problem[] {
  return [...problems].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER);
  });
}

/** 问题面板：汇总当前文档的诊断，点击可按行跳转。见 doc/design.md §15.1。 */
export function ProblemPanel({
  problems,
  onSelect,
  onClose,
}: {
  problems: readonly Problem[];
  onSelect(problem: Problem): void;
  onClose(): void;
}) {
  const items = sortProblems(problems);

  return (
    <section className="problem-panel" aria-label="问题面板">
      <div className="problem-panel-header">
        <span className="problem-panel-title">问题</span>
        <span className="problem-panel-count">共 {items.length} 条</span>
        <button type="button" className="button small ghost" onClick={onClose}>
          关闭
        </button>
      </div>
      {items.length > 0 ? (
        <div className="problem-list">
          {items.map((problem) => (
            <button
              key={problem.id}
              type="button"
              className={`problem-row ${problem.severity}`}
              onClick={() => onSelect(problem)}
            >
              <span className="problem-severity">{SEVERITY_LABELS[problem.severity]}</span>
              <span className="problem-message">{problem.message}</span>
              {problem.line !== undefined && (
                <span className="problem-line">
                  行 {problem.line}
                  {problem.column !== undefined ? `，列 ${problem.column}` : ""}
                </span>
              )}
              <span className="problem-source">{SOURCE_LABELS[problem.source]}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="sidebar-empty">当前文档无诊断</p>
      )}
    </section>
  );
}
