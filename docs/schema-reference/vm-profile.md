# Browser Agent v86 VM profile

Compact reference generated from JSON Schema. Update the source schema before editing field semantics here.

Schema for source VM profiles in vm/profiles/*.json. Profiles are consumed by scripts/setup/vm-profile-image.mjs to generate public v86 initramfs manifests. Minimal valid source profiles need an id, a package list with python3 for the guest runners, and the ordered allowedTools list.

## Source

- Schema: `vm/profiles/profile.schema.json`
- Data: `vm/profiles/*.json`
- Root type: `object`
- Schema id: `https://github.com/Len4m/browser-agent-v86-poc/schemas/vm-profile.schema.json`

## Required Fields

`id`, `packages`, `allowedTools`

## Properties

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `$schema` | no | string | Optional editor hint pointing to this schema. |  |
| `id` | yes | string | Stable profile identifier. Used as manifest filename, selector value and build id prefix. | minLength: 1; pattern: ^[a-z0-9][a-z0-9.-]*$ |
| `name` | no | string | Human-readable profile name shown in the UI. | minLength: 1 |
| `description` | no | string | Short profile summary shown in the UI and generated manifests. |  |
| `type` | no | string | Profile boot mode. Current builder creates initramfs-based images. | enum: "initramfs" |
| `alpineVersion` | no | string | Alpine version used to select the minirootfs, for example 3.23.4. | pattern: ^[0-9]+\.[0-9]+(\.[0-9]+)?$ |
| `alpineBranch` | no | string | Alpine repository branch, for example v3.23. | pattern: ^v[0-9]+\.[0-9]+$ |
| `arch` | no | string | Alpine architecture. v86 currently boots the 32-bit x86 profiles. | enum: "x86" |
| `output` | no | string | Output initramfs path relative to public/ or repository root. | minLength: 1; pattern: ^(public/)?v86/images/.+\.gz$ |
| `kernelOutput` | no | string | Output kernel path relative to public/ or repository root. | minLength: 1; pattern: ^(public/)?v86/images/.+ |
| `minRamMb` | no | integer | Minimum RAM shown for this profile in MB. Real minimum must be validated manually. | minimum: 64 |
| `recommendedRamMb` | no | integer | Recommended RAM shown and applied by default in MB. | minimum: 64 |
| `recommendedVramMb` | no | integer | Recommended VRAM shown and applied by default in MB. | minimum: 0 |
| `defaultDisk` | no | string | Default disk selector value. Use initramfs or one of the hda-* values supported by the UI. | pattern: ^(initramfs\|hda-[0-9]+)$ |
| `packages` | yes | array&lt;string&gt; | Alpine packages installed into the exported rootfs before packing the initramfs. Must include python3 because the guest serial/tool runners depend on it. | minItems: 1; uniqueItems; contains: "python3"; items minLength: 1; items pattern: ^[A-Za-z0-9_.:+-]+$ |
| `allowedTools` | yes | array&lt;string&gt; | Ordered LLM tool allowlist for this VM profile. Order is used as default priority when models see a limited number of tools. | uniqueItems; items minLength: 1; items pattern: ^[A-Za-z0-9_.-]+$ |
| `extraRepositories` | no | array&lt;string&gt; | Extra APK repositories appended after the main/community repositories. | uniqueItems; items minLength: 1; items pattern: ^https?://.+ |
| `firstBootCommands` | no | array&lt;string&gt; | Shell commands written to /etc/browser-agent-firstboot.sh and executed during VM boot. | items minLength: 1 |
| `buildCommands` | no | array&lt;string&gt; | Shell commands executed by scripts/setup/vm-alpine-initramfs.sh against /rootfs during image generation. | items minLength: 1 |
| `validationCommands` | no | array&lt;string&gt; | Manual commands printed after build to validate the generated VM profile. | items minLength: 1 |
| `bootMessage` | no | string | Message displayed on serial0 after first boot setup. | minLength: 1 |
| `notes` | no | array&lt;string&gt; | Maintainer notes for profile-specific package/repository decisions. | items minLength: 1 |
