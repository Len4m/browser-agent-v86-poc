// Browser Agent v86 - terminal marker parsing helpers

import { CR, NL } from "../app/state";
import { normalizeNewlines, stripAnsi } from "../app/text-utils";

export function escapeRegExp(text: unknown): string {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeTerminalStreamForMarkers(text: unknown): string {
  // serial0 is a visual terminal, not a clean stdout channel. Markers may be
  // interleaved with CSI sequences, carriage returns, or cursor movement.
  let value = stripAnsi(text).split(CR).join(NL);
  for (let i = 0; i < 8 && value.includes("\b"); i += 1) {
    value = value.replace(/[^\n]\b/g, "");
  }
  return value;
}

export function extractBetweenLast(
  text: string,
  beginToken: string,
  endToken: string,
  beforeIndex = text.length,
): string | null {
  const endIndex = text.lastIndexOf(endToken, beforeIndex);
  if (endIndex < 0) return null;
  const beginIndex = text.lastIndexOf(beginToken, endIndex);
  if (beginIndex < 0) return null;
  return text.slice(beginIndex + beginToken.length, endIndex);
}

export function cleanVmCheckLines(text: unknown): string[] {
  return normalizeNewlines(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\[ba-s1\]\s+(start|end)\b/.test(line))
    .filter((line) => !/^BA_SERIAL1_/.test(line));
}

export function firstMatchingVmCheckLine(
  text: unknown,
  predicate: (line: string) => boolean,
): string {
  return cleanVmCheckLines(text).find(predicate) || "";
}

export function lastNonEmptyLine(text: unknown): string {
  return cleanVmCheckLines(text).at(-1) || "";
}
