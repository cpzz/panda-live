import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../../src/shared/settings";
import { writeFileAtomic } from "./atomic-write";

/**
 * 设置持久化：`userData/settings.json`。
 * 读取时逐字段校正（含 schemaVersion），未知字段保留。见 doc/design.md §15.3。
 */
export class SettingsService {
  private readonly filePath: string;
  private current: Settings = DEFAULT_SETTINGS;

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, "settings.json");
  }

  get(): Settings {
    return this.current;
  }

  async load(): Promise<Settings> {
    try {
      const text = await fs.readFile(this.filePath, "utf8");
      this.current = mergeSettings(JSON.parse(text) as unknown);
    } catch {
      this.current = DEFAULT_SETTINGS;
    }
    return this.current;
  }

  async update(patch: unknown): Promise<Settings> {
    this.current = mergeSettings({ ...this.current, ...(typeof patch === "object" && patch ? patch : {}) });
    await writeFileAtomic(this.filePath, `${JSON.stringify(this.current, null, 2)}\n`);
    return this.current;
  }
}
