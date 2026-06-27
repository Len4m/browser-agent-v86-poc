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
PROFILE_DESCRIPTION="${PROFILE_DESCRIPTION:-}"
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

cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

write_apk_repositories_file() {
  local dest="$1"
  mkdir -p "$(dirname "$dest")"
  {
    printf '%s/main\n%s/community\n' "$ALPINE_REPO" "$ALPINE_REPO"
    if [ -n "$(echo "${PROFILE_EXTRA_REPOSITORIES:-}" | xargs)" ]; then
      printf '%s\n' "$PROFILE_EXTRA_REPOSITORIES" | sed '/^[[:space:]]*$/d'
    fi
  } > "$dest"
}

for cmd in tar gzip cpio curl awk grep sed find; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Falta '$cmd'. En Debian: sudo apt install -y cpio gzip tar curl grep sed findutils" >&2
    exit 1
  fi
done

if ! command -v zstd >/dev/null 2>&1; then
  echo "Falta 'zstd'. En Debian: sudo apt install -y zstd" >&2
  exit 1
fi

if ! command -v xz >/dev/null 2>&1; then
  echo "Falta 'xz'. En Debian: sudo apt install -y xz-utils" >&2
  exit 1
fi

if [ ! -f "$MINIROOTFS" ]; then
  echo "No existe $MINIROOTFS" >&2
  echo "Ejecuta primero: node scripts/setup/runtime-assets.mjs" >&2
  exit 1
fi

mkdir -p "$WORK/rootfs"
tar --warning=no-unknown-keyword -xzf "$MINIROOTFS" -C "$WORK/rootfs"

echo "$BUILD_ID" > "$WORK/rootfs/etc/browser-agent-build-id"

write_apk_repositories_file "$WORK/rootfs/etc/apk/repositories"

echo "$PROFILE_NAME" > "$WORK/rootfs/etc/browser-agent-profile-name"
echo "$PROFILE_ID" > "$WORK/rootfs/etc/browser-agent-profile-id"
write_profile_boot_message() {
  local packages_label="base"
  if [ -f "$WORK/rootfs/etc/browser-agent-installed-packages" ] && [ -s "$WORK/rootfs/etc/browser-agent-installed-packages" ]; then
    packages_label="$(sed '/^[[:space:]]*$/d' "$WORK/rootfs/etc/browser-agent-installed-packages" | paste -sd ', ' -)"
  elif [ -n "$(echo "${PROFILE_PACKAGES:-}" | xargs)" ]; then
    packages_label="$(printf '%s\n' "$PROFILE_PACKAGES" | sed '/^[[:space:]]*$/d' | paste -sd ', ' -)"
  fi

  cat > "$WORK/rootfs/etc/browser-agent-boot-message" <<MSG
$PROFILE_BOOT_MESSAGE
Network: pulsa Conectar en la UI.
Packages preinstalados: $packages_label
MSG
}

