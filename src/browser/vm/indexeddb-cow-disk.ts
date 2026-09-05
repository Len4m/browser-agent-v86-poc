import { diskRootHash } from "./storage-hash";
import { VM_DISK_BLOCK_SIZE, type ResolvedVmRuntime } from "./runtime-config";

export type WorkspacePersistence = "persisted" | "evictable" | "degraded";

export interface CowBlock {
  index: number;
  bytes: Uint8Array;
}

export interface WorkspaceMetadata {
  id: string;
  profileHash: string;
  seedHash: string;
  sizeBytes: number;
  blockSize: number;
  activeGeneration: string;
  checkpoint: string;
  updatedAt: number;
}

export interface CowBlockStore {
  open(expected: Omit<WorkspaceMetadata, "activeGeneration" | "checkpoint" | "updatedAt">): Promise<WorkspaceMetadata>;
  getMetadata(workspaceId: string): Promise<WorkspaceMetadata | null>;
  read(workspaceId: string, generation: string, index: number): Promise<Uint8Array | null>;
  write(workspaceId: string, generation: string, blocks: readonly CowBlock[]): Promise<void>;
  list(workspaceId: string, generation: string): Promise<CowBlock[]>;
  storedBytes(workspaceId: string, generation: string): Promise<number>;
  stage(workspaceId: string, generation: string, blocks: readonly CowBlock[], checkpoint: string): Promise<void>;
  activate(workspaceId: string, generation: string, checkpoint: string): Promise<void>;
  pruneGenerations(workspaceId: string, keepGeneration: string): Promise<void>;
  reset(workspaceId: string): Promise<void>;
}

export class MemoryCowBlockStore implements CowBlockStore {
  private metadata = new Map<string, WorkspaceMetadata>();
  private blocks = new Map<string, Uint8Array>();

  open(expected: Omit<WorkspaceMetadata, "activeGeneration" | "checkpoint" | "updatedAt">): Promise<WorkspaceMetadata> {
    const current = this.metadata.get(expected.id);
    if (current) {
      if (current.profileHash !== expected.profileHash || current.seedHash !== expected.seedHash
        || current.sizeBytes !== expected.sizeBytes || current.blockSize !== expected.blockSize) {
        return Promise.reject(new Error("El workspace existente no coincide con la identidad del perfil."));
      }
      return Promise.resolve({ ...current });
    }
    const created = { ...expected, activeGeneration: "main", checkpoint: "empty", updatedAt: Date.now() };
    this.metadata.set(expected.id, created);
    return Promise.resolve({ ...created });
  }

  getMetadata(workspaceId: string): Promise<WorkspaceMetadata | null> {
    const metadata = this.metadata.get(workspaceId);
    return Promise.resolve(metadata ? { ...metadata } : null);
  }

  private key(workspaceId: string, generation: string, index: number): string {
    return `${workspaceId}\u0000${generation}\u0000${index}`;
  }

  read(workspaceId: string, generation: string, index: number): Promise<Uint8Array | null> {
    const bytes = this.blocks.get(this.key(workspaceId, generation, index));
    return Promise.resolve(bytes ? bytes.slice() : null);
  }

  write(workspaceId: string, generation: string, blocks: readonly CowBlock[]): Promise<void> {
    for (const block of blocks) this.blocks.set(this.key(workspaceId, generation, block.index), block.bytes.slice());
    return Promise.resolve();
  }

