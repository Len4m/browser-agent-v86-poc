// @ts-nocheck
// Browser Agent v86 - 05 runtime utils assets
// Split from app.js in v9.35. Load order is defined in index.html.

function addMessage(role, text) {
  const log = $("chat-log");
  const msg = document.createElement("div");
  msg.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  msg.appendChild(bubble);
  log.appendChild(msg);
  log.scrollTop = log.scrollHeight;
  return msg;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = Array.from(document.scripts).find((script) => script.dataset.v86Loader === src);
    if (existing) {
      if (window.V86Starter || window.V86) resolve();
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", () => reject(new Error(`No se pudo cargar ${src}`)), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.v86Loader = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    document.head.appendChild(script);
  });
}

async function checkAsset(url) {
  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-store" });
    if (res.ok) return { ok: true, detail: String(res.status) };
    return { ok: false, detail: String(res.status) };
  } catch {
    try {
      const res = await fetch(url, { method: "GET", cache: "no-store" });
      if (res.ok) return { ok: true, detail: String(res.status) };
      return { ok: false, detail: String(res.status) };
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  }
}

function checkWsRelayEndpoint(url, timeoutMs = 1600) {
  return new Promise((resolve) => {
    if (!window.WebSocket) {
      resolve({ ok: false, detail: "WebSocket no disponible" });
      return;
    }

    if (!/^wss?:\/\//.test(url || "")) {
      resolve({ ok: false, detail: "URL WS inválida" });
      return;
    }

    if (state.wsSocket?.readyState === WebSocket.OPEN && state.wsSocket.url === url) {
      resolve({ ok: true, detail: "ya conectado" });
      return;
    }

    let socket;
    let settled = false;

    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      try { socket?.close?.(); } catch {}
      resolve({ ok, detail });
    };

    const timer = window.setTimeout(() => finish(false, "no responde"), timeoutMs);

    try {
      socket = new WebSocket(url);
      socket.onopen = () => finish(true, "conecta");
      socket.onerror = () => finish(false, "error de conexión");
      socket.onclose = () => {
        if (!settled) finish(false, "cerrado");
      };
    } catch (error) {
      finish(false, error.message);
    }
  });
}

function normalizeLs(command) {
  const trimmed = command.trim();
  if (trimmed === "ls") return "ls --color=never";
  if (trimmed.startsWith("ls ")) return "ls --color=never" + trimmed.slice(2);
  return command;
}


function formatBytes(bytes) {
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

function timestampForFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function normalizeStateBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (value instanceof Uint8Array) return value.slice().buffer;
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  throw new Error("save_state no ha devuelto un ArrayBuffer válido");
}

function downloadArrayBuffer(buffer, filename) {
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

function v86SaveState() {
  return new Promise((resolve, reject) => {
    if (!state.vm?.save_state) {
      reject(new Error("Esta build de v86 no expone save_state"));
      return;
    }

    let settled = false;
    const done = (error, result) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else {
        try { resolve(normalizeStateBuffer(result)); }
        catch (e) { reject(e); }
      }
    };

    const timer = window.setTimeout(() => done(new Error("Timeout guardando snapshot")), 120000);

    try {
      const ret = state.vm.save_state(done);
      if (ret?.then) ret.then((result) => done(null, result), done);
      else if (ret instanceof ArrayBuffer || ArrayBuffer.isView(ret)) done(null, ret);
    } catch (error) {
      done(error);
    }
  });
}

function v86RestoreState(buffer) {
  return new Promise((resolve, reject) => {
    if (!state.vm?.restore_state) {
      reject(new Error("Esta build de v86 no expone restore_state"));
      return;
    }

    let settled = false;
    const done = (error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve();
    };

    const timer = window.setTimeout(() => done(new Error("Timeout restaurando snapshot")), 120000);

    try {
      const ret = state.vm.restore_state(buffer, done);
      if (ret?.then) ret.then(() => done(), done);
      else if (ret !== undefined) done();
    } catch (error) {
      done(error);
    }
  });
}

