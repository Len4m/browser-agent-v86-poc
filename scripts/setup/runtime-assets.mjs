import { copyFileSync, createWriteStream, mkdirSync, statSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

const root = fileURLToPath(new URL("../..", import.meta.url));

// Runtime libraries come from package.json/node_modules. Only OS/firmware files
// that are not published as npm runtime assets remain remote downloads.
const npmAssets = [
  {
    name: "libv86.js",
    src: "node_modules/v86/build/libv86.js",
    dest: "public/v86/build/libv86.js",
  },
  {
    name: "v86.wasm",
    src: "node_modules/v86/build/v86.wasm",
    dest: "public/v86/build/v86.wasm",
  },
  {
    name: "xterm.js",
    src: "node_modules/@xterm/xterm/lib/xterm.js",
    dest: "public/vendor/xterm/xterm.js",
  },
  {
    name: "xterm.css",
    src: "node_modules/@xterm/xterm/css/xterm.css",
    dest: "public/vendor/xterm/xterm.css",
  },
  {
    name: "DOMPurify ESM",
    src: "node_modules/dompurify/dist/purify.es.mjs",
    dest: "public/vendor/llm/dompurify/purify.es.mjs",
  },
  {
    name: "DOMPurify license",
    src: "node_modules/dompurify/LICENSE",
    dest: "public/vendor/llm/dompurify/LICENSE",
  },
  {
    name: "streaming-markdown",
    src: "node_modules/streaming-markdown/smd.js",
    dest: "public/vendor/llm/streaming-markdown/smd.js",
  },
  {
    name: "streaming-markdown license",
    src: "node_modules/streaming-markdown/license",
    dest: "public/vendor/llm/streaming-markdown/LICENSE",
  },
];

const remoteAssets = [
  {
    name: "seabios.bin",
    url: "https://cdn.jsdelivr.net/gh/copy/v86@master/bios/seabios.bin",
    dest: "public/v86/bios/seabios.bin",
  },
  {
    name: "vgabios.bin",
    url: "https://cdn.jsdelivr.net/gh/copy/v86@master/bios/vgabios.bin",
    dest: "public/v86/bios/vgabios.bin",
  },
  {
    name: "alpine-minirootfs-3.23.4-x86.tar.gz",
    url: "https://dl-cdn.alpinelinux.org/alpine/v3.23/releases/x86/alpine-minirootfs-3.23.4-x86.tar.gz",
    dest: "public/v86/images/alpine-minirootfs-3.23.4-x86.tar.gz",
  },
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(dest), { recursive: true });
    const file = createWriteStream(dest);
    let settled = false;

    function fail(error) {
      if (settled) return;
      settled = true;
      file.close(() => {});
      try { unlinkSync(dest); } catch {}
      reject(error);
    }

    function request(currentUrl, redirects = 0) {
      https.get(currentUrl, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirects < 8) {
          response.resume();
          request(new URL(response.headers.location, currentUrl).toString(), redirects + 1);
          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          fail(new Error(`HTTP ${response.statusCode} descargando ${currentUrl}`));
          return;
        }

        response.pipe(file);
        file.on("finish", () => {
          file.close(() => {
            if (!settled) {
              settled = true;
              resolve();
            }
          });
        });
      }).on("error", fail);
    }

    request(url);
  });
}

for (const asset of npmAssets) {
  const src = join(root, asset.src);
  const dest = join(root, asset.dest);
  if (!existsSync(src) || statSync(src).size <= 0) {
    throw new Error(`Falta ${asset.name} en ${asset.src}. Ejecuta npm install.`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`OK ${asset.name} copiado desde npm (${statSync(dest).size} bytes)`);
}

for (const asset of remoteAssets) {
  const dest = join(root, asset.dest);
  if (existsSync(dest) && statSync(dest).size > 0) {
    console.log(`OK ${asset.name} ya existe (${statSync(dest).size} bytes)`);
    continue;
  }
  console.log(`Descargando ${asset.name} desde ${asset.url}...`);
  await download(asset.url, dest);
  console.log(`OK ${asset.name} (${statSync(dest).size} bytes)`);
}

console.log("Assets base v86 + Alpine + librerías npm listos.");