install_profile_packages() {
  local packages_text="$PROFILE_PACKAGES"

  # Always ensure basic metadata exists. If a profile with packages is built via
  # Docker export, the rootfs will be replaced and these files are written again
  # after the export.
  echo "$BUILD_ID" > "$WORK/rootfs/etc/browser-agent-build-id"
  write_apk_repositories_file "$WORK/rootfs/etc/apk/repositories"
  echo "$PROFILE_NAME" > "$WORK/rootfs/etc/browser-agent-profile-name"
  echo "$PROFILE_ID" > "$WORK/rootfs/etc/browser-agent-profile-id"

  if [ -z "$(echo "$packages_text" | xargs)" ]; then
    echo "Perfil sin paquetes extra."
    printf 'base\n' > "$WORK/rootfs/etc/browser-agent-installed-packages"
    return 0
  fi

  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: este perfil necesita Docker para instalar paquetes Alpine en el rootfs." >&2
    echo "Instala Docker o crea una imagen sin paquetes extra." >&2
    exit 1
  fi

  local docker_platform="${PROFILE_DOCKER_PLATFORM:-linux/386}"
  local docker_image="alpine:${ALPINE_BRANCH#v}"
  local packages_file="$WORK/profile-packages.txt"
  local exported_rootfs="$WORK/profile-rootfs.tar"
  local cid=""

  printf '%s\n' "$packages_text" | sed '/^[[:space:]]*$/d' > "$packages_file"

  echo "Instalando paquetes del perfil con Docker export ($docker_image, $docker_platform):"
  sed 's/^/  /' "$packages_file"

  cid="$(docker create --platform "$docker_platform" "$docker_image" sleep 600)"
  cleanup_profile_container() {
    if [ -n "${cid:-}" ]; then
      docker rm -f "$cid" >/dev/null 2>&1 || true
      cid=""
    fi
  }
  trap 'cleanup_profile_container; cleanup' EXIT

  docker start "$cid" >/dev/null
  docker cp "$packages_file" "$cid:/profile-packages.txt"

  # IMPORTANT: docker exec needs -i here. Without -i, sh -s receives no stdin,
  # exits successfully, and Docker exports the unchanged base rootfs.
  docker exec -i \
    -e ALPINE_REPO="$ALPINE_REPO" \
    -e ALPINE_ARCH="$ALPINE_ARCH" \
    -e PROFILE_EXTRA_REPOSITORIES="$PROFILE_EXTRA_REPOSITORIES" \
    "$cid" sh -s <<'DOCKER_INSTALL'
set -eu
printf '%s/main\n%s/community\n' "$ALPINE_REPO" "$ALPINE_REPO" > /etc/apk/repositories
if [ -n "${PROFILE_EXTRA_REPOSITORIES:-}" ]; then
  printf '%s\n' "$PROFILE_EXTRA_REPOSITORIES" | sed '/^[[:space:]]*$/d' >> /etc/apk/repositories
fi
PACKAGES=$(tr '\n' ' ' < /profile-packages.txt)
apk update
apk add --no-cache $PACKAGES

echo "Paquetes instalados en el rootfs exportado:"
apk info | sort | sed 's/^/  /'

missing=0
while IFS= read -r pkg; do
  [ -n "$pkg" ] || continue
  if ! apk info -e "$pkg" >/dev/null 2>&1; then
    echo "ERROR: el paquete solicitado no aparece instalado en el contenedor exportable: $pkg" >&2
    missing=1
  fi
done < /profile-packages.txt

if [ "$missing" -ne 0 ]; then
  exit 1
fi
DOCKER_INSTALL

  docker export "$cid" -o "$exported_rootfs"
  cleanup_profile_container

  rm -rf "$WORK/rootfs"
  mkdir -p "$WORK/rootfs"
  tar --warning=no-unknown-keyword -xf "$exported_rootfs" -C "$WORK/rootfs"

  # Remove container-only files and restore metadata needed by our initramfs.
  rm -f "$WORK/rootfs/.dockerenv" "$WORK/rootfs/profile-packages.txt" || true
  mkdir -p "$WORK/rootfs/etc"
  echo "$BUILD_ID" > "$WORK/rootfs/etc/browser-agent-build-id"
  write_apk_repositories_file "$WORK/rootfs/etc/apk/repositories"
  echo "$PROFILE_NAME" > "$WORK/rootfs/etc/browser-agent-profile-name"
  echo "$PROFILE_ID" > "$WORK/rootfs/etc/browser-agent-profile-id"

  if [ ! -f "$WORK/rootfs/lib/apk/db/installed" ]; then
    echo "ERROR: el rootfs exportado no contiene /lib/apk/db/installed" >&2
    exit 1
  fi

  awk -F: '/^P:/ { print $2 }' "$WORK/rootfs/lib/apk/db/installed" | sort > "$WORK/rootfs/etc/browser-agent-installed-packages"

  local verify_missing=0
  while IFS= read -r pkg; do
    [ -n "$pkg" ] || continue
    if ! grep -Fxq "$pkg" "$WORK/rootfs/etc/browser-agent-installed-packages"; then
      echo "ERROR: el paquete solicitado no aparece en el rootfs exportado: $pkg" >&2
      verify_missing=1
    fi
  done < "$packages_file"
  if [ "$verify_missing" -ne 0 ]; then
    echo "Paquetes detectados en el rootfs:" >&2
    sed 's/^/  /' "$WORK/rootfs/etc/browser-agent-installed-packages" >&2
    exit 1
  fi

  echo "Rootfs del perfil exportado y preparado. Paquetes detectados:"
  sed 's/^/  /' "$WORK/rootfs/etc/browser-agent-installed-packages"
}

