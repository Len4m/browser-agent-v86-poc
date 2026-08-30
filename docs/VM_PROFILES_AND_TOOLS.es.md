# Perfiles VM y tools

> [English](VM_PROFILES_AND_TOOLS.en.md) | **Español**

Esta guia explica como añadir un perfil de VM y como exponer tools del agente para ese perfil usando la arquitectura actual del proyecto. No cubre uso de la aplicacion por parte de usuarios finales.

## Idea general

Hay dos contratos separados:

- **Perfil VM**: vive en `vm/profiles/<id>.json`. Define la imagen Alpine, paquetes, comandos de build/arranque, RAM recomendada y la lista `allowedTools`.
- **Tool**: vive en `src/browser/chat/tools/definitions/*.ts`. Define schema AI SDK, normalizacion de argumentos, comando a ejecutar, paquetes requeridos, riesgo, timeout y formato de resultado.

La union entre ambos contratos es:

- El perfil expone una tool incluyendola en `allowedTools`.
- La tool declara `requiredPackages`.
- `scripts/check/vm-profiles.mjs` valida que las tools existen y que el perfil incluye los paquetes requeridos.
- En runtime, `tool-registry.ts` vuelve a filtrar tools incompatibles con el perfil activo.

Las definiciones de campos, reglas de validación y propiedades obligatorias de `vm/profiles/<id>.json` están en la [referencia del schema de perfil VM](schema-reference/vm-profile.md) (**en inglés**; generada desde `vm/profiles/profile.schema.json` con `pnpm docs:schemas`).

## Añadir un perfil VM

1. Crea `vm/profiles/<id>.json`.

   Usa como base el perfil existente mas parecido:

   - `alpine-base.json`: perfil minimo.
   - `alpine-pentest-lite.json`: herramientas ligeras y wordlists.
   - `alpine-pentest-web.json`: herramientas web adicionales, repos extra y comandos de build mas ricos.

2. Mantén `id` y nombre de fichero alineados.

   Si `id` es `alpine-demo`, el fichero debe ser `vm/profiles/alpine-demo.json`. El schema admite ids en minusculas con numeros, puntos y guiones.

3. Declara los campos estructurales.

   Campos habituales:

   ```json
   {
     "$schema": "./profile.schema.json",
     "id": "alpine-demo",
     "name": "Alpine Demo",
     "description": "Perfil Alpine de ejemplo.",
     "alpineVersion": "3.23.4",
     "recommendedRamMb": 1024
   }
   ```

   El builder deriva la salida initramfs desde `id`, por ejemplo `v86/images/profiles/alpine-demo-initramfs.gz`. El kernel usa por defecto el fichero compartido de la rama Alpine efectiva; define `kernelOutput` solo si un perfil necesita una ruta de kernel propia. `defaultDisk` es opcional y por defecto es `initramfs`.

4. Declara `packages`.

   Todos los perfiles deben incluir `python3`, porque los runners guest de `serial1` y `serial2` dependen de Python 3. Añade tambien los paquetes que necesitan tus comandos y tools.

   ```json
   "packages": [
     "ca-certificates",
     "curl",
     "nano",
     "python3",
     "iproute2"
   ]
   ```

5. Declara `allowedTools`.

   Esta lista es la politica del perfil. Solo incluyas tools que tengan sentido en esa imagen. El orden se conserva y se usa como prioridad por defecto cuando la UI o el modelo limita el numero de tools visibles.

   ```json
   "allowedTools": [
     "vm_fs_list",
     "vm_fs_read",
     "vm_cmd_which",
     "web_curl_head",
     "net_ip_status"
   ]
   ```

6. Usa `buildCommands` y `firstBootCommands` con intencion clara.

   - `buildCommands`: se ejecutan durante la generacion de la imagen contra `/rootfs`. Sirven para crear symlinks, descargar wordlists pequeñas, limpiar cache o preparar ficheros.
   - `firstBootCommands`: se escriben en `/etc/browser-agent-firstboot.sh` y se ejecutan al arrancar la VM.

   Si una comprobacion debe fallar la generacion de imagen, ponla en `buildCommands`. Si debe ejecutarse una vez al arrancar la VM, ponla en `firstBootCommands`. Si comprueba la disponibilidad real de una tool y debe aparecer en el panel **Comprobar**, declarala en `runtimeChecks` de esa tool.

   Ejemplo:

   ```json
   "firstBootCommands": [
     "update-ca-certificates >/tmp/update-ca-certificates.log 2>&1 || true"
   ],
   "buildCommands": [
     "rm -rf /rootfs/var/cache/apk/* /rootfs/tmp/* /rootfs/var/tmp/*"
   ]
   ```

7. Usa `extraRepositories` solo cuando sea necesario.

   Si una herramienta no esta en la rama Alpine principal para `x86`, añade repositorios extra y deja una nota explicando por que. El perfil `alpine-pentest-web` es el ejemplo actual.

