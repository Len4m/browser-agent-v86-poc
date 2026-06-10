# Browser Agent v86 - Arquitectura

La aplicación es un frontend **TypeScript + ESM + esbuild** servido desde `public/`. El navegador carga `public/index.html`, vendors globales mínimos, el bridge ESM del AI SDK y el bundle principal `public/assets/app.js`.

La VM corre con **v86** y Alpine x86. La capa LLM usa **AI SDK v6** con backends Transformers.js y Ollama. Las tools del agente se ejecutan dentro de la VM por un canal serial separado de la consola visible.

## Vista general

```mermaid
flowchart LR
  subgraph Browser["Navegador"]
    UI["UI<br/>public/index.html + app.js"]
    Xterm["⌨️ xterm.js<br/>hasta 4 pestañas"]
    Chat["💬 Chat LLM"]
    Bridge["AI SDK bridge<br/>assets/ai-sdk-bridge.mjs"]
    AiBundle["AI SDK bundle<br/>assets/chat/ai-sdk-browser.mjs"]
    Worker["Transformers.js worker"]
    V86["🖥️ v86 emulator"]

    subgraph VM["🐧 VM Alpine x86"]
      PTY["PTYs de usuario 2-4<br/>/bin/sh, nano, top..."]
      S1["ba-serial1-runner<br/>tools/checks"]
      S2["ba-serial2-console-runner<br/>daemon xterm/PTY"]
      Tools["Comandos Alpine"]
    end
  end

  subgraph Local["🏠 Servicios locales opcionales"]
    Ollama["🦙 Ollama<br/>127.0.0.1:11434"]
    Wsnic["wsnic<br/>127.0.0.1:8086"]
  end

  UI --> Chat
  UI --> Xterm
  UI --> V86
  Chat --> Bridge
  Bridge --> AiBundle
  AiBundle --> Worker
  Bridge --> Ollama
  Chat -->|"execVm / tools"| V86
  Xterm <-->|"serial0 / ttyS0<br/>arranque real"| V86
  Xterm <-->|"serial2 / ttyS2<br/>frames base64"| V86
  V86 -->|"ttyS1"| S1
  S1 --> Tools
  V86 -->|"ttyS2"| S2
  S2 <-->|"openpty/select"| PTY
  V86 <-->|"red WS opcional"| Wsnic
```

## Raíz servida

`public/` es la única raíz HTTP. El HTML/CSS editable vive fuera y se regenera con `npm run build`:

- `src/web/index.html`: plantilla fuente del shell de UI.
- `src/web/styles/style.css`: entry CSS fuente; importa `src/web/styles/*.css`.
- `public/index.html`: shell generado con hashes de caché.
- `public/style.css` y `public/styles/`: CSS generado/copiado para desarrollo.
- `public/assets/app.css`: CSS bundle minificado generado por `npm run build:prod`.
- `public/assets/app.js`: bundle principal generado.
- `public/assets/ai-sdk-bridge.mjs`: bridge ESM generado.
- `public/assets/chat/`: bundle AI SDK y worker LLM generados.
- `public/vendor/`: librerías copiadas desde npm.
- `public/v86/`: runtime v86, BIOS, kernel, initramfs, perfiles y discos.
- `public/_headers`: cabeceras para despliegues estáticos compatibles.

`server.mjs` solo sirve `public/` y añade COOP/COEP/CORP, MIME para `.wasm`, caché por tipo y `Range`.

## Build frontend

`scripts/build/frontend.mjs` genera:

- `public/index.html`
- `public/style.css`
- `public/styles/`
- `public/assets/app.js`
- `public/assets/ai-sdk-bridge.mjs`
- `public/assets/app.css` cuando se ejecuta con `--minify` o `BA_MINIFY=1`
- `public/locales/es.json` y `public/locales/en.json`

El entry `src/browser/main.ts` instala `window.BA` desde `src/browser/compat/window-api.ts`. Después el script concatena fuentes TypeScript en el orden `browserSourceOrder`. Este orden mantiene contratos globales históricos mientras los módulos se migran por dominio.

Regla: si cambia el orden de inicialización del browser, se modifica solo `browserSourceOrder` en `scripts/build/frontend.mjs`.

## i18n

