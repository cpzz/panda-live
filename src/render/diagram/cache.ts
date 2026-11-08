/** 图表结果缓存：内存 LRU（100）+ IndexedDB 持久缓存（200 MB）。见 doc/design.md §10.3、附录 B。 */

export interface DiagramCacheStorage {
  get(key: string): Promise<string | null>;
  set(key: string, svg: string): Promise<void>;
}

/** 通用 LRU：命中即刷新到队尾，超出容量淘汰最久未使用项。 */
export class LruCache<T> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string): T | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as T;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

const MEMORY_CAPACITY = 100;
export const INDEXED_DB_CAPACITY_BYTES = 200 * 1024 * 1024;

export interface DiagramCacheStats {
  hits: number;
  misses: number;
  /** 内存层当前条目数。 */
  entries: number;
}

/** 两级缓存：内存优先，未命中再查持久层；持久层失败不影响渲染。 */
export class DiagramCache {
  private readonly memory = new LruCache<string>(MEMORY_CAPACITY);
  private hits = 0;
  private misses = 0;

  constructor(private readonly storage?: DiagramCacheStorage) {}

  stats(): DiagramCacheStats {
    return { hits: this.hits, misses: this.misses, entries: this.memory.size };
  }

  async get(key: string): Promise<string | null> {
    const cached = this.memory.get(key);
    if (cached) {
      this.hits += 1;
      return cached;
    }
    if (!this.storage) {
      this.misses += 1;
      return null;
    }
    try {
      const stored = await this.storage.get(key);
      if (stored) {
        this.memory.set(key, stored);
        this.hits += 1;
        return stored;
      }
    } catch {
      // 持久缓存不可用时静默降级为仅内存缓存。
    }
    this.misses += 1;
    return null;
  }

  async set(key: string, svg: string): Promise<void> {
    this.memory.set(key, svg);
    if (!this.storage) return;
    try {
      await this.storage.set(key, svg);
    } catch {
      // 同上：持久层失败不阻断渲染。
    }
  }
}

interface StoredEntry {
  key: string;
  svg: string;
  size: number;
  createdAt: number;
}

const DB_NAME = "panda-diagram-cache";
const DB_VERSION = 1;
const SVG_STORE = "svg";
const META_STORE = "meta";
const TOTAL_KEY = "total";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SVG_STORE)) {
        const store = database.createObjectStore(SVG_STORE, { keyPath: "key" });
        store.createIndex("createdAt", "createdAt");
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 打开失败"));
  });
}

/** IndexedDB 持久缓存，超过 200 MB 时按写入时间淘汰最旧条目。 */
export class IndexedDbDiagramStorage implements DiagramCacheStorage {
  private databasePromise: Promise<IDBDatabase> | null = null;

  private database(): Promise<IDBDatabase> {
    this.databasePromise ??= openDatabase();
    return this.databasePromise;
  }

  async get(key: string): Promise<string | null> {
    const database = await this.database();
    return new Promise((resolve, reject) => {
      const request = database.transaction(SVG_STORE, "readonly").objectStore(SVG_STORE).get(key);
      request.onsuccess = () => {
        const entry = request.result as StoredEntry | undefined;
        resolve(entry?.svg ?? null);
      };
      request.onerror = () => reject(request.error ?? new Error("读取图表缓存失败"));
    });
  }

  async set(key: string, svg: string): Promise<void> {
    const database = await this.database();
    const entry: StoredEntry = { key, svg, size: new TextEncoder().encode(svg).byteLength, createdAt: Date.now() };

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([SVG_STORE, META_STORE], "readwrite");
      const svgStore = transaction.objectStore(SVG_STORE);
      const metaStore = transaction.objectStore(META_STORE);

      let total = 0;
      const totalRequest = metaStore.get(TOTAL_KEY);
      totalRequest.onsuccess = () => {
        total = Number((totalRequest.result as { bytes?: number } | undefined)?.bytes ?? 0);
        svgStore.put(entry);
      };

      const cursorRequest = svgStore.index("createdAt").openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (total <= INDEXED_DB_CAPACITY_BYTES || !cursor) {
          metaStore.put({ id: TOTAL_KEY, bytes: total });
          return;
        }
        const oldest = cursor.value as StoredEntry;
        total -= oldest.size;
        cursor.delete();
        cursor.continue();
      };

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("写入图表缓存失败"));
      transaction.onabort = () => reject(transaction.error ?? new Error("图表缓存事务中止"));
    });
  }
}
