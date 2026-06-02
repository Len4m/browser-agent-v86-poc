# TODO

Lista de temas detectados para revisar antes de una publicación estable.

## LLM, AI SDK y tools

- [X] Mejorar la interacción de tools con modelos Transformers.js usando AI SDK: revisar documentación oficial, ejemplos actuales, patrones de tool calling, streaming, stop conditions, middlewares y limitaciones de modelos locales.
- [X] Revisar el bloque de thinking en modelos que muestran razonamiento: cuándo aparece, cómo se renderiza, toggle de visibilidad y coherencia con el streaming.
- [X] Revisar la detección de JSON en respuestas de modelos: validar si el parser actual es adecuado para tool calling y si el mensaje «El modelo local no generó texto. Recarga (Ctrl+Shift+R) o prueba otro modelo.» cubre bien los casos reales (respuesta vacía, solo JSON, razonamiento sin texto visible).
- [X] Revisar integración con Ollama cuando el proyecto esté publicado en internet: CORS, origen permitido, endpoints locales, seguridad y experiencia de configuración.
- [X] Mejorar y revisar la gestión de artifacts: ciclo de vida,persistencia, limpieza, referencias desde el contexto, visualización en UI y límites de memoria.
- [X] Seleccionar mejor los modelos que aceptan y funcionan correctamente con tools por defecto.
- [X] Revisar el funcionamiento real de todas las tools creadas y añadir una tool sencilla para escribir ficheros en la VM (p. ej. ruta + contenido, límites de tamaño, creación de directorios opcional y validación de errores/permisos).
  - [X] Probar manualmente cada tool en cada perfil (`alpine-base`, `alpine-pentest-lite`, `alpine-pentest-web`) y confirmar que solo aparecen las que corresponden a los paquetes incluidos en el perfil.
  - [X] Revisar códigos de salida reales por tool, especialmente casos con salida útil y `rc != 0` (`curl`, `ffuf`, `httpx`, `nikto`, `nmap`), para distinguir fallo real, resultado parcial y salida válida.
  - [X] Validar `vm.fs.write`: escritura nueva, bloqueo de sobrescritura, `overwrite`, `createDirs`, límites de contenido, permisos y rutas bloqueadas.
- [X] Revisar la visualización del razonamiento (thinking) en el chat: con el toggle activo, comprobar en qué casos se muestra, si permanece en el historial y si es coherente con tools, respuestas vacías o turnos sin texto final (p. ej. cuando hubo razonamiento pero no respuesta visible, o el modelo ejecutó una tool y el bloque desaparece al cerrar el turno).
- [X] Revisar el fallback WASM tras fallo WebGPU al cargar modelos Transformers.js: comprobar que la alternativa funciona bien y que un segundo intento de carga usa realmente el backend esperado (WASM vs GPU).

## Producto y publicación

- [X] Crear repositorio público`https://github.com/Len4m/browser-agent-v86-poc` cuando se decida publicar.
- [ ] Metadatos básicos para la demo pública (`https://browseragent.icu/`): hoy `index.html` solo tiene charset, viewport y título; no hay favicon real (el servidor responde 204 en`/favicon.ico`),`meta description`, Open Graph/Twitter Card ni `canonical`. Añadir favicon (y opcionalmente`apple-touch-icon`), description,`og:*`/`twitter:*` con imagen de preview,`link rel="canonical"` y, si encaja,`robots.txt`/`sitemap.xml` en `public/` para mejorar snippet en buscadores y vistas previas al compartir el enlace.
- [ ] SEO multilingüe por URL (mejora opcional para publicación): hoy el idioma es solo en cliente (misma URL + selector ES/EN), insuficiente para indexar ES y EN por separado. Valorar rutas distintas (p. ej. `/` y `/en/`) con `lang`, meta y `hreflang` por idioma, sitemap con ambas URLs y alinear el selector con la ruta; preferir generación estática en build (sin lógica extra en servidor más allá de servir `public/`). Complementa el punto anterior; puede aplazarse si basta meta en inglés con mención a la UI en español.

## Consola y xterm.js

- [X] Revisar manualmente la rama`xterm-direct-consoles`: consolas xterm con PTYs independientes dentro de la VM, máximo 4 sesiones, transporte multiplexado por`serial2` y tools separadas por`serial1`.
- [X] Decidir el lenguaje de los runners guest en`vm/overlay/common/usr/local/bin/`: se mantiene `python3` como dependencia obligatoria de todos los perfiles y se migra `ba-serial1-runner` a **Python 3**, igual que `ba-serial2-console-runner`. Criterio: la red/v86 dominan la latencia, el runner serial1 es persistente y no paga arranque de Python por job, y unificar en Python simplifica el protocolo, timeouts y drenaje de stdout/stderr.
- [X] La consola1 (la que funciona por serial0) no permite copiar texto con el botón derecho del ratón ni por ningún otro medio, mientras que en el resto de consolas sí es posible copiar usando el botón derecho.

## VM y carga inicial

