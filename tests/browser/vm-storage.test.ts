import assert from "node:assert/strict";
import test from "node:test";

import { CowDisk, MemoryCowBlockStore } from "../../src/browser/vm/indexeddb-cow-disk";
import {
  assertSnapshotCompatible,
  createSnapshotContainer,
  decodeDiskBlocks,
  decodePortable,
  SNAPSHOT_MAGIC,
  type PortableSnapshotManifest,
} from "../../src/browser/vm/portable-state";
import { persistentWorkspaceId, resolveVmRuntime, type AssetIdentity, type VmProfile } from "../../src/browser/vm/runtime-config";
import { diskRootHash } from "../../src/browser/vm/storage-hash";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function asset(url: string, hash = HASH_A, bytes = 64): AssetIdentity {
  return { url, sha256: hash, bytes };
}

function persistentProfile(): VmProfile {
  return {
    id: "test-persistent",
    profileHash: HASH_B,
    minimumRamMb: 512,
    minimumVramMb: 8,
    storage: { layout: "overlay-hda", rootDiskMb: 128, workspaceDiskMb: 128, blockSize: 65536, filesystem: "ext4" },
    assets: {
      libv86: asset("/libv86.js"), wasm: asset("/v86.wasm"), bios: asset("/bios.bin"), vgaBios: asset("/vgabios.bin"),
      kernel: asset("/kernel"), initramfs: asset("/initramfs"), rootfs: asset("/rootfs.img.zst", HASH_A, 128 * 1024 * 1024),
      persistentSeed: asset("/seed.img", HASH_A, 128 * 1024 * 1024),
    },
    allowedTools: ["vm_sh_exec"],
  };
}

function runtime(
  workspace: { mode: "temporary" | "persistent" } = { mode: "temporary" },
  resources: { ramMb: number; vramMb: number } = { ramMb: 512, vramMb: 8 },
) {
  const profile = persistentProfile();
  return resolveVmRuntime({
    profile,
    ramMb: resources.ramMb,
    vramMb: resources.vramMb,
    workspace,
    wsRelayUrl: "ws://127.0.0.1:8086/wsnic",
    assets: {
      libv86: profile.assets!.libv86!, wasm: profile.assets!.wasm!, bios: profile.assets!.bios!,
      vgaBios: profile.assets!.vgaBios!, kernel: profile.assets!.kernel!, initramfs: profile.assets!.initramfs!,
    },
  });
}

test("resolved runtime freezes the exact profile, policy and fixed disk topology", () => {
  const resolved = runtime();
  assert.equal(resolved.storage.layout, "overlay-hda");
  assert.deepEqual(resolved.storage.disks.map((disk) => [disk.role, disk.kind]), [
    ["hda", "immutable-root"], ["hdb", "overlay-cow"],
  ]);
  assert.equal(resolved.storage.disks[1]?.kind === "overlay-cow" && resolved.storage.disks[1].persistence, "temporary");
  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(Object.isFrozen(resolved.profile?.allowedTools), true);

  const persistent = runtime({ mode: "persistent" });
  const persistentDisk = persistent.storage.disks.find((disk) => disk.kind === "overlay-cow");
  assert.equal(persistent.storage.mode, "persistent");
  assert.equal(persistentDisk?.workspaceId, persistentWorkspaceId(HASH_B));

  const resized = runtime({ mode: "persistent" }, { ramMb: 768, vramMb: 16 });
  const resizedDisk = resized.storage.disks.find((disk) => disk.kind === "overlay-cow");
  assert.equal(resizedDisk?.workspaceId, persistentDisk?.workspaceId);
  assert.equal(resized.ramMb, 768);
  assert.equal(resized.vramMb, 16);
  assert.throws(
    () => runtime({ mode: "persistent" }, { ramMb: 256, vramMb: 8 }),
    /al menos 512 MB de RAM/,
  );
  assert.throws(
    () => runtime({ mode: "persistent" }, { ramMb: 512, vramMb: 4 }),
    /al menos 8 MB de VRAM/,
  );
});

