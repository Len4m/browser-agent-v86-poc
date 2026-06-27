#!/bin/sh
# Ejecutado dentro de un contenedor Alpine via `docker exec -i ... sh -s`.
# Instala los paquetes del perfil (leidos de /profile-packages.txt) en el rootfs
# del contenedor para luego exportarlo. Recibe ALPINE_REPO, ALPINE_ARCH y
# PROFILE_EXTRA_REPOSITORIES por entorno.
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