  list(workspaceId: string, generation: string): Promise<CowBlock[]> {
    const prefix = `${workspaceId}\u0000${generation}\u0000`;
    return Promise.resolve([...this.blocks.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, bytes]) => ({ index: Number(key.slice(prefix.length)), bytes: bytes.slice() }))
      .sort((a, b) => a.index - b.index));
  }

  storedBytes(workspaceId: string, generation: string): Promise<number> {
    const prefix = `${workspaceId}\u0000${generation}\u0000`;
    let total = 0;
    for (const [key, bytes] of this.blocks) if (key.startsWith(prefix)) total += bytes.byteLength;
    return Promise.resolve(total);
  }

  async stage(workspaceId: string, generation: string, blocks: readonly CowBlock[], _checkpoint: string): Promise<void> {
    await this.write(workspaceId, generation, blocks);
  }

  activate(workspaceId: string, generation: string, checkpoint: string): Promise<void> {
    const metadata = this.metadata.get(workspaceId);
    if (!metadata) return Promise.reject(new Error("Workspace inexistente."));
    metadata.activeGeneration = generation;
    metadata.checkpoint = checkpoint;
    metadata.updatedAt = Date.now();
    return Promise.resolve();
  }

  pruneGenerations(workspaceId: string, keepGeneration: string): Promise<void> {
    const prefix = `${workspaceId}\u0000`;
    const keepPrefix = `${workspaceId}\u0000${keepGeneration}\u0000`;
    for (const key of [...this.blocks.keys()]) {
      if (key.startsWith(prefix) && !key.startsWith(keepPrefix)) this.blocks.delete(key);
    }
    return Promise.resolve();
  }

  reset(workspaceId: string): Promise<void> {
    const prefix = `${workspaceId}\u0000`;
    for (const key of [...this.blocks.keys()]) if (key.startsWith(prefix)) this.blocks.delete(key);
    const metadata = this.metadata.get(workspaceId);
    if (metadata) {
      metadata.activeGeneration = "main";
      metadata.checkpoint = "empty";
      metadata.updatedAt = Date.now();
    }
    return Promise.resolve();
  }
}

interface IndexedDbBlockRecord {
  workspaceId: string;
  generation: string;
  index: number;
  bytes: ArrayBuffer;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
  });
}

