# CLAUDE.md — Folio (repo overfree)

Editor LaTeX local/sin conexión: frontend TS + CodeMirror 6 + BusyTeX (WASM), escritorio Tauri v2 + Rust.
**Mapa completo (módulos, líneas, API, releases): [.agent/CONTEXTO.md](.agent/CONTEXTO.md)**. Léelo antes de buscar.

## Reglas rápidas
- Archivos grandes (>300 líneas): `src/main.ts` (2235), `src/overleaf/linter/latex-linter.worker.ts` (2336),
  `src/overleaf/lezer-latex/latex.grammar` (842), `tokens.mjs` (756), `src/style.css` (551),
  `src-tauri/src/store.rs` (468), `server.rs` (419), `native.rs` (314), `src/store.ts` (377), `pdfview.ts` (358).
  Usa los rangos de `.agent/CONTEXTO.md` §4 o pide líneas a `agy` antes de leerlos.
- No hay `#[tauri::command]`: el IPC de escritorio es HTTP en `127.0.0.1:47321/api/*` con `X-Folio-Token`
  (`src-tauri/src/server.rs` ↔ `src/store.ts` `DesktopBackend`). Endpoint nuevo = ruta en server.rs + método en ambos Backends.
- Cualquier cambio de datos tiene que funcionar en los dos backends: navegador (IndexedDB) y escritorio (disco).
- `latex.mjs` y `latex.terms.mjs` son generados: edita `latex.grammar`/`tokens.mjs` y ejecuta `node scripts/gen-latex-parser.mjs`.
- `public/core/` (BusyTeX) se descarga y parchea con `npm run setup`; no está en git.
- La interfaz, los commits y las notas de versión van en español.
- `extension/` es la extensión de VS Code/Antigravity y reutiliza `src/`: los módulos puros (`refs`, `envs`,
  `lint-core`, `logparse`, `checks`, `synctex`, `tables`, `doi`, `encoding`) no pueden importar CodeMirror ni `window`.
  Tras tocar `src/`, ejecuta también `cd extension && npm test && npm run typecheck`.

## Comandos
- `npm run dev` · `npm run build` · `npm run app` (escritorio debug) · `npm run app:build`
- Comprobar tipos: `npx tsc --noEmit` · Rust: `cargo check --manifest-path src-tauri/Cargo.toml`
- Release: `./scripts/release.sh X.Y.Z "notas"` (firma con `~/.tauri/folio-updater.key`, publica en GitHub Releases).
  Commit "Folio X.Y.Z" + tag `vX.Y.Z`.

Si cambias la estructura (módulos nuevos, rutas API), actualiza `.agent/CONTEXTO.md`.
