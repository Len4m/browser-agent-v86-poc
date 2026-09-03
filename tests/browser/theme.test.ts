import assert from "node:assert/strict";
import test from "node:test";

import {
  nextThemePreference,
  normalizeThemePreference,
  resolveTheme,
} from "../../src/browser/app/theme";

test("normalizeThemePreference accepts supported values and falls back to system", () => {
  assert.equal(normalizeThemePreference("system"), "system");
  assert.equal(normalizeThemePreference("light"), "light");
  assert.equal(normalizeThemePreference("dark"), "dark");
  assert.equal(normalizeThemePreference("sepia"), "system");
  assert.equal(normalizeThemePreference(null), "system");
});

test("resolveTheme follows the OS only for the system preference", () => {
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});

test("nextThemePreference cycles through all three appearance modes", () => {
  assert.equal(nextThemePreference("system"), "light");
  assert.equal(nextThemePreference("light"), "dark");
  assert.equal(nextThemePreference("dark"), "system");
});