run_profile_build_commands() {
  if [ -z "$PROFILE_BUILD_COMMANDS_FILE" ] || [ ! -f "$PROFILE_BUILD_COMMANDS_FILE" ]; then
    return 0
  fi
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: los buildCommands del perfil necesitan Docker." >&2
    exit 1
  fi
  local docker_platform="${PROFILE_DOCKER_PLATFORM:-linux/386}"
  local docker_image="alpine:${ALPINE_BRANCH#v}"
  echo "Ejecutando buildCommands del perfil..."
  local host_uid host_gid
  host_uid="$(id -u)"
  host_gid="$(id -g)"

  # buildCommands run inside Docker as root. Any files written to /rootfs
  # would otherwise be owned by root on the host and cleanup would fail with
  # "Permiso denegado". Always chown back to the invoking user, even if the
  # build command fails.
  docker run --rm --platform "$docker_platform" \
    -e HOST_UID="$host_uid" \
    -e HOST_GID="$host_gid" \
    -v "$WORK/rootfs:/rootfs" \
    -v "$PROFILE_BUILD_COMMANDS_FILE:/profile-build-commands.sh:ro" \
    "$docker_image" sh -ceu '''
      trap "chown -R ${HOST_UID}:${HOST_GID} /rootfs 2>/dev/null || true" EXIT
      sh /profile-build-commands.sh
    '''
}

install_profile_packages
run_profile_build_commands
write_profile_boot_message

if [ -n "$PROFILE_FIRSTBOOT_FILE" ] && [ -f "$PROFILE_FIRSTBOOT_FILE" ]; then
  cp "$PROFILE_FIRSTBOOT_FILE" "$WORK/rootfs/etc/browser-agent-firstboot.sh"
  chmod +x "$WORK/rootfs/etc/browser-agent-firstboot.sh"
fi

APKINDEX_TGZ="$WORK/APKINDEX.tar.gz"
APKINDEX="$WORK/APKINDEX"
LINUX_APK="$WORK/linux-lts.apk"
LINUX_EXTRACT="$WORK/linux-lts"

curl -fsSL "${ALPINE_REPO}/main/${ALPINE_ARCH}/APKINDEX.tar.gz" -o "$APKINDEX_TGZ"
tar --warning=no-unknown-keyword -xzf "$APKINDEX_TGZ" -C "$WORK" APKINDEX
LINUX_LTS_VERSION="$(awk 'BEGIN{RS=""; FS="\n"} /(^|\n)P:linux-lts(\n|$)/ { for(i=1;i<=NF;i++) if($i ~ /^V:/) { print substr($i,3); exit } }' "$APKINDEX")"
if [ -z "$LINUX_LTS_VERSION" ]; then
  echo "No se ha encontrado linux-lts en ${ALPINE_REPO}/main/${ALPINE_ARCH}/APKINDEX" >&2
  exit 1
fi

echo "Descargando linux-lts-${LINUX_LTS_VERSION}.apk para extraer módulos..."
curl -fsSL "${ALPINE_REPO}/main/${ALPINE_ARCH}/linux-lts-${LINUX_LTS_VERSION}.apk" -o "$LINUX_APK"
mkdir -p "$LINUX_EXTRACT"
# Alpine .apk is a gzipped tar archive. It may contain signature/control files before payload, tar handles it.
tar --warning=no-unknown-keyword -xzf "$LINUX_APK" -C "$LINUX_EXTRACT"

# Importante: el kernel y los módulos deben venir del mismo linux-lts.apk.
# Si usamos el vmlinuz de netboot y módulos del repositorio actual, aparece
# "invalid module format" / "disagrees about version of symbol module_layout".
KERNEL_FROM_APK="$(find "$LINUX_EXTRACT/boot" -type f \( -name 'vmlinuz-lts' -o -name 'vmlinuz-*' \) | sort | head -n 1 || true)"
if [ -z "$KERNEL_FROM_APK" ] || [ ! -f "$KERNEL_FROM_APK" ]; then
  echo "No se ha encontrado vmlinuz dentro de linux-lts-${LINUX_LTS_VERSION}.apk" >&2
  find "$LINUX_EXTRACT" -maxdepth 4 -type f -name 'vmlinuz*' -print >&2 || true
  exit 1
fi
mkdir -p "$(dirname "$OUT_KERNEL")"
cp "$KERNEL_FROM_APK" "$OUT_KERNEL"
echo "OK kernel extraído desde linux-lts-${LINUX_LTS_VERSION}.apk: $OUT_KERNEL"

