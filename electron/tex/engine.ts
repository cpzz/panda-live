import { spawnSync } from "node:child_process";
import type { EngineId, EngineInfo } from "../../src/shared/ipc";

interface Candidate {
  id: EngineId;
  command: string;
  versionArgs: string[];
}

const CANDIDATES: Candidate[] = [
  { id: "tectonic", command: "tectonic", versionArgs: ["--version"] },
  { id: "latexmk", command: "latexmk", versionArgs: ["-v"] },
  { id: "xelatex", command: "xelatex", versionArgs: ["--version"] },
];

/** 探测可用 TeX 引擎；优先级 Tectonic → latexmk → xelatex。见 doc/design.md §9.5。 */
export function detectEngines(): EngineInfo[] {
  const engines: EngineInfo[] = [];
  for (const candidate of CANDIDATES) {
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
