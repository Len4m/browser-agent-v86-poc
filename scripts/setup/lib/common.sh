#!/usr/bin/env bash
# Helpers compartidos del build de la imagen initramfs.
# Pensado para cargarse con `source` desde vm-alpine-overlay-hda.sh: usa los
# globals ya definidos por el script principal (WORK, BUILD_ID, PROFILE_*,
# ALPINE_REPO).

# Comprueba las herramientas de host necesarias para construir la imagen.
require_build_tools() {
  local cmd
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
}

# Escribe /etc/apk/repositories combinando los repos base de Alpine con los
# extra del perfil (si los hay).
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

# Escribe los metadatos que el initramfs espera en el rootfs. Se llama varias
# veces porque el Docker export del perfil reemplaza el rootfs y hay que
# restaurarlos.
write_rootfs_metadata() {
  mkdir -p "$WORK/rootfs/etc"
  echo "$BUILD_ID" > "$WORK/rootfs/etc/browser-agent-build-id"
  write_apk_repositories_file "$WORK/rootfs/etc/apk/repositories"
  echo "$PROFILE_NAME" > "$WORK/rootfs/etc/browser-agent-profile-name"
  echo "$PROFILE_ID" > "$WORK/rootfs/etc/browser-agent-profile-id"
}