MODDIR="$(find "$LINUX_EXTRACT/lib/modules" -mindepth 1 -maxdepth 1 -type d | sort | head -n 1 || true)"
if [ -z "$MODDIR" ] || [ ! -f "$MODDIR/modules.dep" ]; then
  echo "No se han encontrado módulos en linux-lts-${LINUX_LTS_VERSION}.apk" >&2
  find "$LINUX_EXTRACT" -maxdepth 4 -type d -print >&2 || true
  exit 1
fi

KVER="$(basename "$MODDIR")"
ROOT_MODDIR="$WORK/rootfs/lib/modules/$KVER"
mkdir -p "$ROOT_MODDIR"
cp "$MODDIR"/modules.* "$ROOT_MODDIR/" 2>/dev/null || true

# Prefer virtio-net for modern Alpine; keep NE2000 modules available as a compatibility fallback.
find_module_rel() {
  local name="$1"
  # modules.dep can use either "module.ko.gz:" or "module.ko.gz: dep1 dep2".
  # Do not split on ": " because entries without dependencies have no space after the colon.
  awk -F':' -v name="$name" '
    {
      key=$1
      sub(/^[[:space:]]+/, "", key)
      sub(/[[:space:]]+$/, "", key)
      if (key ~ ("(^|/)" name "\\.ko(\\.(gz|zst|xz))?$")) { print key; found=1; exit }
    }
    END { if(!found) exit 1 }
  ' "$MODDIR/modules.dep" 2>/dev/null || true
}

TARGET_RELS=""
for modname in af_packet lib8390 8390 ne2k-pci virtio virtio_ring virtio_pci virtio_pci_modern_dev virtio_pci_legacy_dev virtio_net ata_piix ata_generic pata_acpi libata scsi_mod sd_mod virtio_blk ext2 ext4 mbcache jbd2 crc16 crc32c crc32c_generic libcrc32c; do
  rel="$(find_module_rel "$modname")"
  if [ -n "$rel" ]; then
    TARGET_RELS="$TARGET_RELS $rel"
  fi
done

# Hard fallback if modules.dep has unexpected formatting.
if [ -z "$(echo "$TARGET_RELS" | xargs)" ]; then
  TARGET_RELS="$(find "$MODDIR/kernel" -type f \( -name 'af_packet.ko*' -o -name 'lib8390.ko*' -o -name '8390.ko*' -o -name 'ne2k-pci.ko*' -o -name 'virtio*.ko*' -o -name 'ata_piix.ko*' -o -name 'ata_generic.ko*' -o -name 'pata_acpi.ko*' -o -name 'libata.ko*' -o -name 'scsi_mod.ko*' -o -name 'sd_mod.ko*' -o -name 'virtio_blk.ko*' -o -name 'ext2.ko*' -o -name 'ext4.ko*' -o -name 'jbd2.ko*' -o -name 'mbcache.ko*' -o -name 'crc*.ko*' -o -name 'libcrc32c.ko*' \) | sed "s#^$MODDIR/##")"
fi

if [ -z "$(echo "$TARGET_RELS" | xargs)" ]; then
  echo "No se han encontrado módulos de red v86 en linux-lts-${LINUX_LTS_VERSION}" >&2
  echo "Candidatos en modules.dep:" >&2
  grep -E 'af_packet|virtio|8390|ne2k|pcnet|e1000|8139|r8169|ata_|pata|libata|scsi|sd_mod|ext2|ext4|jbd2|mbcache|crc32' "$MODDIR/modules.dep" | head -120 >&2 || true
  exit 1
fi

ORDER_FILE="$WORK/v86-net-modules-order"
VISITED_FILE="$WORK/v86-net-modules-visited"
: > "$ORDER_FILE"
: > "$VISITED_FILE"

visit_module() {
  local rel="$1"
  [ -n "$rel" ] || return 0
  rel="${rel#./}"
  if grep -Fxq "$rel" "$VISITED_FILE"; then
    return 0
  fi
  echo "$rel" >> "$VISITED_FILE"

  local deps dep
  deps="$(awk -F':' -v rel="$rel" '
    {
      key=$1
      sub(/^[[:space:]]+/, "", key)
      sub(/[[:space:]]+$/, "", key)
      if (key == rel) {
        rest=$0
        sub(/^[^:]*:/, "", rest)
        print rest
        exit
      }
    }
  ' "$MODDIR/modules.dep" || true)"
  for dep in $deps; do
    dep="${dep#./}"
    [ -n "$dep" ] && visit_module "$dep"
  done
  echo "$rel" >> "$ORDER_FILE"
}

