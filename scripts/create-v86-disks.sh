#!/usr/bin/env bash
set -euo pipefail

# En Debian/Ubuntu, mkfs.ext2 y mke2fs suelen estar en /usr/sbin,
# que a veces no está en el PATH de usuarios normales.
export PATH="$PATH:/usr/sbin:/sbin"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DISK_DIR="$ROOT_DIR/public/v86/disks"
mkdir -p "$DISK_DIR"

require_cmd() {
  local cmd="$1"
  local pkg_hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Falta '$cmd'. En Debian: sudo apt install -y $pkg_hint" >&2
    exit 1
  fi
}

require_cmd truncate coreutils
require_cmd stat coreutils

if command -v mkfs.ext2 >/dev/null 2>&1; then
  MKFS_EXT2=(mkfs.ext2 -q -F)
elif command -v mke2fs >/dev/null 2>&1; then
  MKFS_EXT2=(mke2fs -q -F -t ext2)
else
  echo "Falta 'mkfs.ext2' o 'mke2fs'. En Debian: sudo apt install -y e2fsprogs" >&2
  echo "Comprobación útil: dpkg -L e2fsprogs | grep -E '/(mkfs.ext2|mke2fs)$'" >&2
  echo "PATH actual: $PATH" >&2
  exit 1
fi

echo "Usando formateador ext2: ${MKFS_EXT2[*]}"

human_size() {
  local bytes="$1"
  if command -v numfmt >/dev/null 2>&1; then
    numfmt --to=iec --suffix=B "$bytes"
  else
    echo "${bytes} bytes"
  fi
}

create_disk() {
  local size_mb="$1"
  local suffix="$2"
  local label="$3"
  local img="$DISK_DIR/alpine-hda-${suffix}.img"

  if [ -f "$img" ]; then
    local size
    size="$(stat -c%s "$img")"
    if [ "$size" -gt 0 ]; then
      echo "OK $(basename "$img") ya existe ($(human_size "$size"))"
      return 0
    fi
  fi

  echo "Creando $(basename "$img") (${size_mb} MB, ext2, sparse raw)..."
  rm -f "$img"
  truncate -s "${size_mb}M" "$img"
  "${MKFS_EXT2[@]}" -L "$label" "$img"

  local size
  size="$(stat -c%s "$img")"
  echo "OK $(basename "$img") ($(human_size "$size"))"
}

create_disk 250 250m BA250M
create_disk 512 512m BA512M
create_disk 1024 1g BA1G

echo
ls -lh "$DISK_DIR"/alpine-hda-*.img
cat <<'NOTE'

Discos raw creados.
- Son imágenes ext2 sin particiones, pensadas como hda adicional para v86.
- v86 las cargará con hda: { url, async: true, size }.
- Dentro de Alpine se pueden montar en /mnt/hda.
- Importante: en esta etapa siguen siendo discos de datos; el sistema actual arranca desde initramfs.
NOTE
