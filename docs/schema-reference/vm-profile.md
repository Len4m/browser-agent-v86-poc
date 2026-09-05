# Browser Agent v86 VM profile

Compact reference generated from JSON Schema. Update the source schema before editing field semantics here.

Schema for managed VM profiles. Every profile uses an immutable root HDA plus an optional in-memory or IndexedDB OverlayFS workspace.

## Source

- Schema: `vm/profiles/profile.schema.json`
- Data: `vm/profiles/*.json`
- Root type: `object`
- Schema id: `https://github.com/Len4m/browser-agent-v86-poc/schemas/vm-profile.schema.json`

## Required Fields

`id`, `name`, `description`, `alpineVersion`, `minimumRamMb`, `minimumVramMb`, `storage`, `packages`, `allowedTools`

## Properties

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `$schema` | no | string | Optional editor hint pointing to this schema. |  |
| `id` | yes | string | Stable profile identifier. Used as manifest filename, selector value, build id prefix and generated initramfs filename. | minLength: 1; pattern: ^[a-z0-9][a-z0-9.-]*$ |
| `name` | yes | string | Human-readable profile name shown in the UI. | minLength: 1 |
| `description` | yes | string | Short profile summary shown in the UI and generated manifests. | minLength: 1 |
| `alpineVersion` | yes | string | Exact Alpine minirootfs version used as the rootfs base, for example 3.23.4. | pattern: ^[0-9]+\.[0-9]+(\.[0-9]+)?$ |
| `alpineBranch` | no | string | Optional APK/Docker branch override. Defaults from alpineVersion, for example 3.23.4 -&gt; v3.23. | pattern: ^v[0-9]+\.[0-9]+$ |
| `kernelOutput` | no | string | Optional kernel path override. Default derives from alpineVersion, for example 3.23.4 -&gt; v86/images/kernels/alpine-v3.23-vmlinuz-lts. | minLength: 1; pattern: ^(public/)?v86/images/.+ |
| `minimumRamMb` | yes | integer | Minimum guest RAM required by this profile in MB. The UI disables lower values and runtime validation rejects them. | minimum: 64 |
| `minimumVramMb` | yes | integer | Minimum VGA memory required by this profile in MB. The UI disables lower values and runtime validation rejects them. | minimum: 0 |
| `storage` | yes | object |  | additionalProperties: false |
| `packages` | yes | array&lt;string&gt; | Alpine packages installed into the exported rootfs before packing the initramfs. Must include python3 because the guest serial/tool runners depend on it. | minItems: 1; uniqueItems; contains: "python3"; items minLength: 1; items pattern: ^[A-Za-z0-9_.:+-]+$ |
| `allowedTools` | yes | array&lt;string&gt; | Ordered LLM tool allowlist for this VM profile. Order is used as default priority when models see a limited number of tools. | minItems: 1; uniqueItems; items minLength: 1; items pattern: ^[A-Za-z0-9_.-]+$ |
| `extraRepositories` | no | array&lt;string&gt; | Extra APK repositories appended after the main/community repositories. | uniqueItems; items minLength: 1; items pattern: ^https?://.+ |
| `firstBootCommands` | no | array&lt;string&gt; | Shell commands written to /etc/browser-agent-firstboot.sh and executed during VM boot. | items minLength: 1 |
| `buildCommands` | no | array&lt;string&gt; | Shell commands executed by scripts/setup/vm-alpine-overlay-hda.sh against /rootfs during image generation. | items minLength: 1 |
| `bootMessage` | no | string | Message displayed on serial0 after first boot setup. | minLength: 1 |
| `notes` | no | array&lt;string&gt; | Maintainer notes for profile-specific package/repository decisions. | items minLength: 1 |

## storage

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `storage.layout` | yes | string | Managed profiles boot a minimal initramfs and switch to immutable HDA plus an optional OverlayFS workspace. | const: "overlay-hda" |
| `storage.rootDiskMb` | yes | integer | Logical size of the immutable ext4 root disk. Required for overlay-hda. | minimum: 128 |
| `storage.workspaceDiskMb` | yes | integer | Logical size of the ext4 OverlayFS disk, backed by memory or IndexedDB according to the user's choice. | minimum: 128 |
| `storage.blockSize` | yes | integer | Logical block size used by the browser CoW disk. | enum: 65536 |
| `storage.filesystem` | yes | string |  | enum: "ext4" |
