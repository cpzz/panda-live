import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { draftPayloadSchema, type DraftEntry, type DraftPayload } from "../../src/shared/ipc";
import { writeFileAtomic } from "./atomic-write";

/** 草稿保留 7 天。见 doc/design.md §12.4。 */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 崩溃恢复草稿：`userData/backups/<draftKey>.json`。
 * 有路径的文档用 `sha256(realpath)` 前 16 位作键；未命名文档使用随机 ID 并在草稿内记录路径。
 */
export class DraftService {
  private readonly dir: string;

  constructor(userDataDir: string) {
    this.dir = path.join(userDataDir, "backups");
  }

  async list(): Promise<DraftEntry[]> {
    await fs.mkdir(this.dir, { recursive: true });
    const names = await fs.readdir(this.dir).catch(() => [] as string[]);
    const entries: DraftEntry[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const key = name.slice(0, -".json".length);
      const file = path.join(this.dir, name);
      try {
        const raw = await fs.readFile(file, "utf8");
        const parsed = draftPayloadSchema.safeParse(JSON.parse(raw) as unknown);
        if (!parsed.success) {
          await fs.rm(file, { force: true });
          continue;
        }
        if (Date.now() - parsed.data.savedAt > RETENTION_MS) {
          await fs.rm(file, { force: true });
          continue;
        }
        entries.push({ key, ...parsed.data });
      } catch {
        await fs.rm(file, { force: true }).catch(() => undefined);
      }
    }
    return entries.sort((a, b) => b.savedAt - a.savedAt);
  }

  async save(draft: DraftPayload, existingKey?: string): Promise<string> {
    const key = existingKey ?? (await this.computeKey(draft.path));
    await fs.mkdir(this.dir, { recursive: true });
    await writeFileAtomic(path.join(this.dir, `${key}.json`), `${JSON.stringify(draft, null, 2)}\n`);
    return key;
  }

  async remove(key: string): Promise<void> {
    await fs.rm(path.join(this.dir, `${key}.json`), { force: true });
  }

  private async computeKey(filePath: string | null): Promise<string> {
    if (!filePath) return `untitled-${randomUUID()}`;
    const real = await fs.realpath(filePath).catch(() => path.resolve(filePath));
    return createHash("sha256").update(real).digest("hex").slice(0, 16);
  }
}
