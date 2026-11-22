# Folio

Editor LaTeX local, gratuito y sin conexión. Compila en tu equipo con TeX Live 2026
(BusyTeX en WebAssembly): sin servidor, sin límite de tiempo de compilación y sin cuenta.

## Funciones

- Editor con resaltado, autocompletado (comandos, entornos, `\ref`, `\cite`, archivos, paquetes)
  y corrector ortográfico.
- Compilación con pdfLaTeX, XeLaTeX o LuaLaTeX; BibTeX, Biber y makeindex automáticos.
- Errores y avisos marcados en la línea del editor y en una lista navegable.
- SyncTeX: **Ir al PDF** (Ctrl+Alt+J) y doble clic en el PDF para volver al código.
- Varios proyectos, carpetas, arrastrar y soltar, importar y exportar `.zip`.
- Esquema del documento, búsqueda en todo el proyecto y conteo de palabras.
- Historial de versiones con diferencias y restauración.
- Compilación automática al escribir, tema oscuro, paneles redimensionables.
- Pegar o soltar una imagen en el editor la guarda en `figuras/` e inserta el `figure`.
- Revisión de errores mientras escribes (entornos sin cerrar, `$` sueltos, comandos de
  matemáticas fuera de modo matemático…), sin necesidad de compilar.
- Vista previa de fórmulas al poner el cursor dentro de una ecuación (KaTeX, sin conexión).
- Barra de herramientas: secciones, negrita, cursiva, fórmulas, enlaces, referencias,
  citas, figuras, tablas (con selector de tamaño), listas y comentarios.
- Compilación incremental: se conservan `.aux`, `.toc`, `.bbl`… entre compilaciones y solo
  se repite TeX si el `.aux` cambia. Un documento de 133 páginas pasa de ~54 s a ~7 s.
  La compilación automática usa un modo rápido de una sola pasada.

## Actualizaciones automáticas

La app instalada consulta al arrancar `latest.json` en la última Release de GitHub. Si hay
una versión nueva, pregunta y la instala. Los paquetes van firmados: la app solo acepta
los firmados con la clave privada `%USERPROFILE%\.tauri\folio-updater.key` (no está en el
repositorio; guarda una copia de seguridad, sin ella no se pueden publicar actualizaciones).

Publicar una versión:

```powershell
.\scripts\release.ps1 -Version 0.1.5 -Notes "Qué cambió"
```

### Publicar desde Linux (Windows + Linux a la vez)

`scripts/release.sh` compila Linux (`.AppImage` con actualización automática y `.deb`) y,
de forma cruzada, el instalador de Windows. Requisitos en Ubuntu 24.04:

```bash
sudo apt install -y build-essential pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev nsis clang lld llvm file
cargo install --locked cargo-xwin
```

y la clave de firma en `~/.tauri/folio-updater.key`. Luego:

```bash
./scripts/release.sh 0.1.6 "Qué cambió"
```

## Licencia y créditos

Folio se distribuye bajo **AGPL-3.0** (ver `LICENSE`), igual que los componentes que usa:

- [Overleaf](https://github.com/overleaf/overleaf) (AGPL-3.0): gramática Lezer de LaTeX
  (`src/overleaf/lezer-latex`), revisor de LaTeX (`src/overleaf/linter`) y partes adaptadas
  del lenguaje, la barra de herramientas y la vista previa de fórmulas (`src/overleaf`).
  Cada archivo indica su origen.
- [TeXlyre BusyTeX](https://github.com/TeXlyre/texlyre-busytex) (AGPL-3.0): TeX Live en
  WebAssembly. `scripts/patch-busytex.mjs` ajusta su pipeline (PDF aunque haya errores y
  pasadas solo cuando hacen falta).
- CodeMirror, pdf.js, KaTeX, fflate, Tauri (licencias MIT / Apache-2.0).

## Navegador

```powershell
npm install
npm run dev
```

La primera vez descarga el motor (unos 700 MB) a `public/core`. Los proyectos se guardan
en IndexedDB del navegador.

## App de escritorio (Tauri + Rust)

Requisitos: Rust (`rustup`), Visual Studio Build Tools con C++ y WebView2.

```powershell
npm run app        # compila y abre la app en modo desarrollo
npm run app:build  # genera el instalador en src-tauri/target/release/bundle/nsis
```

En escritorio, cada proyecto es una carpeta real en `Documentos\Folio\<Proyecto>`, con
el historial y el último PDF en su subcarpeta `.folio`. También se puede abrir cualquier
carpeta existente con **Proyectos → Abrir carpeta**. Al eliminar un proyecto, su carpeta
va a la Papelera de reciclaje.

Arquitectura: Rust levanta un servidor HTTP en `127.0.0.1:47321` que sirve la interfaz
y el motor TeX desde disco, más una API `/api` protegida con un token aleatorio por
sesión (y comprobación de `Host`) para leer y escribir los proyectos.