8. Valida el perfil.

   ```bash
   pnpm check
   ```

   Este comando comprueba schema, ids duplicados, `python3`, `allowedTools` desconocidas y `requiredPackages` faltantes. Consulta la [referencia del schema](schema-reference/vm-profile.md) (**en inglés**) si necesitas el detalle de cada campo.

9. Genera los assets del perfil.

   Usa `pnpm setup` como ruta normal. Valida todos los perfiles, prepara assets base, genera las imagenes de perfiles, actualiza `public/v86/images/profiles/index.json` y crea los discos HDA locales.

   ```bash
   pnpm setup
   ```

   Comando para generar un solo perfil:

   ```bash
   node scripts/setup/vm-profile-image.mjs vm/profiles/alpine-demo.json
   ```

   Sustituye `alpine-demo.json` por el fichero real. Ese comando genera el initramfs del perfil y actualiza `public/v86/images/profiles/<id>.json` e `index.json`, pero no crea discos HDA ni valida el resto de perfiles. No edites esos manifests a mano; se regeneran desde `vm/profiles/*.json`.

## Crear una tool para un perfil

1. Crea un modulo en `src/browser/chat/tools/definitions/`.

   El fichero debe exportar `toolDefinition` con tipo `ToolDefinition`. El build descubre estos ficheros y genera el modulo virtual `virtual:ba-tools`; no hay que editar un indice manual.

2. Usa un nombre estable.

   Los nombres siguen el estilo `area.nombre.accion`, por ejemplo:

   - `vm_fs_read`
   - `web_curl_head`
   - `net_nmap_quick`
   - `web_nikto_quick`

3. Declara el contrato de paquetes.

   Si la tool necesita un binario o runtime de Alpine, declara `requiredPackages` con nombres de paquete APK. Despues, cualquier perfil que añada esa tool a `allowedTools` debe incluir esos paquetes en `packages`.

4. Declara checks de disponibilidad runtime.

   Si la tool necesita comandos concretos, añade `runtimeChecks` con etiquetas cortas y comandos minimos como `command -v curl`, `command -v nikto.pl` o un fallback de nombres para `httpx`. El panel **Comprobar** usa estos checks desde el registry segun `allowedTools`; no añadas mapas de paquetes a la UI.

5. Normaliza argumentos y construye comandos de forma acotada.

   Usa helpers existentes cuando encajen:

   - `normalizeUrl`, `normalizeHost`, `normalizeBool`, `textValue`, `toToolArgs`.
   - `clampInt` para limites numericos.
   - `shellQuote` para cualquier valor interpolado en shell.
   - `captureCommand` para envolver comandos y detectar binarios ausentes.
   - `standardFormat`, `cleanToolOutput`, `truncateToolOutput` o `toolFailureDetail` para formatear salida.

6. Añade schema AI SDK e i18n.

   Si la tool se expone al modelo, define `buildInputSchema(z)` y textos localizados en `src/web/locales/en.json` y `src/web/locales/es.json` para nombre, descripcion, schema y errores.

7. Ajusta riesgo y limites.

   - `riskLevel: 1`: lectura acotada.
   - `riskLevel: 2`: diagnostico de bajo impacto.
   - `riskLevel: 3`: acciones activas como comandos o escaneos ligeros.
   - `timeoutMs` y `maxOutputBytes` deben ser explicitos y conservadores.

8. Expón la tool en un perfil.

   Añade el nombre de la tool a `allowedTools` del perfil y los paquetes necesarios a `packages`. Si la tool depende de un ejecutable concreto distinto del nombre del paquete, reflejalo en:

   - `buildCommands` o `firstBootCommands` del perfil.
   - `runtimeChecks` en la propia definicion de tool si esa disponibilidad debe aparecer en **Comprobar**.
   - Tests si el contrato es delicado.

   Ejemplo actual: `web_nikto_quick` declara `requiredPackages` para Nikto y los modulos Perl SSL, pero ejecuta `nikto.pl` mediante `timeout`. El perfil `alpine-pentest-web` crea un symlink `nikto` para uso manual y la tool valida su disponibilidad con `runtimeChecks`.

## Validacion recomendada

Despues de añadir o cambiar perfiles/tools:

```bash
pnpm check
```

Si cambiaste perfiles, overlay o runners:

```bash
pnpm setup
```

Si cambiaste codigo de tools, provider LLM, catalogos i18n o frontend:

```bash
pnpm build
```

Para dejar un entorno local completo:

```bash
pnpm prepare:local
```

## Checklist

- El fichero del perfil se llama igual que su `id`.
- El perfil incluye `python3`.
- `allowedTools` solo contiene tools existentes.
- Cada tool expuesta tiene sus `requiredPackages` en `packages`.
- Los comandos usan quoting y limites.
- Las salidas tienen timeout y tamaño maximo.
- La tool tiene textos i18n si se muestra al usuario/modelo.
- `pnpm check` pasa.
- Tras cambios de perfil, la VM arranca y **Comprobar** no muestra paquetes/tools faltantes.
