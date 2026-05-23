#!/usr/bin/env node
import { rmSync } from "node:fs";

const targets = [
  "build",
  "public/assets/app.js",
  "public/assets/ai-sdk-bridge.mjs",
  "public/assets/chat",
];

for (const target of targets) {
  rmSync(target, { recursive: true, force: true });
  console.log(`clean ${target}`);
}