Toda la copy de UI vive en catálogos JSON (`src/web/locales/*.json`) y el código solo referencia claves vía `t()`/`tn()` (`src/browser/app/i18n.ts`).

- Idiomas soportados: `es` (base) y `en`. Para mantener memoria baja, solo se carga un catálogo a la vez en `public/locales/`.
- Selección: idioma guardado en `localStorage` (`ba.lang`); si no hay, navegador en español → `es`, en otro caso → `en`. El selector de cabecera (`src/browser/app/lang-selector.ts`) cambia el idioma en caliente sin recargar.
- `npm run check` ejecuta `scripts/check/i18n.mjs` para garantizar paridad de claves entre `es.json` y `en.json`. La paridad de claves no valida la calidad del texto; las cadenas nuevas deben añadirse en ambos catálogos.

## Build de la app

`scripts/build.mjs` ejecuta, en orden:

1. `scripts/build/llm-model-catalog.mjs`
2. `scripts/build/llm-browser-bundles.mjs`
3. `scripts/build/frontend.mjs`

`npm run build` presupone que `npm run setup` ya ha preparado los assets base de runtime que el HTML versiona, como xterm y el perfil Alpine base.

Salidas LLM:

- `build/browser/generated/10a-llm-models-catalog.js`, generado desde `data/llm-models.json`.
- `public/assets/chat/ai-sdk-browser.mjs`, generado desde `src/browser/chat/provider/ai-sdk/entry.ts`.
- `public/assets/chat/workers/llm-browser-ai.worker.mjs`, generado desde `src/browser/chat/provider/ai-sdk/llm-browser-ai.worker.ts`.
- `public/assets/ai-sdk-bridge.mjs`, generado desde `src/browser/chat/provider/ai-sdk-bridge.ts`.

El bridge importa el bundle generado con query versionada y expone `window.BA_AISDK`.

## Assets de runtime

Las librerías de runtime deben estar declaradas en `package.json` y copiarse desde `node_modules` con `scripts/setup/runtime-assets.mjs`:

| Dependencia | Salida |
| --- | --- |
| `v86` | `public/v86/build/libv86.js`, `public/v86/build/v86.wasm` |
| `@xterm/xterm` | `public/vendor/xterm/xterm.js`, `public/vendor/xterm/xterm.css` |
| `dompurify` | `public/vendor/llm/dompurify/purify.es.mjs` |
| `streaming-markdown` | `public/vendor/llm/streaming-markdown/smd.js` |

Solo se descargan remotamente los assets que no son librerías npm del runtime: BIOS de v86 y minirootfs Alpine. No añadir librerías nuevas directamente en `public/vendor/`; declararlas en npm y copiarlas o bundlearlas desde scripts.

## Dominios de código

`src/` separa el código ejecutable de las fuentes estáticas:

- `src/browser/`: TypeScript del frontend que acaba en bundles JavaScript.
- `src/web/`: plantilla HTML y CSS fuente que se generan hacia `public/`.

Dentro de `src/browser/`, el TypeScript se organiza por dominio:

| Ruta | Responsabilidad |
| --- | --- |
| `src/browser/app/` | Estado global, bootstrap, helpers de texto y avisos de origen |
| `src/browser/vm/` | v86, perfiles, assets, seriales, red, discos, snapshots y operaciones VM |
| `src/browser/console/` | Pestañas xterm, sesiones PTY, cierre y refresco |
| `src/browser/ui/` | Estado visual, modales, checks y tooltips |
| `src/browser/chat/state/` | Estado LLM, modelos y capacidades |
| `src/browser/chat/panel/` | Panel LLM, controles y vista de capacidades |
| `src/browser/chat/runtime/` | Agent loop, UI de chat, routing, artifacts, contexto y recursos |
| `src/browser/chat/tools/` | Registry de tools, políticas y ejecutor |
| `src/browser/chat/provider/` | Bridge AI SDK, provider Ollama, Transformers.js worker y parser/middleware de tool calls |
| `src/browser/compat/` | API pública `window.BA` |
| `src/browser/core/` | Eventos compartidos |

## Globals y API pública

La aplicación aún expone varios `window.BA_*` porque el bundle principal conserva dependencias globales ordenadas. El punto de compatibilidad público es `window.BA`, instalado por `src/browser/compat/window-api.ts`.

