import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = join(root, "public");
const port = Number(process.env.PORT || 5173);
const ip = process.env.IP || "127.0.0.1";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".svgz": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".ort": "application/octet-stream",
  ".safetensors": "application/octet-stream",
  ".tiktoken": "application/octet-stream",
  ".model": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".bmap": "application/octet-stream",
  ".gz": "application/gzip",
  ".img": "application/octet-stream",
  ".iso": "application/octet-stream",
};

function safePath(urlPath) {
  const cleanUrl = decodeURIComponent(urlPath.split("?")[0] || "/");
  const filePath = cleanUrl === "/" ? "/index.html" : cleanUrl;
  const resolved = normalize(join(publicRoot, filePath));
  if (!resolved.startsWith(publicRoot)) return null;
  return resolved;
}

function parseRange(rangeHeader, size) {
  if (!rangeHeader || !rangeHeader.startsWith("bytes=")) return null;
  const [startText, endText] = rangeHeader.slice(6).split("-");
  let start;
  let end;

  if (startText === "") {
    const suffix = Number(endText);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return null;
  }

  end = Math.min(end, size - 1);
  return { start, end };
}

const server = createServer((req, res) => {
  const requestUrl = req.url || "/";
  const path = safePath(requestUrl);

  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (!path || !existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 Not found");
    return;
  }

  const stat = statSync(path);
  const size = stat.size;
  const ext = extname(path).toLowerCase();
  const contentType = mime[ext] || "application/octet-stream";
  const isGeneratedVmAsset = path.includes("/v86/images/");
  const isDisk = path.includes("/v86/disks/");
  const longCache = !isGeneratedVmAsset && !isDisk && [".wasm", ".bin", ".bmap", ".img", ".iso"].includes(ext);
  const cacheControl = (isGeneratedVmAsset || isDisk) ? "no-store" : (longCache ? "public, max-age=31536000, immutable" : "no-cache");
  const range = parseRange(req.headers.range, size);

  if (req.headers.range && !range) {
    res.writeHead(416, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Range": `bytes */${size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": cacheControl,
    });
    res.end("Range Not Satisfiable");
    return;
  }

  if (range) {
    const contentLength = range.end - range.start + 1;
    res.writeHead(206, {
      "Content-Type": contentType,
      "Content-Length": contentLength,
      "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": cacheControl,
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(path, { start: range.start, end: range.end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": size,
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl,
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  createReadStream(path).pipe(res);
});

server.listen(port, ip, () => {
  console.log(`Browser Agent v86 POC: http://${ip}:${port}`);
  console.log("1) npm run setup   # descarga v86/Alpine y crea discos");
  console.log("2) npm start       # arranca servidor local");
});
