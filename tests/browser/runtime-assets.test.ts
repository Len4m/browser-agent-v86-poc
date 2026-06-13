import assert from "node:assert/strict";
import test from "node:test";

import {
  formatBytes,
  normalizeLs,
  normalizeStateBuffer,
} from "../../src/browser/vm/runtime-assets";

test("formatBytes renders compact binary sizes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(10 * 1024 * 1024), "10 MB");
});

test("normalizeLs disables colored ls output", () => {
  assert.equal(normalizeLs("ls"), "ls --color=never");
  assert.equal(normalizeLs("ls -la /tmp"), "ls --color=never -la /tmp");
  assert.equal(normalizeLs("pwd"), "pwd");
});

test("normalizeStateBuffer accepts ArrayBuffer and typed views", () => {
  const source = new Uint8Array([1, 2, 3, 4]).buffer;
  assert.equal(normalizeStateBuffer(source), source);

  const view = new Uint8Array(source, 1, 2);
  assert.deepEqual(Array.from(new Uint8Array(normalizeStateBuffer(view))), [2, 3]);
});
