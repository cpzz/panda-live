/** 渲染进程内的问题汇总：解析、扩展与 TeX 编译诊断统一进入问题面板。见 doc/design.md §15.1。 */

export type ProblemSeverity = "error" | "warning" | "info";

export type ProblemSource = "markdown" | "latex" | "extension" | "diagram" | "math";

export interface Problem {
  /** 来源内唯一标识，用于 React key。 */
  id: string;
  source: ProblemSource;
  severity: ProblemSeverity;
  message: string;
  /** 1-based 源码行号。 */
  line?: number;
  /** 1-based 列号。 */
  column?: number;
  /** 同一来源内的分组键：按节点上报时用于覆盖该节点的旧诊断。 */
  key: string;
}

export type ProblemInput = Omit<Problem, "id" | "source" | "key">;

export interface ProblemState {
  byDocument: Record<string, Problem[]>;
}

export const EMPTY_PROBLEMS: readonly Problem[] = [];

/**
 * 按文档、按来源覆盖诊断：每次 `setSource` 替换该来源的全部问题，
 * 其余来源保持不变。状态不可变，配合 `useSyncExternalStore` 使用。
 */
export class ProblemStore {
  private state: ProblemState = { byDocument: {} };
  private readonly listeners = new Set<(state: ProblemState) => void>();

  readonly getState = (): ProblemState => this.state;

  readonly subscribe = (listener: (state: ProblemState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setSource(documentId: string, source: ProblemSource, items: readonly ProblemInput[]): void {
    this.setEntry(documentId, source, "", items);
  }

  /**
   * 按分组键覆盖诊断：同一来源下不同节点各自维护条目，
   * 例如多个图表节点分别上报渲染错误。
   */
  setEntry(documentId: string, source: ProblemSource, key: string, items: readonly ProblemInput[]): void {
    const current = this.state.byDocument[documentId] ?? EMPTY_PROBLEMS;
    const retained = current.filter((problem) => !(problem.source === source && problem.key === key));
    const next: Problem[] = [
      ...retained,
      ...items.map((item, index) => ({ id: `${source}:${key}:${index}`, source, key, ...item })),
    ];
    this.commit(documentId, next);
  }

  clearDocument(documentId: string): void {
    this.commit(documentId, []);
  }

  private commit(documentId: string, problems: readonly Problem[]): void {
    const current = this.state.byDocument[documentId] ?? EMPTY_PROBLEMS;
    if (problems.length === 0 && current.length === 0) return;
    const byDocument = { ...this.state.byDocument };
    if (problems.length === 0) {
      delete byDocument[documentId];
    } else {
      byDocument[documentId] = [...problems];
    }
    this.state = { byDocument };
    for (const listener of this.listeners) listener(this.state);
  }
}

export const problemStore = new ProblemStore();