test("CoW disk reads seed, commits writes before callback and exports deterministic delta", async () => {
  const sizeBytes = 2 * 65536;
  const seed = new Uint8Array(sizeBytes);
  seed[0] = 7;
  seed[65536] = 9;
  const fetcher: typeof fetch = async (_input, init) => {
    const range = String(new Headers(init?.headers).get("Range"));
    const match = range.match(/bytes=(\d+)-(\d+)/);
    assert.ok(match);
    const start = Number(match[1]);
    const end = Number(match[2]);
    return new Response(seed.slice(start, end + 1), { status: 206 });
  };
  const store = new MemoryCowBlockStore();
  const disk = new CowDisk({
    workspaceId: "workspace:test", profileHash: HASH_A, seedUrl: "/seed.img", seedHash: HASH_B,
    sizeBytes, store, fetcher,
  });
  await disk.load();
  const initial = await new Promise<Uint8Array>((resolve) => disk.get(0, 1, resolve));
  assert.deepEqual([...initial], [7]);

  let callbackCalled = false;
  await new Promise<void>((resolve) => disk.set(65535, Uint8Array.of(1, 2, 3), () => {
    callbackCalled = true;
    resolve();
  }));
  assert.equal(callbackCalled, true);
  const changed = await new Promise<Uint8Array>((resolve) => disk.get(65534, 5, resolve));
  assert.deepEqual([...changed], [0, 1, 2, 3, 0]);
  const blocks = await disk.exportBlocks();
  assert.deepEqual(blocks.map((block) => block.index), [0, 1]);
  assert.equal(await disk.storedBytes(), 2 * 65536);
  const checkpoint = await disk.checkpoint();
  assert.match(checkpoint, /^[a-f0-9]{64}$/);
  assert.deepEqual(disk.get_state().slice(0, 5), [2, "workspace:test", HASH_A, sizeBytes, 65536]);
  assert.doesNotThrow(() => disk.set_state(disk.get_state()));
  assert.throws(() => disk.set_state([2, "workspace:test", HASH_A, sizeBytes, 65536, "wrong"]), /Checkpoint HDB incompatible/);

  const imported = [{ index: 0, bytes: new Uint8Array(65536).fill(33) }];
  await disk.importBlocks(imported, await diskRootHash(imported), { provisional: true });
  assert.equal(await disk.storedBytes(), 65536);
  await disk.load();
  assert.deepEqual([...await new Promise<Uint8Array>((resolve) => disk.get(0, 1, resolve))], [33]);
  await disk.rollbackImport();
  assert.equal(await disk.storedBytes(), 2 * 65536);
  assert.deepEqual([...await new Promise<Uint8Array>((resolve) => disk.get(65535, 1, resolve))], [1]);
});

test("snapshot imports prune provisional and superseded generations", async () => {
  class TrackingStore extends MemoryCowBlockStore {
    stagedGeneration = "";

    override async stage(workspaceId: string, generation: string, blocks: readonly { index: number; bytes: Uint8Array }[], checkpoint: string): Promise<void> {
      this.stagedGeneration = generation;
      await super.stage(workspaceId, generation, blocks, checkpoint);
    }
  }

  const workspaceId = "workspace:generations";
  const store = new TrackingStore();
  const fetcher: typeof fetch = async () => new Response(new Uint8Array(65536), { status: 206 });
  const disk = new CowDisk({ workspaceId, profileHash: HASH_A, seedUrl: "/seed.img", seedHash: HASH_B, sizeBytes: 65536, store, fetcher });
  await disk.load();
  await new Promise<void>((resolve) => disk.set(0, Uint8Array.of(7), resolve));

  const imported = [{ index: 0, bytes: new Uint8Array(65536).fill(11) }];
  const checkpoint = await diskRootHash(imported);
  await disk.importBlocks(imported, checkpoint, { provisional: true });
  const rolledBackGeneration = store.stagedGeneration;
  assert.equal(await store.storedBytes(workspaceId, rolledBackGeneration), 65536);
  await disk.rollbackImport();
  assert.equal(await store.storedBytes(workspaceId, rolledBackGeneration), 0);

  await disk.importBlocks(imported, checkpoint, { provisional: true });
  const committedGeneration = store.stagedGeneration;
  await disk.commitImport();
  assert.equal((await store.getMetadata(workspaceId))?.activeGeneration, committedGeneration);
  assert.equal(await store.storedBytes(workspaceId, "main"), 0);
  assert.equal(await store.storedBytes(workspaceId, committedGeneration), 65536);
});

test("a failed CoW read reports degradation without poisoning later writes", async () => {
  class FlakyStore extends MemoryCowBlockStore {
    failNextRead = true;

    override read(workspaceId: string, generation: string, index: number): Promise<Uint8Array | null> {
      if (this.failNextRead) {
        this.failNextRead = false;
        return Promise.reject(new Error("transient read failure"));
      }
      return super.read(workspaceId, generation, index);
    }
  }

  const statuses: string[] = [];
  const store = new FlakyStore();
  const disk = new CowDisk({
    workspaceId: "workspace:flaky",
    profileHash: HASH_A,
    seedUrl: "/seed.img",
    seedHash: HASH_B,
    sizeBytes: 65536,
    store,
    fetcher: async () => new Response(new Uint8Array(65536), { status: 206 }),
    onStatus: (status) => statuses.push(status),
  });
  await disk.load();

  await new Promise<void>((resolve) => disk.set(1, Uint8Array.of(3), resolve));
  await new Promise<void>((resolve) => disk.set(2, Uint8Array.of(4), resolve));
  await disk.flush();
  assert.deepEqual(statuses, ["degraded"]);
  assert.equal((await disk.exportBlocks())[0]?.bytes[2], 4);
});

