import { promises as fs } from "node:fs";
import path from "node:path";

/** PDF 缓存上限 2 GB（LRU 淘汰）。见 doc/design.md §9.5、§14.1。 */
export const PDF_CACHE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

interface CacheEntry {
  file: string;
  size: number;
  mtimeMs: number;
}

/**
 * 按修改时间淘汰 PDF 缓存，直到总量不超过上限。
 * 返回被删除的文件路径；目录不存在或读取失败时静默跳过。
 */
export async function prunePdfCache(
  cacheDir: string,
  limitBytes: number = PDF_CACHE_LIMIT_BYTES,
): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(cacheDir);
  } catch {
    return [];
  }

  const entries: CacheEntry[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".pdf")) continue;
    const file = path.join(cacheDir, name);
    const stats = await fs.stat(file).catch(() => null);
    if (!stats?.isFile()) continue;
    entries.push({ file, size: stats.size, mtimeMs: stats.mtimeMs });
  }

  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= limitBytes) return [];

  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const removed: string[] = [];
  for (const entry of entries) {
    if (total <= limitBytes) break;
    const ok = await fs.rm(entry.file, { force: true }).then(
      () => true,
      () => false,
    );
    if (!ok) continue;
    total -= entry.size;
    removed.push(entry.file);
  }
  return removed;
}

/** 启动时清理遗留的编译临时目录（异常退出可能留下）。见 doc/design.md §9.5。 */
export async function cleanupCompileDirs(compileRoot: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(compileRoot);
  } catch {
    return;
  }
  await Promise.all(
    names.map((name) =>
      fs.rm(path.join(compileRoot, name), { recursive: true, force: true }).catch(() => undefined),
    ),
  );
}
