#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PUBLIC_DIR="$ROOT_DIR/public"
ALPINE_VERSION="${ALPINE_VERSION:-3.23.4}"
ALPINE_BRANCH="${ALPINE_BRANCH:-v${ALPINE_VERSION%.*}}"
ALPINE_ARCH="${ALPINE_ARCH:-x86}"
ALPINE_REPO="${ALPINE_REPO:-https://dl-cdn.alpinelinux.org/alpine/${ALPINE_BRANCH}}"
MINIROOTFS="$PUBLIC_DIR/v86/images/alpine-minirootfs-${ALPINE_VERSION}-${ALPINE_ARCH}.tar.gz"
PROFILE_ID="${PROFILE_ID:-alpine-base}"
PROFILE_NAME="${PROFILE_NAME:-Alpine Base}"
PROFILE_PACKAGES="${PROFILE_PACKAGES:-}"
PROFILE_EXTRA_REPOSITORIES="${PROFILE_EXTRA_REPOSITORIES:-}"
PROFILE_FIRSTBOOT_FILE="${PROFILE_FIRSTBOOT_FILE:-}"
PROFILE_BUILD_COMMANDS_FILE="${PROFILE_BUILD_COMMANDS_FILE:-}"
PROFILE_BOOT_MESSAGE="${PROFILE_BOOT_MESSAGE:-Browser Alpine Persistent ready.}"
PROFILE_VERIFY_PACKAGES="${PROFILE_VERIFY_PACKAGES:-1}"
PROFILE_ROOT_DISK_MB="${PROFILE_ROOT_DISK_MB:-512}"
PROFILE_WORKSPACE_DISK_MB="${PROFILE_WORKSPACE_DISK_MB:-512}"
OUT_INITRAMFS="$ROOT_DIR/${PROFILE_OUTPUT:-public/v86/images/profiles/${PROFILE_ID}-initramfs.gz}"
OUT_ROOT="$ROOT_DIR/${PROFILE_ROOTFS_OUTPUT:-public/v86/images/profiles/${PROFILE_ID}-rootfs.img}"
OUT_SEED="$ROOT_DIR/${PROFILE_PERSISTENT_SEED_OUTPUT:-public/v86/images/profiles/${PROFILE_ID}-persistent-seed.img}"
OUT_KERNEL="$ROOT_DIR/${PROFILE_KERNEL_OUTPUT:-public/v86/images/kernels/alpine-${ALPINE_BRANCH}-vmlinuz-lts}"
WORK="$(mktemp -d)"
BUILD_ID="${PROFILE_BUILD_ID:-${PROFILE_ID}-$(date -u +%Y%m%d%H%M%S)}"
MODULES_LIST="$WORK/rootfs/etc/v86-net-modules.list"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

LIB_DIR="$ROOT_DIR/scripts/setup/lib"
. "$LIB_DIR/common.sh"
. "$LIB_DIR/profile-rootfs.sh"
. "$LIB_DIR/kernel-modules.sh"

require_build_tools
for command in mke2fs zstd dd; do
  command -v "$command" >/dev/null 2>&1 || { echo "ERROR: falta $command" >&2; exit 1; }
done
[ -f "$MINIROOTFS" ] || { echo "ERROR: falta $MINIROOTFS; ejecuta pnpm setup" >&2; exit 1; }

mkdir -p "$WORK/rootfs"
tar --warning=no-unknown-keyword -xzf "$MINIROOTFS" -C "$WORK/rootfs"
write_rootfs_metadata
install_profile_packages
run_profile_build_commands
write_profile_boot_message

if [ -n "$PROFILE_FIRSTBOOT_FILE" ] && [ -f "$PROFILE_FIRSTBOOT_FILE" ]; then
  install -m 0755 "$PROFILE_FIRSTBOOT_FILE" "$WORK/rootfs/etc/browser-agent-firstboot.sh"
fi