Globals principales:

- `window.BA`: versión, origen y eventos públicos.
- `window.BA_TEXT_UTILS`: helpers de texto y shell.
- `window.BA_BG_TOOLS`: ejecución por `serial1`.
- `window.BA_CONSOLE_CONTROL`: control xterm/PTY por `serial2`.
- `window.BA_AISDK`: bridge/provider LLM.
- `window.BA_LLM_*`: estado, UI, tools, artifacts, contexto y recursos del chat.

Regla: los módulos TypeScript nuevos deben vivir en `src/browser/` y exponer globals solo cuando haya consumidores reales.

## Seriales y ejecución VM

```txt
Usuario / LLM
  -> execVm() [src/browser/vm/operations.ts]
    -> targetTools=true (por defecto)
      -> window.BA_BG_TOOLS.execVm()
      -> serial1 / ttyS1
      -> ba-serial1-runner
    -> targetTools=false
      -> serial0 / ttyS0 con marcadores __BAGENT_*
```

Contratos actuales:

- `serial0` / `/dev/ttyS0`: arranque, login base y pestaña 1 de usuario.
- `serial1` / `/dev/ttyS1`: tools del LLM, checks, formulario manual y operaciones internas que no deben ensuciar la consola visible.
- `serial2` / `/dev/ttyS2`: daemon xterm/PTY. Multiplexa las pestañas 2-4 como PTYs reales hacia xterm.js con frames base64.
- No hay fallback silencioso de `serial1` a `serial0` en `execVm(targetTools=true)`.
- Cancelación: el browser envía `__BA_S1_CANCEL:<id>` por `serial1` para abortar el job en curso en `ba-serial1-runner` (timeout, reset o cancelación de usuario).

Fuentes de runners:

- `vm/overlay/common/usr/local/bin/ba-serial1-runner`
- `vm/overlay/common/usr/local/bin/ba-serial2-console-runner`

Ambos runners guest están escritos en Python 3 y son procesos persistentes supervisados por el initramfs. Por tanto, `python3` es dependencia obligatoria de todos los perfiles VM; `npm run check` y `scripts/setup/vm-profile-image.mjs` lo validan.

## VM e imágenes

`scripts/setup.mjs` ejecuta:

1. `scripts/check/vm-profiles.mjs`
2. `scripts/setup/runtime-assets.mjs`
3. `scripts/setup/vm-alpine-initramfs.sh`
4. `scripts/setup/vm-profile-image.mjs vm/profiles/*.json` para cada perfil válido, en orden de nombre de fichero
5. `scripts/setup/vm-hda-data-disks.sh`

El listado de perfiles se descubre desde `vm/profiles/*.json`, excluyendo `profile.schema.json`. Si algún perfil no pasa el schema, `setup` se detiene antes de generar imágenes.

`scripts/setup/vm-profile-image.mjs` genera manifests en `public/v86/images/profiles/` y mantiene `index.json`. Los perfiles usan initramfs; los discos HDA creados por `scripts/setup/vm-hda-data-disks.sh` son imágenes ext2 raw para datos.

Los runners seriales se instalan desde `vm/overlay/common/usr/local/bin/`. Tras cambiar overlay, perfiles, runners o build de Alpine, ejecutar `npm run setup`.

## Capa LLM

Flujo de un turno:

```txt
sendChat()
  -> window.BA_LLM_AGENT.handleUserMessage()
  -> window.BA_buildAiSdkTools()
  -> window.BA_AISDK.runAgentStreamTurn()
    -> streamText()
    -> stopWhen(stepCountIs(maxSteps))
    -> prepareStep()
  -> tool.execute()
  -> window.BA_LLM_TOOL_EXECUTOR.runTool()
  -> execVm()
  -> serial1 / ba-serial1-runner
  -> artifacts + respuesta de chat
```

Detalles importantes:

