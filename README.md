# Browser Agent v86 POC

Browser Agent v86 explora una idea simple y potente: ejecutar una **VM Linux x86**, un **chat con LLM local** y un conjunto de **herramientas de agente** directamente desde el navegador. Es un laboratorio web para experimentar con IA local, sistemas Linux, automatización y redes sin instalar una plataforma pesada.

El proyecto está en **beta** (`0.9.0-beta.1`). La version `1.0.0` queda reservada para la primera publicacion estable.

Autor y contacto: Lenam [lenam@protonmail.com](mailto:lenam@protonmail.com) ([https://Len4m.github.io](https://Len4m.github.io)).   
Repositorio: [https://github.com/Len4m/browser-agent-v86-poc](https://github.com/Len4m/browser-agent-v86-poc).

## Requisitos para ejecutar un runtime ya generado

- Navegador reciente.
- WebGPU recomendado para el LLM local.
- Servidor HTTP con COOP/COEP, MIME correcto para `.wasm` y soporte `Range`.
- Conexión a Internet para la primera descarga de modelos locales, salvo que ya estén cacheados por el navegador.

No necesitas Node.js, Docker ni herramientas de build si ya tienes el zip runtime de `public/` y lo sirves con un servidor adecuado.

## Requisitos para preparar o desarrollar

- Node.js 18+
- Linux/macOS para `npm run setup` (construcción de initramfs Alpine)
- Docker para `npm run prepare:local` / `npm run setup` con los perfiles incluidos
- Herramientas de sistema para el build VM: `tar`, `cpio`, `gzip`, `zstd`, `curl`, `e2fsprogs` (Debian: `sudo apt install -y cpio gzip tar curl zstd e2fsprogs findutils`)
- Conexión a Internet para descargar assets base, paquetes Alpine y modelos locales
- ~1–2 GB libres tras `npm run setup` (v86, initramfs, discos sparse)

## Uso rapido (desarrollo)

```bash
git clone https://github.com/Len4m/browser-agent-v86-poc.git
cd browser-agent-v86-poc
npm install            # instala dependencias
npm run prepare:local  # primera vez: setup VM + build frontend/LLM/assets
npm start              # http://127.0.0.1:5173
npm run check          # opcional: TypeScript, manifest, sintaxis y headers/range
```

1. Carga un modelo en el panel **LLM** (Transformers.js).
2. Pulsa **Comprobar** y luego **Arrancar VM**.
3. Usa el chat o el formulario de comando manual.

Para mas detalle: [docs/USAGE.md](docs/USAGE.md).

## Que se versiona y que se genera


| Fuente                                              | Generado                                                                                                                    | Cómo regenerar                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `src/`, `public/index.html`, `public/styles/`       | `public/assets/app.js`, `public/assets/ai-sdk-bridge.mjs`                                                                   | `npm run build`                   |
| `src/chat/provider/ai-sdk/`, `data/llm-models.json` | `public/assets/chat/ai-sdk-browser.mjs`, `public/assets/chat/workers/`, `build/browser/generated/10a-llm-models-catalog.js` | `npm run build`                   |
| `vm/profiles/*.json`, `vm/overlay/common/`           | `build/profiles/`, `public/v86/images/profiles/`                                                                            | `npm run setup`                   |
| Dependencias npm y assets remotos base              | `public/vendor/`, `public/v86/build/`, `public/v86/bios/`, `public/v86/images/`                                             | `npm run build` / `npm run setup` |
| Discos v86 locales                                  | `public/v86/disks/`                                                                                                         | `npm run setup`                   |


Tras clonar el repo hace falta `npm install` y `npm run prepare:local`. La VM no arranca hasta que existan los assets de `setup`.

## Scripts npm


| Script                  | Descripción                                                          |
| ----------------------- | -------------------------------------------------------------------- |
| `npm install`           | Instala deps; no ejecuta builds ni descargas pesadas                 |
| `npm run prepare:local` | Prepara todo para uso local: VM, perfiles, discos, bundles y assets  |
| `npm run setup`         | Prepara initramfs, perfiles VM y discos locales                      |
| `npm run build`         | Genera bundle frontend, bundle LLM, catálogo de modelos y assets npm |
| `npm run check`         | Valida TypeScript, manifest, sintaxis JS y servidor local            |
| `npm run clean`         | Limpia bundles/artefactos generados no versionados                   |
| `npm start`             | Servidor estático con COOP/COEP (`server.mjs`)                       |


## Perfiles VM

- `alpine-base` — uso general
- `alpine-pentest-lite` — herramientas de red ligeras
- `alpine-pentest-web` — pentest web ampliado

Metadatos servidos desde `/v86/images/profiles/*.json` y escritos en `public/v86/images/profiles/`. Tras cambiar runners seriales, perfiles o paquetes del initramfs: `npm run setup`.

## Red WebSocket (opcional)

Proxy local **wsnic** (Docker), puerto por defecto en la UI:

```txt
ws://127.0.0.1:8086/wsnic
```

La UI incluye el comando Docker para arrancar/parar el contenedor.

## Estructura principal

```txt
browser-agent-v86-poc/
├── public/             # única raíz servida al navegador
│   ├── index.html      # shell estático; carga assets/app.js
│   ├── style.css       # importa styles/*
│   ├── styles/
│   ├── assets/         # iconos locales, app.js y bundles LLM generados
│   ├── v86/            # runtime v86 + imágenes VM (generado)
│   └── vendor/         # librerías servidas al navegador (generado)
├── src/
│   ├── app/            # estado, bootstrap y utilidades compartidas
│   ├── vm/             # v86, perfiles, serial, discos, red y snapshots
│   ├── console/        # pestañas tmux y control de consola
│   ├── ui/             # modales, checks, badges y tooltips
│   └── chat/           # LLM, panel, tools, artifacts y provider AI SDK
├── server.mjs
├── scripts/            # build Alpine / v86
├── vm/
│   ├── profiles/       # JSON de perfiles VM
│   └── overlay/        # overlay común del rootfs Alpine
└── docs/
    ├── USAGE.md        # uso, desarrollo, zip y troubleshooting
    └── ARCHITECTURE.md
```

## Tools del agente (serial1)

Las tools del LLM y los checks de VM usan `execVm` → **serial1** (`src/vm/background-tools-serial1.ts`), no la consola tmux visible.

- Fuente del runner en la VM: `vm/overlay/common/usr/local/bin/ba-serial1-runner`
- Control de consola tmux por `serial2`: `vm/overlay/common/usr/local/bin/ba-serial2-console-runner`
- Detalles operativos: [docs/USAGE.md](docs/USAGE.md)

## LLM local

- Motor: **Transformers.js** en el navegador (worker en `public/assets/chat/workers/`, generado con `npm run build`)
- Catálogo de tools: `src/chat/tools/tool-registry.ts` (por perfil VM)
- El chat requiere modelo cargado
- El servidor debe enviar los headers **COOP/COEP** (`npm start`); si no están presentes, los discos serán muy lentos porque no se podrá utilizar la función `SharedArrayBuffer`, y además el LLM/WASM puede no funcionar correctamente.

## Despliegue / distribucion

Ver [docs/USAGE.md](docs/USAGE.md):

- **Zip runtime**: es la carpeta `public/` con assets ya generados; no requiere `npm run setup`.
- **Paquete local con servidor**: añade `server.mjs`, `package.json` y `package-lock.json` para poder usar `npm start`.
- **Clone del repo**: requiere `npm install` + `npm run prepare:local` antes de usar la VM.

## Documentación

- Uso, desarrollo, zip y troubleshooting: [docs/USAGE.md](docs/USAGE.md)
- Arquitectura frontend: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Licencia

MIT. Consulta [LICENSE](LICENSE).
