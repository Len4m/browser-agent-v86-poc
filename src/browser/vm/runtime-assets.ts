// Browser Agent v86 - VM runtime assets and UI helpers.

import { $, state } from "../app/state";
import { t } from "../app/i18n";

export interface AssetCheckResult {
  ok: boolean;
  detail: string;
}

export interface AbortableOptions {
  signal?: AbortSignal | null;
}

export type LoadScriptOptions = AbortableOptions;

export interface LoadingOptions {
  title?: string;
  detail?: string;
  percent?: number | null;
  indeterminate?: boolean;
  cancelable?: boolean;
  cancelLabel?: string;
  onCancel?: (() => void) | null;
}

export interface PreloadVmAssetsOptions extends AbortableOptions {
  onCancel?: (() => void) | null;
}

export interface PreloadVmAssetsConfig {
  libv86: string;
  wasm: string;
  bios: string;
  vgaBios: string;
  bzimage: string;
  initrd?: string;
}

export type VmAssetBuffers = Record<string, ArrayBuffer>;

interface AssetSpec {
  key: string;
  name: string;
  url: string;
  mode: "script" | "cache" | "buffer";
}

type V86RuntimeWindow = Window & typeof globalThis & {
  V86Starter?: unknown;
  V86?: unknown;
};

interface V86StateApi {
  save_state?: (done: (error: unknown, result?: unknown) => void) => unknown;
  restore_state?: (buffer: ArrayBuffer, done: (error?: unknown) => void) => unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === "function";
}

function messageFromUnknown(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") return String(error);
  return "Error";
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(messageFromUnknown(error));
}

function abortReasonMessage(signal: AbortSignal | null | undefined): string {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string" && reason) return reason;
  return t("common.operationCancelled");
}

function hasV86Runtime(): boolean {
  const runtimeWindow = window as V86RuntimeWindow;
  return Boolean(runtimeWindow.V86Starter || runtimeWindow.V86);
}

function vmStateApi(): V86StateApi | null {
  return isRecord(state.vm) ? state.vm : null;
}

function copyBytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function addMessage(role: string, text: string): HTMLDivElement {
  const log = $("chat-log");
  const msg = document.createElement("div");
  msg.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  msg.appendChild(bubble);
  if (log) {
    log.appendChild(msg);
    log.scrollTop = log.scrollHeight;
  }
  return msg;
}

export function makeAbortError(message: unknown = t("common.operationCancelled")): Error {
  const error = new Error(message == null ? t("common.operationCancelled") : messageFromUnknown(message));
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

export function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw makeAbortError(abortReasonMessage(signal));
}

export function loadScript(src: string, { signal = null }: LoadScriptOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      throwIfAborted(signal);
    } catch (error) {
      reject(errorFromUnknown(error));
      return;
    }

    const existing = Array.from(document.scripts).find((script) => script.dataset.v86Loader === src);
    if (existing) {
      if (hasV86Runtime()) {
        resolve();
        return;
      }
      const cleanup = (): void => {
        existing.removeEventListener("load", onLoad);
        existing.removeEventListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      const onLoad = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error(t("common.loadFailed", { src })));
      };
      const onAbort = (): void => {
        cleanup();
        reject(makeAbortError(abortReasonMessage(signal)));
      };
      existing.addEventListener("load", onLoad, { once: true });
      existing.addEventListener("error", onError, { once: true });
      signal?.addEventListener("abort", onAbort, { once: true });
      return;
    }

    const script = document.createElement("script");
    const cleanup = (): void => {
      script.onload = null;
      script.onerror = null;
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      try {
        script.remove();
      } catch {
        // Removing a partially appended script is best-effort.
      }
      reject(makeAbortError(abortReasonMessage(signal)));
    };
    script.src = src;
    script.async = true;
    script.dataset.v86Loader = src;
    script.onload = (): void => {
      cleanup();
      resolve();
    };
    script.onerror = (): void => {
      cleanup();
      reject(new Error(t("common.loadFailed", { src })));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    document.head.appendChild(script);
  });
}

export async function checkAsset(url: string, { signal = null }: AbortableOptions = {}): Promise<AssetCheckResult> {
  throwIfAborted(signal);
  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-store", signal });
    if (res.ok) return { ok: true, detail: String(res.status) };
    return { ok: false, detail: String(res.status) };
  } catch (error) {
    if (isAbortError(error)) throw error;
    try {
      const res = await fetch(url, { method: "GET", cache: "no-store", signal });
      if (res.ok) return { ok: true, detail: String(res.status) };
      return { ok: false, detail: String(res.status) };
    } catch (fallbackError) {
      if (isAbortError(fallbackError)) throw fallbackError;
      return { ok: false, detail: messageFromUnknown(fallbackError) };
    }
  }
}

