import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PandaError } from "../../src/shared/errors";
import type { CompileRequest, CompileResult, EngineInfo } from "../../src/shared/ipc";
import type { FileService } from "../services/file-service";
import { sha256Hex } from "../services/text-codec";
import { parseLatexLog } from "./log-parser";

const COMPILE_TIMEOUT_MS = 60_000;

interface RunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  cancelled: boolean;
}

/**
 * TeX 编译：编译只读磁盘内容，并发 1，新任务替换旧任务，超时 60 s。
 * 本实现直接把输出写到 `userData/cache/pdf/<cacheKey>.pdf`。见 doc/design.md §9.5。
 */
export class TexCompiler {
  private current: { child: ChildProcess; cancel(): void } | null = null;

  constructor(
    private readonly files: FileService,
    private readonly userDataDir: string,
    private readonly engines: () => EngineInfo[],
  ) {}

  async compile(request: CompileRequest): Promise<CompileResult> {
    const engine = this.engines()[0];
    if (!engine) {
      throw new PandaError("E_ENGINE_MISSING", "未找到 TeX 引擎（Tectonic / latexmk / xelatex）");
    }
    const root = await this.files.assertAllowed(request.rootPath);
    if (!/\.(tex|latex)$/i.test(root)) {
      throw new PandaError("E_COMPILE_FAILED", "编译根文件必须是 .tex");
    }

    this.cancel();
    const jobDir = path.join(this.userDataDir, "compile", request.jobId);
    await fs.rm(jobDir, { recursive: true, force: true });
    await fs.mkdir(jobDir, { recursive: true });

    let run: RunResult;
    try {
      run = await this.run(engine, root, jobDir);
    } finally {
      this.current = null;
    }

    const diagnostics = parseLatexLog(run.output, root);
    if (run.cancelled) throw new PandaError("E_CANCELLED", "编译已取消");
    if (run.timedOut) {
      await this.cleanup(jobDir);
      return {
        ok: false,
        diagnostics: [
          { severity: "error", message: "编译超时（60 s）", file: root },
          ...diagnostics,
        ],
      };
    }

    const outputPdf = path.join(jobDir, `${path.basename(root).replace(/\.(tex|latex)$/i, "")}.pdf`);
    const exists = await fs.stat(outputPdf).then((stats) => stats.isFile()).catch(() => false);
    if (run.code !== 0 || !exists) {
      await this.cleanup(jobDir);
      return {
        ok: false,
        diagnostics:
          diagnostics.length > 0
            ? diagnostics
            : [{ severity: "error", message: "编译失败，详见引擎日志", file: root }],
      };
    }

    const rootBytes = new Uint8Array(await fs.readFile(root));
    const keyInput = new Uint8Array(rootBytes.length + engine.id.length);
    keyInput.set(rootBytes);
    keyInput.set(new TextEncoder().encode(engine.id), rootBytes.length);
    const pdfKey = sha256Hex(keyInput);

    const cacheDir = path.join(this.userDataDir, "cache", "pdf");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.copyFile(outputPdf, path.join(cacheDir, `${pdfKey}.pdf`));
    await this.cleanup(jobDir);
    return { ok: true, pdfKey, diagnostics };
  }

  cancel(): void {
    if (!this.current) return;
    const current = this.current;
    this.current = null;
    current.cancel();
    current.child.kill();
  }

  private run(engine: EngineInfo, root: string, jobDir: string): Promise<RunResult> {
    const args =
      engine.id === "tectonic"
        ? ["--untrusted", "--outdir", jobDir, root]
        : engine.id === "latexmk"
          ? ["-pdf", "-interaction=nonstopmode", "-outdir", jobDir, root]
          : ["-interaction=nonstopmode", "-output-directory", jobDir, root];

    return new Promise<RunResult>((resolve) => {
      const child = spawn(engine.path, args, {
        cwd: path.dirname(root),
        windowsHide: true,
        env: {
          PATH: process.env["PATH"] ?? "",
          ...(process.env["SYSTEMROOT"] ? { SYSTEMROOT: process.env["SYSTEMROOT"] } : {}),
          ...(process.env["HOME"] ? { HOME: process.env["HOME"] } : {}),
        },
      });
      let output = "";
      let timedOut = false;
      let cancelled = false;
      const append = (chunk: Buffer): void => {
        output += chunk.toString("utf8");
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, COMPILE_TIMEOUT_MS);

      this.current = {
        child,
        cancel: () => {
          cancelled = true;
        },
      };

      child.on("error", (error) => {
        clearTimeout(timer);
        output += `\n! ${error.message}`;
        resolve({ code: -1, output, timedOut, cancelled });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, output, timedOut, cancelled });
      });
    });
  }

  private async cleanup(jobDir: string): Promise<void> {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