build_net_modules
install -m 0755 "$ROOT_DIR/vm/overlay/common/init" "$WORK/rootfs/init"
printf 'overlay-hda\n' > "$WORK/rootfs/etc/browser-agent-storage-layout"
mkdir -p "$WORK/rootfs/usr/local/bin" "$WORK/rootfs/root" "$WORK/rootfs/mnt" "$WORK/rootfs/tmp" "$WORK/rootfs/run"
install -m 0755 "$ROOT_DIR/vm/overlay/common/usr/local/bin/ba-serial1-runner" "$WORK/rootfs/usr/local/bin/ba-serial1-runner"
install -m 0755 "$ROOT_DIR/vm/overlay/common/usr/local/bin/ba-serial2-console-runner" "$WORK/rootfs/usr/local/bin/ba-serial2-console-runner"

mkdir -p "$(dirname "$OUT_ROOT")" "$(dirname "$OUT_SEED")" "$(dirname "$OUT_INITRAMFS")"
truncate -s "${PROFILE_ROOT_DISK_MB}M" "$OUT_ROOT"
mke2fs -q -F -t ext4 -L ba-root -O '^64bit,^metadata_csum' -d "$WORK/rootfs" "$OUT_ROOT"

mkdir -p "$WORK/persistent/upper" "$WORK/persistent/work"
truncate -s "${PROFILE_WORKSPACE_DISK_MB}M" "$OUT_SEED"
mke2fs -q -F -t ext4 -L ba-persist -O '^64bit,^metadata_csum' -d "$WORK/persistent" "$OUT_SEED"

MINROOT="$WORK/minroot"
mkdir -p "$MINROOT/bin" "$MINROOT/sbin" "$MINROOT/etc" "$MINROOT/lib" "$MINROOT/dev" "$MINROOT/proc" "$MINROOT/sys" "$MINROOT/run" "$MINROOT/lower" "$MINROOT/persist" "$MINROOT/newroot"
cp "$WORK/rootfs/bin/busybox" "$MINROOT/bin/busybox"
cp -a "$WORK/rootfs/lib/ld-musl-i386.so.1" "$MINROOT/lib/"
cp -a "$WORK/rootfs/lib/modules" "$MINROOT/lib/"
cp "$MODULES_LIST" "$MINROOT/etc/v86-boot-modules.list"
install -m 0755 "$ROOT_DIR/vm/overlay/persistent-init" "$MINROOT/init"
for applet in sh mount mkdir sleep switch_root insmod setsid; do ln -s /bin/busybox "$MINROOT/bin/$applet"; done
(
  cd "$MINROOT"
  find . -print0 | cpio --null -o -H newc 2>/dev/null | gzip -9 > "$OUT_INITRAMFS"
)

PART_SIZE=$((4 * 1024 * 1024))
ROOT_BYTES=$((PROFILE_ROOT_DISK_MB * 1024 * 1024))
PART_BASE="${OUT_ROOT%.img}"
rm -f "${PART_BASE}-"*.img.zst
offset=0
while [ "$offset" -lt "$ROOT_BYTES" ]; do
  end=$((offset + PART_SIZE))
  dd if="$OUT_ROOT" bs="$PART_SIZE" skip=$((offset / PART_SIZE)) count=1 status=none \
    | zstd -q -19 -o "${PART_BASE}-${offset}-${end}.img.zst"
  offset="$end"
done

echo "OK initramfs mínimo: $OUT_INITRAMFS ($(wc -c < "$OUT_INITRAMFS") bytes)"
echo "OK HDA rootfs ext4: $OUT_ROOT ($ROOT_BYTES bytes lógicos; partes zstd de $PART_SIZE)"
echo "OK HDB semilla ext4: $OUT_SEED ($((PROFILE_WORKSPACE_DISK_MB * 1024 * 1024)) bytes lógicos)"
echo "Build id: $BUILD_ID"
