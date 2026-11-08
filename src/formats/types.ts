/** 解析/编译产生的诊断信息。见 doc/design.md §7.4。 */
export interface Diagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  /** 1-based；不可得时省略。 */
  line?: number;
  /** 1-based。 */
  column?: number;
  /** 附录 A 错误码。 */
  code?: string;
}
