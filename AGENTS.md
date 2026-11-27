# Contexto del Proyecto: overfree

## Protocolo de Relevo Automático (Claude Code & Gemini / agy)
**REGLA OBLIGATORIA AL FINALIZAR CADA TAREA:** Actualiza la sección **Estado Actual** al final de `AGENTS.md` (máximo últimas 3 entradas) con fecha, modelo, archivos modificados y siguiente paso. Al iniciar un hilo nuevo, lee primero **Estado Actual**.

---

- **Reindexación de Codegraph:** Si creaste, eliminaste o moviste archivos o funciones, ejecuta `codegraph index` antes de cerrar la tarea.

## Estado Actual
- **[2026-11-26 · Opus 5.5]:** Error "The PDF file is empty, i.e. its size is zero bytes" (de PDF.js): la compilación nativa devolvía un PDF de 0 bytes como éxito y el `catch` de `compile()` reemplazaba el registro de LaTeX por el error del visor. `src-tauri/src/native.rs` (PDF vacío o sin "%PDF" = sin PDF; corta las pasadas) y `src/main.ts` (descarta PDF inválido; si PDF.js falla, lo agrega a Problemas SIN borrar el registro). `tsc` y `cargo check` OK; commit 240d28e. **Publicada v0.1.9** (Windows + Linux, `latest.json` 0.1.9). Siguiente: que Angel actualice y ver el error real de LaTeX de su "Tarea Kalman".
- **[2026-11-26 · Opus 5.5]:** Motor **Automático** (opción por defecto en proyectos nuevos): `src/engine.ts` (`engineFromSource`/`resolveEngine`, compartido con la extensión): `% !TEX program`; babel `bidi=basic`/`onchar=`/luacode → LuaLaTeX; xeCJK… → XeLaTeX; fontspec/unicode-math/polyglossia/`\babelfont` → XeLaTeX; si no pdfLaTeX. Cambios: `src/main.ts` (resuelve al compilar, mira todos los .tex), `src/store.ts`, `index.html`, `src-tauri/src/store.rs` (carpetas adoptadas → "auto"), `extension/src/texproject.ts` (project.json con "auto" detecta), tests. Commit fff33a4. **Publicadas app v0.1.10** (Latest, Windows + Linux) **y extension-v0.1.4**. Siguiente: que Angel actualice, ponga «Automático» en "Tarea Kalman" y confirme que compila con LuaLaTeX.
- **[2026-11-27 · Opus 5.5]:** Extensión: PDF en blanco en Antigravity (VS Code 1.104, Chromium 138). Causa: pdf.js 6.5 build moderna usa `Map.getOrInsertComputed`, `Math.sumPrecise`, `Promise.try` sin polyfill; `page.render` fallaba y el error se perdía. `extension/build.mjs` usa `pdfjs-dist/legacy` (worker y librería) en el webview; `src/pdfview.ts` `onRenderError`; `extension/webview/pdf.ts` mide tinta de la página 1 y reporta errores; la prueba de integración exige tinta. Tests unitarios e integración OK. **Publicada extension-v0.1.5.** Siguiente: que Angel instale el .vsix en Antigravity y confirme que se ve el PDF. Riesgo: la app en Linux (WebKitGTK) usa la build moderna.
