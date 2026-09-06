# Uso, desarrollo y distribución

> [English](USAGE.en.md) | **Español**

Esta guía cubre cómo ejecutar Browser Agent v86 POC, preparar el entorno de desarrollo, usar la VM/LLM/red y empaquetar un runtime.

Consulta [Almacenamiento y snapshots](STORAGE_AND_SNAPSHOTS.es.md) para las garantías y límites exactos de persistencia, exportación y restore.

## Demo online

La forma más sencilla de usar Browser Agent v86 POC es la demo publicada:

[https://browseragent.icu/](https://browseragent.icu/)

No necesitas instalar Node.js, Docker ni clonar el repositorio para probarla. La VM, el chat y los assets se sirven desde la web; los modelos Transformers.js se descargan/cachean en tu navegador. Ollama y wsnic, si los usas, siguen siendo servicios locales de tu máquina porque el navegador llama a tu propio `127.0.0.1`.

## Idioma (ES/EN)

La interfaz está disponible en español e inglés. El idioma se elige en el selector de la cabecera y cambia en caliente, sin recargar la página ni perder la VM en marcha.

- Si no hay una preferencia guardada, la app elige español cuando alguno de los idiomas declarados por el navegador es español e inglés en caso contrario.
- La elección se guarda en `localStorage` (`ba.lang`) y se respeta en siguientes visitas.
- Los dos catálogos se publican en `public/locales/`, pero el navegador solo mantiene en memoria el idioma activo.

La interfaz, los [manuales de usuario](USER_MANUAL.es.md), esta guía y la documentación de arquitectura están disponibles en español e inglés. Consulta [README.es.md](../README.es.md) para acceder a toda la documentación en español.

## Tema de apariencia

El botón de tema de la cabecera alterna **Sistema → Claro → Oscuro** y cambia entre los iconos de sol y luna combinados, sol y luna. El modo Sistema sigue los cambios de apariencia del navegador; una elección explícita se guarda en `localStorage` (`ba.theme`) y se aplica antes de mostrar la interfaz para evitar destellos de otro tema.

## Requisitos

Para usar un runtime ya generado basta con:

- Navegador moderno.
- WebGPU recomendado para modelos Transformers.js locales; existe alternativa WASM cuando el modelo/configuración lo permite.
- Servidor HTTP con COOP/COEP/CORP, MIME `application/wasm` y soporte `Range`.
- Conexión a Internet para la primera descarga de modelos, salvo que ya estén en caché del navegador.

Para preparar el proyecto desde el repo necesitas además:

- Node.js 26.8.1 y pnpm 11.24.0, fijados respectivamente en `.nvmrc` / `.node-version` y `packageManager`.
- Linux. En macOS hay que instalar y exponer en `PATH` versiones compatibles con GNU de `tar`, `stat` y `cpio`, además de las herramientas ext2; las utilidades BSD incluidas por defecto no aceptan todas las opciones que usa `pnpm setup`.
- Docker para construir los perfiles Alpine incluidos.
- Herramientas de sistema: `tar`, `cpio`, `gzip`, `zstd`, `xz`, `curl`, `coreutils`, `e2fsprogs`, `find`, `awk`, `grep` y `sed`.
- Conexión a Internet para los assets base, los paquetes Alpine y las wordlists de perfiles que descarga `pnpm setup`.
- 1-2 GB libres para runtime v86, initramfs, perfiles y discos sparse.

En Debian/Ubuntu:

```bash
sudo apt install -y cpio gzip tar curl zstd xz-utils coreutils e2fsprogs findutils gawk grep sed
```

### Memoria recomendada

La memoria depende del backend LLM elegido. **Transformers.js y Ollama no tienen el mismo coste de memoria**:

- Si usas **Transformers.js**, el modelo se descarga/cachea en el navegador y la inferencia corre con WebGPU/WASM, dentro del worker LLM.
- Si usas **Ollama**, no se carga el runtime ni el modelo Transformers.js en el navegador. El coste del modelo vive en el proceso de Ollama del host y depende del modelo que tengas cargado allí.
- Si no cargas un modelo Transformers.js, no debes sumar la memoria medida para Transformers.js. Solo suma la app, la VM y, si usas Ollama, el modelo de Ollama.

Guía práctica:

| Escenario | Mínimo práctico | Recomendado |
| --- | ---: | ---: |
| UI + VM ligera, sin LLM local de navegador | 4 GB | 8 GB |
| VM `alpine-base` + Transformers.js `qwen3-tools-onnx-q4` WebGPU | 8 GB | 12 GB |
| VM pentest + Transformers.js `qwen3-tools-onnx-q4` WebGPU + tools | 12 GB | 16 GB |
| Ollama | Depende del modelo Ollama | Suma la memoria del modelo Ollama al uso de la VM/app |

Como referencia, `qwen3-tools-onnx-q4` (`onnx-community/Qwen3-0.6B-ONNX`, q4/WebGPU) descargó/cacheó unos 0.93 GB y Chrome alcanzó alrededor de 5.3 GB RSS durante generación en la prueba local. Ese coste solo aplica al backend Transformers.js; con Ollama no se usa salvo que también cargues un modelo Transformers.js.

## Preparación local

```bash
git clone https://github.com/Len4m/browser-agent-v86-poc.git
cd browser-agent-v86-poc
pnpm install
pnpm prepare:local
pnpm start
```

Abre `http://127.0.0.1:5173/`.

`pnpm prepare:local` ejecuta `setup` y después `build`. La VM no arrancará correctamente hasta que existan los assets generados en `public/v86/`, `public/vendor/` y `public/assets/`.

## Primer uso

1. Selecciona el perfil de VM.
2. Pulsa **Arrancar VM** y espera a que aparezca la shell; la primera vez puede descargar assets grandes.
3. Si el navegador acepta WebGPU, carga un modelo Transformers.js u Ollama desde el panel **LLM**. Con solo WASM, para agente/tools suele ser mejor usar Ollama o probar otro navegador/equipo con WebGPU.
4. Usa el chat para pedir acciones dentro de la VM, o las consolas xterm para comprobar y ejecutar manualmente.
5. Si necesitas red en la VM, configura wsnic desde **Red WS**.

Puedes pulsar **Comprobar** en cualquier momento para validar cabeceras, assets, seriales, runners, red y tools cuando corresponda.

Los perfiles generados aparecen desde `/v86/images/profiles/index.json`. Si no aparecen, ejecuta `pnpm setup`.

## VM, perfiles y almacenamiento

Perfiles incluidos:

| Perfil | Uso | RAM mínima |
| --- | --- | --- |
| `alpine-base` | Alpine mínimo con certificados, curl, nano y Python para el daemon xterm | 512 MB |
| `alpine-pentest-lite` | Herramientas ligeras: nmap, ffuf, Python, DNS y wordlists web pequeñas | 1024 MB |
| `alpine-pentest-web` | Pentest web ampliado: nikto, httpx, SSL Perl y wordlists | 1536 MB |

Al elegir un perfil, la UI aplica sus mínimos de RAM y VRAM y deshabilita los valores inferiores. Ambos recursos pueden aumentarse antes de arrancar sin cambiar el workspace asociado; el runtime impide arrancar o restaurar por debajo de los mínimos. En **Conservar cambios** se elige **No, sesión temporal** o **Workspace persistente**.

Discos:

- Todos los perfiles usan HDA rootfs inmutable y HDB OverlayFS. **No, sesión temporal** descarta el HDB al apagar; **Workspace persistente** lo guarda automáticamente en IndexedDB después de que el usuario lo active.
- Cada versión de perfil tiene un único workspace automático en el navegador; no dispone de importación o exportación propia.
- El selector marca con **💾** los perfiles con datos guardados. El resumen muestra **Datos persistentes · tamaño**, calculado solo con los bloques de ese workspace y sin incluir modelos o cachés.
- **Reiniciar workspace** aparece cuando el perfil tiene datos y se ha elegido **Workspace persistente**; solo se puede ejecutar con la VM apagada.
- Los botones **Exportar** e **Importar** trabajan exclusivamente con snapshots `.bav86snapshot`. Funcionan en ambos modos e incluyen identidad verificable, estado de ejecución, delta HDB y metadatos de las consolas.

## Consola y tools

Canales seriales actuales:

| Canal | Dispositivo VM | Uso |
| --- | --- | --- |
| `serial0` | `/dev/ttyS0` | Arranque, login base y pestaña 1 de usuario |
| `serial1` | `/dev/ttyS1` | Tools del agente, checks y formulario manual |
| `serial2` | `/dev/ttyS2` | Daemon xterm/PTY para las pestañas interactivas 2-4 |

Los runners instalados en el initramfs vienen de:

- `vm/overlay/common/usr/local/bin/ba-serial1-runner`
- `vm/overlay/common/usr/local/bin/ba-serial2-console-runner`

Ambos runners guest usan Python 3. Todos los perfiles en `vm/profiles/*.json` deben incluir el paquete `python3`; `pnpm test:all` y la construcción de perfiles fallan si falta.

Después de cambiar perfiles, overlay, runners o scripts de initramfs, ejecuta:

```bash
pnpm setup
```

Validación rápida dentro de la VM:

```sh
ls -l /dev/ttyS*
ps | grep '[b]a-serial1-runner'
ps | grep '[b]a-serial2-console-runner'
python3 --version
```

## LLM

Backends soportados:

- **Transformers.js**: corre en el navegador con worker propio. WebGPU es lo recomendado; algunos modelos pueden caer a WASM si WebGPU falla.
- **Ollama HTTP**: el navegador llama directamente al endpoint local, por defecto `http://127.0.0.1:11434`.

Los modelos se descubren en runtime. Transformers.js busca repositorios públicos no gated de `text-generation` etiquetados `transformers.js` en Hugging Face Hub; Ollama consulta los modelos instalados en el endpoint configurado y muestra los que anuncian soporte de tools. También se puede introducir manualmente un ID de repositorio para Transformers.js.

La búsqueda del Hub es remota y paginada; **Cargar más** aparece como última opción del listado mientras existan más resultados. La lista solo incluye repositorios con soporte de tools detectado. El ID manual no tiene ese filtro: el botón de información situado dentro del campo permite inspeccionar sus metadatos antes de cargarlo y muestra el error bajo el campo si no se puede consultar. Al seleccionar o inspeccionar un repositorio, un worker temporal revisa ficheros ONNX, dtypes, contexto declarado, chat template y señales de tools/thinking. Ollama muestra los modelos instalados que anuncian tools y consulta `/api/show` para obtener capacidades y contexto.

La caché del navegador puede evitar que Transformers.js vuelva a descargar los archivos. La aplicación persiste el último motor/modelo seleccionado y sus ajustes bajo `ba.llm.lastProfile.v1`. **Restaurar defaults** recupera los valores iniciales del motor y modelo actuales.

Los bloques básico y avanzado representan la política del usuario, no recomendaciones. Una capacidad desconocida produce avisos, pero no desactiva por sí sola el agente.

Notas de uso:

- El chat está deshabilitado hasta que cargues un backend/modelo.
- La carga de Transformers.js usa el overlay general de la aplicación. Indica la fase o componente en curso —por ejemplo, configuración, tokenizador o pesos— y permite **Cancelar descarga** sin recargar la página. Si falla, el detalle aparece junto a **Cargar modelo** y se limpia al cambiar de fuente o candidato.
- Al comenzar una respuesta se fija la configuración efectiva de ese turno. Los ajustes que alteran el runtime cargado —motor/modelo, device, dtype, generation cache y generación/parsing de thinking— quedan bloqueados hasta que termine; la autonomía también se bloquea para no cambiar la política de aprobación a mitad del turno. Si los ajustes de runtime se cambian con el chat inactivo, descargan el runtime y requieren volver a cargarlo. Los ajustes de agente, selección de tools, sampling, contexto y visualización del razonamiento pueden prepararse para el siguiente turno sin interrumpir el actual.
- El razonamiento se transmite en streaming y no se guarda como respuesta final ni se conserva en memoria.
- Los resultados de las tools se guardan como artifacts en el modal **Recursos y contexto**, accesible desde el botón de la cabecera del chat: puedes previsualizarlos, adjuntarlos al siguiente mensaje o eliminarlos. El adjuntado respeta el presupuesto de contexto del modelo y se omite si no hay margen.
- La primera carga de modelos Transformers.js puede descargar ficheros grandes y quedar cacheada por el navegador.
- WebGPU es la ruta recomendada para tools con Transformers.js. El fallback WASM existe para chat básico en navegadores sin WebGPU, pero no debe considerarse una ruta fiable para tool calling; usa un navegador con WebGPU compatible u Ollama si necesitas herramientas.
- Si usas Ollama desde otro origen distinto al permitido, arranca Ollama con `OLLAMA_ORIGINS` incluyendo el origen de la página. Ejemplo: `OLLAMA_ORIGINS=http://127.0.0.1:5173`.
- En una publicación web, Ollama sigue siendo local para cada usuario: el navegador llama a su propio `127.0.0.1`.

## Red WS

La red es opcional. Usa **Probar** para comprobar el handshake y **Conectar** para activar el endpoint; DHCP, DNS y tráfico se validan después desde la VM.

### Local Docker WS

Es la opción predeterminada (`ws://127.0.0.1:8086/wsnic`). Ejecuta el comando Docker mostrado en la UI. Con `-i` permite acceso al host e Internet; sin `-i`, las VMs/pestañas solo pueden comunicarse entre sí por la red virtual.

### Relay público

Usa el endpoint fijo `wss://relay.widgetry.org/`. Es un relay experimental, compartido, limitado y sin SLA ni garantías de privacidad, disponibilidad o estabilidad. No envíes información sensible ni hagas pruebas de carga.

### Personalizado

Permite introducir cualquier URL válida `ws://` o `wss://`. Para WSS usa un certificado público válido y la cadena completa, directamente con wsnic/stunnel en `8087` o terminando TLS con Caddy, Nginx o Traefik en `443`. No expongas `ws://` a Internet, no uses certificados autofirmados ni desactives la seguridad del navegador.

## Scripts

| Comando | Uso |
| --- | --- |
| `pnpm install` | Instala las dependencias del proyecto; no genera los assets pesados |
| `pnpm prepare:local` | Ejecuta `setup` y `build` para dejar un entorno local usable |
| `pnpm setup` | Descarga/copia assets base y genera los perfiles OverlayFS |
| `pnpm build` | Genera el worker/bridge LLM y el bundle frontend; no consulta APIs de modelos y requiere haber ejecutado `setup` al menos una vez |
| `pnpm build:prod` | Genera el runtime minificado para producción: JS/CSS minificados y hashes de caché |
| `pnpm test` | Ejecuta los tests rápidos de módulos e integración ligera |
| `pnpm test:e2e` | Ejecuta las pruebas reales con Chromium y v86 |
| `pnpm test:all` | Ejecuta TypeScript, lint, tests rápidos, checks de integridad y pruebas E2E |
| `pnpm clean` | Borra `build/` y las salidas generadas por el build en `public/` |
| `pnpm clean:runtime` | Borra runtime pesado generado por `setup`: `public/vendor/` y `public/v86/` |
| `pnpm clean:all` | Ejecuta la limpieza de build y runtime |
| `pnpm start` | Sirve `public/` con `server.mjs` en `127.0.0.1:5173` |

Para observar la prueba E2E en Chromium, ejecuta:

```bash
pnpm test:e2e --help
pnpm test:e2e --headed
pnpm test:e2e --headed --slow-mo=250 --pause-on-end
```

`--help` (o `-h`) muestra todas las opciones sin iniciar las pruebas. `--slow-mo` acepta de 0 a 5000 ms entre acciones. `--pause-on-end` implica `--headed` y mantiene Chromium abierto hasta pulsar Enter; en una ejecución no interactiva se omite la pausa para no bloquear CI.

Regenera con `pnpm setup` después de tocar:

- `vm/profiles/*.json`
- `vm/overlay/common/`
- `scripts/setup/vm-alpine-overlay-hda.sh`
- runners seriales

Los perfiles VM deben mantener `python3` en `packages`, porque los runners seriales del guest dependen de Python 3.

Regenera con `pnpm build` después de tocar:

- `src/browser/`
- `src/web/index.html`
- `src/web/styles/`
- provider AI SDK o worker LLM

## Artefactos generados

| Fuente | Salida | Regenerar |
| --- | --- | --- |
| `src/browser/`, `src/web/index.html`, `src/web/styles/` | `public/index.html`, `public/style.css`, `public/styles/`, `public/assets/app.js`, `public/assets/ai-sdk-bridge.mjs` | `pnpm build` |
| `src/web/styles/` | `public/assets/app.css` | `pnpm build:prod` |
| `src/browser/chat/provider/ai-sdk/` | `public/assets/chat/` | `pnpm build` |
| `vm/profiles/*.json`, `vm/overlay/common/` | `build/profiles/`, `public/v86/images/profiles/` | `pnpm setup` |
| v86, xterm, DOMPurify, streaming-markdown, BIOS y Alpine base | `public/vendor/`, `public/v86/build/`, `public/v86/bios/`, `public/v86/images/` | `pnpm setup` |
| HDA raíz por partes y semilla HDB de cada perfil | `public/v86/images/profiles/` | `pnpm setup` |

## Limpieza

Usa `pnpm clean` durante el desarrollo normal. Borra `build/` y las salidas generadas por el build en `public/`: `index.html`, `style.css`, `styles/`, `locales/` (copiados desde `src/web/`), bundles JS y `assets/chat/`. No borra `public/vendor/` ni `public/v86/`, ni los estáticos versionados en git (`favicon.ico`, iconos, `robots.txt`, etc.).

Usa `pnpm clean:runtime` cuando quieras forzar una regeneración del runtime pesado: vendors, v86, BIOS, initramfs, perfiles y discos. Después ejecuta `pnpm setup` o `pnpm prepare:local` antes de arrancar la VM.

Usa `pnpm clean:all` para limpiar ambos grupos.

## Runtime zip

El runtime estático es la carpeta `public/`. Un paquete completo con todas las funciones incluidas contiene HTML, CSS y JS generados, vendors, v86, BIOS, initramfs, perfiles y discos.

Crear zip:

```bash
pnpm prepare:local
pnpm test:all
cd public
zip -r ../browser-agent-v86-poc-runtime-public.zip .
```

Contenido mínimo:

- `index.html`, `style.css`, `styles/`
- `assets/`
- `vendor/`
- `v86/build/`
- `v86/bios/`
- `v86/images/`
- `v86/disks/`
- `favicon.ico`, `apple-touch-icon.png`, `site.webmanifest` y `robots.txt`
- `_headers` si despliegas en una plataforma compatible como Cloudflare Pages

El servidor final debe enviar COOP/COEP/CORP y soportar `Range`. `public/_headers` documenta esas cabeceras para Cloudflare Pages, pero otros servidores necesitan configuración equivalente.

Para el build público de la demo oficial:

```bash
pnpm build:prod
```

`build:prod` usa `https://browseragent.icu/` como `BA_PUBLIC_SITE_URL` por defecto. Para otro dominio:

```bash
BA_PUBLIC_SITE_URL=https://tu-dominio.example/ pnpm build:prod
```

Ese valor se usa para `canonical`, `og:url` e imágenes Open Graph/Twitter absolutas. Si se ejecuta el build no productivo sin esa variable, el HTML queda portable con URLs relativas al origen.

Paquete local con servidor incluido:

```bash
zip -r browser-agent-v86-poc-local-server.zip public server.mjs package.json pnpm-lock.yaml pnpm-workspace.yaml
```

Uso:

```bash
unzip browser-agent-v86-poc-local-server.zip -d destino/
cd destino
pnpm install
pnpm start
```

## Problemas habituales

- **VM no arranca**: ejecuta `pnpm prepare:local` y después `pnpm test:all`.
- **No aparecen perfiles**: falta `/v86/images/profiles/index.json`; ejecuta `pnpm setup`.
- **Cambiaste initramfs, runners o perfiles**: ejecuta `pnpm setup` y arranca una VM nueva.
- **El almacenamiento del perfil no monta**: verifica que existan la HDA raíz por partes y la semilla HDB en `public/v86/images/profiles/`; `pnpm setup` las crea.
- **Tools o checks afectan a la consola visible**: valida `/dev/ttyS1`, `/dev/ttyS2` y los procesos `ba-serial1-runner` / `ba-serial2-console-runner`.
- **Una consola xterm queda desincronizada**: usa refrescar; limpia el xterm local y envía `Ctrl+L` al shell activo.
- **LLM local falla por WebGPU**: prueba un modelo WASM o reduce el modelo; algunas rutas intentan fallback WASM.
- **Ollama falla por CORS**: configura `OLLAMA_ORIGINS` con el origen exacto desde el que sirves la página.
- **Ollama no responde con el modelo elegido**: comprueba que el modelo está instalado en tu Ollama local con `ollama list` o instálalo con `ollama pull <modelo>`.
- **Red de VM sin salida**: revisa que `wsnic` esté corriendo, que la UI esté conectada y que la VM haya ejecutado la configuración de red.
