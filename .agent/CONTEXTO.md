# Folio (repo `overfree`) — Mapa del proyecto

> Editor LaTeX local y sin conexión (web + escritorio Tauri). Licencia AGPL-3.0.
> Repo: https://github.com/ZuNeR0o/overfree · Producto: **Folio** · Versión actual: **0.1.7**
> Generado con `agy` (gemini-4-hydrogen-medium) y verificado a mano el 2026-11-23.
> Los números de línea caducan con cada cambio: si no cuadran, vuelve a pedirlos a `agy`.

## 1. Stack

- **Frontend:** TypeScript + Vite 6 (dos entradas: `index.html`, `pdf.html`), CodeMirror 6, Lezer
  (gramática LaTeX de Overleaf), `pdfjs-dist`, KaTeX, `fflate` (ZIP), Inter.
- **Motor LaTeX:** `texlyre-busytex` (TeX Live 2026 en WebAssembly, en Web Worker), descargado a
  `public/core/` por `scripts/ensure-assets.mjs` y parcheado por `scripts/patch-busytex.mjs`.
- **Escritorio:** Tauri v2 (`tauri-plugin-dialog`, `tauri-plugin-updater`), Rust 2021, `tiny_http`,
  `serde`, `base64`, `trash`.

## 2. Arquitectura y flujo de datos

```
UI (src/main.ts, CodeMirror) ──► store.ts: Backend
                                   ├─ BrowserBackend  → IndexedDB "folio" v2 (projects, files, snapshots, outputs)
                                   └─ DesktopBackend  → fetch http://127.0.0.1:47321/api/*  (cabecera X-Folio-Token)
                                                          └─ src-tauri/src/server.rs → store.rs (carpetas reales en Documentos/Folio)
Compilar ─┬─ latex.ts → BusyTeX WASM (navegador y escritorio)
          └─ /api/projects/:id/native/compile → native.rs (pdflatex/xelatex/lualatex del sistema)
Log → logparse.ts → lista de problemas + diagnósticos CodeMirror
PDF → pdfview.ts (pdf.js) · synctex.ts (forward / inverse) · pdfwindow.ts (ventana aparte, BroadcastChannel "folio-pdf")
```

- **Sin `#[tauri::command]`:** todo el IPC de escritorio va por HTTP local. `lib.rs` genera un token
  por sesión, arranca `tiny_http` (8 hilos, puerto 47321 o libre), inyecta
  `window.__FOLIO = { token, api }` con `initialization_script` y limita la navegación al mismo origen.
- `server.rs` sirve estáticos (`dist/` en debug, `resource_dir/web/` en release) con ETag y valida
  `Host` (anti DNS rebinding) + `X-Folio-Token` en `/api/*`.
- **TeX del sistema** (`native.rs`): busca en PATH, MiKTeX o `C:\texlive`; compila en
  `<proyecto>/.folio/build` con biber/bibtex/makeindex; se cancela por job/PID (`kill_tree`); devuelve
  PDF + SyncTeX en Base64.
- **Git** (`git.rs`): usa el `git` del sistema y anula `core.fsmonitor`, `core.hooksPath`,
  `protocol.ext.allow`, etc. (constante `SAFE`); valida ramas y URLs remotas.
- **Updater** (`updater.rs`, solo release): espera 8 s, lee `latest.json` de GitHub Releases, pide
  confirmación, verifica la firma (`pubkey` en `tauri.conf.json`), instala y reinicia.

## 3. Módulos

