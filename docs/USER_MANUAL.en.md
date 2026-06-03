# Browser Agent v86 POC User Manual

> Spanish version: [USER_MANUAL.es.md](USER_MANUAL.es.md)

This manual explains how to use the application once it is open. It does not cover installation, development, profile generation, or repository scripts.

## Overview

Browser Agent v86 POC combines three work areas:

- **Chat**: conversation with a local browser LLM or local Ollama.
- **VM**: a Linux x86 machine running with v86, including profiles, consoles, disks, and snapshots.
- **Lower panels**: wsnic networking, LLM information, and status checks.

![Browser Agent v86 POC](assets/20260604_010743_image.png)

The header shows global status:

- **Version**: current application version.
- **v86**: VM status.
- **WebGPU/WASM**: inference backend available for local models. It may show WebGPU or WASM depending on what the browser supports.
- **WS**: wsnic network status.
- **Language**: ES/EN selector. It switches the UI without reloading the page or losing the VM.
- **GitHub**: opens the project repository.

## Recommended Flow

1. Select the VM **Profile** you want to use.
2. Press **Start VM**. On first use it may download large assets; wait until the console shows the shell.
3. If the browser supports **WebGPU**, you can use a local Transformers.js model or an Ollama model and load it from the **LLM** panel. Transformers.js downloads and caches the model in the browser. If you only have **WASM**, using Ollama or switching to another browser/device with WebGPU is usually better for agent and tool usage.
4. Talk to the chat to request actions inside the VM, or use the consoles to inspect and run anything manually.
5. If you need outbound network access inside the VM, configure **wsnic** from the **WS network** panel.

You can press **Run checks** at any time to verify whether the application, VM, network, assets, and tools are healthy.

## Chat

The chat panel is on the left on desktop and above the VM on mobile.

- **Expand chat** switches between split view and full-width chat.
- **Clear chat** clears the visible history, internal LLM memory, and turn artifacts.
- **Tools button** opens the selector for tools the agent may use. Available tools vary by selected VM profile.
- **Message field** stays disabled until a model is ready; see the **LLM Panel** section.
- **Send / stop** sends the message; during generation it can stop the active turn.

Use concrete prompts. For example: "check the VM IP", "list /etc", "send a HEAD request to this authorized host", "create a Python script that processes this file and saves it in `/tmp`", or "summarize the last artifact".

Tool-enabled chat quality depends heavily on the selected model. Some models follow instructions and tool calls better than others. Also, the smaller the model context is, the more you should limit the number of active tools in one request to reduce noise, memory usage, and planning errors.

## VM, Profiles, and Disks

Before booting you can configure:

| Control | Purpose |
| --- | --- |
| **Profile** | Selects a prepared Alpine image. |
| **RAM** | Main memory in **Free / manual** mode. Generated profiles apply their recommended value. |
| **VRAM** | Video memory in **Free / manual** mode. |
| **Disk** | Selects RAM/initramfs-only execution or a data HDA disk. |

Common profiles:

| Profile | Recommended use |
| --- | --- |
| `alpine-base` | Minimal Alpine shell with basic utilities. |
| `alpine-pentest-lite` | Light reconnaissance with tools such as nmap and ffuf. |
| `alpine-pentest-web` | Broader web testing with additional tools such as nikto/httpx. |

HDA disks are data disks. The system boots from initramfs; if you choose an HDA disk, mount or unmount it with the disk button once the VM is ready. Snapshots save VM state, but they are not a replacement for a persistence strategy for important data.

### VM Controls

- **Start VM / Shut down VM** starts or stops the VM. Shutting down loses changes not saved in a snapshot or persistent disk.
- **Mount disk / Unmount disk** appears when an HDA disk is selected.
- **New console** creates an additional xterm tab up to the application limit.
- **Rename console** lets you change a tab name by double-clicking its label, which helps organize several sessions.
- **Redraw console** forces the active console to repaint.
- **Close console** closes the active xterm tab when it is not the base console.
- **Console help** explains serial channels, PTYs, and tool separation.
- **Cancel tool** attempts to cancel a running background tool.

