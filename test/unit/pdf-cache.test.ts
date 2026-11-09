import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupCompileDirs, prunePdfCache } from "../../electron/tex/pdf-cache";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "panda-pdf-cache-"));
}

async function writeFile(file: string, size: number, mtime: Date): Promise<void> {
  await fs.writeFile(file, Buffer.alloc(size, 1));
  await fs.utimes(file, mtime, mtime);
}

describe("PDF 缓存 LRU", () => {
  it("超出上限时按修改时间删除最旧文件", async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(path.join(dir, "old.pdf"), 100, new Date(2020, 0, 1));
      await writeFile(path.join(dir, "middle.pdf"), 100, new Date(2021, 0, 1));
      await writeFile(path.join(dir, "new.pdf"), 100, new Date(2022, 0, 1));
      await writeFile(path.join(dir, "notes.txt"), 100, new Date(2019, 0, 1));
      await fs.mkdir(path.join(dir, "folder.pdf"));

      const removed = await prunePdfCache(dir, 200);
      expect(removed.map((file) => path.basename(file)).sort()).toEqual(["old.pdf"]);
      expect(await fs.readdir(dir)).toEqual(
        expect.arrayContaining(["middle.pdf", "new.pdf", "notes.txt", "folder.pdf"]),
      );
      expect(
        await fs.access(path.join(dir, "old.pdf")).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("未超过上限时不删除任何文件", async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(path.join(dir, "a.pdf"), 100, new Date(2020, 0, 1));
      await writeFile(path.join(dir, "b.pdf"), 100, new Date(2021, 0, 1));
      expect(await prunePdfCache(dir, 300)).toEqual([]);
      expect(await fs.readdir(dir)).toHaveLength(2);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("目录不存在时静默返回空列表", async () => {
    expect(await prunePdfCache(path.join(os.tmpdir(), "panda-missing-cache-dir"), 10)).toEqual([]);
  });
});

describe("编译临时目录清理", () => {
  it("启动时清空遗留任务目录", async () => {
    const root = await makeTempDir();
    try {
      await fs.mkdir(path.join(root, "job-1"), { recursive: true });
      await fs.writeFile(path.join(root, "job-1", "main.pdf"), "x");
      await fs.mkdir(path.join(root, "job-2"), { recursive: true });
      await cleanupCompileDirs(root);
      expect(await fs.readdir(root)).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("目录不存在时不报错", async () => {
    await expect(cleanupCompileDirs(path.join(os.tmpdir(), "panda-missing-compile-dir"))).resolves.toBeUndefined();
  });
});