for target_rel in $TARGET_RELS; do
  visit_module "$target_rel"
done

MODULES_LIST="$WORK/rootfs/etc/v86-net-modules.list"
: > "$MODULES_LIST"
CANDIDATES="$WORK/rootfs/etc/v86-net-candidates.txt"
grep -E 'af_packet|virtio|8390|ne2k|pcnet|e1000|8139|r8169|ata_|pata|libata|scsi|sd_mod|ext2|ext4|jbd2|mbcache|crc32' "$MODDIR/modules.dep" > "$CANDIDATES" || true

copy_module() {
  local rel="$1"
  [ -n "$rel" ] || return 0
  local src="$MODDIR/$rel"
  if [ ! -f "$src" ]; then
    echo "Módulo no encontrado: $src" >&2
    return 1
  fi

  local dest_rel="$rel"
  if [[ "$dest_rel" == *.zst ]]; then
    dest_rel="${dest_rel%.zst}"
  elif [[ "$dest_rel" == *.gz ]]; then
    dest_rel="${dest_rel%.gz}"
  elif [[ "$dest_rel" == *.xz ]]; then
    dest_rel="${dest_rel%.xz}"
  fi

  local dest="$ROOT_MODDIR/$dest_rel"
  mkdir -p "$(dirname "$dest")"
  if [[ "$src" == *.zst ]]; then
    zstd -q -d -c "$src" > "$dest"
  elif [[ "$src" == *.gz ]]; then
    gzip -dc "$src" > "$dest"
  elif [[ "$src" == *.xz ]]; then
    xz -dc "$src" > "$dest"
  else
    cp "$src" "$dest"
  fi
  echo "/lib/modules/$KVER/$dest_rel" >> "$MODULES_LIST"
}

while IFS= read -r rel; do
  copy_module "$rel"
done < "$ORDER_FILE"

if [ ! -s "$MODULES_LIST" ]; then
  echo "ERROR: /etc/v86-net-modules.list quedaría vacío" >&2
  exit 1
fi

if ! grep -q 'virtio_net\.ko' "$MODULES_LIST"; then
  echo "ERROR: no se ha incluido virtio_net.ko; v86 usa virtio-net por defecto." >&2
  exit 1
fi

if ! grep -q 'virtio_pci\.ko' "$MODULES_LIST"; then
  echo "ERROR: no se ha incluido virtio_pci.ko; v86 expone virtio-net por PCI." >&2
  exit 1
fi

if ! grep -q 'ne2k-pci\.ko' "$MODULES_LIST"; then
  echo "AVISO: no se ha incluido ne2k-pci.ko; NE2000 no estará disponible como fallback." >&2
fi

if ! grep -q 'af_packet\.ko' "$MODULES_LIST"; then
  echo "ERROR: no se ha incluido af_packet.ko; udhcpc necesita AF_PACKET para DHCP." >&2
  echo "Candidatos en modules.dep:" >&2
  grep -E 'af_packet|packet' "$MODDIR/modules.dep" >&2 || true
  exit 1
fi

cat > "$WORK/rootfs/init" <<'INIT'
#!/bin/sh
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export TERM=xterm

mount -t devtmpfs dev /dev 2>/dev/null || mount -t tmpfs dev /dev
mkdir -p /dev/pts /proc /sys /run /tmp /mnt /root
mount -t devpts devpts /dev/pts 2>/dev/null || true
mount -t proc proc /proc 2>/dev/null || true
mount -t sysfs sysfs /sys 2>/dev/null || true
mount -t tmpfs tmpfs /run 2>/dev/null || true
mount -t tmpfs tmpfs /tmp 2>/dev/null || true

hostname browser-alpine 2>/dev/null || true
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /etc/resolv.conf

: > /tmp/v86-net-modules.log
printf 'build-id: ' >> /tmp/v86-net-modules.log
cat /etc/browser-agent-build-id >> /tmp/v86-net-modules.log 2>/dev/null || true
printf '\n' >> /tmp/v86-net-modules.log