class IndexedDbCowBlockStore implements CowBlockStore {
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly databaseName = "browser-agent-v86-storage-v1") {}

  private database(): Promise<IDBDatabase> {
    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve, reject) => {
        if (!globalThis.indexedDB) {
          reject(new Error("IndexedDB no está disponible en este navegador."));
          return;
        }
        const request = indexedDB.open(this.databaseName, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("workspaces")) db.createObjectStore("workspaces", { keyPath: "id" });
          if (!db.objectStoreNames.contains("blocks")) {
            const blocks = db.createObjectStore("blocks", { keyPath: ["workspaceId", "generation", "index"] });
            blocks.createIndex("generation", ["workspaceId", "generation"], { unique: false });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("No se pudo abrir IndexedDB."));
      });
    }
    return this.databasePromise;
  }

  async open(expected: Omit<WorkspaceMetadata, "activeGeneration" | "checkpoint" | "updatedAt">): Promise<WorkspaceMetadata> {
    const db = await this.database();
    const tx = db.transaction("workspaces", "readwrite");
    const store = tx.objectStore("workspaces");
    const current = await requestResult(store.get(expected.id)) as WorkspaceMetadata | undefined;
    if (current) {
      if (current.profileHash !== expected.profileHash || current.seedHash !== expected.seedHash
        || current.sizeBytes !== expected.sizeBytes || current.blockSize !== expected.blockSize) {
        tx.abort();
        throw new Error("El workspace existente no coincide con la identidad del perfil.");
      }
      await transactionDone(tx);
      return current;
    }
    const created = { ...expected, activeGeneration: "main", checkpoint: "empty", updatedAt: Date.now() };
    store.put(created);
    await transactionDone(tx);
    return created;
  }

  async getMetadata(workspaceId: string): Promise<WorkspaceMetadata | null> {
    const db = await this.database();
    const tx = db.transaction("workspaces", "readonly");
    const metadata = await requestResult(tx.objectStore("workspaces").get(workspaceId)) as WorkspaceMetadata | undefined;
    await transactionDone(tx);
    return metadata || null;
  }

  async read(workspaceId: string, generation: string, index: number): Promise<Uint8Array | null> {
    const db = await this.database();
    const tx = db.transaction("blocks", "readonly");
    const record = await requestResult(tx.objectStore("blocks").get([workspaceId, generation, index])) as IndexedDbBlockRecord | undefined;
    await transactionDone(tx);
    return record ? new Uint8Array(record.bytes) : null;
  }

  async write(workspaceId: string, generation: string, blocks: readonly CowBlock[]): Promise<void> {
    if (!blocks.length) return;
    const db = await this.database();
    const tx = db.transaction("blocks", "readwrite", { durability: "strict" });
    const store = tx.objectStore("blocks");
    for (const block of blocks) {
      store.put({ workspaceId, generation, index: block.index, bytes: block.bytes.slice().buffer });
    }
    await transactionDone(tx);
  }

  async list(workspaceId: string, generation: string): Promise<CowBlock[]> {
    const db = await this.database();
    const tx = db.transaction("blocks", "readonly");
    const records = await requestResult(tx.objectStore("blocks").index("generation").getAll([workspaceId, generation])) as IndexedDbBlockRecord[];
    await transactionDone(tx);
    return records.map((record) => ({ index: record.index, bytes: new Uint8Array(record.bytes) })).sort((a, b) => a.index - b.index);
  }

  async storedBytes(workspaceId: string, generation: string): Promise<number> {
    const db = await this.database();
    const tx = db.transaction("blocks", "readonly");
    const done = transactionDone(tx);
    const request = tx.objectStore("blocks").index("generation").openCursor(IDBKeyRange.only([workspaceId, generation]));
    const total = await new Promise<number>((resolve, reject) => {
      let bytes = 0;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(bytes);
          return;
        }
        const record = cursor.value as IndexedDbBlockRecord;
        bytes += record.bytes.byteLength;
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error("No se pudo medir el workspace en IndexedDB."));
    });
    await done;
    return total;
  }

  async stage(workspaceId: string, generation: string, blocks: readonly CowBlock[], _checkpoint: string): Promise<void> {
    await this.write(workspaceId, generation, blocks);
  }

  async activate(workspaceId: string, generation: string, checkpoint: string): Promise<void> {
    const db = await this.database();
    const tx = db.transaction("workspaces", "readwrite", { durability: "strict" });
    const store = tx.objectStore("workspaces");
    const metadata = await requestResult(store.get(workspaceId)) as WorkspaceMetadata | undefined;
    if (!metadata) throw new Error("Workspace inexistente.");
    store.put({ ...metadata, activeGeneration: generation, checkpoint, updatedAt: Date.now() });
    await transactionDone(tx);
  }

  async pruneGenerations(workspaceId: string, keepGeneration: string): Promise<void> {
    const db = await this.database();
    const tx = db.transaction("blocks", "readwrite", { durability: "strict" });
    const request = tx.objectStore("blocks").index("generation")
      .openKeyCursor(IDBKeyRange.bound([workspaceId, ""], [workspaceId, "\uffff"]));
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const key = cursor.primaryKey;
        if (Array.isArray(key) && key[1] !== keepGeneration) cursor.delete();
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error("No se pudieron limpiar generaciones antiguas del workspace."));
    });
    await transactionDone(tx);
  }

  async reset(workspaceId: string): Promise<void> {
    const db = await this.database();
    const readTx = db.transaction("blocks", "readonly");
    const records = await requestResult(readTx.objectStore("blocks").index("generation").getAllKeys(IDBKeyRange.bound([workspaceId, ""], [workspaceId, "\uffff"])));
    await transactionDone(readTx);
    const tx = db.transaction(["blocks", "workspaces"], "readwrite", { durability: "strict" });
    for (const key of records) tx.objectStore("blocks").delete(key);
    const metadata = await requestResult(tx.objectStore("workspaces").get(workspaceId)) as WorkspaceMetadata | undefined;
    if (metadata) tx.objectStore("workspaces").put({ ...metadata, activeGeneration: "main", checkpoint: "empty", updatedAt: Date.now() });
    await transactionDone(tx);
  }
}

