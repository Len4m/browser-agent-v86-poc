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

## i18n

- [ ] Revisar textos visibles de la UI y documentación para preparar internacionalización: separar cadenas traducibles, decidir idioma base y evitar textos hardcodeados en JavaScript cuando sea posible. Tener especial cuidado con el uso de memoria: no cargar catálogos de idiomas grandes ni mantener duplicadas cadenas que no sean necesarias en runtime.

## Build, CSS y tamaño

- [X] Revisar HTML/CSS generado o inyectado desde JavaScript (p. ej. plantillas del panel LLM): decidir qué puede vivir directamente en`index.html` o ficheros estáticos para evitar construcción en runtime, reducir JS y simplificar mantenimiento.
- [X] Optimizar el render markdown durante streaming: AI SDK entrega los deltas, pero el DOM lo gestiona`streaming-markdown`; reducir pasadas repetidas de mejora de bloques de código durante la generación.
- [X] Reducir reconstrucciones del panel LLM con`innerHTML`: tools nativas, recursos/contexto y metadatos deberían tender a DOM persistente, event delegation y actualizaciones puntuales.
- [X] Revisar CSS: ahora hay muchos ficheros; agrupar o simplificar reglas si mejora mantenimiento y permite reducir bytes sin perder claridad.
- [X] Revisar configuración de esbuild para reducir tamaño: minify en runtime zip, sourcemaps opcionales, splitting si aporta valor, tree shaking real y separación de bundles pesados.
- [X] Revisar qué assets se copian a`public/vendor/` y asegurar que solo se incluyen los necesarios para ejecución.
