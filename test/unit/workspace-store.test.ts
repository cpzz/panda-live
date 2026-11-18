import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceStore, type WorkspaceNode } from "../../src/services/workspace-store";
import type { DirEntry } from "../../src/shared/ipc";

type EntryMap = Record<string, DirEntry[]>;

/** 模拟 window.panda：内存版目录读取，供 WorkspaceStore 测试使用。 */
function createPanda(entries: EntryMap) {
  let current = entries;
  return {
    setEntries(next: EntryMap): void {
      current = next;
    },
    panda: {
      workspace: {
        open: vi.fn(async ({ path }: { path: string }) => ({
          root: { path, name: path.split("/").pop() ?? path, rootId: "r1" },
          entries: current[path] ?? [],
        })),
      },
      dialog: { openDirectory: vi.fn(async () => null) },
      fs: {
        readDir: vi.fn(async ({ path }: { path: string }) => ({ entries: current[path] ?? [] })),
        watch: vi.fn(async () => ({ watchId: "w1" })),
        unwatch: vi.fn(async () => undefined),
        create: vi.fn(async () => null),
        rename: vi.fn(async () => null),
        remove: vi.fn(async () => true),
      },
      shell: { reveal: vi.fn(async () => undefined) },
    },
  };
}

function names(nodes: WorkspaceNode[] | null): string[] {
  return (nodes ?? []).map((node) => node.name);
}

describe("WorkspaceStore 行级刷新与展开", () => {
  const entries: EntryMap = {
    "/root": [
      { name: "a", path: "/root/a", kind: "dir" },
      { name: "b.txt", path: "/root/b.txt", kind: "file" },
    ],
    "/root/a": [{ name: "old.txt", path: "/root/a/old.txt", kind: "file" }],
  };

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { window?: unknown }).window;
  });

  it("refreshNode 重新读取指定子目录的内容", async () => {
    const stub = createPanda(entries);
    (globalThis as { window?: unknown }).window = { panda: stub.panda };
    const store = new WorkspaceStore();
    await store.openPath("/root");
    await store.toggle("/root/a");

    const dir = () => store.getState().roots[0]?.nodes.find((node) => node.path === "/root/a");
    expect(names(dir()?.children ?? null)).toEqual(["old.txt"]);

    // 外部新增文件后，行级刷新只重读该目录
    stub.setEntries({
      ...entries,
      "/root/a": [
        { name: "old.txt", path: "/root/a/old.txt", kind: "file" },
        { name: "new.txt", path: "/root/a/new.txt", kind: "file" },
      ],
    });
    await store.refreshNode("/root/a");
    expect(names(dir()?.children ?? null)).toEqual(["old.txt", "new.txt"]);
  });

  it("refreshNode 对根目录路径回退到根刷新", async () => {
    const stub = createPanda(entries);
    (globalThis as { window?: unknown }).window = { panda: stub.panda };
    const store = new WorkspaceStore();
    await store.openPath("/root");
    await store.refreshNode("/root");
    expect(names(store.getState().roots[0]?.nodes ?? null)).toEqual(["a", "b.txt"]);
  });

  it("expand 展开折叠目录并加载子节点", async () => {
    const stub = createPanda(entries);
    (globalThis as { window?: unknown }).window = { panda: stub.panda };
    const store = new WorkspaceStore();
    await store.openPath("/root");
    await store.expand("/root/a");
    const dir = store.getState().roots[0]?.nodes.find((node) => node.path === "/root/a");
    expect(dir?.expanded).toBe(true);
    expect(names(dir?.children ?? null)).toEqual(["old.txt"]);
  });
});