export function checkWsRelayEndpoint(url: string, timeoutMs = 1600): Promise<AssetCheckResult> {
  return new Promise((resolve) => {
    if (!window.WebSocket) {
      resolve({ ok: false, detail: t("checks.detail.wsNoWebSocket") });
      return;
    }

    if (!/^wss?:\/\//.test(url || "")) {
      resolve({ ok: false, detail: t("checks.detail.wsInvalidUrl") });
      return;
    }

    if (state.wsSocket?.readyState === WebSocket.OPEN && state.wsSocket.url === url) {
      resolve({ ok: true, detail: t("checks.detail.wsAlreadyConnected") });
      return;
    }

    let socket: WebSocket | null = null;
    let settled = false;
    let timer = 0;

    const finish = (ok: boolean, detail: string): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // Closing a probe socket is best-effort.
      }
      resolve({ ok, detail });
    };

    timer = window.setTimeout(() => finish(false, t("common.noResponse")), timeoutMs);

    try {
      socket = new WebSocket(url);
      socket.onopen = (): void => finish(true, t("checks.detail.wsConnectOk"));
      socket.onerror = (): void => finish(false, t("checks.detail.wsConnectionError"));
      socket.onclose = (): void => {
        if (!settled) finish(false, t("common.closed"));
      };
    } catch (error) {
      finish(false, messageFromUnknown(error));
    }
  });
}

export function normalizeLs(command: string): string {
  const trimmed = command.trim();
  if (trimmed === "ls") return "ls --color=never";
  if (trimmed.startsWith("ls ")) return `ls --color=never${trimmed.slice(2)}`;
  return command;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function timestampForFilename(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function normalizeStateBuffer(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  if (value instanceof Uint8Array) return copyBytesToArrayBuffer(value);
  if (ArrayBuffer.isView(value)) {
    return copyBytesToArrayBuffer(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  throw new Error(t("vm.snapshot.error.invalidBuffer"));
}

export function downloadArrayBuffer(buffer: ArrayBuffer, filename: string): void {
  const blob = new Blob([buffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 3000);
}

export function v86SaveState(): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const vm = vmStateApi();
    if (!vm?.save_state) {
      reject(new Error(t("vm.snapshot.error.noSaveState")));
      return;
    }

    let settled = false;
    const done = (error: unknown, result?: unknown): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (error) {
        reject(errorFromUnknown(error));
        return;
      }
      try {
        resolve(normalizeStateBuffer(result));
      } catch (normalizeError) {
        reject(errorFromUnknown(normalizeError));
      }
    };

    const timer = window.setTimeout(() => done(new Error(t("vm.snapshot.error.saveTimeout"))), 120000);

    try {
      const ret = vm.save_state(done);
      if (isPromiseLike(ret)) ret.then((result) => done(null, result), done);
      else if (ret instanceof ArrayBuffer || ArrayBuffer.isView(ret)) done(null, ret);
    } catch (error) {
      done(error);
    }
  });
}

export function v86RestoreState(buffer: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const vm = vmStateApi();
    if (!vm?.restore_state) {
      reject(new Error(t("vm.snapshot.error.noRestoreState")));
      return;
    }

    let settled = false;
    const done = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (error) reject(errorFromUnknown(error));
      else resolve();
    };

    const timer = window.setTimeout(() => done(new Error(t("vm.snapshot.error.restoreTimeout"))), 120000);

    try {
      const ret = vm.restore_state(buffer, done);
      if (isPromiseLike(ret)) ret.then(() => done(), done);
      else if (ret !== undefined) done();
    } catch (error) {
      done(error);
    }
  });
}

export function setLoading(show: boolean, {
  title = t("common.loading"),
  detail = "",
  percent = null,
  indeterminate = false,
  cancelable = false,
  cancelLabel = t("common.cancel"),
  onCancel = null,
}: LoadingOptions = {}): void {
  const overlay = $("loading-overlay");
  const titleEl = $("loading-title");
  const detailEl = $("loading-detail");
  const bar = $("loading-bar");
  const percentEl = $("loading-percent");
  const cancelButton = $<HTMLButtonElement>("loading-cancel");
  if (!overlay) return;

  overlay.classList.toggle("show", Boolean(show));
  overlay.setAttribute("aria-hidden", show ? "false" : "true");
  if (!show) document.body.classList.remove("app-booting");
  if (titleEl) titleEl.textContent = title;
  if (detailEl) detailEl.textContent = detail;

  if (bar) {
    bar.classList.toggle("indeterminate", Boolean(indeterminate || percent === null));
    if (percent === null) bar.style.width = "35%";
    else bar.style.width = `${Math.max(0, Math.min(100, percent)).toFixed(1)}%`;
  }
  if (percentEl) percentEl.textContent = percent === null ? "" : `${Math.round(percent)}%`;

  state.loadingCancelHandler = show && cancelable && typeof onCancel === "function" ? onCancel : null;
  if (cancelButton) {
    cancelButton.hidden = !state.loadingCancelHandler;
    cancelButton.disabled = false;
    cancelButton.textContent = cancelLabel;
    cancelButton.onclick = state.loadingCancelHandler
      ? () => {
          cancelButton.disabled = true;
          state.loadingCancelHandler?.();
        }
      : null;
  }
}