function setLoading(show, { title = t("common.loading", "Cargando"), detail = "", percent = null, indeterminate = false } = {}) {
  const overlay = $("loading-overlay");
  const titleEl = $("loading-title");
  const detailEl = $("loading-detail");
  const bar = $("loading-bar");
  const percentEl = $("loading-percent");
  if (!overlay) return;

  overlay.classList.toggle("show", Boolean(show));
  overlay.setAttribute("aria-hidden", show ? "false" : "true");
  if (titleEl) titleEl.textContent = title;
  if (detailEl) detailEl.textContent = detail;

  if (bar) {
    bar.classList.toggle("indeterminate", Boolean(indeterminate || percent === null));
    if (percent === null) bar.style.width = "35%";
    else bar.style.width = `${Math.max(0, Math.min(100, percent)).toFixed(1)}%`;
  }
  if (percentEl) percentEl.textContent = percent === null ? "" : `${Math.round(percent)}%`;
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function getAssetSize(url) {
  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-store" });
    const size = Number(res.headers.get("content-length") || "0");
    return res.ok && Number.isFinite(size) ? size : 0;
  } catch {
    return 0;
  }
}

async function fetchAssetBufferWithProgress(url, onProgress) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status} descargando ${url}`);

  const total = Number(response.headers.get("content-length") || "0");
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    onProgress?.(buffer.byteLength, total || buffer.byteLength);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.(loaded, total);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

async function preloadVmAssets(cfg) {
  const cacheKey = JSON.stringify({
    libv86: cfg.libv86,
    wasm: cfg.wasm,
    bios: cfg.bios,
    vgaBios: cfg.vgaBios,
    bzimage: cfg.bzimage,
    initrd: cfg.initrd || "",
  });
  if (state.assetBuffers && state.assetCacheKey === cacheKey) {
    setLoading(true, { title: t("vm.loading.preparing", "Preparando VM"), detail: t("vm.loading.assetsCached", "Assets ya cargados en memoria"), percent: 100 });
    await nextPaint();
    return state.assetBuffers;
  }

  const assets = [
    { key: "libv86", name: "libv86.js", url: cfg.libv86, mode: "script" },
    { key: "wasm", name: "v86.wasm", url: cfg.wasm, mode: "cache" },
    { key: "bios", name: "BIOS", url: cfg.bios, mode: "buffer" },
    { key: "vgaBios", name: "VGA BIOS", url: cfg.vgaBios, mode: "buffer" },
    { key: "bzimage", name: "Alpine vmlinuz", url: cfg.bzimage, mode: "buffer" },
    ...(cfg.initrd ? [{ key: "initrd", name: "Alpine initramfs", url: cfg.initrd, mode: "buffer" }] : []),
  ];

  const buffers = {};
  setLoading(true, { title: t("vm.loading.preparing", "Preparando VM"), detail: t("vm.loading.calculatingSize", "Calculando tamaño de assets…"), percent: null, indeterminate: true });
  await nextPaint();

  const sizes = await Promise.all(assets.map((asset) => getAssetSize(asset.url)));
  const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
  let completedBytes = 0;

  for (let i = 0; i < assets.length; i += 1) {
    const asset = assets[i];
    const knownSize = sizes[i] || 0;

    setLoading(true, {
      title: t("vm.loading.downloading", "Descargando VM"),
      detail: `${asset.name} · 0 B${knownSize ? ` / ${formatBytes(knownSize)}` : ""}`,
      percent: totalBytes ? (completedBytes / totalBytes) * 100 : null,
      indeterminate: !totalBytes,
    });
    await nextPaint();

    if (asset.mode === "script") {
      await loadScript(asset.url);
      completedBytes += knownSize;
      setLoading(true, {
        title: t("vm.loading.downloading", "Descargando VM"),
        detail: t("vm.loading.assetReady", "{name} · listo", { name: asset.name }),
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

      setLoading(true, {
        title: t("vm.loading.downloading", "Descargando VM"),
        detail: `${asset.name} · ${sizeLabel}`,
        percent,
        indeterminate: !totalBytes && !responseTotal,
      });
    });

    if (asset.mode === "buffer") buffers[asset.key] = buffer;
    completedBytes += knownSize || buffer.byteLength || 0;
  }

  state.assetBuffers = buffers;
  state.assetCacheKey = cacheKey;
  setLoading(true, { title: t("vm.loading.starting", "Arrancando VM"), detail: t("vm.loading.initializing", "Inicializando v86…"), percent: 100 });
  await nextPaint();
  return buffers;
}
