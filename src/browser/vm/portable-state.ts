import type { CowBlock } from "./indexeddb-cow-disk";
import type { ResolvedVmRuntime } from "./runtime-config";
import type { SnapshotConsoleUiState } from "../console/console-state";
export type { SnapshotConsoleUiState } from "../console/console-state";
import { V86_BUILD_VERSION } from "./runtime-config";
import { diskRootHash, sha256 } from "./storage-hash";

export const SNAPSHOT_MAGIC = "BAV86SNP";
export const PORTABLE_FORMAT_VERSION = 1;
const HEADER_BYTES = 20;

interface SectionDescriptor {
  name: string;
  encoding: "identity" | "gzip";
  bytes: number;
  decodedBytes: number;
  sha256: string;
  decodedSha256: string;
}

interface EnvelopeManifest {
  kind: "snapshot";
  formatVersion: 1;
  createdAt: string;
  sections: SectionDescriptor[];
  [key: string]: unknown;
}

export interface PortableSnapshotManifest extends EnvelopeManifest {
  kind: "snapshot";
  v86Version: string;
  runtime: ResolvedVmRuntime;
  diskRootHash: string | null;
  blockCount: number;
  stateSha256: string;
  consoleUi?: SnapshotConsoleUiState;
}

export interface DecodedPortable<T extends EnvelopeManifest> {
  manifest: T;
  sections: Map<string, Uint8Array>;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") return bytes;
  const stream = new Blob([Uint8Array.from(bytes).buffer]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new Error("Este navegador no puede descomprimir el contenedor.");
  const stream = new Blob([Uint8Array.from(bytes).buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function writeMagic(target: Uint8Array, magic: string): void {
  target.set(new TextEncoder().encode(magic), 0);
}

function readMagic(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes.subarray(0, 8));
}

export async function encodePortable(
  magic: typeof SNAPSHOT_MAGIC,
  manifestFields: Omit<EnvelopeManifest, "formatVersion" | "createdAt" | "sections">,
  inputs: readonly { name: string; bytes: Uint8Array; gzip?: boolean }[],
): Promise<ArrayBuffer> {
  const encodedSections: Uint8Array[] = [];
  const descriptors: SectionDescriptor[] = [];
  for (const input of inputs) {
    const compressed = input.gzip ? await gzip(input.bytes) : input.bytes;
    const useGzip = Boolean(input.gzip && compressed !== input.bytes);
    encodedSections.push(compressed);
    descriptors.push({
      name: input.name,
      encoding: useGzip ? "gzip" : "identity",
      bytes: compressed.byteLength,
      decodedBytes: input.bytes.byteLength,
      sha256: await sha256(compressed),
      decodedSha256: await sha256(input.bytes),
    });
  }
  const manifest: EnvelopeManifest = {
    ...manifestFields,
    formatVersion: PORTABLE_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    sections: descriptors,
  } as EnvelopeManifest;
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const total = HEADER_BYTES + json.byteLength + encodedSections.reduce((sum, item) => sum + item.byteLength, 0);
  const output = new Uint8Array(total);
  writeMagic(output, magic);
  const view = new DataView(output.buffer);
  view.setUint32(8, PORTABLE_FORMAT_VERSION, true);
  view.setUint32(12, json.byteLength, true);
  view.setUint32(16, descriptors.length, true);
  output.set(json, HEADER_BYTES);
  let offset = HEADER_BYTES + json.byteLength;
  for (const section of encodedSections) {
    output.set(section, offset);
    offset += section.byteLength;
  }
  return output.buffer;
}

export async function decodePortable<T extends EnvelopeManifest>(
  input: ArrayBuffer,
  expectedMagic: typeof SNAPSHOT_MAGIC,
): Promise<DecodedPortable<T>> {
  const bytes = new Uint8Array(input);
  if (bytes.byteLength < HEADER_BYTES || readMagic(bytes) !== expectedMagic) {
    throw new Error("Formato no compatible. Selecciona un snapshot .bav86snapshot verificable.");
  }
  const view = new DataView(input);
  const version = view.getUint32(8, true);
  const jsonBytes = view.getUint32(12, true);
  const sectionCount = view.getUint32(16, true);
  if (version !== PORTABLE_FORMAT_VERSION) throw new Error(`Versión de contenedor no compatible: ${version}.`);
  if (jsonBytes < 2 || HEADER_BYTES + jsonBytes > bytes.byteLength) throw new Error("Contenedor truncado: manifiesto incompleto.");
  let manifest: T;
  try {
    manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + jsonBytes))) as T;
  } catch {
    throw new Error("El manifiesto del contenedor no es JSON válido.");
  }
  if (manifest.formatVersion !== 1 || !Array.isArray(manifest.sections) || manifest.sections.length !== sectionCount) {
    throw new Error("Manifiesto de contenedor incoherente.");
  }
  const sections = new Map<string, Uint8Array>();
  let offset = HEADER_BYTES + jsonBytes;
  for (const descriptor of manifest.sections) {
    if (!descriptor || !descriptor.name || !Number.isInteger(descriptor.bytes) || descriptor.bytes < 0) {
      throw new Error("Descriptor de sección inválido.");
    }
    const end = offset + descriptor.bytes;
    if (end > bytes.byteLength) throw new Error(`Contenedor truncado en la sección ${descriptor.name}.`);
    const encoded = bytes.slice(offset, end);
    if (await sha256(encoded) !== descriptor.sha256) throw new Error(`Hash inválido en la sección ${descriptor.name}.`);
    const decoded = descriptor.encoding === "gzip" ? await gunzip(encoded) : encoded;
    if (decoded.byteLength !== descriptor.decodedBytes || await sha256(decoded) !== descriptor.decodedSha256) {
      throw new Error(`Contenido corrupto en la sección ${descriptor.name}.`);
    }
    sections.set(descriptor.name, decoded);
    offset = end;
  }
  if (offset !== bytes.byteLength) throw new Error("El contenedor contiene bytes no declarados.");
  return { manifest, sections };
}