- [X] Revisar restauración de máquinas desde fichero/snapshot: tras restaurar, revalidar o reenganchar `serial1` y `serial2` para que funcionen tools y creación de nuevas consolas. Definir también qué debe ocurrir con pestañas xterm/PTY ya existentes: si el snapshot contenía procesos en otras pestañas, la UI debería recuperar esas pestañas y reconectarlas a sus sesiones/procesos, o detectar claramente que no son recuperables y recrearlas de forma consistente.
- [X] Permitir cancelar la descarga de assets de la VM: hoy, una vez iniciado el arranque (`preloadVmAssets` en`runtime-assets.ts`), las peticiones de kernel, initrd, disco hda y scripts no se pueden abortar; si el usuario se equivoca de perfil/disco o la descarga tarda demasiado, la única salida es refrescar la página. Añadir cancelación explícita (p. ej. botón en`#loading-overlay`,`AbortController` en los fetch, limpieza de estado en`serial-vm.ts` y desbloqueo de opciones/Start).
- [X] Probar la experiencia en conexiones lentas y valorar un loading inicial de la aplicación: antes de arrancar la VM, el bundle JS, los catálogos i18n y otros assets pueden tardar en redes lentas sin feedback claro. Hacer pruebas con throttling (DevTools) y, si hace falta, reutilizar el overlay de carga existente (`#loading-overlay`/`setLoading`) para mostrar progreso o estado indeterminado hasta que la UI esté lista para interactuar.

## i18n

- [X] Revisar textos visibles de la UI y documentación para preparar internacionalización: separar cadenas traducibles, decidir idioma base y evitar textos hardcodeados en JavaScript cuando sea posible. Tener especial cuidado con el uso de memoria: no cargar catálogos de idiomas grandes ni mantener duplicadas cadenas que no sean necesarias en runtime.
- [X] Traducir la UI y los prompts LLM al inglés: catálogo `en.json` en paridad con `es.json` (~780 claves), selector ES/EN y comprobación de claves en `npm run check`.
- [X] Revisar la calidad de las traducciones al inglés: `npm run check` garantiza paridad de claves, no que el texto EN sea correcto o natural. Repasar manualmente las cadenas más visibles (errores, panel LLM, chat, checks).
- [X] Alinear la documentación con i18n: actualizar `README.md` y `docs/USAGE.md` (y lo que aplique) para reflejar el selector de idioma ES/EN y no dejar solo contenido en español donde deba servir también a usuarios en inglés.

## Build, CSS y tamaño

- [X] Revisar HTML/CSS generado o inyectado desde JavaScript (p. ej. plantillas del panel LLM): decidir qué puede vivir directamente en`index.html` o ficheros estáticos para evitar construcción en runtime, reducir JS y simplificar mantenimiento.
- [X] Optimizar el render markdown durante streaming: AI SDK entrega los deltas, pero el DOM lo gestiona`streaming-markdown`; reducir pasadas repetidas de mejora de bloques de código durante la generación.
- [X] Reducir reconstrucciones del panel LLM con`innerHTML`: tools nativas, recursos/contexto y metadatos deberían tender a DOM persistente, event delegation y actualizaciones puntuales.
- [X] Revisar CSS: ahora hay muchos ficheros; agrupar o simplificar reglas si mejora mantenimiento y permite reducir bytes sin perder claridad.
- [X] Revisar configuración de esbuild para reducir tamaño: minify en runtime zip, sourcemaps opcionales, splitting si aporta valor, tree shaking real y separación de bundles pesados.
- [X] Revisar qué assets se copian a`public/vendor/` y asegurar que solo se incluyen los necesarios para ejecución.
- [X] Reorganizar `scripts/` en subcarpetas: hoy hay ~19 ficheros mezclados (build, check, clean, setup/VM, LLM). Agrupar por dominio (p. ej. `scripts/build/`, `scripts/check/`, `scripts/clean/`, `scripts/vm/`, `scripts/llm/`) y actualizar referencias en `package.json`, `build.mjs` y documentación. Aparte, revisar scripts de **migración ya consumida** que no entran en `npm run build` ni `npm run check`: p. ej. `migrate-i18n-to-json.mjs` (sirvió para volcar el español inline a `es.json`; probablemente ya no hace falta). Decidir si archivarlos en una carpeta tipo `scripts/archive/` o quitarlos del repo para no confundirlos con tooling activo.

## Calidad y tests

- [ ] CI mínimo en GitHub: workflow que ejecute `npm run check` (y, si encaja, `npm run build`) en push y pull requests a `main`.
- [ ] Definir e introducir tests automatizados más allá de `npm run check`: hoy solo hay validaciones estáticas (schemas, i18n, manifest, syntax). Decidir alcance (unitarios de módulos browser p. ej. i18n, tool-registry, context-budget; integración de scripts de build/check; smoke o e2e en navegador/VM), elegir runner (p. ej. Node test runner, Vitest, Playwright) e integrarlos en CI antes de una release estable.