| Ruta | Líneas | Responsabilidad |
| --- | ---: | --- |
| `src/main.ts` | 2235 | Controlador principal: UI, editor, árbol, compilación, historial, ajustes, cambios externos |
| `src/store.ts` | 377 | Interfaz `Backend` (IndexedDB / `/api`) y migración legacy |
| `src/pdfview.ts` | 358 | Visor PDF: render perezoso, zoom, capa de texto, enlaces, búsqueda, resaltado SyncTeX |
| `src/complete.ts` | 236 | Autocompletado: comandos, entornos, `\ref`, `\cite`, archivos, paquetes |
| `src/refs.ts` | 21 | `extractLabels`, `extractBibEntries` (puro; lo usan complete, checks y la extensión) |
| `src/project.ts` | 236 | `\input`/`\include`, esquema, conteo de palabras, ZIP, plantillas |
| `src/latex.ts` | 225 | Cola BusyTeX, detección bibtex/biber/makeindex, `auxCache`, envoltorio `__folio_main.tex` |
| `src/structure.ts` | 179 | `\begin`/`\end` sincronizados, Enter en listas, alinear `&` (Ctrl+Alt+A) |
| `src/envs.ts` | 43 | `openEnvsAt`, `maskComments`, `commentStart`, `ENV_RE` (puro, sin CodeMirror) |
| `src/logparse.ts` | 189 | Parser de logs LaTeX (líneas de 79 cols, traducción de errores) |
| `src/gitpanel.ts` | 165 | UI del panel Git |
| `src/symbols.ts` | 162 | Paleta de símbolos (KaTeX) |
| `src/checks.ts` | 138 | Revisión sin compilar: etiquetas repetidas, refs/citas/imágenes rotas, estilo |
| `src/synctex.ts` | 117 | Parser `.synctex.gz` (`DecompressionStream`) forward/inverse |
| `src/tables.ts` | 114 | TSV/CSV → tabla `booktabs`/`siunitx` |
| `src/doi.ts` | 61 | DOI → BibTeX (doi.org / Crossref) |
| `src/pdfwindow.ts` | 54 | Entrada de `pdf.html` |
| `src/icons.ts` | 49 | Paths SVG (Tabler) |
| `src/encoding.ts` | 44 | UTF-8 ↔ Windows-1252 |
| `src/style.css` | 551 | Estilos y temas |
| `src/overleaf/linter/latex-linter.worker.ts` | 2336 | Linter LaTeX de Overleaf en Worker; exporta `Parse` para usarlo sin Worker |
| `src/overleaf/linter/latex-linter.ts` | 44 | Cliente CodeMirror del worker |
| `src/overleaf/linter/lint-core.ts` | 64 | Traducción de mensajes y `errorsToDiagnostics` (puro) |
| `src/overleaf/lezer-latex/latex.grammar` | 842 | Gramática Lezer (fuente) |
| `src/overleaf/lezer-latex/tokens.mjs` | 756 | Tokenizadores externos |
| `src/overleaf/lezer-latex/latex.mjs`, `latex.terms.mjs` | 24 / 180 | **Generados**: no editar a mano |
| `src/overleaf/toolbar.ts` | 273 | Barra de herramientas del editor |
| `src/overleaf/math-preview.ts` | 177 | Vista previa KaTeX con macros del proyecto |
| `src/overleaf/latex-language.ts` | 128 | `LRLanguage` (plegado, `styleTags`) |
| `src/overleaf/no-spellcheck.ts` | 69 | `spellcheck="false"` en comandos/matemáticas |
| `src-tauri/src/store.rs` | 468 | Proyectos en disco, `.folio/`, snapshots, outputs, `adopt_folder` |
| `src-tauri/src/server.rs` | 419 | Servidor HTTP: estáticos + `/api/*` |
| `src-tauri/src/native.rs` | 314 | TeX del sistema: detección, multipasada, cancelación |
| `src-tauri/src/git.rs` | 207 | Git seguro |
| `src-tauri/src/lib.rs` | 110 | Setup Tauri, servidor, ventana, token |
| `src-tauri/src/updater.rs` | 74 | Actualizaciones firmadas |
| `scripts/release.sh` / `release.ps1` | 91 / 72 | Publicar release (Linux+Windows / solo Windows) |
| `scripts/patch-busytex.mjs` | 126 | Parche idempotente de `busytex_pipeline.js` |
| `scripts/ensure-assets.mjs` | 24 | Descarga BusyTeX si falta + parche |
| `scripts/gen-latex-parser.mjs` | 13 | Regenera el parser Lezer |

## 4. Archivos grandes (>300 líneas): dónde está cada cosa

### `src/main.ts` (2235) — rangos de sección aproximados (±5); funciones exactas
- 1–147 imports y utilidades: `setStatus` 37, `ask` 71, `download` 101, `cleanPath` 124
- 148–216 ajustes y tema: `saveSettings` 198, `applyTheme` 206
- 217–307 estado y persistencia: `allProblems` 225, `readUpload` 245, `persist` 253, `flushPending` 292
- 308–694 editor: `otherTexSources` 344, `makeState` 456, `reconfigureAll` 475, `diagnosticsFor` 486,
  `openFile` 501, `goToLine` 539, `showBinary` 555, `addImageFromEditor` 582, `onPaste` 606,
  `insertTable` 632, `onEditorDrop` 663
- 695–995 árbol: `buildTree` 696, `renderTree` 720, `handleDrop` 788, `uploadFiles` 825, `newFile` 851,
  `movePath` 876, `deletePath` 944, `setMain` 966, `refreshMainSelect` 974
- 996–1107 panel lateral: `showTab` 998, `renderOutline` 1016, `scheduleIndex` 1035,
  `runProjectChecks` 1047, `runSearch` 1057
- 1108–1230 PDF: `openPdfFind` 1138, `runPdfFind` 1148, `stepPdfFind` 1156, `setZoom` 1185,
  `syncForward` 1198, `showPdf` 1209
