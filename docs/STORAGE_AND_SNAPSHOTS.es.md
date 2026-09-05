# Almacenamiento y snapshots de VM

> [English](STORAGE_AND_SNAPSHOTS.en.md) | **Español**

## Arquitectura

Todos los perfiles publicados arrancan un initramfs mínimo, cargan IDE/ext4/OverlayFS y ejecutan `switch_root` sobre:

```text
HDA ext4 inmutable del perfil (lowerdir, partes zstd de 4 MiB)
  + HDB ext4 CoW (upperdir/workdir, bloques de 64 KiB)
      ├─ memoria, para una sesión temporal
      └─ IndexedDB, para un workspace activado por el usuario
  = raíz OverlayFS
```

Se descartó 9p como raíz por semántica y rendimiento para toolchains; `filesystem: {}` se conserva para mantener la topología estable y 9p queda como futura vía de intercambio. Una HDA raíz escribible también se descartó porque acoplaría el sistema completo a la caché opaca de v86.

El arranque identifica ambas particiones por sus etiquetas ext4 (`ba-root` y `ba-persist`), no por el orden eventual `sda`/`sdb`. Esto evita invertir las capas cuando v86/Linux enumera los dos discos SCSI en distinto orden.

El perfil decide el sistema, las tools y los mínimos de RAM/VRAM; el usuario decide **No, sesión temporal** o **Workspace persistente** antes de arrancar. Puede aumentar RAM/VRAM sin cambiar la identidad del workspace. El `ResolvedVmRuntime` inmutable valida y fija estas decisiones, `allowedTools`, assets, cmdline, red, UARTs, 9p y discos.

## Persistencia

- La sesión temporal es el valor predeterminado y nunca escribe en IndexedDB. Todos sus cambios desaparecen al apagar, salvo que se guarde un snapshot.
- Al activar persistencia se abre automáticamente el único workspace del perfil, identificado por el SHA-256 exacto de su versión base. Una versión nueva usa otro workspace y nunca monta silenciosamente datos de una base distinta.
- El navegador solicita `navigator.storage.persist()` al arrancar un workspace. `persisted` significa protección aceptada; `evictable`, que está guardado pero el navegador puede expulsarlo.
- Al apagar se ejecuta `sync` en el guest, se vacían las transacciones CoW y se fija un checkpoint antes de destruir v86.
- `degraded` indica fallo o cuota insuficiente de IndexedDB; en ese estado ya no se afirma persistencia local.
- Un cierre abrupto puede perder lo que siga en la caché del guest. ext4 reproducirá el journal al arrancar.
- El selector de perfiles muestra **💾** cuando existe un delta compatible. Para el perfil seleccionado, la UI suma con un cursor de solo lectura los bloques de su generación activa y muestra **Datos persistentes · tamaño**. Esta cifra no usa `navigator.storage.estimate()` y, por tanto, no mezcla el workspace con modelos LLM, cachés ni otros perfiles.
- **Reiniciar workspace** solo aparece si el perfil seleccionado tiene datos y el usuario también elige **Workspace persistente** en **Conservar cambios**. Solo puede ejecutarse con la VM apagada y devuelve el perfil a su semilla inmutable.

IndexedDB no es una copia de seguridad garantizada. No existe importación o exportación independiente del workspace. El snapshot es la única copia portable: incluye tanto el estado de ejecución como el delta HDB, sea temporal o persistente.

## Snapshots verificables

`.bav86snapshot` (`BAV86SNP`, v1) contiene una cabecera fija, manifiesto JSON y secciones identity/gzip. Registra versión exacta de v86 (`0.5.445+gb0d8f2c`), perfil/hash, hashes y tamaños de libv86/WASM/BIOS/kernel/initramfs, RAM/VRAM, cmdline, red, UARTs, 9p, discos, estado `save_state()`, delta HDB y metadatos visuales de las consolas (nombres y pestaña activa). No incluye assets base: deben seguir publicados con la misma identidad.

El botón **Exportar** ejecuta `sync`, fija HDB, pausa, serializa, empaqueta y reanuda incluso si la descarga falla. **Importar** valida todo **antes** de apagar la VM actual, selecciona automáticamente el perfil, RAM, VRAM y modo temporal/persistente registrados, recalcula las tools desde `allowedTools` (con fallback a la prioridad del perfil si la selección anterior es incompatible), arranca el runtime exacto, aplica delta/estado, revalida seriales/PTYs, restaura nombres y pestaña activa, solicita el repintado automático de cada PTY y reconstruye WS con el endpoint actual. Los formatos que no sean `.bav86snapshot` se rechazan por carecer del contrato completo del snapshot actual.

## Comportamiento comprobado de v86

En v86 `0.5.445+gb0d8f2c`, `save_state()` conserva RAM y dispositivos. `CowDisk.get_state()` sólo incluye identidad/checkpoint: su contenido se empaqueta como delta explícito. Restore exige la misma base, versión, RAM y topología registradas por el snapshot.

| Layout | Tras apagar/recargar | Snapshot | Requisito de restore |
| --- | --- | --- | --- |
| Perfil + sesión temporal | No | Estado + delta HDB | Misma base inmutable |
| Perfil + workspace | HDB en IndexedDB | Estado + delta HDB | Misma base inmutable |

## Validación

Ejecuta `pnpm check`, `pnpm setup` y `pnpm test:vm-storage`. El último usa Chromium para comprobar que una sesión temporal se descarta, que un workspace conserva `/root` incluso al cambiar RAM/VRAM, que la UI muestra solo el tamaño de ese workspace, que el botón de reinicio respeta **Conservar cambios**, que un snapshot persistente restaura HDB, consolas, perfil, tools y `serial1` en un navegador vacío y que el workspace se puede reiniciar. La matriz manual cubre Firefox, cierre abrupto/journal, red y los tres canales seriales.
