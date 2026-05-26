# Browser Agent v86 POC

[![Versión beta](https://img.shields.io/badge/version-0.9.1--beta.2-orange)](https://github.com/Len4m/browser-agent-v86-poc)

Browser Agent v86 POC ejecuta una **VM Linux x86 con v86**, un **chat con LLM desde el navegador** y herramientas de agente que pueden lanzar comandos dentro de la VM. El objetivo es experimentar con IA local, Linux, automatización y red desde una aplicación web servida como archivos estáticos.

Estado actual: **beta `0.9.1-beta.2`**. La versión `1.0.0` queda reservada para la primera publicación estable.

- Demo: [https://browseragent.icu/](https://browseragent.icu/)
- Repositorio: [https://github.com/Len4m/browser-agent-v86-poc](https://github.com/Len4m/browser-agent-v86-poc)
- Autor: Lenam [lenamgenx@protonmail.com](mailto:lenamgenx@protonmail.com) ([https://Len4m.github.io](https://Len4m.github.io))

## Que incluye

- **VM Alpine x86 en el navegador**: arranque por initramfs, perfiles generados y discos HDA opcionales como discos de datos.
- **Consolas xterm directas**: hasta 4 pestañas de usuario; la pestaña 1 usa `serial0` real y las pestañas 2-4 usan PTY propia dentro de la VM.
- **Tools de agente en background**: comandos del chat y checks por `serial1` / `/dev/ttyS1`, separados de la consola visible.
- **Transporte de consola dedicado**: multiplexado xterm/PTY por `serial2` / `/dev/ttyS2` para las pestañas 2-4.
- **LLM en navegador u Ollama local**: Transformers.js con WebGPU/WASM y provider Ollama HTTP opcional.
- **Red opcional vía wsnic**: proxy WebSocket local para dar salida de red a la VM.

## Probar la demo online

La forma más rápida de probar el proyecto es abrir:

[https://browseragent.icu/](https://browseragent.icu/)

La demo no requiere clonar el repo. Los modelos locales se descargan y ejecutan desde tu navegador, y los servicios opcionales como Ollama o wsnic siguen siendo locales a tu equipo.

## Ejecutar desde el repo

Requisitos principales: Node.js 18+, Linux/macOS, Docker, herramientas de sistema para generar initramfs/discos y conexión a Internet para descargar assets base, paquetes Alpine y modelos.

```bash
git clone https://github.com/Len4m/browser-agent-v86-poc.git
cd browser-agent-v86-poc
npm install
npm run prepare:local
npm start
```

Abre `http://127.0.0.1:5173/`.

Primer uso recomendado:

1. Pulsa **Comprobar**.
2. Elige perfil, RAM, VRAM y disco antes de arrancar.
3. Pulsa **Arrancar VM**.
4. Carga un modelo en el panel **LLM** si vas a usar el chat.
5. Usa la consola, el formulario manual o el chat.

El detalle de requisitos, scripts, empaquetado y solución de problemas está en [docs/USAGE.md](docs/USAGE.md).

## Ejecutar un runtime ya generado

Si ya tienes un zip de `public/` con los assets generados, no necesitas Node.js ni Docker para usar la aplicación. Sirve esa carpeta con un servidor HTTP que envie:

- COOP/COEP/CORP para `SharedArrayBuffer`.
- MIME correcto para `.wasm`.
- Soporte `Range` para assets grandes.

No abras `index.html` como `file://`. `npm start` ya sirve `public/` con las cabeceras necesarias.

## Estructura principal

```txt
public/             # raíz servida al navegador
src/                # código TypeScript de aplicación, VM, consola y chat
scripts/            # setup, build, checks y generacion de assets
vm/profiles/        # perfiles Alpine de VM
vm/overlay/common/  # runners y ficheros incluidos en el initramfs
docs/USAGE.md       # uso, desarrollo, distribución y troubleshooting
docs/ARCHITECTURE.md # arquitectura y contratos internos
```

## Documentación

- [docs/USAGE.md](docs/USAGE.md): instalación local, uso de VM/LLM/wsnic, scripts, runtime zip y problemas habituales.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): arquitectura frontend, build, VM, seriales, LLM y reglas de mantenimiento.

## Licencia

MIT. Consulta [LICENSE](LICENSE).
