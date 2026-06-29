# VM Profiles and Tools

> **English** | [Español](VM_PROFILES_AND_TOOLS.es.md)

This guide explains how to add a VM profile and how to expose agent tools for that profile using the current project architecture. It is not an end-user manual.

## Overview

There are two separate contracts:

- **VM profile**: lives in `vm/profiles/<id>.json`. It defines the Alpine image, packages, build/boot commands, recommended RAM, and `allowedTools`.
- **Tool**: lives in `src/browser/chat/tools/definitions/*.ts`. It defines the AI SDK schema, argument normalization, command construction, required packages, risk, timeout, and result formatting.

The connection between them is:

- A profile exposes a tool by listing it in `allowedTools`.
- A tool declares `requiredPackages`.
- `scripts/check/vm-profiles.mjs` validates that tools exist and that the profile includes their required packages.
- At runtime, `tool-registry.ts` filters out tools that the active profile cannot support.

## Add A VM Profile

1. Create `vm/profiles/<id>.json`.

   Start from the closest existing profile:

   - `alpine-base.json`: minimal profile.
   - `alpine-pentest-lite.json`: lightweight tools and wordlists.
   - `alpine-pentest-web.json`: extra web tools, extra repositories, and richer build commands.

2. Keep `id` and filename aligned.

   If `id` is `alpine-demo`, the file must be `vm/profiles/alpine-demo.json`. The schema accepts lowercase ids with numbers, dots, and hyphens.

3. Declare the structural fields.

   Common fields:

   ```json
   {
     "$schema": "./profile.schema.json",
     "id": "alpine-demo",
     "name": "Alpine Demo",
     "description": "Example Alpine profile.",
     "alpineVersion": "3.23.4",
     "recommendedRamMb": 1024
   }
   ```

   The builder derives the initramfs output from `id`, for example `v86/images/profiles/alpine-demo-initramfs.gz`. The kernel defaults to the shared file for the effective Alpine branch; set `kernelOutput` only when a profile needs a custom kernel path. `defaultDisk` is optional and defaults to `initramfs`.

4. Declare `packages`.

   Every profile must include `python3`, because the guest `serial1` and `serial2` runners depend on Python 3. Also add the packages required by your commands and tools.

   ```json
   "packages": [
     "ca-certificates",
     "curl",
     "nano",
     "python3",
     "iproute2"
   ]
   ```

5. Declare `allowedTools`.

   This list is the profile policy. Only include tools that make sense for that image. Order is preserved and used as the default priority when the UI or model limits the number of visible tools.

   ```json
   "allowedTools": [
     "vm.fs.list",
     "vm.fs.read",
     "vm.cmd.which",
     "web.curl.head",
     "net.ip.status"
   ]
   ```

6. Use `buildCommands`, `firstBootCommands`, and `validationCommands` deliberately.

   - `buildCommands`: run during image generation against `/rootfs`. Use them for symlinks, small wordlist downloads, cache cleanup, or file preparation.
   - `firstBootCommands`: written to `/etc/browser-agent-firstboot.sh` and run when the VM boots.
   - `validationCommands`: manual-validation metadata only. `scripts/setup/vm-profile-image.mjs` copies them to the profile manifest and prints them at the end as suggested commands, but does not run them during `setup`, `build`, `check`, or runtime.

   If a check must fail image generation, put it in `buildCommands`. If it must run once when the VM boots, put it in `firstBootCommands`. If it proves a tool's real availability and must appear in **Run checks**, declare it in that tool's `runtimeChecks`.

   Example:

   ```json
   "firstBootCommands": [
     "update-ca-certificates >/tmp/update-ca-certificates.log 2>&1 || true"
   ],
   "buildCommands": [
     "rm -rf /rootfs/var/cache/apk/* /rootfs/tmp/* /rootfs/var/tmp/*"
   ],
   "validationCommands": [
     "python3 --version",
     "curl -fsS --max-time 8 -o /dev/null https://browseragent.icu/"
   ]
   ```

7. Use `extraRepositories` only when necessary.

   If a tool is not available in the main Alpine branch for `x86`, add extra repositories and leave a note explaining why. `alpine-pentest-web` is the current example.