if [ -f /etc/v86-net-modules.list ]; then
  while read -r mod; do
    [ -n "$mod" ] || continue
    if [ -f "$mod" ]; then
      insmod "$mod" >>/tmp/v86-net-modules.log 2>&1 || true
    else
      echo "missing $mod" >>/tmp/v86-net-modules.log
    fi
  done < /etc/v86-net-modules.list
else
  echo "missing /etc/v86-net-modules.list" >>/tmp/v86-net-modules.log
fi

if [ -e /sys/bus/pci/devices/0000:00:05.0 ] && [ ! -e /sys/bus/pci/devices/0000:00:05.0/driver ] && [ -e /sys/bus/pci/drivers/ne2k-pci/bind ]; then
  echo 0000:00:05.0 > /sys/bus/pci/drivers/ne2k-pci/bind 2>>/tmp/v86-net-modules.log || true
fi

cat > /sbin/browser-agent-login <<'LOGIN'
#!/bin/sh
export HOME=/root
export TERM=${TERM:-xterm-256color}
export HISTFILE=/dev/null
cd /root 2>/dev/null || cd /

stty rows 24 cols 100 </dev/ttyS0 2>/dev/null || stty rows 24 cols 100 2>/dev/null || true
exec /bin/sh -l
LOGIN
chmod +x /sbin/browser-agent-login

supervise_browser_agent_runner() {
  name="$1"
  tty="$2"
  command="$3"
  log="/tmp/${name}.log"

  (
    while true; do
      if [ -e "$tty" ]; then
        "$command" "$tty" >"$log" 2>&1
      fi
      sleep 1
    done
  ) &
}

supervise_browser_agent_runner ba-serial1-runner /dev/ttyS1 /usr/local/bin/ba-serial1-runner
supervise_browser_agent_runner ba-serial2-console-runner /dev/ttyS2 /usr/local/bin/ba-serial2-console-runner

if [ -x /etc/browser-agent-firstboot.sh ]; then
  /etc/browser-agent-firstboot.sh >>/tmp/browser-agent-firstboot.log 2>&1 || true
fi

{
  printf '\n'
  if [ -f /etc/browser-agent-boot-message ]; then
    cat /etc/browser-agent-boot-message
  else
    echo 'Browser Alpine ready.'
    echo 'Network: pulsa Conectar en la UI.'
    echo 'Packages: apk update; apk add curl nano'
  fi
  printf '\n'
} >/dev/ttyS0

while true; do
  # Use getty instead of launching /bin/sh directly. This gives the shell a
  # proper controlling TTY on ttyS0, enabling job control (Ctrl+Z, jobs, fg, bg).
  setsid getty -L -n -l /sbin/browser-agent-login 115200 ttyS0 xterm >/dev/ttyS0 2>&1
  printf '\n[init] serial getty exited, restarting...\n' >/dev/ttyS0
  sleep 1
done
INIT
chmod +x "$WORK/rootfs/init"

mkdir -p "$WORK/rootfs/root" "$WORK/rootfs/mnt" "$WORK/rootfs/tmp" "$WORK/rootfs/run"

SERIAL1_RUNNER_SRC="$ROOT_DIR/vm/overlay/common/usr/local/bin/ba-serial1-runner"
if [ ! -f "$SERIAL1_RUNNER_SRC" ]; then
  echo "ERROR: falta $SERIAL1_RUNNER_SRC (fuente única del runner serial1)" >&2
  exit 1
fi
SERIAL2_RUNNER_SRC="$ROOT_DIR/vm/overlay/common/usr/local/bin/ba-serial2-console-runner"
if [ ! -f "$SERIAL2_RUNNER_SRC" ]; then
  echo "ERROR: falta $SERIAL2_RUNNER_SRC (fuente única del runner serial2)" >&2
  exit 1
fi
mkdir -p "$WORK/rootfs/usr/local/bin"
install -m 0755 "$SERIAL1_RUNNER_SRC" "$WORK/rootfs/usr/local/bin/ba-serial1-runner"
install -m 0755 "$SERIAL2_RUNNER_SRC" "$WORK/rootfs/usr/local/bin/ba-serial2-console-runner"

# Verify before packing: this prevents silently serving an initramfs with no network modules.
if [ ! -s "$WORK/rootfs/etc/v86-net-modules.list" ]; then
  echo "ERROR interno: falta etc/v86-net-modules.list antes de empaquetar" >&2
  exit 1
fi

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
