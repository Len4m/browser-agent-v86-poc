#!/usr/bin/env node
import { spawn } from "node:child_process";

const port = 5199;
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["server.mjs"], {
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
server.stdout.on("data", (chunk) => { output += String(chunk); });
server.stderr.on("data", (chunk) => { output += String(chunk); });

function stop(code = 0) {
  server.kill("SIGTERM");
  process.exit(code);
}

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    console.error(output);
    stop(1);
  }
}

async function waitForServer() {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base, { method: "HEAD" });
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("server.mjs no arrancó a tiempo");
}

try {
  const head = await waitForServer();
  assert(head.headers.get("cross-origin-opener-policy") === "same-origin", "Falta COOP");
  assert(head.headers.get("cross-origin-embedder-policy") === "require-corp", "Falta COEP");
  assert(head.headers.get("cross-origin-resource-policy") === "same-origin", "Falta CORP");

  const range = await fetch(`${base}/assets/app.js`, { headers: { Range: "bytes=0-9" } });
  assert(range.status === 206, "Range request no devuelve 206");
  assert(range.headers.get("accept-ranges") === "bytes", "Falta Accept-Ranges");

  console.log("OK server headers/range");
  stop(0);
} catch (error) {
  console.error(error?.message || String(error));
  stop(1);
}
