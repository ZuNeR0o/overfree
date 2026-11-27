# Contexto del Proyecto: overfree

## Protocolo de Relevo Automático (Claude Code & Gemini / agy)
**REGLA OBLIGATORIA AL FINALIZAR CADA TAREA:** Actualiza la sección **Estado Actual** al final de `AGENTS.md` (máximo últimas 3 entradas) con fecha, modelo, archivos modificados y siguiente paso. Al iniciar un hilo nuevo, lee primero **Estado Actual**.

---

- **Reindexación de Codegraph:** Si creaste, eliminaste o moviste archivos o funciones, ejecuta `codegraph index` antes de cerrar la tarea.

## Estado Actual
- **[2026-11-27 · Opus 5.5]:** Extensión: funciones de la app. `extension/src/editing.ts` (autocompletado, esquema Outline, comandos `folio.format.*` con submenú y Ctrl+B/I), `extension/src/snippet.ts`, en `extension.ts` barra de estado (motor con `folio.selectEngine`, «Auto» = `folio.compileOnType` que guarda tras 1,5 s, palabras), `configurationDefaults` wordWrap. Movidos sin cambios a módulos sin dependencias: `src/outline.ts` (esquema, orden, palabras; reexportados desde `src/project.ts`) y `src/latexdata.ts` (datos de `src/complete.ts`). 14 unitarias + 17 integración OK. **Publicada extension-v0.1.6.** Siguiente: probar en Antigravity (Ctrl+I tapa el atajo de su IA en .tex).
- **[2026-11-27 · Opus 5.5]:** Extensión 0.1.7: `folio.openProject` (`extension/src/projects.ts` lee `<datos>/app.folio.editor/projects.json` y Documentos/Folio), menús de editor con `resourceLangId` (con `editorLangId` se ocultaban al enfocar el PDF), `setSetting` ofrece recargar ventana si el ajuste no está registrado. 15 unitarias + 17 integración OK. Publicada extension-v0.1.7.
- **[2026-11-27 · Opus 5.5]:** Extensión: autoactualización desde GitHub Releases. `extension/src/releases.ts` (`pickUpdate`: tag `extension-vX.Y.Z`, sin prerelease, asset `folio-latex.vsix` solo de `github.com/ZuNeR0o/overfree/releases/download/`), `extension/src/update.ts` (1 vez/día en modo Production, «Omitir esta versión», descarga a globalStorage, comprueba "PK", `workbench.extensions.installExtension`, ofrece recargar), ajuste `folio.checkForUpdates`, comando `folio.checkForUpdates`. Probado contra la API real. 16 unitarias + 17 integración OK. **Publicada extension-v0.1.8** (hay que instalarla a mano una vez; desde ahí se actualiza sola).