- 1231–1282 problemas: `renderProblems` 1230, `setProblemsOpen` 1266
- 1283–1479 compilación: `cancelCompilation` 1291, `compile` 1315
- 1480–1638 historial: `autoSnapshot` 1488, `lineDiff` 1504, `openHistory` 1542, `showSnapshot` 1564,
  `restoreSnapshot` 1606
- 1639–1817 proyectos: `openProject` 1638, `createProject` 1699, `renderProjectList` 1715
- 1818–1933 ajustes/compilador: `openSettings` 1817, `refreshCompilerInfo` 1882, `updateCompilerBadge` 1912
- 1934–1975 paneles: `applyLayout` 1934
- 1976–2011 PDF aparte: `openPdfWindow` 2004
- 2012–2078 DOI: `targetBib` 2012, `addReferenceByDoi` 2028
- 2079–2208 cambios externos: `checkExternalChanges` 2094, `applyExternal` 2175
- 2209–2238 arranque (escritorio + `warmUp`)

### `src/overleaf/linter/latex-linter.worker.ts` (2336)
- 40–708 tokenizador `Tokenise` (40); `readLetDefinition` 271, `readOptionalParams` 444,
  `readDefinition` 545, `readVerb` 595, `readUrl` 640
- 709–1357 `InterpretTokens` (reglas de modo matemático y comandos)
- 1358–1504 `DocumentTree`
- 1505–2064 `EnvHandler`: `closedBy` 1637, `delimiterPrecedence` 1670, `reportError` 1718,
  `resetMathMode` 1828, `getNewMathMode` 1844
- 2065–2291 `ErrorReporter`
- 2292–2336 entrada: `Parse` 2292, `onmessage` 2316, `export { Parse }` 2336

## 5. API HTTP de escritorio (`src-tauri/src/server.rs`)

| Método y ruta | Línea |
| --- | ---: |
| `GET /api/projects` | 250 |
| `POST /api/open-folder` | 252 |
| `GET /api/native` · `POST /api/native-cancel` | 260 · 262 |
| `POST /api/open-url` · `/api/open-window` · `/api/save-as` | 267 · 279 · 307 |
| `PUT /api/projects/:id/meta` · `DELETE /api/projects/:id` | 325 · 332 |
| `GET /api/projects/:id/files` · `/manifest` | 333 · 334 |
| `GET·PUT·DELETE /api/projects/:id/file` | 335 · 339 · 346 |
| `GET·PUT /api/projects/:id/snapshots` · `DELETE …/snapshots/:sid` | 350 · 351 · 355 |
| `GET·PUT /api/projects/:id/output/:which` | 356 · 361 |
| `POST /api/projects/:id/native/{compile,clean}` | 365 |
| `GET·POST /api/projects/:id/git/{status,log,init,commit,remote,sync}` | 385 |
| `POST /api/projects/:id/reveal` | 407 |

## 6. Comandos

- `npm run setup` — descarga y parchea BusyTeX en `public/core/`
- `npm run dev` — Vite (con `predev` → ensure-assets)
- `npm run build` — `dist/` con `index.html` + `pdf.html`
- `npm run app` — build + `cargo run` (escritorio en debug)
- `npm run app:build` — ensure-assets + `tauri build`
- `node scripts/gen-latex-parser.mjs` — regenera el parser Lezer tras tocar `latex.grammar`
- Release: `./scripts/release.sh X.Y.Z "notas"` (Linux: AppImage + .deb + NSIS Windows con `cargo-xwin`)
  o `.\scripts\release.ps1 -Version X.Y.Z -Notes "..."` (Windows). Firma con `~/.tauri/folio-updater.key`,
  genera `latest.json`, commit "Folio X.Y.Z", tag `vX.Y.Z` y GitHub Release con `gh`.

## 7. Gotchas

- `tauri.conf.json`: `frontendDist` apunta a `../shell` (página mínima); la web real (`dist/`) va como
  recurso `web/` y la sirve `tiny_http` desde disco, para no incrustar ~700 MB de BusyTeX en el binario.
- `pdf.html` no recibe `window.__FOLIO`: enlaces externos e inverse search pasan por
  `BroadcastChannel("folio-pdf")` a la ventana principal.
- `lib.rs` llama a `.disable_drag_drop_handler()`: sin ello Tauri se come el drop en Windows.
- `vite.config.ts` ignora `src-tauri`, `dist`, `public/core`, `shell` en el watcher (evita `EBUSY`).
- Latin-1: el frontend decodifica Windows-1252 (`encoding.ts`), Rust envía `b64` si no es UTF-8
  (`store.rs` ~260), BusyTeX compila el envoltorio `__folio_main.tex` (`latex.ts` ~119).
