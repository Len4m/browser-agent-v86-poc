const encoder = new TextEncoder();

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const copy = bytes instanceof ArrayBuffer ? bytes.slice(0) : Uint8Array.from(bytes).buffer;
  return hex(await crypto.subtle.digest("SHA-256", copy));
}

export async function diskRootHash(blocks: readonly { index: number; bytes: Uint8Array }[]): Promise<string> {
  const entries: string[] = [];
  for (const block of [...blocks].sort((a, b) => a.index - b.index)) {
    entries.push(`${block.index}:${block.bytes.byteLength}:${await sha256(block.bytes)}`);
  }
  return sha256(entries.join("\n"));
}
