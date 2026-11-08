import { describe, expect, it } from "vitest";
import { parseLatexLog } from "../../electron/tex/log-parser";

describe("TeX 日志解析", () => {
  it("解析 file:line:col 形式的错误", () => {
    const log = "./main.tex:12:5: Undefined control sequence.";
    const diagnostics = parseLatexLog(log, "/work/main.tex");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      severity: "error",
      line: 12,
      column: 5,
      message: "Undefined control sequence.",
    });
  });

  it("解析 ! 错误与 l.N 行号", () => {
    const log = ["! Missing $ inserted.", "<inserted text>", "                $", "l.42"].join("\n");
    const diagnostics = parseLatexLog(log, "/work/main.tex");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("Missing $ inserted");
    expect(diagnostics[0]?.line).toBe(42);
  });

  it("解析 LaTeX Warning 并去重", () => {
    const log = [
      "LaTeX Warning: There were undefined references.",
      "LaTeX Warning: There were undefined references.",
    ].join("\n");
    const diagnostics = parseLatexLog(log, "/work/main.tex");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe("warning");
  });

  it("空日志返回空诊断", () => {
    expect(parseLatexLog("", "/work/main.tex")).toEqual([]);
  });
});
