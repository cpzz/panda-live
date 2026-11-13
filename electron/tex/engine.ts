import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { EngineId, EngineInfo } from "../../src/shared/ipc";

interface Candidate {
  id: EngineId;
  command: string;
  versionArgs: string[];
}

/**
 * 通过 npm 依赖 `node-tectonic` 内置的 Tectonic 可执行文件。
 * 未安装（如 `--omit=optional`）或打包后缺少 node_modules 时返回 null。
 */
function bundledTectonicPath(): string | null {
  try {
    const requireFromHere = createRequire(import.meta.url);
    const mod = requireFromHere("node-tectonic") as { binaryPath?: () => string };
    const binary = mod.binaryPath?.();
    return binary && existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

/**
 * 打包版由 electron-builder 的 extraResources 携带到 `resources/tectonic/`，
 * 位于 asar 之外，可直接 spawn。
 */
function packagedTectonicPath(): string | null {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resources) return null;
  const binary = path.join(
    resources,
    "tectonic",
    process.platform === "win32" ? "tectonic.exe" : "tectonic",
  );
  return existsSync(binary) ? binary : null;
}

/** 依据 `--version` 输出判定引擎类型；无法识别时返回 null（放弃该候选）。 */
function classifyEngine(output: string): EngineId | null {
  const text = output.toLowerCase();
  if (text.includes("tectonic")) return "tectonic";
  if (text.includes("latexmk")) return "latexmk";
  if (text.includes("xetex") || text.includes("xelatex")) return "xelatex";
  return null;
}

/**
 * 探测可用 TeX 引擎；优先级 自定义命令 → Tectonic → latexmk → xelatex → 内置 Tectonic。
 * 自定义命令（设置 `latex.engineCommand`）通过 `--version` 输出判定类型，
 * 探测失败或类型不明时回落到自动探测。见 doc/design.md §9.5、§15.3。
 */
export function detectEngines(customCommand?: string): EngineInfo[] {
  const candidates: Candidate[] = [];

  const command = (customCommand ?? "").trim();
  if (command) {
    const probe = spawnSync(command, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    const output = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
    const id = classifyEngine(output);
    if (!probe.error && probe.status === 0 && id) {
      candidates.push({ id, command, versionArgs: id === "latexmk" ? ["-v"] : ["--version"] });
    }
  }

  candidates.push(
    { id: "tectonic", command: "tectonic", versionArgs: ["--version"] },
    { id: "latexmk", command: "latexmk", versionArgs: ["-v"] },
    { id: "xelatex", command: "xelatex", versionArgs: ["--version"] },
  );
  const packaged = packagedTectonicPath();
  if (packaged) {
    candidates.push({ id: "tectonic", command: packaged, versionArgs: ["--version"] });
  }
  const bundled = bundledTectonicPath();
  if (bundled) {
    candidates.push({ id: "tectonic", command: bundled, versionArgs: ["--version"] });
  }

  const engines: EngineInfo[] = [];
  for (const candidate of candidates) {
    if (engines.some((engine) => engine.id === candidate.id)) continue;
    const result = spawnSync(candidate.command, candidate.versionArgs, {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) continue;
    const version =
      (result.stdout ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? candidate.id;
    engines.push({ id: candidate.id, path: candidate.command, version });
  }
  return engines;
}