### Consoles

The first console uses `serial0` and shows the base VM boot. Additional consoles use PTYs inside the VM over `serial2`.

Agent tools, checks, and the manual command form do not write to the visible console: they use `serial1` / `/dev/ttyS1`. This separation prevents a tool from polluting or blocking the interactive session.

### Manual Execution and Tool Log

Below the VM there is a tool log and a manual command form.

- The log shows internal operations, network events, snapshots, disk actions, and tool output.
- The command field runs a command inside the VM through `serial1`.
- While a tool is active, some controls are locked until it finishes or is cancelled.

This form is useful for short check commands. Use console tabs for interactive work.

### Snapshots

- **Save snapshot** downloads a `.v86state` file with the current VM state.
- **Restore snapshot** asks for a state file and restarts/restores the VM.
- Restore with compatible settings: RAM, disk, and profile should reasonably match the saved state.
- Snapshots may not include data written to HDA disks; check the tool log warnings.

Before shutting down the VM, save a snapshot if you want to keep RAM/process state.

## LLM Panel

The **LLM** panel lets you choose and load the inference engine:

- **Model**: lists browser Transformers.js models and Ollama options.
- **Ollama endpoint**: appears when an Ollama model is selected; usually `http://127.0.0.1:11434`.
- **Load model** downloads/caches the model and prepares the worker.
- **Show reasoning** appears for models compatible with thinking output.
- **Resources and context** shows context budget, artifacts, and active operation.
- **Tool autonomy** defines up to which risk level the agent may act without asking for confirmation.
- **Unload worker** releases the loaded worker/model.

WebGPU is the recommended path for local models. If WebGPU fails and the model supports it, the app may try the experimental WASM fallback.

### Ollama

Ollama runs outside the browser, usually on your own machine. The browser calls the Ollama HTTP endpoint directly, by default `http://127.0.0.1:11434`.

For it to work from the app, Ollama must allow the origin where you open Browser Agent. Set `OLLAMA_ORIGINS` before starting Ollama.

Example for local use:

```bash
OLLAMA_ORIGINS=http://127.0.0.1:5173 ollama serve
```

Example for the published demo:

```bash
OLLAMA_ORIGINS=https://browseragent.icu ollama serve
```

If you serve the app from another port or domain, use that exact origin. The selected model must also exist in your local Ollama; if it does not, install it with `ollama pull <model>`.

### Tools

Inside the **LLM** panel, tools control how the chat interacts with the VM. They are actions the chat can execute inside the VM: reading files, writing files, running controlled commands, checking packages, inspecting network state, making HTTP requests, or launching pentest tools allowed by the active profile.

- Enable or disable tools from the chat wrench button.
- Available tools depend on the selected profile. For example, pentest profiles expose tools that do not appear in the base profile.
- Each tool has a security level: level 1 for bounded reads, level 2 for low-impact diagnostics, and level 3 for active actions such as controlled commands or light scans.
- **Tool autonomy** decides up to which level the agent can act without confirmation. Tools above the allowed level show a confirmation prompt before running.
- The tools selector lets you reduce how many tools the model sees in one request. This helps with smaller models or models with limited context.

Use network and pentest tools only against systems you own or are authorized to test.

### Artifacts

Artifacts are real tool results saved by the **LLM** panel so the chat is not flooded and long outputs are not resent to the model on every turn.

- The app keeps up to **10 recent artifacts**, with an approximate total limit of **1 MB**. If the limit is exceeded, the oldest artifacts are removed first.
- Each artifact may contain truncated output: the on-screen preview and the compact text for the model have different limits.
- You can open an artifact preview from **Resources and context**.
- You can attach an artifact to the context of the next chat interaction when the model has enough context budget. If there is no room, the UI marks it as not sendable.
- You can detach an artifact from context, delete individual artifacts, or clear all artifacts from the panel.