test("a profile hash resolves to one deterministic persistent workspace", async () => {
  const store = new MemoryCowBlockStore();
  const fetcher: typeof fetch = async () => new Response(new Uint8Array(65536), { status: 206 });
  const options = { workspaceId: persistentWorkspaceId(HASH_A), profileHash: HASH_A, seedUrl: "/seed.img", seedHash: HASH_B, sizeBytes: 65536, store, fetcher };
  const first = new CowDisk(options);
  const second = new CowDisk(options);
  await first.load();
  await new Promise<void>((resolve) => first.set(0, Uint8Array.of(7), resolve));
  assert.equal((await store.getMetadata(options.workspaceId))?.checkpoint, "dirty");
  await second.load();
  assert.deepEqual([...await new Promise<Uint8Array>((resolve) => second.get(0, 1, resolve))], [7]);
  await second.reset();
  assert.equal((await store.getMetadata(options.workspaceId))?.checkpoint, "empty");
  assert.equal(await store.storedBytes(options.workspaceId, "main"), 0);
  assert.deepEqual(await second.exportBlocks(), []);
});

test("a workspace can be reset without reopening incompatible metadata", async () => {
  const store = new MemoryCowBlockStore();
  const workspaceId = persistentWorkspaceId(HASH_A);
  const original = {
    id: workspaceId,
    profileHash: HASH_A,
    seedHash: HASH_A,
    sizeBytes: 65536,
    blockSize: 65536,
  };
  const metadata = await store.open(original);
  await store.write(workspaceId, metadata.activeGeneration, [{ index: 0, bytes: new Uint8Array(65536).fill(7) }]);
  await store.activate(workspaceId, metadata.activeGeneration, "dirty");
  await assert.rejects(store.open({ ...original, seedHash: HASH_B }), /identidad del perfil/);

  await store.reset(workspaceId);
  assert.equal(await store.getMetadata(workspaceId), null);
  assert.equal(await store.storedBytes(workspaceId, metadata.activeGeneration), 0);
  assert.equal((await store.open({ ...original, seedHash: HASH_B })).checkpoint, "empty");
});

test("portable snapshots include HDB and reject truncation, corruption and incompatible RAM", async () => {
  const blocks = [{ index: 1, bytes: new Uint8Array(65536).fill(42) }];
  const consoleUi = {
    activeSessionId: "2",
    serialTitle: "Principal",
    sessions: [{ sessionId: "2", title: "Investigación" }],
  };
  const snapshot = await createSnapshotContainer(runtime(), Uint8Array.of(1, 2, 3, 4).buffer, blocks, consoleUi);
  const decoded = await decodePortable<PortableSnapshotManifest>(snapshot, SNAPSHOT_MAGIC);
  assert.deepEqual([...decoded.sections.get("v86-state")!], [1, 2, 3, 4]);
  const snapshotBlocks = decodeDiskBlocks(decoded.sections.get("hdb-delta")!, 65536, 128 * 1024 * 1024);
  assert.equal(snapshotBlocks[0]?.bytes[0], 42);
  assert.deepEqual(decoded.manifest.consoleUi, consoleUi);
  assert.doesNotThrow(() => assertSnapshotCompatible(decoded.manifest, runtime()));
  const incompatible = { ...runtime(), ramMb: 256 };
  assert.throws(() => assertSnapshotCompatible(decoded.manifest, incompatible), /RAM\/VRAM/);

  await assert.rejects(() => decodePortable(snapshot.slice(0, snapshot.byteLength - 1), SNAPSHOT_MAGIC), /truncado/);
  const corrupt = snapshot.slice(0);
  new Uint8Array(corrupt)[corrupt.byteLength - 1] ^= 0xff;
  await assert.rejects(() => decodePortable(corrupt, SNAPSHOT_MAGIC), /Hash inválido|corrupto/);
  await assert.rejects(() => decodePortable(Uint8Array.of(1, 2, 3).buffer, SNAPSHOT_MAGIC), /no compatible|bav86snapshot/);
});
