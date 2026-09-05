# VM storage and snapshots

> **English** | [Español](STORAGE_AND_SNAPSHOTS.es.md)

## Architecture

Every published profile boots a minimal initramfs, loads IDE/ext4/OverlayFS and runs `switch_root` over:

```text
immutable ext4 profile HDA (lowerdir, 4 MiB zstd parts)
  + ext4 HDB CoW (upperdir/workdir, 64 KiB blocks)
      ├─ memory, for a temporary session
      └─ IndexedDB, for a user-enabled workspace
  = OverlayFS root
```

9p was rejected as root because of toolchain semantics/performance; `filesystem: {}` remains for stable topology and 9p is reserved for future file exchange. A writable root HDA was rejected because it would bind the whole system to v86's opaque cache.

Boot identifies both partitions by their ext4 labels (`ba-root` and `ba-persist`), rather than the incidental `sda`/`sdb` order. This prevents the layers from being reversed when v86/Linux enumerates the two SCSI disks differently.

The profile chooses the system, tools, and minimum RAM/VRAM; the user chooses **No, temporary session** or **Persistent workspace** before boot. RAM/VRAM can be increased without changing workspace identity. Immutable `ResolvedVmRuntime` validates and pins those decisions, `allowedTools`, assets, cmdline, network, UARTs, 9p and disks.

## Persistence

- Temporary is the default and never writes to IndexedDB. Its changes disappear on shutdown unless a snapshot is saved.
- Enabling persistence automatically opens the profile's single workspace, identified by the exact base-version SHA-256. A new version uses another workspace and never silently mounts data from a different base.
- The browser requests `navigator.storage.persist()` when starting a workspace. `persisted` means protection was granted; `evictable` means it is saved but the browser may evict it.
- Shutdown runs guest `sync`, flushes CoW transactions and fixes a checkpoint before destroying v86.
- `degraded` means IndexedDB failure or insufficient quota; local persistence is no longer claimed in that state.
- An abrupt close can lose guest-cached data. ext4 replays its journal at boot.
- The profile selector shows **💾** when a compatible delta exists. For the selected profile, the UI uses a read-only cursor to total the active generation's blocks and shows **Persistent data · size**. This value does not use `navigator.storage.estimate()`, so it does not mix workspace data with LLM models, caches, or other profiles.
- **Reset workspace** appears only when the selected profile has data and the user also chooses **Persistent workspace** under **Keep changes**. It can run only while the VM is stopped and returns the profile to its immutable seed.

IndexedDB is not a guaranteed backup. There is no separate workspace import or export. A snapshot is the only portable copy: it includes both execution state and the HDB delta, whether temporary or persistent.

## Verifiable snapshots

`.bav86snapshot` (`BAV86SNP`, v1) contains a fixed header, JSON manifest and identity/gzip sections. It records exact v86 (`0.5.445+gb0d8f2c`), profile/hash, libv86/WASM/BIOS/kernel/initramfs hashes and sizes, RAM/VRAM, cmdline, network, UARTs, 9p, disks, `save_state()`, the HDB delta and visual console metadata (names and active tab). Base assets are not embedded and must remain published with the same identity.

The **Export** button runs `sync`, fixes HDB, pauses, serializes, packages and resumes even if download fails. **Import** validates everything **before** stopping the current VM, automatically selects the recorded profile, RAM, VRAM, and temporary/persistent mode, recalculates tools from `allowedTools` (falling back to profile priority when the previous selection is incompatible), boots the exact runtime, applies delta/state, revalidates serials/PTYs, restores names and the active tab, requests an automatic repaint from every PTY and recreates WS with the current endpoint. Formats other than `.bav86snapshot` are rejected because they do not provide the complete contract of the current snapshot.

## Verified v86 behavior

With v86 `0.5.445+gb0d8f2c`, `save_state()` preserves RAM and devices. `CowDisk.get_state()` contains identity/checkpoint only; content is packaged as an explicit delta. Restore requires the base, version, RAM and topology recorded by the snapshot.

| Layout | After shutdown/reload | Snapshot | Restore requirement |
| --- | --- | --- | --- |
| Profile + temporary session | No | State + HDB delta | Same immutable base |
| Profile + workspace | HDB in IndexedDB | State + HDB delta | Same immutable base |

## Validation

Run `pnpm check`, `pnpm setup`, and `pnpm test:vm-storage`. The last command uses Chromium to verify that a temporary session is discarded, a workspace preserves `/root` after changing RAM/VRAM, the UI reports only that workspace's size, the reset button follows **Keep changes**, a persistent snapshot restores HDB, consoles, profile, tools, and `serial1` in an empty browser, and the workspace can be reset. The manual matrix covers Firefox, abrupt close/journal replay, networking, and all three serial channels.