export interface CowDiskOptions {
  workspaceId: string;
  profileHash: string;
  seedUrl: string;
  seedHash: string;
  sizeBytes: number;
  blockSize?: number;
  store?: CowBlockStore;
  fetcher?: typeof fetch;
  onStatus?: (status: WorkspacePersistence, error?: unknown) => void;
  onDirty?: () => void;
}

let sharedBrowserStore: CowBlockStore | null = null;

export function browserCowStore(): CowBlockStore {
  return sharedBrowserStore || (sharedBrowserStore = new IndexedDbCowBlockStore());
}

export class CowDisk {
  readonly byteLength: number;
  readonly blockSize: number;
  onload: ((event: object) => void) | null = null;
  onprogress: ((event: object) => void) | null = null;
  private metadata: WorkspaceMetadata | null = null;
  private readonly memory = new Map<number, Uint8Array>();
  private pending: Promise<void> = Promise.resolve();
  private degraded = false;
  private importRollback: { generation: string; checkpoint: string } | null = null;

  constructor(private readonly options: CowDiskOptions) {
    this.byteLength = options.sizeBytes;
    this.blockSize = options.blockSize || VM_DISK_BLOCK_SIZE;
    if (this.blockSize !== VM_DISK_BLOCK_SIZE || this.byteLength <= 0 || this.byteLength % this.blockSize !== 0) {
      throw new Error("El disco CoW requiere tamaño múltiplo de 64 KiB.");
    }
  }

  private get store(): CowBlockStore {
    return this.options.store || (this.options.store = browserCowStore());
  }

  private reportDegraded(error: unknown): void {
    this.degraded = true;
    this.options.onStatus?.("degraded", error);
  }

  async load(): Promise<void> {
    // V86Starter calls load() even when the host prepared the disk beforehand.
    // Do not reopen IndexedDB here: a restore may be reading a staged generation
    // which intentionally is not the globally active pointer yet.
    if (!this.metadata) {
      this.metadata = await this.store.open({
        id: this.options.workspaceId,
        profileHash: this.options.profileHash,
        seedHash: this.options.seedHash,
        sizeBytes: this.byteLength,
        blockSize: this.blockSize,
      });
      try {
        await this.store.pruneGenerations(this.metadata.id, this.metadata.activeGeneration);
      } catch (error) {
        this.reportDegraded(error);
      }
    }
    this.onload?.({});
  }

  private async seedBlock(index: number): Promise<Uint8Array> {
    const start = index * this.blockSize;
    const response = await (this.options.fetcher || fetch)(this.options.seedUrl, {
      headers: { Range: `bytes=${start}-${start + this.blockSize - 1}` },
      cache: "force-cache",
    });
    if (!response.ok) throw new Error(`No se pudo leer la semilla HDB: HTTP ${response.status}`);
    const received = new Uint8Array(await response.arrayBuffer());
    if (response.status === 206 && received.byteLength === this.blockSize) return received;
    if (response.status === 200 && received.byteLength === this.byteLength) return received.slice(start, start + this.blockSize);
    throw new Error("El hosting no sirve rangos válidos para la semilla HDB.");
  }

  private async readBlock(index: number): Promise<Uint8Array> {
    const cached = this.memory.get(index);
    if (cached) return cached;
    if (!this.metadata) throw new Error("Disco CoW no cargado.");
    const persisted = await this.store.read(this.metadata.id, this.metadata.activeGeneration, index);
    const bytes = persisted || await this.seedBlock(index);
    this.memory.set(index, bytes);
    return bytes;
  }

  get(offset: number, length: number, callback: (bytes: Uint8Array) => void): void {
    void this.readRange(offset, length).then(callback).catch((error: unknown) => {
      this.reportDegraded(error);
      callback(new Uint8Array(Math.max(0, length)));
    });
  }