- `prepareStep` oculta tools devolviendo `tools: {}` cuando el turno no necesita VM o cuando el paso posterior debe sintetizar en prosa.
- En el primer paso con tools, `prepareStep` puede restringir `activeTools` al subconjunto permitido.
- El runner usa el loop de AI SDK (`streamText` + `stopWhen(stepCountIs)`), pero contiene una síntesis de respaldo si hubo tool work y la respuesta textual falta, parece un plan de tool o falla el paso de síntesis del SDK.
- El middleware de Transformers.js elimina `toolChoice` para compatibilidad con ese backend.
- El razonamiento (thinking) se configura por modelo en `data/llm-models.json` (campo `thinking`: `enabled`, `tagName`, `startWithReasoning`). En Transformers.js se extrae con `extractReasoningMiddleware` según el `tagName`; en chat se muestra con el conmutador del panel LLM. Se transmite en streaming y no se conserva en memoria ni como respuesta final.
- Ollama se llama desde el navegador, no desde la VM. El endpoint por defecto es `http://127.0.0.1:11434`.

Archivos clave:

| Archivo | Responsabilidad |
| --- | --- |
| `src/browser/chat/provider/ai-sdk-bridge.ts` | Crea/carga modelos, fallback WebGPU->WASM, Ollama y `window.BA_AISDK` |
| `src/browser/chat/provider/ai-sdk/browser-agent-runner.ts` | Turno AI SDK, steps, streaming y síntesis de respaldo |
| `src/browser/chat/provider/ai-sdk/ollama-browser-model.ts` | Provider Ollama HTTP browser |
| `src/browser/chat/provider/ai-sdk/llm-browser-ai.worker.ts` | Worker Transformers.js |
| `src/browser/chat/tools/ai-tools.ts` | Adaptador registry -> `tool()` del AI SDK |
| `src/browser/chat/tools/tool-executor.ts` | Ejecuta tools vía `execVm` y publica eventos |
| `src/browser/chat/tools/tool-registry.ts` | Catálogo único de tools por contexto/perfil |
| `src/browser/chat/runtime/context-budget.ts` | Presupuesto de contexto y tokens |
| `src/browser/chat/runtime/artifact-store.ts` | Persistencia compacta de resultados de tools |
| `src/browser/chat/rendering/markdown-renderer.ts` | Markdown streaming sin React |

## Checks

`npm run check` ejecuta:

- `tsc --noEmit`
- `scripts/check.mjs`

`scripts/check.mjs` ejecuta:

- `scripts/check/llm-models.mjs`
- `scripts/check/vm-profiles.mjs`
- `scripts/check/frontend-manifest.mjs`
- `scripts/check/js-syntax.mjs`
- `scripts/check/i18n.mjs`
- `scripts/check/server.mjs`

`check-server` arranca `server.mjs` en `127.0.0.1:5199` y valida COOP, COEP, CORP y `Range`.

## Limpieza

`npm run clean` borra `build/` y las salidas generadas por el build en `public/`: `index.html`, CSS, `styles/`, `locales/` (desde `src/web/`), bundles y `assets/chat/`. No borra `public/vendor/` ni `public/v86/`, ni estáticos versionados (`favicon.ico`, iconos, `robots.txt`, etc.).

`npm run clean:runtime` borra el runtime pesado generado por `setup`: `public/vendor/` y `public/v86/`. Después hay que ejecutar `npm run setup` o `npm run prepare:local` antes de arrancar la VM.

`npm run clean:all` combina ambos alcances.

## Reglas de mantenimiento

1. Código nuevo de aplicación en `src/browser/` con TypeScript.
2. Cambios de orden del bundle principal solo en `browserSourceOrder`.
3. Nuevo CSS en `src/web/styles/` y `@import` desde `src/web/styles/style.css`.
4. Nuevas librerías browser vía `package.json` + script de copia/bundle, no copiadas a mano en `public/vendor/`.
5. Nuevo modelo en `data/llm-models.json` y regeneración con `npm run build`.
6. Nueva tool en `src/browser/chat/tools/tool-registry.ts`; no duplicar catálogos.
7. Cambios en perfiles, overlay o runners requieren `npm run setup`.
8. Cambios en provider AI SDK o worker requieren `npm run build`.
9. `npm run build:prod` usa `https://browseragent.icu/` como `BA_PUBLIC_SITE_URL` por defecto; otros dominios deben sobrescribir esa variable para generar canonical y Open Graph/Twitter con URLs absolutas del dominio correcto.
10. Mantener límites explícitos para logs, artifacts, historial y salidas de tools.
11. Probar consolas xterm, cierre, refresco, programas de pantalla completa y tools tras tocar seriales o geometría de consola.