## wsnic Network

The **WS** panel connects the VM to `wsnic`, which effectively acts as a WebSocket-accessible virtual network interface. The UI calls it a local proxy for simplicity, but it is closer to an access point/bridge for the VM network.

When connected, wsnic gives the VM outbound network access to the Internet and to networks reachable from the host where you run the Docker container. This means the VM may be able to reach local network resources from that host if the host network configuration allows it.

With networking available, you can also install Alpine packages inside the VM with `apk`, for example `apk add htop`. Remember that changes made in RAM/initramfs are lost on shutdown unless you save/restore state through the snapshot flow.

- **URL** points to the proxy WebSocket endpoint.
- **Connect / Disconnect** opens or closes the connection.
- After connecting, the app tries to configure networking inside the VM when it is ready.
- Header and panel badges show whether wsnic is disconnected, connecting, connected, or in error.

Google Chrome and other Chromium-based browsers may show a local-network access permission prompt when connecting to wsnic on `127.0.0.1`. Allow it so the page can open the local WebSocket connection.

Command shown by the UI to start local wsnic:

```bash
docker rm -f browser-agent-wsnic 2>/dev/null || true; docker run -d --name browser-agent-wsnic --restart unless-stopped --cap-add=NET_ADMIN --device /dev/net/tun:/dev/net/tun --sysctl net.ipv4.ip_forward=1 --sysctl net.ipv4.conf.all.forwarding=1 --sysctl net.ipv4.conf.default.forwarding=1 -p 127.0.0.1:8086:8086 chschnell86/wsnic -i
```

Command to stop it:

```bash
docker rm -f browser-agent-wsnic
```

Networking is optional. Without wsnic, the VM can still work locally, but it will not have real outbound network access.

So far it has mainly been tested with local wsnic on the same machine that opens the app. A remote wsnic endpoint still needs proper validation; if you expose it on a network, do it only in controlled environments because you are giving network connectivity to the VM.

## Checks

The **Run checks** panel validates environment and runtime state:

- headers required for `SharedArrayBuffer`;
- v86 and vendor assets;
- WebGPU/WASM availability;
- snapshot APIs;
- serial channels and runners when the VM is active;
- packages and tools expected by the active profile.

If a check fails, review the detail and the tool log before starting again.

## Common States and Errors

| State or error | Meaning | Recommended action |
| --- | --- | --- |
| **v86 inactive / off** | The VM has not started yet. | Choose profile/disk and press **Start VM**. |
| **WebGPU unavailable** | The browser or device does not expose compatible WebGPU. | Use another browser/device or a model with WASM fallback. |
| **serial1 not ready** | The tools runner is not responding inside the VM yet. | Wait for full boot and run **Run checks**. |
| **tool running** | A background operation is active. | Wait or press **Cancel tool** when appropriate. |
| **model not loaded** | Chat cannot generate yet. | Open **LLM**, choose backend/model, and press **Load model**. |
| **wsnic cannot connect** | The local WebSocket proxy is unavailable or not responding. | Check the **WS** panel URL and local wsnic service. |
| **snapshot error** | The app could not save or restore state. | Check memory, selected file, and configuration compatibility. |
| **disk not mounted** | An HDA disk is selected but not mounted in the VM. | Press **Mount disk** when the shell is ready. |

## Good Practices

- Start with `alpine-base` if you only need to test the VM.
- Use an Ollama model if your browser does not support WebGPU properly, or try another browser with WebGPU support. You can check compatibility at [Can I use WebGPU](https://caniuse.com/webgpu).
- Keep fewer tools enabled if the local model responds poorly or uses too much memory.
- Keep network-tool concurrency low inside v86.
- Save a snapshot before long operations or changes you do not want to lose.
- Check the tool log when chat says a tool failed or generated an artifact.
