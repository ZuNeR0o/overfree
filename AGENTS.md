# Contexto del Proyecto: overfree

## Protocolo de Relevo Automático (Claude Code & Gemini / agy)
**REGLA OBLIGATORIA AL FINALIZAR CADA TAREA:** Actualiza la sección **Estado Actual** al final de `AGENTS.md` (máximo últimas 3 entradas) con fecha, modelo, archivos modificados y siguiente paso. Al iniciar un hilo nuevo, lee primero **Estado Actual**.

---

- **Reindexación de Codegraph:** Si creaste, eliminaste o moviste archivos o funciones, ejecuta `codegraph index` antes de cerrar la tarea.

## Estado Actual
- **[2026-11-27 · Opus 5.5]:** Extensión: autoactualización desde GitHub Releases. `extension/src/releases.ts` (`pickUpdate`: tag `extension-vX.Y.Z`, sin prerelease, asset `folio-latex.vsix` solo de `github.com/ZuNeR0o/overfree/releases/download/`), `extension/src/update.ts` (1 vez/día en modo Production, «Omitir esta versión», descarga a globalStorage, comprueba "PK", `workbench.extensions.installExtension`, ofrece recargar), ajuste `folio.checkForUpdates`, comando `folio.checkForUpdates`. Probado contra la API real. 16 unitarias + 17 integración OK. **Publicada extension-v0.1.8** (hay que instalarla a mano una vez; desde ahí se actualiza sola).
- **[2026-11-27 · Opus 5.5]:** Extensión (bloque propuesto por Gemini): `extension/src/navigation.ts` (F12 en \ref/\cite, DocumentLinks en \input/\includegraphics, hover cita/ref/imagen, vista `folio.outline` multiarchivo), `extension/src/texargs.ts` (puro, con prueba), `quickFixProvider` en `diagnostics.ts`. `Problem` admite `col`/`length` y `src/checks.ts` los da para sin/$$/comillas (rango exacto). 17 unitarias + 20 integración OK. **Publicada extension-v0.1.9.**
- **[2026-11-27 · Opus 5.5]:** Extensión 0.1.10: panel webview `folio.tools` (`extension/src/toolsView.ts`, comandos en lista blanca), botones de formato en `editor/title`, actualizaciones al abrir (`MIN_GAP` 1 h). Nuevo `scripts/release-extension.sh` (publica y borra las releases `extension-v*` anteriores; conserva etiquetas). Releases compactadas: solo quedan la última de la app y la de la extensión. Captura en `extension/media/captura-interfaz.png` (README).