- Módulos puros (`refs.ts`, `envs.ts`, `lint-core.ts`, `logparse`, `checks`, `synctex`, `tables`, `doi`,
  `encoding`): no importes CodeMirror ni `window` en ellos, la extensión de VS Code los empaqueta para Node.
- `native.rs`: `PATH_SEP` (`;` Windows, `:` resto) para `BIBINPUTS`/`BSTINPUTS`; antes Linux usaba `;` y
  BibTeX con el TeX del sistema no encontraba los `.bib`/`.bst`.

## 8. Releases en GitHub (análisis a 2026-11-23)

Repo creado el 2026-11-20; 4 releases en 3 días, todas publicadas por `scripts/release.*`.

| Versión | Fecha | Plataformas | Novedades |
| --- | --- | --- | --- |
| 0.1.4 | 20-nov | Windows (NSIS) | Primera con autoactualización; cambios externos (Drive, VS Code), panel Git, DOI, PDF en otra ventana, corrector que ignora LaTeX |
| 0.1.5 | 20-nov | Windows | Buscar/seleccionar/copiar en el PDF, enlaces; edición estructural; paleta de símbolos; glosarios/acrónimos; TeX del sistema; arreglos de `\begin{}` y Tab |
| 0.1.6 | 22-nov | Windows + **Linux** (AppImage, .deb) | Cancelar compilación (Esc), soltar archivos en Windows, SyncTeX y saltos a errores con TeX del sistema |
| 0.1.7 | 22-nov (Latest) | Windows + Linux | Latin-1 editable, vista previa con macros del proyecto + siunitx/physics, pegar Excel/CSV → booktabs, revisión del proyecto sin compilar |

Tamaño de los artefactos: `.exe` ~450 MB, AppImage ~593 MB, `.deb` ~531 MB, más `latest.json`
(manifiesto del updater). Descargas: entre 1 y 5 por artefacto.

Observaciones:
- **Tamaño:** casi todo el peso es BusyTeX (TeX Live en WASM) empaquetado en cada instalador. Cada
  actualización vuelve a bajar ~450–590 MB. Alternativa: descargar BusyTeX la primera vez, o publicar
  un paquete "lite" que use solo el TeX del sistema.
- **Sin macOS:** no hay `.dmg`/`.app`; `latest.json` solo cubre Windows y Linux.
- 0.1.2 se hizo commit pero no tiene release; 0.1.3 no aparece ni en el historial.
- No hay `CHANGELOG.md`: las notas de versión solo viven en GitHub Releases y en los mensajes de commit.
- El repo se llama `overfree` y el producto `Folio`. `release.sh` usa `REPO=overfree` por defecto y saca
  el owner con `gh api user`.

## 9. Extensión VS Code / Antigravity (`extension/`)

Un `.vsix` para los dos (Antigravity es fork de VS Code). Reutiliza `../src` vía esbuild (`extension/build.mjs`).

| Ruta | Responsabilidad |
| --- | --- |
| `extension/src/extension.ts` | `activate`: comandos, barra de estado, compilar al guardar, lint/checks con debounce |
| `extension/src/compile.ts` | Port de `native.rs` (mismas pasadas, `.folio/build`, cancelación por grupo de procesos) |
| `extension/src/texproject.ts` | Raíz/principal/motor: `.folio/project.json` → `% !TEX root` → `\documentclass` → ajuste → adivinar |
| `extension/src/diagnostics.ts` | Colecciones «Folio · LaTeX / Revisión / Proyecto» (`parseLog`, `Parse`, `checkProject`) |
| `extension/src/pdfPanel.ts` | Webview del PDF, SyncTeX en la extensión, CSP con nonce |
| `extension/webview/pdf.ts` | Usa `src/pdfview.ts`; worker de pdf.js desde blob |
| `extension/src/tools.ts` | Tablas desde portapapeles/CSV, figura al soltar imagen, DOI → BibTeX |
| `extension/test/test.ts` | Pruebas sin VS Code con un TeX simulado (`npm test`) |
| `extension/test/integration/` | Dentro de VS Code con TeX real: `index.ts` (pasos) y `run.mjs` (lanza VS Code con xvfb-run; `FOLIO_VSIX`, `FOLIO_SHOTS`) |

Comandos (en `extension/`): `npm test` · `npm run test:integration` · `npm run typecheck` · `npm run package` → `folio-latex.vsix`.
`activate()` devuelve `{ pdf, diagnostics, isCompiling }` solo para las pruebas de integración.
SyncTeX (`src/synctex.ts` `inverse`): la caja de una línea de párrafo lleva la etiqueta de donde TeX cerró el
párrafo; se usa el carácter más cercano de esa línea.
Seguridad: `folio.texPath`/`folio.shellEscape` restringidos en espacios no fiables; motor validado;
el principal debe estar dentro del espacio de trabajo.
