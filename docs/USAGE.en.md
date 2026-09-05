# Usage, development, and distribution

> **English** | [Español](USAGE.es.md)

This guide explains how to run Browser Agent v86 POC, prepare the development environment, use the VM/LLM/network features, and package a runtime.

See [VM storage and snapshots](STORAGE_AND_SNAPSHOTS.en.md) for exact persistence, export and restore guarantees and limitations.

## Online demo

The easiest way to use Browser Agent v86 POC is the published demo:

[https://browseragent.icu/](https://browseragent.icu/)

You do not need to install Node.js or Docker, or clone the repository, to try it. The VM, chat, and assets are served from the web; Transformers.js models are downloaded and cached in your browser. Ollama and wsnic remain local services on your computer because the browser connects to its own `127.0.0.1`.

## Language (ES/EN)

The interface is available in Spanish and English. Use the language selector in the header to switch instantly without reloading the page or losing the running VM.

- When there is no saved choice, the app selects Spanish if any reported browser language is Spanish and English otherwise.
- The selection is stored in `localStorage` (`ba.lang`) and reused on later visits.
- Both catalog files are published under `public/locales/`, but the browser keeps only the active catalog in memory.

The interface, [user manuals](USER_MANUAL.en.md), this guide, and the architecture documentation are available in Spanish and English. See [README.md](../README.md) for links to all English documentation.

## Appearance theme

The header theme button cycles through **System → Light → Dark** and changes between combined sun-and-moon, sun, and moon icons. System mode follows browser appearance changes; an explicit choice is stored in `localStorage` (`ba.theme`) and applied before the interface is shown to avoid a flash of another theme.

## Requirements

To use a prebuilt runtime, you only need:

- A modern browser.
- WebGPU, recommended for local Transformers.js models; a WASM alternative is available when the model and configuration support it.
- An HTTP server with COOP/COEP/CORP headers, the `application/wasm` MIME type, and `Range` support.
- An Internet connection for the first Transformers.js model download, unless the model is already cached by the browser.

To prepare the project from the repository, you also need:

- Node.js 26.8.1 and pnpm 11.24.0, pinned respectively in `.nvmrc` / `.node-version` and `packageManager`.
- Linux. macOS requires GNU-compatible `tar`, `stat`, and `cpio`, plus the ext2 tools, to be installed and available on `PATH`; the default BSD utilities do not support every option used by `pnpm setup`.
- Docker to build the included Alpine profiles.
- System tools: `tar`, `cpio`, `gzip`, `zstd`, `xz`, `curl`, `coreutils`, `e2fsprogs`, `find`, `awk`, `grep`, and `sed`.
- An Internet connection for the base runtime assets, Alpine packages, and profile wordlists downloaded by `pnpm setup`.
- 1-2 GB of free space for the v86 runtime, initramfs, profiles, and sparse disks.

On Debian/Ubuntu:

```bash
sudo apt install -y cpio gzip tar curl zstd xz-utils coreutils e2fsprogs findutils gawk grep sed
```

### Recommended Memory

Memory depends on the selected LLM backend. **Transformers.js and Ollama do not have the same memory cost**:

- With **Transformers.js**, the model is downloaded/cached by the browser and inference runs with WebGPU/WASM, inside the LLM worker.
- With **Ollama**, the browser does not load the Transformers.js runtime or model. The model memory belongs to the host Ollama process and depends on the Ollama model you have loaded there.
- If you do not load a Transformers.js model, do not add the measured Transformers.js memory cost. Count only the app, the VM, and, when using Ollama, the Ollama model.

Practical guide:

| Scenario | Practical minimum | Recommended |
| --- | ---: | ---: |
| UI + lightweight VM, without local browser LLM | 4 GB | 8 GB |
| `alpine-base` VM + Transformers.js `qwen3-tools-onnx-q4` WebGPU | 8 GB | 12 GB |
| Pentest VM + Transformers.js `qwen3-tools-onnx-q4` WebGPU + tools | 12 GB | 16 GB |
| Ollama | Depends on the Ollama model | Add the Ollama model memory to the VM/app usage |

For reference, `qwen3-tools-onnx-q4` (`onnx-community/Qwen3-0.6B-ONNX`, q4/WebGPU) downloaded/cached about 0.93 GB and Chrome reached roughly 5.3 GB RSS during generation in the local test. That cost applies only to the Transformers.js backend; with Ollama it is not used unless you also load a Transformers.js model.

## Local setup

```bash
git clone https://github.com/Len4m/browser-agent-v86-poc.git
cd browser-agent-v86-poc
pnpm install
pnpm prepare:local
pnpm start
```

Open `http://127.0.0.1:5173/`.

`pnpm prepare:local` runs `setup` followed by `build`. The VM will not start correctly until the generated assets exist in `public/v86/`, `public/vendor/`, and `public/assets/`.

## First run

1. Select a VM profile.
2. Press **Start VM** and wait for the shell to appear; the first run may download large assets.
3. If the browser supports WebGPU, load a Transformers.js or Ollama model from the **LLM** panel. With WASM only, Ollama or another browser/device with WebGPU is generally a better choice for agent/tool use.
4. Use the chat to request actions inside the VM, or use the xterm consoles to inspect and run commands manually.
5. If the VM needs network access, configure wsnic from **WS network**.

Press **Run checks** at any time to validate headers, assets, serial channels, runners, network, and tools as applicable.

Generated profiles are listed in `/v86/images/profiles/index.json`. If they do not appear, run `pnpm setup`.

## VM, profiles, and storage

Included profiles:

| Profile | Purpose | Minimum RAM |
| --- | --- | --- |
| `alpine-base` | Minimal Alpine with certificates, curl, nano, and Python for the xterm daemon | 512 MB |
| `alpine-pentest-lite` | Lightweight tools: nmap, ffuf, Python, DNS, and small web wordlists | 1024 MB |
| `alpine-pentest-web` | Extended web pentesting: nikto, httpx, Perl SSL tools, and wordlists | 1536 MB |

Selecting a profile applies its minimum RAM and VRAM and disables lower values. Both resources can be increased before boot without changing the associated workspace; runtime prevents boot or restore below the minimums. Under **Keep changes**, the user chooses **No, temporary session** or **Persistent workspace**.

Disks:

- Every profile uses an immutable HDA rootfs and OverlayFS HDB. **No, temporary session** discards HDB on shutdown; **Persistent workspace** saves it automatically to IndexedDB after the user enables it.
- Each profile version has one automatic browser workspace; it has no separate import or export.
- The selector marks profiles containing saved data with **💾**. The summary shows **Persistent data · size**, calculated only from that workspace's blocks and excluding models and caches.
- **Reset workspace** appears when the profile has data and **Persistent workspace** is selected; it can run only while the VM is stopped.
- The **Export** and **Import** buttons work exclusively with `.bav86snapshot` files. Snapshots work in both modes and include verifiable identity, execution state, the explicit HDB delta, and console metadata.

## Consoles and tools

Current serial channels:

| Channel | VM device | Purpose |
| --- | --- | --- |
| `serial0` | `/dev/ttyS0` | Boot, base login, and user tab 1 |
| `serial1` | `/dev/ttyS1` | Agent tools, checks, and the manual command form |
| `serial2` | `/dev/ttyS2` | xterm/PTY daemon for interactive tabs 2-4 |

The runners installed in the initramfs come from:

- `vm/overlay/common/usr/local/bin/ba-serial1-runner`
- `vm/overlay/common/usr/local/bin/ba-serial2-console-runner`

Both guest runners use Python 3. Every profile in `vm/profiles/*.json` must include the `python3` package; `pnpm check` and the profile builder fail if it is missing.

After changing profiles, the overlay, runners, or initramfs scripts, run:

```bash
pnpm setup
```

Quick validation inside the VM:

```sh
ls -l /dev/ttyS*
ps | grep '[b]a-serial1-runner'
ps | grep '[b]a-serial2-console-runner'
python3 --version
```

## LLM

Supported backends:

- **Transformers.js**: runs in a dedicated browser worker. WebGPU is recommended; some models can fall back to WASM if WebGPU fails.
- **Ollama HTTP**: the browser connects directly to the local endpoint, `http://127.0.0.1:11434` by default.

Models are discovered at runtime. Transformers.js searches public, non-gated `text-generation` repositories tagged `transformers.js` on the Hugging Face Hub; Ollama queries the models installed at the configured endpoint and shows those that announce tool support. A repository ID can also be entered manually for Transformers.js.

Hub search is remote and paginated; **Load more** remains the last list option while more results are available. The list only includes repositories with detected tool support. A manual repository ID is not subject to that filter: the information button inside the field inspects its metadata before loading and shows an error below the field when inspection fails. Selecting or inspecting a repository uses a temporary worker to inspect its ONNX files, dtypes, declared context, chat template, and tool/thinking signals. Ollama lists installed models that announce tool support and requests `/api/show` for their capabilities and context.

The browser cache may prevent Transformers.js from downloading model files again. The application persists the last selected engine/model and its settings under `ba.llm.lastProfile.v1`. **Restore defaults** restores the initial values for the current engine and model.

The basic and advanced sections represent user policy, not recommendations. An unknown capability produces warnings but does not disable the agent by itself.

Usage notes:

- Chat is disabled until you load a backend/model.
- Transformers.js loading uses the application's shared overlay. It identifies the current phase or component—for example configuration, tokenizer, or weights—and provides **Cancel download** without reloading the page. On failure, the details appear next to **Load model** and are cleared when the source or candidate changes.
- The effective configuration is captured when a response starts. Settings that change the loaded runtime—engine/model, device, dtype, generation cache, and thinking generation/parsing—are locked until it finishes; autonomy is also locked so approval policy cannot change mid-turn. Changing runtime settings while chat is idle unloads the runtime and requires loading it again. Agent, tool-selection, sampling, context, and reasoning-display settings can be prepared for the next turn without interrupting the current one.
- Reasoning text is streamed but is not saved as the final response or retained in memory.
- Tool results are stored as artifacts in the LLM panel: you can preview them, attach them to the next message, or delete them. Attachments respect the model's context budget and are omitted when there is not enough room.
- The first Transformers.js model load may download large files, which the browser can cache.
- WebGPU is the recommended path for tools with Transformers.js. The WASM fallback exists for basic chat in browsers without WebGPU, but should not be considered reliable for tool calling; use a browser with compatible WebGPU or Ollama when you need tools.
- If you use Ollama from an origin that is not allowed, start Ollama with `OLLAMA_ORIGINS` including the page origin. Example: `OLLAMA_ORIGINS=http://127.0.0.1:5173`.
- In a web deployment, Ollama remains local to each user: the browser connects to its own `127.0.0.1`.

## WS network

Networking is optional. Use **Test** to check the handshake and **Connect** to activate the endpoint; DHCP, DNS, and traffic are then validated from the VM.

### Local Docker WS

This is the default (`ws://127.0.0.1:8086/wsnic`). Run the Docker command shown in the UI. With `-i`, it allows access to the host and Internet; without `-i`, VMs/tabs can only communicate with one another over the virtual network.

### Public relay

Uses the fixed endpoint `wss://relay.widgetry.org/`. It is an experimental, shared, limited relay with no SLA or privacy, availability, or stability guarantees. Do not send sensitive data or load-test it.

### Custom

Accepts any valid `ws://` or `wss://` URL. For WSS, use a valid public certificate and complete chain, either directly with wsnic/stunnel on `8087` or by terminating TLS with Caddy, Nginx, or Traefik on `443`. Do not expose `ws://` to the Internet, use self-signed certificates, or disable browser security.

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm install` | Installs the project dependencies; does not generate heavy assets |
| `pnpm prepare:local` | Runs `setup` and `build` to create a usable local environment |
| `pnpm setup` | Downloads/copies base assets and generates the OverlayFS profiles |
| `pnpm build` | Generates the LLM worker/bridge and frontend bundle; it does not query model APIs and requires `setup` to have run at least once |
| `pnpm build:prod` | Generates the minified production runtime: minified JS/CSS and cache hashes |
| `pnpm check` | Runs TypeScript, lint, unit tests, and repository/asset integrity checks |
| `pnpm clean` | Removes `build/` and generated build outputs from `public/` |
| `pnpm clean:runtime` | Removes the heavy runtime generated by `setup`: `public/vendor/` and `public/v86/` |
| `pnpm clean:all` | Cleans both build outputs and the runtime |
| `pnpm start` | Serves `public/` through `server.mjs` at `127.0.0.1:5173` |

Regenerate with `pnpm setup` after changing:

- `vm/profiles/*.json`
- `vm/overlay/common/`
- `scripts/setup/vm-alpine-overlay-hda.sh`
- Serial runners

VM profiles must keep `python3` in `packages`, because the guest serial runners depend on Python 3.

Regenerate with `pnpm build` after changing:

- `src/browser/`
- `src/web/index.html`
- `src/web/styles/`
- The AI SDK provider or LLM worker

## Generated artifacts

| Source | Output | Regenerate with |
| --- | --- | --- |
| `src/browser/`, `src/web/index.html`, `src/web/styles/` | `public/index.html`, `public/style.css`, `public/styles/`, `public/assets/app.js`, `public/assets/ai-sdk-bridge.mjs` | `pnpm build` |
| `src/web/styles/` | `public/assets/app.css` | `pnpm build:prod` |
| `src/browser/chat/provider/ai-sdk/` | `public/assets/chat/` | `pnpm build` |
| `vm/profiles/*.json`, `vm/overlay/common/` | `build/profiles/`, `public/v86/images/profiles/` | `pnpm setup` |
| v86, xterm, DOMPurify, streaming-markdown, BIOS, and Alpine base | `public/vendor/`, `public/v86/build/`, `public/v86/bios/`, `public/v86/images/` | `pnpm setup` |
| Split profile root HDA and HDB seed | `public/v86/images/profiles/` | `pnpm setup` |

## Cleaning

Use `pnpm clean` during normal development. It removes `build/` and generated build outputs from `public/`: `index.html`, `style.css`, `styles/`, `locales/` (copied from `src/web/`), JS bundles, and `assets/chat/`. It does not remove `public/vendor/`, `public/v86/`, or the static files tracked by Git (`favicon.ico`, icons, `robots.txt`, etc.).

Use `pnpm clean:runtime` to force regeneration of the heavy runtime: vendors, v86, BIOS, initramfs, profiles, and disks. Then run `pnpm setup` or `pnpm prepare:local` before starting the VM.

Use `pnpm clean:all` to clean both groups.

## Runtime zip

The static runtime is the `public/` directory. A complete package containing every included feature has the generated HTML, CSS, JS, vendor files, v86, BIOS, initramfs, profiles, and disks.

Create the zip:

```bash
pnpm prepare:local
pnpm check
cd public
zip -r ../browser-agent-v86-poc-runtime-public.zip .
```

Minimum contents:

- `index.html`, `style.css`, `styles/`
- `assets/`
- `vendor/`
- `v86/build/`
- `v86/bios/`
- `v86/images/`
- `v86/disks/`
- `favicon.ico`, `apple-touch-icon.png`, `site.webmanifest`, and `robots.txt`
- `_headers` when deploying to a compatible platform such as Cloudflare Pages

The final server must send COOP/COEP/CORP headers and support `Range`. `public/_headers` documents these headers for Cloudflare Pages, but other servers need equivalent configuration.

For the official demo's public build:

```bash
pnpm build:prod
```

`build:prod` uses `https://browseragent.icu/` as `BA_PUBLIC_SITE_URL` by default. For another domain:

```bash
BA_PUBLIC_SITE_URL=https://your-domain.example/ pnpm build:prod
```

This value is used for `canonical`, `og:url`, and absolute Open Graph/Twitter image URLs. If a non-production build runs without this variable, the HTML remains portable by using origin-relative URLs.

Package the runtime with the local server included:

```bash
zip -r browser-agent-v86-poc-local-server.zip public server.mjs package.json pnpm-lock.yaml pnpm-workspace.yaml
```

Usage:

```bash
unzip browser-agent-v86-poc-local-server.zip -d destination/
cd destination
pnpm install
pnpm start
```

## Common issues

- **VM does not start**: run `pnpm prepare:local`, then `pnpm check`.
- **Profiles do not appear**: `/v86/images/profiles/index.json` is missing; run `pnpm setup`.
- **You changed the initramfs, runners, or profiles**: run `pnpm setup` and start a new VM.
- **Profile storage does not mount**: verify that the split root HDA and HDB seed exist under `public/v86/images/profiles/`; `pnpm setup` creates them.
- **Tools or checks affect the visible console**: validate `/dev/ttyS1`, `/dev/ttyS2`, and the `ba-serial1-runner` / `ba-serial2-console-runner` processes.
- **An xterm console becomes desynchronized**: use refresh; it clears the local xterm and sends `Ctrl+L` to the active shell.
- **Local LLM fails because of WebGPU**: try a WASM model or a smaller model; some paths attempt a WASM fallback.
- **Ollama fails because of CORS**: configure `OLLAMA_ORIGINS` with the exact origin serving the page.
- **Ollama does not respond with the selected model**: check that the model is installed in your local Ollama with `ollama list`, or install it with `ollama pull <model>`.
- **VM has no network access**: verify that `wsnic` is running, the UI is connected, and the VM has completed network configuration.
