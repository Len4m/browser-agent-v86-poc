# TODO

Lista de temas detectados para revisar antes de una publicación estable.

## LLM, AI SDK y tools

- [X] Mejorar la interacción de tools con modelos Transformers.js usando AI SDK: revisar documentación oficial, ejemplos actuales, patrones de tool calling, streaming, stop conditions, middlewares y limitaciones de modelos locales.
- [X] Revisar el bloque de thinking en modelos que muestran razonamiento: cuándo aparece, cómo se renderiza, toggle de visibilidad y coherencia con el streaming.
- [X] Revisar la detección de JSON en respuestas de modelos: validar si el parser actual es adecuado para tool calling y si el mensaje «El modelo local no generó texto. Recarga (Ctrl+Shift+R) o prueba otro modelo.» cubre bien los casos reales (respuesta vacía, solo JSON, razonamiento sin texto visible).
- [X] Revisar integración con Ollama cuando el proyecto esté publicado en internet: CORS, origen permitido, endpoints locales, seguridad y experiencia de configuración.
- [ ] Mejorar y revisar la gestión de artifacts: ciclo de vida,~~persistencia~~,~~limpieza~~, referencias desde el contexto, visualización en UI y límites de memoria.
- [X] Seleccionar mejor los modelos que aceptan y funcionan correctamente con tools por defecto.

## Producto y publicación

- [X] Crear repositorio público`https://github.com/Len4m/browser-agent-v86-poc` cuando se decida publicar.

## Consola y xterm.js

- [X] Revisar manualmente la rama`xterm-direct-consoles`: consolas xterm con PTYs independientes dentro de la VM, máximo 4 sesiones, transporte multiplexado por`serial2` y tools separadas por`serial1`.
- [ ] Decidir el lenguaje de los runners guest en`vm/overlay/common/usr/local/bin/`: hoy `ba-serial1-runner` está en **bash** (jobs base64 por`ttyS1`) y `ba-serial2-console-runner` en **Python 3** (daemon PTY/xterm por`ttyS2`). Valorar unificar en **bash** para poder reducir la VM base (p. ej. quitar `python3` del perfil `alpine-base` y del initramfs si ya no hace falta) o, al revés, reescribir serial1 en **Python** por consistencia y mantenibilidad, dado que todos los perfiles actuales ya incluyen `python3`. Criterios: tamaño de imagen, dependencias del overlay, complejidad del protocolo (PTY/select vs shell puro) y coste de mantener dos estilos distintos.

## VM y carga inicial

- [ ] Permitir cancelar la descarga de assets de la VM: hoy, una vez iniciado el arranque (`preloadVmAssets` en`runtime-assets.ts`), las peticiones de kernel, initrd, disco hda y scripts no se pueden abortar; si el usuario se equivoca de perfil/disco o la descarga tarda demasiado, la única salida es refrescar la página. Añadir cancelación explícita (p. ej. botón en`#loading-overlay`,`AbortController` en los fetch, limpieza de estado en`serial-vm.ts` y desbloqueo de opciones/Start).
- [ ] Probar la experiencia en conexiones lentas y valorar un loading inicial de la aplicación: antes de arrancar la VM, el bundle JS, los catálogos i18n y otros assets pueden tardar en redes lentas sin feedback claro. Hacer pruebas con throttling (DevTools) y, si hace falta, reutilizar el overlay de carga existente (`#loading-overlay`/`setLoading`) para mostrar progreso o estado indeterminado hasta que la UI esté lista para interactuar.

## i18n

- [X] Revisar textos visibles de la UI y documentación para preparar internacionalización: separar cadenas traducibles, decidir idioma base y evitar textos hardcodeados en JavaScript cuando sea posible. Tener especial cuidado con el uso de memoria: no cargar catálogos de idiomas grandes ni mantener duplicadas cadenas que no sean necesarias en runtime.

## Build, CSS y tamaño

- [X] Revisar HTML/CSS generado o inyectado desde JavaScript (p. ej. plantillas del panel LLM): decidir qué puede vivir directamente en`index.html` o ficheros estáticos para evitar construcción en runtime, reducir JS y simplificar mantenimiento.
- [X] Optimizar el render markdown durante streaming: AI SDK entrega los deltas, pero el DOM lo gestiona`streaming-markdown`; reducir pasadas repetidas de mejora de bloques de código durante la generación.
- [X] Reducir reconstrucciones del panel LLM con`innerHTML`: tools nativas, recursos/contexto y metadatos deberían tender a DOM persistente, event delegation y actualizaciones puntuales.
- [X] Revisar CSS: ahora hay muchos ficheros; agrupar o simplificar reglas si mejora mantenimiento y permite reducir bytes sin perder claridad.
- [X] Revisar configuración de esbuild para reducir tamaño: minify en runtime zip, sourcemaps opcionales, splitting si aporta valor, tree shaking real y separación de bundles pesados.
- [X] Revisar qué assets se copian a`public/vendor/` y asegurar que solo se incluyen los necesarios para ejecución.
- [ ] Reorganizar`scripts/` en subcarpetas: hoy hay ~19 ficheros mezclados (build, check, clean, setup/VM, LLM, utilidades puntuales como`migrate-i18n-to-json.mjs`). Agrupar por dominio (p. ej.`scripts/build/`,`scripts/check/`,`scripts/clean/`,`scripts/vm/`,`scripts/llm/`) y actualizar referencias en`package.json`,`build.mjs` y documentación; valorar scripts de un solo uso fuera del árbol principal o eliminarlos cuando dejen de ser necesarios.

## Calidad y tests

- [ ] Definir e introducir tests automatizados más allá de`npm run check`: hoy solo hay validaciones estáticas (schemas, i18n, manifest, syntax). Decidir alcance (unitarios de módulos browser p. ej. i18n, tool-registry, context-budget; integración de scripts de build/check; smoke o e2e en navegador/VM), elegir runner (p. ej. Node test runner, Vitest, Playwright) e integrarlos en CI antes de una release estable.
