import assert from "node:assert/strict";
import test from "node:test";

import {
  getWsRetryDelay,
  LOCAL_WS_URL,
  PUBLIC_RELAY_URL,
  urlForWsPreset,
  validateWsUrl,
} from "../../src/browser/vm/ws-network-config";

test("wsnic presets map to safe defaults", () => {
  assert.equal(urlForWsPreset("local-ws"), LOCAL_WS_URL);
  assert.equal(urlForWsPreset("public-relay"), PUBLIC_RELAY_URL);
  assert.equal(urlForWsPreset("custom"), "");
});

test("validateWsUrl accepts WebSocket URLs and rejects unsafe forms", () => {
  assert.equal(validateWsUrl(LOCAL_WS_URL).ok, true);
  assert.equal(validateWsUrl("ws://192.0.2.10:8086/wsnic").ok, true);
  assert.equal(validateWsUrl("wss://relay.example.net/wsnic").ok, true);
  assert.equal(validateWsUrl("").error, "empty");
  assert.equal(validateWsUrl("not a url").error, "invalid");
  assert.equal(validateWsUrl("https://relay.example.net/wsnic").error, "scheme");
  assert.equal(validateWsUrl("wss://user:secret@relay.example.net/wsnic").error, "credentials");
  assert.equal(validateWsUrl("ws://relay.example.net/wsnic", "https:").error, "mixedContent");
  assert.equal(validateWsUrl(LOCAL_WS_URL, "https:").ok, true);
});

test("getWsRetryDelay applies capped exponential backoff", () => {
  const noJitter = (): number => 0.5;
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map((attempt) => getWsRetryDelay(attempt, noJitter)),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000],
  );
  assert.equal(getWsRetryDelay(-3, noJitter), 1000);
});
