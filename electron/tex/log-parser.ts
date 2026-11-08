import type { TexDiagnostic } from "../../src/shared/ipc";

/**
 * 解析 TeX 引擎日志，提取错误与警告位置。见 doc/design.md §9.5。
 * 兼容 `file:line:col: message`、`! message` + `l.N`、`LaTeX Warning: ... on input line N`。
 */
export function parseLatexLog(log: string, rootPath: string): TexDiagnostic[] {
  const diagnostics: TexDiagnostic[] = [];
  const seen = new Set<string>();
  const lines = log.split(/\r?\n/);
  let pendingError: TexDiagnostic | null = null;

  const push = (diagnostic: TexDiagnostic): void => {
    const key = `${diagnostic.severity}:${diagnostic.message}:${diagnostic.line ?? 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push(diagnostic);
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const fileMatch = line.match(/^(.+?\.(?:tex|sty|cls|bib)):(\d+):(?:\s*(\d+):)?\s*(.*)$/i);
    if (fileMatch) {
      const [, file, lineText, columnText, message] = fileMatch;
      if (message && message.trim()) {
        push({
          severity: /error|undefined|missing|runaway/i.test(message) ? "error" : "warning",
          message: message.trim(),
          ...(file ? { file } : {}),
          line: Number(lineText),
          ...(columnText ? { column: Number(columnText) } : {}),
        });
      }
      continue;
    }
    if (/^! /.test(line)) {
      pendingError = { severity: "error", message: line.slice(2).trim(), file: rootPath };
      continue;
    }
    if (pendingError) {
      const lineMatch = line.match(/^l\.(\d+)/);
      if (lineMatch) {
        pendingError.line = Number(lineMatch[1]);
        push(pendingError);
        pendingError = null;
      } else if (line.startsWith("!") && line.trim().length > 1) {
        pendingError = { severity: "error", message: line.slice(1).trim(), file: rootPath };
      }
      continue;
    }
    const warningMatch = line.match(/LaTeX Warning:\s*(.+?)(?: on input line (\d+))?\.?$/);
    if (warningMatch) {
      const [, message, lineText] = warningMatch;
      push({
        severity: "warning",
        message: (message ?? "").trim(),
        file: rootPath,
        ...(lineText ? { line: Number(lineText) } : {}),
      });
    }
  }

  if (pendingError) push(pendingError);
  return diagnostics;
}