8. Validate the profile.

   ```bash
   npm run check
   ```

   This checks schema, duplicate ids, `python3`, unknown `allowedTools`, and missing `requiredPackages`.

9. Generate the profile assets.

   Use `npm run setup` as the normal path. It validates all profiles, prepares base assets, generates profile images, updates `public/v86/images/profiles/index.json`, and creates local HDA disks.

   ```bash
   npm run setup
   ```

   Command to generate one profile:

   ```bash
   node scripts/setup/vm-profile-image.mjs vm/profiles/alpine-demo.json
   ```

   Replace `alpine-demo.json` with the real file. That command generates the profile initramfs and updates `public/v86/images/profiles/<id>.json` and `index.json`, but it does not create HDA disks or validate the other profiles. Do not edit those manifests by hand; they are regenerated from `vm/profiles/*.json`.

## Create A Tool For A Profile

1. Create a module in `src/browser/chat/tools/definitions/`.

   The file must export `toolDefinition` typed as `ToolDefinition`. The build discovers these files and generates the virtual `virtual:ba-tools` module; there is no manual index to edit.

2. Use a stable name.

   Names follow the `area.name.action` style, for example:

   - `vm.fs.read`
   - `web.curl.head`
   - `net.nmap.quick`
   - `web.nikto.quick`

3. Declare the package contract.

   If the tool needs an Alpine binary or runtime, declare `requiredPackages` with APK package names. Any profile adding that tool to `allowedTools` must include those packages in `packages`.

4. Declare runtime availability checks.

   If the tool needs concrete commands, add `runtimeChecks` with short labels and minimal commands such as `command -v curl`, `command -v nikto.pl`, or an `httpx` binary-name fallback. The **Run checks** panel gets these checks from the registry according to `allowedTools`; do not add package maps to the UI.

5. Normalize arguments and build bounded commands.

   Use existing helpers when they fit:

   - `normalizeUrl`, `normalizeHost`, `normalizeBool`, `textValue`, `toToolArgs`.
   - `clampInt` for numeric limits.
   - `shellQuote` for every value interpolated into shell.
   - `captureCommand` to wrap commands and detect missing binaries.
   - `standardFormat`, `cleanToolOutput`, `truncateToolOutput`, or `toolFailureDetail` for output formatting.

6. Add AI SDK schema and i18n.

   If the tool is exposed to the model, define `buildInputSchema(z)` and localized strings in `src/web/locales/en.json` and `src/web/locales/es.json` for name, description, schema text, and errors.

7. Set risk and limits.

   - `riskLevel: 1`: bounded reads.
   - `riskLevel: 2`: low-impact diagnostics.
   - `riskLevel: 3`: active actions such as commands or light scans.
   - `timeoutMs` and `maxOutputBytes` must be explicit and conservative.

8. Expose the tool in a profile.

   Add the tool name to the profile's `allowedTools` and the required packages to `packages`. If the tool depends on a specific executable name that differs from the package name, keep these aligned:

   - Profile `buildCommands` or `firstBootCommands`.
   - `validationCommands`.
   - `runtimeChecks` in the tool definition when that availability should appear in **Run checks**.
   - Tests if the contract is delicate.

   Current example: `web.nikto.quick` declares `requiredPackages` for Nikto and the Perl SSL modules, but runs `nikto.pl` through `timeout`. The `alpine-pentest-web` profile creates a `nikto` symlink for manual use and validates both commands.

## Recommended Validation

After adding or changing profiles/tools:

```bash
npm run check
```

If you changed profiles, the overlay, or runners:

```bash
npm run setup
```

If you changed tool code, the LLM provider, i18n catalogs, or frontend code:

```bash
npm run build
```

For a complete local environment:

```bash
npm run prepare:local
```

## Checklist

- The profile filename matches its `id`.
- The profile includes `python3`.
- `allowedTools` contains only existing tools.
- Every exposed tool has its `requiredPackages` in `packages`.
- Commands use quoting and limits.
- Outputs have timeout and maximum size.
- The tool has i18n text if it is shown to the user/model.
- `npm run check` passes.
- After profile changes, the VM boots and **Run checks** does not report missing packages/tools.
