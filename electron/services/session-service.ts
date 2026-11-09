import { promises as fs } from "node:fs";
import path from "node:path";
import { sessionStateSchema, type RecentEntry, type SessionState } from "../../src/shared/ipc";
import { writeFileAtomic } from "./atomic-write";

const MAX_RECENT = 12;

/**
 * 会话与最近文件持久化。
 * `session.json` 保存标签、模式、光标与窗口状态（§12.4）；
 * 最近文件单独落在 `recent.json`，避免与周期性会话写入互相覆盖。
 */
export class SessionService {
  private readonly sessionPath: string;
  private readonly recentPath: string;
  private state: SessionState | null = null;
  private recent: RecentEntry[] = [];

  constructor(userDataDir: string) {
    this.sessionPath = path.join(userDataDir, "session.json");
    this.recentPath = path.join(userDataDir, "recent.json");
  }

  async load(): Promise<SessionState | null> {
    if (this.state) return this.state;
    try {
      const raw = await fs.readFile(this.sessionPath, "utf8");
      const parsed = sessionStateSchema.safeParse(JSON.parse(raw) as unknown);
      this.state = parsed.success ? parsed.data : null;
    } catch {
      this.state = null;
    }
    return this.state;
  }

  async save(state: SessionState): Promise<void> {
    this.state = { ...state, recent: (await this.listRecent()).map((entry) => entry.path) };
    await writeFileAtomic(this.sessionPath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  /** 记录窗口尺寸/位置；与标签状态合并写回。 */
  async saveWindow(bounds: NonNullable<SessionState["window"]>): Promise<void> {
    const current = await this.load();
    if (!current) {
      this.state = {
        documents: [],
        activeIndex: 0,
        mode: "split",
        sidebarVisible: true,
        recent: [],
        window: bounds,
      };
    } else {
      this.state = { ...current, window: bounds };
    }
    await writeFileAtomic(this.sessionPath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  async listRecent(): Promise<RecentEntry[]> {
    if (this.recent.length > 0) return this.recent;
    try {
      const raw = await fs.readFile(this.recentPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.recent = parsed
          .filter(
            (item): item is RecentEntry =>
              typeof item === "object" &&
              item !== null &&
              typeof (item as RecentEntry).path === "string" &&
              typeof (item as RecentEntry).name === "string",
          )
          .map((item) => ({
            path: item.path,
            name: item.name,
            openedAt: typeof item.openedAt === "number" ? item.openedAt : 0,
          }))
          .slice(0, MAX_RECENT);
      }
    } catch {
      this.recent = [];
    }
    return this.recent;
  }

  async addRecent(filePath: string): Promise<RecentEntry[]> {
    const entries = await this.listRecent();
    this.recent = [
      { path: filePath, name: path.basename(filePath), openedAt: Date.now() },
      ...entries.filter((entry) => entry.path !== filePath),
    ].slice(0, MAX_RECENT);
    await writeFileAtomic(this.recentPath, `${JSON.stringify(this.recent, null, 2)}\n`);
    return this.recent;
  }

  async removeRecent(filePath: string): Promise<RecentEntry[]> {
    const entries = await this.listRecent();
    this.recent = entries.filter((entry) => entry.path !== filePath);
    await writeFileAtomic(this.recentPath, `${JSON.stringify(this.recent, null, 2)}\n`);
    return this.recent;
  }

  async clearRecent(): Promise<RecentEntry[]> {
    this.recent = [];
    await writeFileAtomic(this.recentPath, "[]\n");
    return this.recent;
  }
}
