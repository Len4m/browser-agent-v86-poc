#!/usr/bin/env bash
# Extraccion del kernel linux-lts y de los modulos de red/almacenamiento que
# necesita v86, resolviendo dependencias desde modules.dep.
# Se carga con `source` desde vm-alpine-overlay-hda.sh y depende de los globals
# WORK, ALPINE_REPO, ALPINE_ARCH, OUT_KERNEL y MODULES_LIST. Las funciones
# auxiliares usan MODDIR/KVER/ROOT_MODDIR/ORDER_FILE/VISITED_FILE que
# build_net_modules declara como locales (bash usa scope dinamico).

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

# Descarga linux-lts, extrae kernel + modulos al rootfs y genera
# /etc/v86-net-modules.list (en $MODULES_LIST) con el orden de carga correcto.
build_net_modules() {
  local APKINDEX_TGZ="$WORK/APKINDEX.tar.gz"
  local APKINDEX="$WORK/APKINDEX"
  local LINUX_APK="$WORK/linux-lts.apk"
  local LINUX_EXTRACT="$WORK/linux-lts"

  curl -fsSL "${ALPINE_REPO}/main/${ALPINE_ARCH}/APKINDEX.tar.gz" -o "$APKINDEX_TGZ"
  tar --warning=no-unknown-keyword -xzf "$APKINDEX_TGZ" -C "$WORK" APKINDEX
  local linux_lts_version
  linux_lts_version="$(awk 'BEGIN{RS=""; FS="\n"} /(^|\n)P:linux-lts(\n|$)/ { for(i=1;i<=NF;i++) if($i ~ /^V:/) { print substr($i,3); exit } }' "$APKINDEX")"
  if [ -z "$linux_lts_version" ]; then
    echo "No se ha encontrado linux-lts en ${ALPINE_REPO}/main/${ALPINE_ARCH}/APKINDEX" >&2
    exit 1
  fi

  echo "Descargando linux-lts-${linux_lts_version}.apk para extraer módulos..."
  curl -fsSL "${ALPINE_REPO}/main/${ALPINE_ARCH}/linux-lts-${linux_lts_version}.apk" -o "$LINUX_APK"
  mkdir -p "$LINUX_EXTRACT"
  # Alpine .apk is a gzipped tar archive. It may contain signature/control files before payload, tar handles it.
  tar --warning=no-unknown-keyword -xzf "$LINUX_APK" -C "$LINUX_EXTRACT"

  # Importante: el kernel y los módulos deben venir del mismo linux-lts.apk.
  # Si usamos el vmlinuz de netboot y módulos del repositorio actual, aparece
  # "invalid module format" / "disagrees about version of symbol module_layout".
  local kernel_from_apk
  kernel_from_apk="$(find "$LINUX_EXTRACT/boot" -type f \( -name 'vmlinuz-lts' -o -name 'vmlinuz-*' \) | sort | head -n 1 || true)"
  if [ -z "$kernel_from_apk" ] || [ ! -f "$kernel_from_apk" ]; then
    echo "No se ha encontrado vmlinuz dentro de linux-lts-${linux_lts_version}.apk" >&2
    find "$LINUX_EXTRACT" -maxdepth 4 -type f -name 'vmlinuz*' -print >&2 || true
    exit 1
  fi
  mkdir -p "$(dirname "$OUT_KERNEL")"
  cp "$kernel_from_apk" "$OUT_KERNEL"
  echo "OK kernel extraído desde linux-lts-${linux_lts_version}.apk: $OUT_KERNEL"

  local MODDIR
  MODDIR="$(find "$LINUX_EXTRACT/lib/modules" -mindepth 1 -maxdepth 1 -type d | sort | head -n 1 || true)"
  if [ -z "$MODDIR" ] || [ ! -f "$MODDIR/modules.dep" ]; then
    echo "No se han encontrado módulos en linux-lts-${linux_lts_version}.apk" >&2
    find "$LINUX_EXTRACT" -maxdepth 4 -type d -print >&2 || true
    exit 1
  fi

  local KVER ROOT_MODDIR
  KVER="$(basename "$MODDIR")"
  ROOT_MODDIR="$WORK/rootfs/lib/modules/$KVER"
  mkdir -p "$ROOT_MODDIR"
  cp "$MODDIR"/modules.* "$ROOT_MODDIR/" 2>/dev/null || true

  local target_rels="" modname rel
  for modname in af_packet lib8390 8390 ne2k-pci virtio virtio_ring virtio_pci virtio_pci_modern_dev virtio_pci_legacy_dev virtio_net ata_piix ata_generic pata_acpi libata scsi_mod sd_mod virtio_blk ext2 ext4 overlay mbcache jbd2 crc16 crc32c crc32c_generic libcrc32c; do
    rel="$(find_module_rel "$modname")"
    if [ -n "$rel" ]; then
      target_rels="$target_rels $rel"
    fi
  done

  # Hard fallback if modules.dep has unexpected formatting.
  if [ -z "$(echo "$target_rels" | xargs)" ]; then
    target_rels="$(find "$MODDIR/kernel" -type f \( -name 'af_packet.ko*' -o -name 'lib8390.ko*' -o -name '8390.ko*' -o -name 'ne2k-pci.ko*' -o -name 'virtio*.ko*' -o -name 'ata_piix.ko*' -o -name 'ata_generic.ko*' -o -name 'pata_acpi.ko*' -o -name 'libata.ko*' -o -name 'scsi_mod.ko*' -o -name 'sd_mod.ko*' -o -name 'virtio_blk.ko*' -o -name 'ext2.ko*' -o -name 'ext4.ko*' -o -name 'overlay.ko*' -o -name 'jbd2.ko*' -o -name 'mbcache.ko*' -o -name 'crc*.ko*' -o -name 'libcrc32c.ko*' \) | sed "s#^$MODDIR/##")"
  fi

  if [ -z "$(echo "$target_rels" | xargs)" ]; then
    echo "No se han encontrado módulos de red v86 en linux-lts-${linux_lts_version}" >&2
    echo "Candidatos en modules.dep:" >&2
    grep -E 'af_packet|virtio|8390|ne2k|pcnet|e1000|8139|r8169|ata_|pata|libata|scsi|sd_mod|ext2|ext4|jbd2|mbcache|crc32' "$MODDIR/modules.dep" | head -120 >&2 || true
    exit 1
  fi

  local ORDER_FILE="$WORK/v86-net-modules-order"
  local VISITED_FILE="$WORK/v86-net-modules-visited"
  : > "$ORDER_FILE"
  : > "$VISITED_FILE"

  local target_rel
  for target_rel in $target_rels; do
    visit_module "$target_rel"
  done

  : > "$MODULES_LIST"
  local mod_rel
  while IFS= read -r mod_rel; do
    copy_module "$mod_rel"
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
}
