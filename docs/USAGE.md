# Uso, desarrollo y distribucion

Esta guia resume lo necesario para ejecutar, desarrollar y empaquetar Browser Agent v86 POC.

## Requisitos para ejecutar un runtime ya generado

- Navegador moderno.
- WebGPU recomendado para modelos locales.
- Servidor HTTP con COOP/COEP, MIME correcto para `.wasm` y soporte `Range`.
- Conexion a Internet para la primera descarga de modelos locales, salvo que ya esten cacheados por el navegador.

No necesitas Node.js, Docker ni herramientas de sistema si ya tienes el zip runtime de `public/` y lo sirves con un servidor adecuado.

## Requisitos para preparar o desarrollar

- Node.js 18+
- Linux/macOS para construir initramfs Alpine.
- Herramientas de sistema: `tar`, `cpio`, `gzip`, `zstd`, `curl`, `e2fsprogs`, `findutils`.
- Docker para `npm run prepare:local` / `npm run setup` con los perfiles incluidos.
- Conexion a Internet para descargar assets base, paquetes Alpine y modelos locales.
- 1-2 GB libres para runtime v86, initramfs, perfiles y discos sparse.

En Debian/Ubuntu:

```bash
sudo apt install -y cpio gzip tar curl zstd e2fsprogs findutils
```

## Preparacion local desde el repo

```bash
git clone https://github.com/Len4m/browser-agent-v86-poc.git
cd browser-agent-v86-poc
npm install
npm run prepare:local
npm start
```

Abre `http://127.0.0.1:5173/`.

Primer uso:

1. Pulsa `Comprobar`.
2. Arranca la VM.
3. Carga un modelo en el panel LLM si vas a usar el chat.
4. Usa la consola tmux, el formulario manual o el chat.

## Scripts

| Comando | Uso |
| --- | --- |
| `npm run prepare:local` | Preparacion completa: setup VM + build frontend/LLM/assets |
| `npm run setup` | Regenera initramfs, perfiles VM y discos |
| `npm run build` | Regenera frontend, catalogo LLM, vendors y workers |
| `npm run check` | Valida TypeScript, manifest, sintaxis JS y servidor |
| `npm start` | Sirve la app con headers COOP/COEP |

Usa `npm run setup` despues de tocar `vm/profiles/`, `vm/overlay/common/`, runners seriales o `scripts/build-alpine-initramfs.sh`.

Usa `npm run build` despues de tocar `src/`, `public/index.html`, `public/styles/` o `data/llm-models.json`.

## Que se genera

| Fuente | Salida | Regenerar |
| --- | --- | --- |
| `src/`, `public/index.html`, `public/styles/` | `public/assets/app.js`, `public/assets/ai-sdk-bridge.mjs` | `npm run build` |
| `src/chat/provider/`, `data/llm-models.json` | `public/assets/chat/`, `build/browser/generated/` | `npm run build` |
| `vm/profiles/*.json`, `vm/overlay/common/` | `build/profiles/`, `public/v86/images/profiles/` | `npm run setup` |
| Runtime v86, BIOS, vendor y Alpine base | `public/vendor/`, `public/v86/` | `npm run build` o `npm run setup` |
| Discos HDA locales | `public/v86/disks/` | `npm run setup` |

## VM, consola y tools

- `serial0` / `/dev/ttyS0`: consola tmux visible del usuario.
- `serial1` / `/dev/ttyS1`: tools del agente y checks en background.
- `serial2` / `/dev/ttyS2`: control de consolas tmux desde la UI.

Los runners se instalan dentro del initramfs desde:

- `vm/overlay/common/usr/local/bin/ba-serial1-runner`
- `vm/overlay/common/usr/local/bin/ba-serial2-console-runner`

Tras cambiar cualquiera de esos ficheros, ejecuta `npm run setup` y reinicia la VM.

Validacion rapida dentro de la VM:

```sh
ls -l /dev/ttyS*
ps | grep '[b]a-serial1-runner'
ps | grep '[b]a-serial2-console-runner'
```

Desde la UI, `Comprobar` debe validar serial1, runner serial1 y los checks de VM. Una tool lenta debe mostrar salida en `Tools background` mientras la consola visible sigue aceptando comandos.

## Zip runtime

El zip runtime de la aplicacion debe ser la carpeta `public/`. Esa carpeta es la unica raiz servida al navegador y contiene HTML, CSS, JS generado, vendors, v86, perfiles, initramfs y discos.

Crear zip runtime estatico:

```bash
npm run prepare:local
npm run check
cd public
zip -r ../browser-agent-v86-poc-runtime-public.zip .
```

Contenido minimo dentro de `public/`:

- `index.html`, `style.css`, `styles/`
- `assets/`
- `vendor/`
- `v86/build/`
- `v86/bios/`
- `v86/images/`
- `v86/disks/`

Para usar ese zip necesitas servirlo con un servidor que envie COOP/COEP, MIME correcto para `.wasm` y soporte `Range` para assets grandes.

Si quieres un paquete local que incluya el servidor de desarrollo, crea otro zip con `public/`, `server.mjs`, `package.json` y `package-lock.json`:

```bash
zip -r browser-agent-v86-poc-local-server.zip public server.mjs package.json package-lock.json
```

Uso del paquete local con servidor:

```bash
unzip browser-agent-v86-poc-local-server.zip -d destino/
cd destino
npm install
npm start
```

## Servidor y publicacion

Usa `npm start` o un servidor equivalente que envie COOP/COEP. No abras `index.html` como `file://` ni uses `python3 -m http.server` para VM con discos, porque faltan headers para `SharedArrayBuffer`.

Para una publicacion web, documenta que Ollama y wsnic son servicios locales externos: el navegador del usuario llama a su propio `127.0.0.1`, no al servidor publicado.

El proyecto esta preparado como beta `0.9.0-beta.1`. La version `1.0.0` queda reservada para la primera publicacion estable.

Licencia: MIT. Autor y contacto: Lenam <lenam@protonmail.com> (https://Len4m.github.io). Repositorio: https://github.com/Len4m/browser-agent-v86-poc.

## Problemas habituales

- VM no arranca: ejecuta `npm run prepare:local`, luego `npm run check`.
- Cambiaste initramfs/runners/perfiles: ejecuta `npm run setup` y arranca una VM nueva.
- tmux muestra restos visuales: usa el boton de refresco; al cambiar a una consola con paneles la UI usa `select-redraw` por serial2.
- Tools o checks afectan a la consola visible: comprueba `/dev/ttyS1`, `/dev/ttyS2` y los procesos `ba-serial1-runner` / `ba-serial2-console-runner`.
- Ollama falla desde el navegador: revisa `OLLAMA_ORIGINS` para permitir el origen de `npm start`.
