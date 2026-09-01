# Browser Agent v86 POC

> **English** | [Español](README.es.md)

[![Beta version](https://img.shields.io/badge/version-0.9.8--beta.8-orange)](https://github.com/Len4m/browser-agent-v86-poc)

Browser Agent v86 POC runs an **x86 Linux VM with v86**, an **in-browser LLM chat**, and agent tools that can execute commands inside the VM. Its purpose is to experiment with local AI, Linux, automation, and networking from a web application served entirely as static files.

Current status: **beta `0.9.8-beta.8`**. Version `1.0.0` is reserved for the first stable release.

- Demo: [https://browseragent.icu/](https://browseragent.icu/)
- Repository: [https://github.com/Len4m/browser-agent-v86-poc](https://github.com/Len4m/browser-agent-v86-poc)
- Author: Lenam [lenamgenx@protonmail.com](mailto:lenamgenx@protonmail.com) ([https://Len4m.github.io](https://Len4m.github.io))

## Features

- **In-browser Alpine x86 VM**: initramfs boot, generated profiles, and optional HDA data disks.
- **Direct xterm consoles**: up to 4 user tabs; tab 1 uses the real `serial0`, while tabs 2-4 use dedicated PTYs inside the VM.
- **Background agent tools**: chat commands and checks run through `serial1` / `/dev/ttyS1`, separately from the visible console.
- **Dedicated console transport**: multiplexed xterm/PTY traffic for tabs 2-4 through `serial2` / `/dev/ttyS2`.
- **Python 3 guest runners**: VM profiles include `python3` as a base dependency of the serial overlay.
- **Browser-based LLM or local Ollama**: Transformers.js with WebGPU/WASM and an optional Ollama HTTP provider, including optional per-model reasoning (thinking) display.
- **Optional networking through wsnic**: a local WebSocket proxy that gives the VM network access.
- **Bilingual ES/EN UI**: switch languages instantly from the header without reloading or losing the VM; when there is no saved choice, the app selects Spanish if the browser reports a Spanish language and English otherwise.

## Try the online demo

The fastest way to try the project is to open:

[https://browseragent.icu/](https://browseragent.icu/)

Before trying the demo, we recommend reading the [user manual](docs/USER_MANUAL.en.md).

You do not need to clone the repository. Transformers.js models are downloaded and run in your browser. Ollama and wsnic are optional; when used, they run locally on your computer.

## Run from the repository

Main requirements: Node.js 26.8.1, pnpm 11.24.0, Linux (or macOS with GNU-compatible build tools), Docker, system tools for generating initramfs/disk images, and an Internet connection to download base assets, Alpine packages, and browser models when first loaded. Versions are pinned in `.nvmrc`, `.node-version`, and `packageManager`.

On Debian/Ubuntu, install the system dependencies with:

```bash
sudo apt install -y cpio gzip tar curl zstd xz-utils coreutils e2fsprogs findutils gawk grep sed
```

Indicative memory/GPU: minimum 4 GB RAM; 8 GB RAM and a WebGPU GPU with ~2 GB VRAM/shared memory for local browser LLM; more RAM/VRAM improves stability. Details in [docs/USAGE.en.md](docs/USAGE.en.md).

```bash
git clone https://github.com/Len4m/browser-agent-v86-poc.git
cd browser-agent-v86-poc
pnpm install
pnpm prepare:local
pnpm start
```

Open `http://127.0.0.1:5173/`.

Recommended first run:

1. Select a VM profile.
2. Press **Start VM** and wait for the shell to appear; the first run may download large assets.
3. If the browser supports WebGPU, load a Transformers.js or Ollama model from the **LLM** panel. With WASM only, Ollama or another browser/device with WebGPU is generally a better choice for agent/tool use.
4. Use the chat to request actions inside the VM, or use the consoles to inspect and run commands manually.
5. If the VM needs network access, configure wsnic from **WS network**.

Press **Run checks** at any time to inspect the app, VM, assets, network, and tool status.

For detailed requirements, scripts, packaging, and troubleshooting, see [docs/USAGE.en.md](docs/USAGE.en.md).

## Run a prebuilt runtime

If you already have a zip of `public/` containing the generated assets, you do not need Node.js or Docker to use the application. Serve that directory with an HTTP server that provides:

- COOP/COEP/CORP headers for `SharedArrayBuffer`.
- The correct MIME type for `.wasm`.
- `Range` support for large assets.

Do not open `index.html` through `file://`. `pnpm start` already serves `public/` with the required headers.

## Main structure

```txt
public/                    # browser-served root; generated outputs and static assets
src/browser/               # frontend TypeScript source
src/web/                   # source HTML template and CSS
scripts/                   # main scripts and internal build/setup/check/clean steps
tests/                     # Node/unit tests for browser modules and repository behavior
vm/profiles/               # Alpine VM profiles
vm/overlay/common/         # runners and files included in the initramfs
docs/                      # user, usage, architecture, and developer documentation
```

## Documentation

| Document | Contents |
| --- | --- |
| [README.md](README.md) | Repository entry point (this file). |
| [docs/USER_MANUAL.en.md](docs/USER_MANUAL.en.md) | End-user guide to the VM, chat, and panels; does not cover installation or development. |
| [docs/USAGE.en.md](docs/USAGE.en.md) | Local setup, VM/LLM/wsnic, scripts, runtime zip, and common issues. |
| [docs/ARCHITECTURE.en.md](docs/ARCHITECTURE.en.md) | Frontend architecture, build, VM, serial channels, LLM, tool/profile contracts, and maintenance rules. |
| [docs/VM_PROFILES_AND_TOOLS.en.md](docs/VM_PROFILES_AND_TOOLS.en.md) | Developer guide for adding VM profiles and exposing tools through profile policy. |
| [docs/schema-reference/](docs/schema-reference/README.md) | Generated JSON Schema field references (LLM catalog, VM profile). |

Each document links to its counterpart in the other language. Use `USAGE`, `ARCHITECTURE`, and `VM_PROFILES_AND_TOOLS` when contributing to or deploying the project. For profile and LLM catalog field semantics, see `docs/schema-reference/`.

## Contributing

All kinds of contributions are welcome: [issues](https://github.com/Len4m/browser-agent-v86-poc/issues), bug reports, ideas, translations, documentation improvements, [pull requests](https://github.com/Len4m/browser-agent-v86-poc/pulls), and new VM profiles or profile tools. You can find planned improvements and open tasks in [TODO.md](TODO.md), currently available in Spanish. If you want to add runtime capabilities, see the [VM profiles and tools guide](docs/VM_PROFILES_AND_TOOLS.en.md).

If the project is useful or interesting to you, starring the repository helps other developers discover it.

## License

Browser Agent v86 POC's original code is released under the MIT License. See [LICENSE](LICENSE).

The runtime includes or downloads third-party components under their own licenses. See [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) for a summary.

Main third-party dependencies:

- v86: BSD-2-Clause.
- `@browser-ai/transformers-js`, `@huggingface/transformers`, and AI SDK (`ai`): Apache-2.0.
- Generated Alpine profiles may contain packages under the GPL, LGPL, and other package-specific licenses. When redistributing generated initramfs files, images, or profiles, retain the corresponding notices and comply with their obligations.
- LLM models downloaded by the user from Hugging Face, Ollama, or other sources retain their own licenses and are not covered by this repository's MIT License.