export function encodeDiskBlocks(blocks: readonly CowBlock[], blockSize: number): Uint8Array {
  const ordered = [...blocks].sort((a, b) => a.index - b.index);
  const result = new Uint8Array(ordered.reduce((sum, block) => sum + 8 + block.bytes.byteLength, 0));
  const view = new DataView(result.buffer);
  let offset = 0;
  let previous = -1;
  for (const block of ordered) {
    if (!Number.isInteger(block.index) || block.index <= previous || block.bytes.byteLength !== blockSize) {
      throw new Error("Delta HDB no canónico.");
    }
    view.setUint32(offset, block.index, true);
    view.setUint32(offset + 4, block.bytes.byteLength, true);
    result.set(block.bytes, offset + 8);
    offset += 8 + block.bytes.byteLength;
    previous = block.index;
  }
  return result;
}

export function decodeDiskBlocks(payload: Uint8Array, blockSize: number, sizeBytes: number): CowBlock[] {
  const blocks: CowBlock[] = [];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let offset = 0;
  let previous = -1;
  while (offset < payload.byteLength) {
    if (offset + 8 > payload.byteLength) throw new Error("Cabecera de bloque HDB truncada.");
    const index = view.getUint32(offset, true);
    const length = view.getUint32(offset + 4, true);
    offset += 8;
    if (index <= previous || length !== blockSize || (index + 1) * blockSize > sizeBytes || offset + length > payload.byteLength) {
      throw new Error("Bloque HDB inválido o fuera de rango.");
    }
    blocks.push({ index, bytes: payload.slice(offset, offset + length) });
    offset += length;
    previous = index;
  }
  return blocks;
}

export async function createSnapshotContainer(
  runtime: ResolvedVmRuntime,
  state: ArrayBuffer,
  blocks: CowBlock[],
  consoleUi?: SnapshotConsoleUiState,
): Promise<ArrayBuffer> {
  const cow = runtime.storage.disks.find((disk) => disk.kind === "overlay-cow");
  const rootHash = cow ? await diskRootHash(blocks) : null;
  const stateBytes = new Uint8Array(state);
  const sections: { name: string; bytes: Uint8Array; gzip?: boolean }[] = [{ name: "v86-state", bytes: stateBytes, gzip: true }];
  if (cow) sections.push({ name: "hdb-delta", bytes: encodeDiskBlocks(blocks, cow.blockSize), gzip: true });
  return encodePortable(SNAPSHOT_MAGIC, {
    kind: "snapshot", v86Version: V86_BUILD_VERSION, runtime,
    diskRootHash: rootHash, blockCount: blocks.length, stateSha256: await sha256(stateBytes),
    ...(consoleUi ? { consoleUi } : {}),
  }, sections);
}

function stableRuntimeIdentity(runtime: ResolvedVmRuntime): string {
  const assets = runtime.assets;
  return JSON.stringify({
    formatVersion: runtime.formatVersion,
    profileHash: runtime.profileHash,
    ramMb: runtime.ramMb,
    vramMb: runtime.vramMb,
    cmdline: runtime.cmdline,
    assets: Object.fromEntries(Object.entries(assets).map(([name, asset]) => [name, { bytes: asset.bytes, sha256: asset.sha256 }])),
    storage: runtime.storage,
    networkType: runtime.network.type,
    uarts: runtime.uarts,
    filesystem9p: runtime.filesystem9p,
  });
}

export function assertSnapshotCompatible(manifest: PortableSnapshotManifest, available: ResolvedVmRuntime): void {
  if (manifest.kind !== "snapshot") throw new Error("El contenedor no es un snapshot.");
  if (manifest.v86Version !== V86_BUILD_VERSION) throw new Error(`Versión v86 incompatible: ${manifest.v86Version}.`);
  if (manifest.runtime.profileHash !== available.profileHash) throw new Error("El snapshot pertenece a otro perfil o versión del perfil.");
  if (manifest.runtime.ramMb !== available.ramMb || manifest.runtime.vramMb !== available.vramMb) throw new Error("RAM/VRAM incompatibles con el snapshot.");
  if (stableRuntimeIdentity(manifest.runtime) !== stableRuntimeIdentity(available)) {
    throw new Error("Assets, cmdline o topología incompatibles con el snapshot.");
  }
}
