#!/usr/bin/env bash
# Preparacion del rootfs segun el perfil: instalacion de paquetes (via Docker
# export), buildCommands y mensaje de arranque.
# Se carga con `source` desde vm-alpine-initramfs.sh y depende de los globals
# WORK, ROOT_DIR, ALPINE_BRANCH, ALPINE_REPO, ALPINE_ARCH, PROFILE_* y de las
# funciones de common.sh (write_rootfs_metadata, write_apk_repositories_file).

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
  write_rootfs_metadata

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
    "$cid" sh -s < "$ROOT_DIR/scripts/setup/lib/docker-install-packages.sh"

  docker export "$cid" -o "$exported_rootfs"
  cleanup_profile_container

  rm -rf "$WORK/rootfs"
  mkdir -p "$WORK/rootfs"
  tar --warning=no-unknown-keyword -xf "$exported_rootfs" -C "$WORK/rootfs"

  # Remove container-only files and restore metadata needed by our initramfs.
  rm -f "$WORK/rootfs/.dockerenv" "$WORK/rootfs/profile-packages.txt" || true
  write_rootfs_metadata

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
