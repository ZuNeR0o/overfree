# Contexto del Proyecto: overfree

## Protocolo de Relevo Automático (Claude Code & Gemini / agy)
**REGLA OBLIGATORIA AL FINALIZAR CADA TAREA:** Actualiza la sección **Estado Actual** al final de `AGENTS.md` (máximo últimas 3 entradas) con fecha, modelo, archivos modificados y siguiente paso. Al iniciar un hilo nuevo, lee primero **Estado Actual**.

---

- **Reindexación de Codegraph:** Si creaste, eliminaste o moviste archivos o funciones, ejecuta `codegraph index` antes de cerrar la tarea.

## Estado Actual
- **[Inicio]:** Proyecto `overfree` inicializado con contexto compartido (`AGENTS.md` -> `CLAUDE.md` / `GEMINI.md`).
- **[2026-11-23 · Opus 5.5]:** Extensión: icono de Folio en la barra de actividad con vista *Acciones* (`extension/package.json`, `extension/src/extension.ts`, `extension/media/folio.svg`, prueba de integración). Publicada extension-v0.1.2. Siguiente: release de la app Folio 0.1.8 (pendiente de aprobación).
- **[2026-11-23 · Opus 5.5]:** Renombrado Folio → **Overfree** (app y extensión 0.1.3), logo nuevo con el cubículo 246 (`public/overfree.svg`, `src-tauri/icons/*`, `extension/media/*`), `src-tauri/windows/hooks.nsh` + deb conflicts para sustituir la instalación antigua. Siguiente: commit/push/release de la extensión y release de la app 0.1.8 (pendientes de aprobación).
