// Browser Agent v86 - small, testable wsnic endpoint helpers.

export const LOCAL_WS_URL = "ws://127.0.0.1:8086/wsnic";
export const PUBLIC_RELAY_URL = "wss://relay.widgetry.org/";

export type WsPreset = "local-ws" | "public-relay" | "custom";
export type WsValidationError = "empty" | "invalid" | "scheme" | "credentials" | "mixedContent";

export interface WsUrlValidation {
  ok: boolean;
  url: string;
  error?: WsValidationError;
}

export function validateWsUrl(value: string, pageProtocol = ""): WsUrlValidation {
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, url: trimmed, error: "empty" };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, url: trimmed, error: "invalid" };
  }

  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return { ok: false, url: trimmed, error: "scheme" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, url: trimmed, error: "credentials" };
  }

  const loopback = parsed.hostname === "localhost"
    || parsed.hostname === "127.0.0.1"
    || parsed.hostname === "[::1]";
  if (pageProtocol === "https:" && parsed.protocol === "ws:" && !loopback) {
    return { ok: false, url: trimmed, error: "mixedContent" };
  }

  return { ok: true, url: parsed.toString() };
}

export function urlForWsPreset(preset: WsPreset): string {
  if (preset === "local-ws") return LOCAL_WS_URL;
  if (preset === "public-relay") return PUBLIC_RELAY_URL;
  return "";
}

export function getWsRetryDelay(attempt: number, random = Math.random, maxMs = 30000): number {
  const base = Math.min(maxMs, 1000 * (2 ** Math.max(0, attempt)));
  const jittered = base * (0.85 + (Math.max(0, Math.min(1, random())) * 0.3));
  return Math.round(Math.min(maxMs, jittered));
}
