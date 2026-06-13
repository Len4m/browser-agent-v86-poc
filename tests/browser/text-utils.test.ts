import assert from "node:assert/strict";
import test from "node:test";

import {
  clampExecVmOutputBytes,
  clampInt,
  normalizeNewlines,
  shellQuote,
  stripAnsi,
  stripAnsiAndControls,
  trimLines,
  trimLinesSimple,
  utf8ToBase64,
} from "../../src/browser/app/text-utils";

test("stripAnsi removes ANSI escape sequences", () => {
  assert.equal(stripAnsi("\u001b[31mred\u001b[0m"), "red");
});

test("normalizeNewlines converts CRLF and CR to LF", () => {
  assert.equal(normalizeNewlines("a\r\nb\rc"), "a\nb\nc");
});

test("stripAnsiAndControls normalizes text for logs", () => {
  assert.equal(stripAnsiAndControls("\u001b[32mok\u001b[0m\u0000\r\nnext"), "ok\nnext");
});

test("trim helpers remove terminal framing without touching inner text", () => {
  assert.equal(trimLines("\n\nhello\r\n"), "hello");
  assert.equal(trimLinesSimple("\r\n  hello  \n"), "hello");
});

test("shellQuote produces single-quoted shell-safe text", () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test("clamp helpers keep numeric values inside supported bounds", () => {
  assert.equal(clampInt("12.8", 1, 10, 5), 10);
  assert.equal(clampInt("bad", 1, 10, 5), 5);
  assert.equal(clampExecVmOutputBytes(999), 1024);
  assert.equal(clampExecVmOutputBytes(999999), 131072);
});

test("utf8ToBase64 encodes UTF-8 text", () => {
  assert.equal(utf8ToBase64("he"), "aGU=");
  assert.equal(utf8ToBase64("hé"), "aMOp");
});
