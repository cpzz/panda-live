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

/** 探测可用 TeX 引擎；优先级 Tectonic → latexmk → xelatex → 内置 Tectonic。见 doc/design.md §9.5。 */
export function detectEngines(): EngineInfo[] {
  const candidates: Candidate[] = [
    { id: "tectonic", command: "tectonic", versionArgs: ["--version"] },
    { id: "latexmk", command: "latexmk", versionArgs: ["-v"] },
    { id: "xelatex", command: "xelatex", versionArgs: ["--version"] },
  ];
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
