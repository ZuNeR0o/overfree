# Contexto del Proyecto: overfree

## Protocolo de Relevo Automático (Claude Code & Gemini / agy)
**REGLA OBLIGATORIA AL FINALIZAR CADA TAREA:** Actualiza la sección **Estado Actual** al final de `AGENTS.md` (máximo últimas 3 entradas) con fecha, modelo, archivos modificados y siguiente paso. Al iniciar un hilo nuevo, lee primero **Estado Actual**.

---

- **Reindexación de Codegraph:** Si creaste, eliminaste o moviste archivos o funciones, ejecuta `codegraph index` antes de cerrar la tarea.

## Estado Actual
- **[2026-11-27 · Opus 5.5]:** Extensión: PDF en blanco en Antigravity (VS Code 1.104, Chromium 138). Causa: pdf.js 6.5 build moderna usa `Map.getOrInsertComputed`, `Math.sumPrecise`, `Promise.try` sin polyfill; `page.render` fallaba y el error se perdía. `extension/build.mjs` usa `pdfjs-dist/legacy` (worker y librería) en el webview; `src/pdfview.ts` `onRenderError`; `extension/webview/pdf.ts` mide tinta de la página 1 y reporta errores; la prueba de integración exige tinta. Tests unitarios e integración OK. **Publicada extension-v0.1.5.** Siguiente: que Angel instale el .vsix en Antigravity y confirme que se ve el PDF. Riesgo: la app en Linux (WebKitGTK) usa la build moderna.
- **[2026-11-27 · Opus 5.5]:** Extensión: funciones de la app. `extension/src/editing.ts` (autocompletado, esquema Outline, comandos `folio.format.*` con submenú y Ctrl+B/I), `extension/src/snippet.ts`, en `extension.ts` barra de estado (motor con `folio.selectEngine`, «Auto» = `folio.compileOnType` que guarda tras 1,5 s, palabras), `configurationDefaults` wordWrap. Movidos sin cambios a módulos sin dependencias: `src/outline.ts` (esquema, orden, palabras; reexportados desde `src/project.ts`) y `src/latexdata.ts` (datos de `src/complete.ts`). 14 unitarias + 17 integración OK. **Publicada extension-v0.1.6.** Siguiente: probar en Antigravity (Ctrl+I tapa el atajo de su IA en .tex).
- **[2026-11-27 · Opus 5.5]:** Extensión 0.1.7: `folio.openProject` (`extension/src/projects.ts` lee `<datos>/app.folio.editor/projects.json` y Documentos/Folio), menús de editor con `resourceLangId` (con `editorLangId` se ocultaban al enfocar el PDF), `setSetting` ofrece recargar ventana si el ajuste no está registrado. 15 unitarias + 17 integración OK. Publicada extension-v0.1.7.