export function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export async function getAssetSize(url: string, { signal = null }: AbortableOptions = {}): Promise<number> {
  throwIfAborted(signal);
  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-store", signal });
    const size = Number(res.headers.get("content-length") || "0");
    return res.ok && Number.isFinite(size) ? size : 0;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return 0;
  }
}

export async function fetchAssetBufferWithProgress(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
  { signal = null }: AbortableOptions = {},
): Promise<ArrayBuffer> {
  throwIfAborted(signal);
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`HTTP ${response.status} descargando ${url}`);

  const total = Number(response.headers.get("content-length") || "0");
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    throwIfAborted(signal);
    onProgress?.(buffer.byteLength, total || buffer.byteLength);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  for (;;) {
    throwIfAborted(signal);
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.(loaded, total);
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
  }
  throwIfAborted(signal);

  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

export async function preloadVmAssets(
  cfg: PreloadVmAssetsConfig,
  { signal = null, onCancel = null }: PreloadVmAssetsOptions = {},
): Promise<VmAssetBuffers> {
  throwIfAborted(signal);
  const cancellableLoading: LoadingOptions = signal && onCancel
    ? { cancelable: true, cancelLabel: t("vm.loading.cancel"), onCancel }
    : {};
  const showLoading = (options: LoadingOptions): void => setLoading(true, { ...cancellableLoading, ...options });
  const cacheKey = JSON.stringify({
    libv86: cfg.libv86,
    wasm: cfg.wasm,
    bios: cfg.bios,
    vgaBios: cfg.vgaBios,
    bzimage: cfg.bzimage,
    initrd: cfg.initrd || "",
  });
  if (state.assetBuffers && state.assetCacheKey === cacheKey) {
    showLoading({ title: t("vm.loading.preparing"), detail: t("vm.loading.assetsCached"), percent: 100 });
    await nextPaint();
    return state.assetBuffers;
  }

  const assets: AssetSpec[] = [
    { key: "libv86", name: "libv86.js", url: cfg.libv86, mode: "script" },
    { key: "wasm", name: "v86.wasm", url: cfg.wasm, mode: "cache" },
    { key: "bios", name: "BIOS", url: cfg.bios, mode: "buffer" },
    { key: "vgaBios", name: "VGA BIOS", url: cfg.vgaBios, mode: "buffer" },
    { key: "bzimage", name: "Alpine vmlinuz", url: cfg.bzimage, mode: "buffer" },
    ...(cfg.initrd ? [{ key: "initrd", name: "Alpine initramfs", url: cfg.initrd, mode: "buffer" as const }] : []),
  ];

  const buffers: VmAssetBuffers = {};
  showLoading({ title: t("vm.loading.preparing"), detail: t("vm.loading.calculatingSize"), percent: null, indeterminate: true });
  await nextPaint();
  throwIfAborted(signal);

  const sizes = await Promise.all(assets.map((asset) => getAssetSize(asset.url, { signal })));
  const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
  let completedBytes = 0;

  for (let i = 0; i < assets.length; i += 1) {
    throwIfAborted(signal);
    const asset = assets[i];
    if (!asset) continue;
    const knownSize = sizes[i] || 0;

    showLoading({
      title: t("vm.loading.downloading"),
      detail: `${asset.name} · 0 B${knownSize ? ` / ${formatBytes(knownSize)}` : ""}`,
      percent: totalBytes ? (completedBytes / totalBytes) * 100 : null,
      indeterminate: !totalBytes,
    });
    await nextPaint();
    throwIfAborted(signal);

    if (asset.mode === "script") {
      await loadScript(asset.url, { signal });
      completedBytes += knownSize;
      showLoading({
        title: t("vm.loading.downloading"),
        detail: t("vm.loading.assetReady", { name: asset.name }),
        percent: totalBytes ? (completedBytes / totalBytes) * 100 : null,
        indeterminate: !totalBytes,
      });
      await nextPaint();
      continue;
    }

    const buffer = await fetchAssetBufferWithProgress(asset.url, (loaded, responseTotal) => {
      const denominator = totalBytes || assets.length;
      const numerator = totalBytes
        ? completedBytes + loaded
        : i + (responseTotal ? loaded / responseTotal : 0.5);
      const percent = denominator ? (numerator / denominator) * 100 : null;
      const sizeLabel = knownSize || responseTotal
        ? `${formatBytes(loaded)} / ${formatBytes(knownSize || responseTotal)}`
        : formatBytes(loaded);

      showLoading({
        title: t("vm.loading.downloading"),
        detail: `${asset.name} · ${sizeLabel}`,
        percent,
        indeterminate: !totalBytes && !responseTotal,
      });
    }, { signal });

    if (asset.mode === "buffer") buffers[asset.key] = buffer;
    completedBytes += knownSize || buffer.byteLength || 0;
  }

  throwIfAborted(signal);
  state.assetBuffers = buffers;
  state.assetCacheKey = cacheKey;
  setLoading(true, { title: t("vm.loading.starting"), detail: t("vm.loading.initializing"), percent: 100 });
  await nextPaint();
  return buffers;
}
