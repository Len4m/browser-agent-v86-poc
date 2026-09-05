import { readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function sizeSummary(file) {
  const content = readFileSync(file);
  return `${formatBytes(statSync(file).size)} / gzip ${formatBytes(gzipSync(content).length)}`;
}
