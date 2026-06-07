# Browser Agent v86 POC

[![Versión beta](https://img.shields.io/badge/version-0.9.6--beta.0-orange)](https://github.com/Len4m/browser-agent-v86-poc)

Browser Agent v86 POC ejecuta una **VM Linux x86 con v86**, un **chat con LLM desde el navegador** y herramientas de agente que pueden lanzar comandos dentro de la VM. El objetivo es experimentar con IA local, Linux, automatización y red desde una aplicación web servida como archivos estáticos.

Estado actual: **beta `0.9.6-beta.0`**. La versión `1.0.0` queda reservada para la primera publicación estable.

- Demo: [https://browseragent.icu/](https://browseragent.icu/)
- Repositorio: [https://github.com/Len4m/browser-agent-v86-poc](https://github.com/Len4m/browser-agent-v86-poc)
- Autor: Lenam [lenamgenx@protonmail.com](mailto:lenamgenx@protonmail.com) ([https://Len4m.github.io](https://Len4m.github.io))

> **English**: the web UI is available in English (auto-selected for non-Spanish browsers; switch anytime from the header). For end-user help, see [docs/USER_MANUAL.en.md](docs/USER_MANUAL.en.md). Developer and repo docs (`USAGE`, `ARCHITECTURE`, this README) are in Spanish only for now — see [Documentation](#documentación) below.

## Qué incluye

- **VM Alpine x86 en el navegador**: arranque por initramfs, perfiles generados y discos HDA opcionales como discos de datos.
- **Consolas xterm directas**: hasta 4 pestañas de usuario; la pestaña 1 usa `serial0` real y las pestañas 2-4 usan PTY propia dentro de la VM.
- **Tools de agente en background**: comandos del chat y checks por `serial1` / `/dev/ttyS1`, separados de la consola visible.
- **Transporte de consola dedicado**: multiplexado xterm/PTY por `serial2` / `/dev/ttyS2` para las pestañas 2-4.
- **Runners guest en Python 3**: los perfiles VM incluyen `python3` como dependencia base del overlay serial.
- **LLM en navegador u Ollama local**: Transformers.js con WebGPU/WASM y provider Ollama HTTP opcional, con visualización opcional del razonamiento (thinking) configurable por modelo.
- **Red opcional vía wsnic**: proxy WebSocket local para dar salida de red a la VM.
- **UI bilingüe ES/EN**: selector de idioma en la cabecera con cambio en caliente (sin recargar ni perder la VM); por defecto español, e inglés automático en navegadores no españoles.

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

1. Selecciona el perfil de VM.
2. Pulsa **Arrancar VM** y espera a que aparezca la shell; la primera vez puede descargar assets grandes.
3. Si el navegador acepta WebGPU, carga un modelo Transformers.js u Ollama desde el panel **LLM**. Con solo WASM, para agente/tools suele ser mejor usar Ollama o probar otro navegador/equipo con WebGPU.
4. Usa el chat para pedir acciones dentro de la VM, o las consolas para comprobar y ejecutar manualmente.
5. Si necesitas red en la VM, configura wsnic desde **Red WS**.

Puedes pulsar **Comprobar** en cualquier momento para revisar el estado de la app, VM, assets, red y tools.

El detalle de requisitos, scripts, empaquetado y solución de problemas está en [docs/USAGE.md](docs/USAGE.md).

## Ejecutar un runtime ya generado

Si ya tienes un zip de `public/` con los assets generados, no necesitas Node.js ni Docker para usar la aplicación. Sirve esa carpeta con un servidor HTTP que envíe:

- COOP/COEP/CORP para `SharedArrayBuffer`.
- MIME correcto para `.wasm`.
- Soporte `Range` para assets grandes.

No abras `index.html` como `file://`. `npm start` ya sirve `public/` con las cabeceras necesarias.

## Estructura principal

```txt
public/             # raíz servida al navegador; contiene salidas generadas y assets estáticos
src/browser/        # código TypeScript del frontend
src/web/            # plantilla HTML y CSS fuente
scripts/            # scripts principales y pasos internos de build/setup/check/clean
vm/profiles/        # perfiles Alpine de VM
vm/overlay/common/  # runners y ficheros incluidos en el initramfs
docs/USER_MANUAL.es.md  # manual de uso (usuarios finales), español
docs/USER_MANUAL.en.md  # user manual (end users), English
docs/USAGE.md           # uso, desarrollo, distribución y troubleshooting (español)
docs/ARCHITECTURE.md    # arquitectura y contratos internos (español)
```

## Documentación

| Documento | Idioma | Contenido |
| --- | --- | --- |
| [README.md](README.md) | ES | Entrada al repositorio (este fichero). |
| [docs/USER_MANUAL.es.md](docs/USER_MANUAL.es.md) | ES | Manual de uso de la aplicación (VM, chat, paneles); sin instalación ni desarrollo. |
| [docs/USER_MANUAL.en.md](docs/USER_MANUAL.en.md) | EN | User manual for application usage (VM, chat, panels); does not cover installation or development. |
| [docs/USAGE.md](docs/USAGE.md) | ES | Instalación local, VM/LLM/wsnic, scripts, runtime zip y problemas habituales. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | ES | Arquitectura frontend, build, VM, seriales, LLM y reglas de mantenimiento. |

Los manuales de usuario enlazan entre sí por idioma. Para contribuir o desplegar el proyecto, usa `USAGE` y `ARCHITECTURE`.

## Licencia

El código propio de Browser Agent v86 POC se publica bajo licencia MIT. Consulta [LICENSE](LICENSE).

El runtime incluye o descarga componentes de terceros con sus propias licencias. Hay un resumen en [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).

Dependencias principales de terceros:

- v86: BSD-2-Clause.
- `@browser-ai/transformers-js`, `@huggingface/transformers` y AI SDK (`ai`): Apache-2.0.
- Los perfiles Alpine generados pueden contener paquetes con licencias GPL, LGPL y otras licencias por paquete. Al redistribuir initramfs, imagenes o perfiles generados hay que conservar los avisos correspondientes y cumplir sus obligaciones.
- Los modelos LLM descargados por el usuario desde Hugging Face, Ollama u otros origenes mantienen sus propias licencias y no pasan a estar cubiertos por la licencia MIT de este repositorio.
