import { rmSync } from "node:fs";

export const buildTargets = [
  "build",
  "public/index.html",
  "public/style.css",
  "public/styles",
  "public/assets/app.js",
  "public/assets/app.css",
  "public/assets/ai-sdk-bridge.mjs",
  "public/assets/chat",
];

export const runtimeTargets = [
  "public/vendor",
  "public/v86",
];

export function cleanTargets(label, targets) {
  for (const target of targets) {
    rmSync(target, { recursive: true, force: true });
    console.log(`${label} ${target}`);
  }
}