  private async readRange(offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0 || length < 0 || offset + length > this.byteLength) throw new RangeError("Lectura fuera del disco CoW.");
    const result = new Uint8Array(length);
    let cursor = 0;
    while (cursor < length) {
      const absolute = offset + cursor;
      const index = Math.floor(absolute / this.blockSize);
      const within = absolute % this.blockSize;
      const count = Math.min(length - cursor, this.blockSize - within);
      result.set((await this.readBlock(index)).subarray(within, within + count), cursor);
      cursor += count;
    }
    return result;
  }

  set(offset: number, bytes: Uint8Array, callback: () => void): void {
    const operation = this.pending.catch(() => undefined).then(async () => {
      if (!this.metadata) throw new Error("Disco CoW no cargado.");
      if (offset < 0 || offset + bytes.byteLength > this.byteLength) throw new RangeError("Escritura fuera del disco CoW.");
      const dirty = new Map<number, Uint8Array>();
      let cursor = 0;
      while (cursor < bytes.byteLength) {
        const absolute = offset + cursor;
        const index = Math.floor(absolute / this.blockSize);
        const within = absolute % this.blockSize;
        const count = Math.min(bytes.byteLength - cursor, this.blockSize - within);
        const block = within === 0 && count === this.blockSize
          ? new Uint8Array(this.blockSize)
          : (await this.readBlock(index)).slice();
        block.set(bytes.subarray(cursor, cursor + count), within);
        this.memory.set(index, block);
        dirty.set(index, block);
        cursor += count;
      }
      await this.store.write(this.metadata.id, this.metadata.activeGeneration, [...dirty].map(([index, block]) => ({ index, bytes: block })));
      if (this.metadata.checkpoint !== "dirty") {
        await this.store.activate(this.metadata.id, this.metadata.activeGeneration, "dirty");
        this.metadata.checkpoint = "dirty";
        this.options.onDirty?.();
      }
    });
    this.pending = operation.catch((error: unknown) => {
      this.reportDegraded(error);
    });
    void this.pending.then(() => {
      try {
        callback();
      } catch (error) {
        this.reportDegraded(error);
      }
    });
  }

  async flush(): Promise<void> {
    await this.pending;
  }

  async checkpoint(): Promise<string> {
    await this.flush();
    const blocks = await this.exportBlocks();
    const checkpoint = await diskRootHash(blocks);
    if (this.metadata && !this.degraded) {
      await this.store.activate(this.metadata.id, this.metadata.activeGeneration, checkpoint);
      this.metadata.checkpoint = checkpoint;
    }
    return checkpoint;
  }

  currentCheckpoint(): string {
    if (!this.metadata) throw new Error("Disco CoW no cargado.");
    return this.metadata.checkpoint;
  }

  async storedBytes(): Promise<number> {
    if (!this.metadata) throw new Error("Disco CoW no cargado.");
    await this.flush();
    return this.store.storedBytes(this.metadata.id, this.metadata.activeGeneration);
  }

  async exportBlocks(): Promise<CowBlock[]> {
    if (!this.metadata) throw new Error("Disco CoW no cargado.");
    const persisted = await this.store.list(this.metadata.id, this.metadata.activeGeneration);
    const merged = new Map(persisted.map((block) => [block.index, block.bytes]));
    for (const [index, bytes] of this.memory) {
      const seed = await this.seedBlock(index);
      if (bytes.some((byte, position) => byte !== seed[position])) merged.set(index, bytes.slice());
    }
    return [...merged].map(([index, bytes]) => ({ index, bytes })).sort((a, b) => a.index - b.index);
  }

  async importBlocks(
    blocks: readonly CowBlock[],
    expectedCheckpoint: string,
    { provisional = false }: { provisional?: boolean } = {},
  ): Promise<void> {
    if (!this.metadata) throw new Error("Disco CoW no cargado.");
    const actual = await diskRootHash(blocks);
    if (actual !== expectedCheckpoint) throw new Error("El delta HDB está corrupto.");
    const generation = `import-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const previous = { generation: this.metadata.activeGeneration, checkpoint: this.metadata.checkpoint };
    await this.store.stage(this.metadata.id, generation, blocks, actual);
    if (!provisional) await this.store.activate(this.metadata.id, generation, actual);
    this.metadata.activeGeneration = generation;
    this.metadata.checkpoint = actual;
    this.importRollback = provisional ? previous : null;
    this.memory.clear();
  }

  async commitImport(): Promise<void> {
    if (!this.metadata || !this.importRollback) return;
    await this.store.activate(this.metadata.id, this.metadata.activeGeneration, this.metadata.checkpoint);
    this.importRollback = null;
    try {
      await this.store.pruneGenerations(this.metadata.id, this.metadata.activeGeneration);
    } catch (error) {
      this.reportDegraded(error);
    }
  }

  async rollbackImport(): Promise<void> {
    if (!this.metadata || !this.importRollback) return;
    const previous = this.importRollback;
    this.metadata.activeGeneration = previous.generation;
    this.metadata.checkpoint = previous.checkpoint;
    this.importRollback = null;
    this.memory.clear();
    try {
      await this.store.pruneGenerations(this.metadata.id, previous.generation);
    } catch (error) {
      this.reportDegraded(error);
    }
  }

  async reset(): Promise<void> {
    await this.flush();
    await this.store.reset(this.options.workspaceId);
    this.memory.clear();
    if (this.metadata) {
      this.metadata.activeGeneration = "main";
      this.metadata.checkpoint = "empty";
    }
  }

  get_state(): [number, string, string, number, number, string] {
    return [2, this.options.workspaceId, this.options.profileHash, this.byteLength, this.blockSize, this.metadata?.checkpoint || "uncheckpointed"];
  }

  set_state(state: unknown): void {
    if (!Array.isArray(state)) throw new Error("Estado HDB inválido: v86 no entregó una tupla.");
    if (state[0] !== 2) throw new Error(`Versión de estado HDB incompatible: ${String(state[0])}.`);
    if (state[1] !== this.options.workspaceId) throw new Error("El estado v86 referencia otro ID de workspace HDB.");
    if (state[2] !== this.options.profileHash) throw new Error("El estado v86 referencia otro hash de perfil HDB.");
    if (state[3] !== this.byteLength || state[4] !== this.blockSize) throw new Error("El estado v86 referencia otro tamaño o bloque HDB.");
    if (!this.metadata || state[5] !== this.metadata.checkpoint) {
      throw new Error(`Checkpoint HDB incompatible: snapshot=${String(state[5])}, importado=${this.metadata?.checkpoint || "none"}.`);
    }
  }
}

export function createRuntimeCowDisk(
  runtime: ResolvedVmRuntime,
  onStatus?: CowDiskOptions["onStatus"],
  onDirty?: CowDiskOptions["onDirty"],
): CowDisk | null {
  const disk = runtime.storage.disks.find((candidate) => candidate.kind === "overlay-cow");
  if (!disk) return null;
  return new CowDisk({
    workspaceId: disk.workspaceId,
    profileHash: runtime.profileHash,
    seedUrl: disk.seed.url,
    seedHash: disk.seed.sha256,
    sizeBytes: disk.sizeBytes,
    blockSize: disk.blockSize,
    ...(disk.persistence === "temporary" ? { store: new MemoryCowBlockStore() } : {}),
    onStatus,
    onDirty,
  });
}

export async function requestDurableBrowserStorage(): Promise<WorkspacePersistence> {
  if (!navigator.storage?.persist) return "evictable";
  try {
    return await navigator.storage.persist() ? "persisted" : "evictable";
  } catch {
    return "evictable";
  }
}

export async function browserStorageStatus(): Promise<WorkspacePersistence> {
  if (!navigator.storage?.persisted) return "evictable";
  try {
    return await navigator.storage.persisted() ? "persisted" : "evictable";
  } catch {
    return "evictable";
  }
}
