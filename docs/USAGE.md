# Uso, desarrollo y distribución

Esta guía cubre cómo ejecutar Browser Agent v86 POC, preparar el entorno de desarrollo, usar la VM/LLM/red y empaquetar un runtime.

## Demo online

La forma más sencilla de usar Browser Agent v86 POC es la demo publicada:

[https://browseragent.icu/](https://browseragent.icu/)

No necesitas instalar Node.js, Docker ni clonar el repositorio para probarla. La VM, el chat y los assets se sirven desde la web; los modelos Transformers.js se descargan/cachean en tu navegador. Ollama y wsnic, si los usas, siguen siendo servicios locales de tu máquina porque el navegador llama a tu propio `127.0.0.1`.

## Requisitos

Para usar un runtime ya generado basta con:

- Navegador moderno.
- WebGPU recomendado para modelos Transformers.js locales; existe alternativa WASM cuando el modelo/configuración lo permite.
- Servidor HTTP con COOP/COEP/CORP, MIME `application/wasm` y soporte `Range`.
- Conexión a Internet para la primera descarga de modelos, salvo que ya estén en caché del navegador.

Para preparar el proyecto desde el repo necesitas además:

- Node.js 18+.
- Linux/macOS.
- Docker para construir los perfiles Alpine incluidos.
- Herramientas de sistema: `tar`, `cpio`, `gzip`, `zstd`, `xz`, `curl`, `e2fsprogs`, `find`, `awk`, `grep` y `sed`.
- 1-2 GB libres para runtime v86, initramfs, perfiles y discos sparse.

En Debian/Ubuntu:

```bash
sudo apt install -y cpio gzip tar curl zstd xz-utils e2fsprogs findutils gawk grep sed
```

## Preparación local

```bash
git clone https://github.com/Len4m/browser-agent-v86-poc.git
cd browser-agent-v86-poc
npm install
npm run prepare:local
npm start
```

Abre `http://127.0.0.1:5173/`.

`npm run prepare:local` ejecuta `setup` y después `build`. La VM no arrancará correctamente hasta que existan los assets generados en `public/v86/`, `public/vendor/` y `public/assets/`.

## Primer uso

1. Pulsa **Comprobar** para validar cabeceras, assets, serial1 y runners de la VM cuando corresponda.
2. Antes de arrancar, elige perfil, RAM, VRAM y disco.
3. Pulsa **Arrancar VM** y espera a que la shell esté lista.
4. Para usar chat, abre el panel **LLM**, selecciona backend/modelo y pulsa cargar.
5. Usa las consolas xterm, el formulario manual o el chat con tools habilitadas.

Los perfiles generados aparecen desde `/v86/images/profiles/index.json`. Si no aparecen, ejecuta `npm run setup`.

## VM, perfiles y discos

Perfiles incluidos:

| Perfil | Uso | RAM recomendada |
| --- | --- | --- |
| `alpine-base` | Alpine mínimo con certificados, curl, nano y Python para el daemon xterm | 512 MB |
| `alpine-pentest-lite` | Herramientas ligeras: nmap, ffuf, Python, DNS y wordlists web pequeñas | 1024 MB |
| `alpine-pentest-web` | Pentest web ampliado: nikto, httpx, SSL Perl y wordlists | 1536 MB |

La opción **Libre / manual** usa el kernel e initramfs por defecto y permite cambiar RAM/VRAM. Al elegir un perfil generado, la UI aplica sus valores recomendados.

Discos:

- `RAM / initramfs`: el sistema vive en memoria; los cambios se pierden al apagar salvo snapshot.
- `hda 250 MB`, `hda 512 MB`, `hda 1 GB`: imágenes ext2 raw creadas por `npm run setup`.
- Los discos HDA son datos montables en `/mnt/hda`; el sistema sigue arrancando desde initramfs.
- Los snapshots guardan RAM/CPU/estado de v86, pero no incluyen cambios persistidos en discos HDA.

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

Ambos runners guest usan Python 3. Todos los perfiles en `vm/profiles/*.json` deben incluir el paquete `python3`; `npm run check` y la construcción de perfiles fallan si falta.

Después de cambiar perfiles, overlay, runners o scripts de initramfs, ejecuta:

```bash
npm run setup
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

Los modelos disponibles se declaran en `data/llm-models.json` y se regeneran con `npm run build`.
El catálogo prioriza modelos con evidencia de tool calling en `Transformers.js + AI SDK`; las entradas experimentales sirven para validación local antes de tratarlas como recomendadas.

Notas de uso:

- El chat está deshabilitado hasta que cargues un backend/modelo.
- El conmutador **Mostrar razonamiento del modelo (thinking)** del panel LLM muestra el razonamiento cuando el modelo lo declara en el catálogo. El texto de razonamiento se transmite en streaming y no se guarda como respuesta final ni se conserva en memoria.
- Los resultados de las tools se guardan como artifacts en el panel LLM: puedes previsualizarlos, adjuntarlos al siguiente mensaje o eliminarlos. El adjuntado respeta el presupuesto de contexto del modelo y se omite si no hay margen.
- La primera carga de modelos Transformers.js puede descargar ficheros grandes y quedar cacheada por el navegador.
- WebGPU es la ruta recomendada para tools con Transformers.js. El fallback WASM existe para chat básico en navegadores sin WebGPU, pero no debe considerarse una ruta fiable para tool calling; usa un navegador con WebGPU compatible u Ollama si necesitas herramientas.
- Si usas Ollama desde otro origen distinto al permitido, arranca Ollama con `OLLAMA_ORIGINS` incluyendo el origen de la página. Ejemplo: `OLLAMA_ORIGINS=http://127.0.0.1:5173`.
- En una publicación web, Ollama sigue siendo local para cada usuario: el navegador llama a su propio `127.0.0.1`.

## Red WS

La red de la VM es opcional y usa un proxy local `wsnic`. La UI muestra comandos Docker para abrir y cerrar el contenedor.

Endpoint por defecto:

```txt
ws://127.0.0.1:8086/wsnic
```

Flujo recomendado:

1. Arranca el contenedor `wsnic` con el comando de la UI.
2. Pulsa **Conectar** en el panel **Red WS**.
3. Arranca la VM o espera a que la UI configure la red si ya estaba arrancada.
4. Valida con **Comprobar** o con comandos como `curl -I https://example.com` dentro de la VM.

## Scripts

| Comando | Uso |
| --- | --- |
| `npm install` | Instala dependencias npm; no genera los assets pesados |
| `npm run prepare:local` | Ejecuta `setup` y `build` para dejar un entorno local usable |
| `npm run setup` | Descarga/copia assets base, genera initramfs, perfiles y discos |
| `npm run build` | Genera catálogo LLM, vendors, worker/bridge LLM y bundle frontend |
| `npm run build:prod` | Genera el runtime minificado para producción: JS/CSS minificados y hashes de caché |
| `npm run check` | Valida TypeScript, modelos LLM, perfiles VM, manifest frontend, sintaxis JS y servidor |
| `npm run clean` | Borra `build/` y las salidas generadas por el build en `public/` |
| `npm run clean:runtime` | Borra runtime pesado generado por `setup`: `public/vendor/` y `public/v86/` |
| `npm run clean:all` | Ejecuta la limpieza de build y runtime |
| `npm start` | Sirve `public/` con `server.mjs` en `127.0.0.1:5173` |

Regenera con `npm run setup` después de tocar:

- `vm/profiles/*.json`
- `vm/overlay/common/`
- `scripts/vm/build-alpine-initramfs.sh`
- runners seriales

Los perfiles VM deben mantener `python3` en `packages`, porque los runners seriales del guest dependen de Python 3.

Regenera con `npm run build` después de tocar:

- `src/browser/`
- `src/web/index.html`
- `src/web/styles/`
- `data/llm-models.json`
- provider AI SDK o worker LLM

## Artefactos generados

| Fuente | Salida | Regenerar |
| --- | --- | --- |
| `src/browser/`, `src/web/index.html`, `src/web/styles/` | `public/index.html`, `public/style.css`, `public/styles/`, `public/assets/app.js`, `public/assets/ai-sdk-bridge.mjs` | `npm run build` |
| `src/web/styles/` | `public/assets/app.css` | `npm run build:prod` |
| `src/browser/chat/provider/ai-sdk/`, `data/llm-models.json` | `public/assets/chat/`, `build/browser/generated/` | `npm run build` |
| `vm/profiles/*.json`, `vm/overlay/common/` | `build/profiles/`, `public/v86/images/profiles/` | `npm run setup` |
| v86, xterm, DOMPurify, streaming-markdown, BIOS y Alpine base | `public/vendor/`, `public/v86/build/`, `public/v86/bios/`, `public/v86/images/` | `npm run build` o `npm run setup` |
| Discos HDA locales | `public/v86/disks/` | `npm run setup` |

## Limpieza

Usa `npm run clean` durante el desarrollo normal. Borra `build/` y las salidas generadas por el build en `public/`: HTML/CSS generado y bundles. No borra `public/vendor/` ni `public/v86/`.

Usa `npm run clean:runtime` cuando quieras forzar una regeneración del runtime pesado: vendors, v86, BIOS, initramfs, perfiles y discos. Después ejecuta `npm run setup` o `npm run prepare:local` antes de arrancar la VM.

Usa `npm run clean:all` para limpiar ambos grupos.

## Runtime zip

El runtime estático es la carpeta `public/`. Debe contener HTML, CSS, JS generado, vendors, v86, BIOS, initramfs, perfiles y discos.

Crear zip:

```bash
npm run prepare:local
npm run check
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
- `_headers` si despliegas en una plataforma compatible como Cloudflare Pages

El servidor final debe enviar COOP/COEP/CORP y soportar `Range`. `public/_headers` documenta esas cabeceras para Cloudflare Pages, pero otros servidores necesitan configuración equivalente.

Paquete local con servidor incluido:

```bash
zip -r browser-agent-v86-poc-local-server.zip public server.mjs package.json package-lock.json
```

Uso:

```bash
unzip browser-agent-v86-poc-local-server.zip -d destino/
cd destino
npm install
npm start
```

## Problemas habituales

- **VM no arranca**: ejecuta `npm run prepare:local` y después `npm run check`.
- **No aparecen perfiles**: falta `/v86/images/profiles/index.json`; ejecuta `npm run setup`.
- **Cambiaste initramfs, runners o perfiles**: ejecuta `npm run setup` y arranca una VM nueva.
- **Disco HDA no monta**: verifica que existe `public/v86/disks/alpine-hda-*.img`; `npm run setup` los crea.
- **Tools o checks afectan a la consola visible**: valida `/dev/ttyS1`, `/dev/ttyS2` y los procesos `ba-serial1-runner` / `ba-serial2-console-runner`.
- **Una consola xterm queda desincronizada**: usa refrescar; limpia el xterm local y envía `Ctrl+L` al shell activo.
- **LLM local falla por WebGPU**: prueba un modelo WASM o reduce el modelo; algunas rutas intentan fallback WASM.
- **Ollama falla por CORS**: configura `OLLAMA_ORIGINS` con el origen exacto desde el que sirves la página.
- **Ollama no responde con el modelo elegido**: comprueba que el modelo está instalado en tu Ollama local con `ollama list` o instálalo con `ollama pull <modelo>`.
- **Red de VM sin salida**: revisa que `wsnic` esté corriendo, que la UI esté conectada y que la VM haya ejecutado la configuración de red.
