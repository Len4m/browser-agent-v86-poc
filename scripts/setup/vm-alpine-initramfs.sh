#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PUBLIC_DIR="$ROOT_DIR/public"
ALPINE_VERSION="${ALPINE_VERSION:-3.23.4}"
ALPINE_BRANCH="${ALPINE_BRANCH:-v${ALPINE_VERSION%.*}}"
ALPINE_ARCH="${ALPINE_ARCH:-x86}"
ALPINE_REPO="${ALPINE_REPO:-https://dl-cdn.alpinelinux.org/alpine/${ALPINE_BRANCH}}"
MINIROOTFS="$PUBLIC_DIR/v86/images/alpine-minirootfs-${ALPINE_VERSION}-${ALPINE_ARCH}.tar.gz"
PROFILE_ID="${PROFILE_ID:-alpine-default}"
PROFILE_NAME="${PROFILE_NAME:-Alpine Default}"
PROFILE_PACKAGES="${PROFILE_PACKAGES:-}"
PROFILE_EXTRA_REPOSITORIES="${PROFILE_EXTRA_REPOSITORIES:-}"
PROFILE_FIRSTBOOT_FILE="${PROFILE_FIRSTBOOT_FILE:-}"
PROFILE_BUILD_COMMANDS_FILE="${PROFILE_BUILD_COMMANDS_FILE:-}"
PROFILE_BOOT_MESSAGE="${PROFILE_BOOT_MESSAGE:-Browser Alpine ready.}"
PROFILE_VERIFY_PACKAGES="${PROFILE_VERIFY_PACKAGES:-0}"
OUT="$ROOT_DIR/${PROFILE_OUTPUT:-public/v86/images/alpine-initramfs.gz}"
WORK="$(mktemp -d)"
BUILD_ID="${PROFILE_ID}-$(date -u +%Y%m%d%H%M%S)"
OUT_KERNEL="$ROOT_DIR/${PROFILE_KERNEL_OUTPUT:-public/v86/images/alpine-vmlinuz-lts}"
MODULES_LIST="$WORK/rootfs/etc/v86-net-modules.list"

cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

LIB_DIR="$ROOT_DIR/scripts/setup/lib"
# shellcheck source=scripts/setup/lib/common.sh
. "$LIB_DIR/common.sh"
# shellcheck source=scripts/setup/lib/profile-rootfs.sh
. "$LIB_DIR/profile-rootfs.sh"
# shellcheck source=scripts/setup/lib/kernel-modules.sh
. "$LIB_DIR/kernel-modules.sh"

require_build_tools

if [ ! -f "$MINIROOTFS" ]; then
  echo "No existe $MINIROOTFS" >&2
  echo "Ejecuta primero: node scripts/setup/runtime-assets.mjs" >&2
  exit 1
fi

mkdir -p "$WORK/rootfs"
tar --warning=no-unknown-keyword -xzf "$MINIROOTFS" -C "$WORK/rootfs"
write_rootfs_metadata

# Fase 1: rootfs del perfil (paquetes, buildCommands, mensaje de arranque).
install_profile_packages
run_profile_build_commands
write_profile_boot_message

if [ -n "$PROFILE_FIRSTBOOT_FILE" ] && [ -f "$PROFILE_FIRSTBOOT_FILE" ]; then
  cp "$PROFILE_FIRSTBOOT_FILE" "$WORK/rootfs/etc/browser-agent-firstboot.sh"
  chmod +x "$WORK/rootfs/etc/browser-agent-firstboot.sh"
fi

# Fase 2: kernel + módulos de red/almacenamiento para v86.
build_net_modules

# Fase 3: instalar el guest /init y los runners serie desde la fuente única
# en vm/overlay/common (mismo patrón para los tres ficheros).
install_overlay_file() {
  local src="$1" dest="$2" what="$3"
  if [ ! -f "$src" ]; then
    echo "ERROR: falta $src ($what)" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$dest")"
  install -m 0755 "$src" "$dest"
}

OVERLAY_COMMON="$ROOT_DIR/vm/overlay/common"
install_overlay_file "$OVERLAY_COMMON/init" "$WORK/rootfs/init" "fuente única del guest /init"
install_overlay_file "$OVERLAY_COMMON/usr/local/bin/ba-serial1-runner" "$WORK/rootfs/usr/local/bin/ba-serial1-runner" "fuente única del runner serial1"
install_overlay_file "$OVERLAY_COMMON/usr/local/bin/ba-serial2-console-runner" "$WORK/rootfs/usr/local/bin/ba-serial2-console-runner" "fuente única del runner serial2"

mkdir -p "$WORK/rootfs/root" "$WORK/rootfs/mnt" "$WORK/rootfs/tmp" "$WORK/rootfs/run"

# Verify before packing: this prevents silently serving an initramfs with no network modules.
if [ ! -s "$MODULES_LIST" ]; then
  echo "ERROR interno: falta etc/v86-net-modules.list antes de empaquetar" >&2
  exit 1
fi

# Fase 4: empaquetar el initramfs.
mkdir -p "$(dirname "$OUT")"
(
  cd "$WORK/rootfs"
  find . -print0 | cpio --null -o -H newc 2>/dev/null | gzip -9 > "$OUT"
)

BYTES="$(wc -c < "$OUT")"
echo "OK alpine-initramfs.gz generado: $OUT (${BYTES} bytes)"
echo "OK alpine-vmlinuz-lts generado: $OUT_KERNEL ($(wc -c < "$OUT_KERNEL") bytes)"
echo "Build id: $BUILD_ID"
echo "Módulos incluidos en /etc/v86-net-modules.list:"
sed 's/^/  /' "$MODULES_LIST"
echo "Nota: este Alpine arranca en RAM. apk add funciona durante la sesión, pero no persiste tras reiniciar."
