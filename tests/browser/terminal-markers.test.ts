import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanVmCheckLines,
  extractBetweenLast,
  firstMatchingVmCheckLine,
  lastNonEmptyLine,
  normalizeTerminalStreamForMarkers,
} from "../../src/browser/vm/terminal-markers";

test("normalizeTerminalStreamForMarkers strips ANSI, CR, and backspaces", () => {
  assert.equal(
    normalizeTerminalStreamForMarkers("\u001b[31mabc\u001b[0m\rde\bX\n"),
    "ab\nd\n",
  );
});

test("extractBetweenLast returns the last complete marker section", () => {
  const text = "A_START one A_END A_START two A_END";
  assert.equal(extractBetweenLast(text, "A_START", "A_END"), " two ");
});

test("VM check line helpers ignore serial runner markers", () => {
  const text = "[ba-s1] start\nBA_SERIAL1_READY\nunknown\nprofile-a\n";
  assert.deepEqual(cleanVmCheckLines(text), ["unknown", "profile-a"]);
  assert.equal(firstMatchingVmCheckLine(text, (line) => line !== "unknown"), "profile-a");
  assert.equal(lastNonEmptyLine(text), "profile-a");
});
