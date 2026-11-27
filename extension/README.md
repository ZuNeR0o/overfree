# Overfree LaTeX para VS Code y Antigravity

Las herramientas de [Overfree](https://github.com/ZuNeR0o/overfree) dentro de tu editor. Funciona en
**VS Code** y en **Google Antigravity** (que es un fork de VS Code): el mismo `.vsix` sirve para los dos.

## Funciones

- **Abrir proyecto…**: los proyectos de la app Overfree (y de Documentos/Folio) a un clic, u otra carpeta.
- **Se actualiza sola** desde GitHub Releases: una vez al día busca una versión nueva y ofrece instalarla (ajuste `folio.checkForUpdates`; comando *Overfree: Buscar actualizaciones de la extensión*).
- **Icono de Overfree en la barra de actividad** (a la izquierda, como PlatformIO): abre la vista
  *Acciones* con todos los comandos a un clic.
- **Compilar** (`Ctrl+Alt+B`, botón ▶ o al guardar) con el TeX del sistema (MiKTeX o TeX Live):
  pdfLaTeX, XeLaTeX o LuaLaTeX, con BibTeX, Biber, glosarios y makeindex automáticos y las pasadas
  que haga falta. Los auxiliares van a `.folio/build/`, como en la app, así que un proyecto de Overfree
  compila igual en los dos sitios. `Esc` cancela.
- **Compilación automática al escribir** (como «Auto» en la app): clic en *Auto* en la barra de estado
  o el ajuste `folio.compileOnType`. Guarda tras 1,5 s sin escribir y compila.
- **Motor en la barra de estado**: muestra el que se usa (p. ej. *LuaLaTeX (auto)*); clic para elegir
  Automático, pdfLaTeX, XeLaTeX o LuaLaTeX.
- **Formato** como la barra de la app: botón *Formato LaTeX* en la barra del editor y en el menú
  contextual (negrita, cursiva, subrayado, estilo del párrafo, fórmulas, listas, enlace, nota al
  pie, figura, tabla). `Ctrl+B` y `Ctrl+I` en archivos LaTeX; repetirlo sobre `\textbf{…}` lo quita.
- **Autocompletado**: comandos y símbolos, `\begin{…}` con su `\end`, `\ref` con las etiquetas del
  proyecto, `\cite` con las entradas de los `.bib`, archivos en `\includegraphics`/`\input` y paquetes.
- **Esquema** de secciones en la vista *Outline*, las migas de pan y `Ctrl+Shift+O`.
- **Ir a la definición** (`F12` / `Ctrl+Clic`): de `\ref` a su `\label` y de `\cite` a su entrada del `.bib`, en cualquier archivo del proyecto. `\input`, `\include`, `\includegraphics` y `\bibliography` son enlaces.
- **Al pasar el ratón**: autor, título y año de una cita; el texto alrededor del `\label` de una referencia; la miniatura de una imagen.
- **Correcciones rápidas** (`Ctrl+.`) en los avisos de la revisión: `sin` → `\sin`, `$$…$$` → `\[…\]`, comillas rectas → ``` ``…'' ```.
- **Esquema del proyecto** en la barra lateral de Overfree, con los capítulos de los `\input`/`\include`.
- **Conteo de palabras** del documento en la barra de estado.
- **Ajuste de línea** activado por defecto en LaTeX (`editor.wordWrap`), como en la app.
- **Errores explicados en español** en la lista de Problemas, en su archivo y línea
  («Comando no definido: \foo. ¿Está mal escrito o falta cargar su paquete?»).
- **Visor PDF** al lado, con zoom, búsqueda (`Ctrl+F`), enlaces y selección de texto.
- **SyncTeX**: `Ctrl+Alt+J` salta del código al PDF; doble clic en el PDF vuelve al código.
- **Revisión en vivo** sin compilar: entornos sin cerrar, `$` sueltos, comandos de matemáticas
  fuera de modo matemático…
- **Revisión del proyecto** al guardar: etiquetas repetidas, `\ref` y `\cite` rotos, imágenes que
  faltan, `sin` → `\sin`, comillas rectas.
- **Tablas**: *Overfree: Pegar como tabla LaTeX* convierte las celdas copiadas de Excel o LibreOffice
  en una tabla `booktabs` (con columnas `S` si usas `siunitx`). Soltar un `.csv` en el editor también.
- **Figuras**: soltar una imagen del proyecto en el editor inserta el `figure`.
- **Referencias por DOI**: *Overfree: Añadir referencia por DOI* descarga la entrada BibTeX, la añade al
  `.bib` del documento y escribe el `\cite{…}`.

## Qué archivo se compila

1. Si la carpeta es un proyecto de la app Overfree (`.folio/project.json`), su archivo principal y motor.
2. Si el archivo empieza con `% !TEX root = ../main.tex`, ese.
3. Si el archivo tiene `\documentclass`, él mismo.
4. El ajuste `folio.mainFile`.
5. El `.tex` con `\documentclass` del espacio de trabajo (mejor `main.tex`).

El motor sale de `.folio/project.json`, de `% !TEX program = xelatex` o del ajuste `folio.engine`.
Con `auto`, se usa LuaLaTeX si el documento usa algo exclusivo de LuaTeX (babel con `bidi=basic` u
`onchar=`, `luacode`…) y XeLaTeX si carga `fontspec`, `unicode-math` o `polyglossia`.

## Requisitos

Un TeX instalado: [MiKTeX](https://miktex.org/) (Windows) o [TeX Live](https://tug.org/texlive/)
(Linux, macOS, Windows). Se busca en `PATH`, en las carpetas habituales de MiKTeX y TeX Live y en
`/Library/TeX/texbin` (macOS). Si está en otro sitio, indica la carpeta en `folio.texPath`.

## Instalación

- **VS Code**: *Extensiones* → `…` → *Instalar desde VSIX…* → `folio-latex.vsix`,
  o `code --install-extension folio-latex.vsix`.
- **Antigravity**: *Extensiones* → `…` → *Install from VSIX…* → `folio-latex.vsix`.

## Ajustes

| Ajuste | Por defecto | |
| --- | --- | --- |
| `folio.engine` | `auto` | `pdflatex`, `xelatex`, `lualatex` o `auto` |
| `folio.mainFile` | | Archivo principal relativo al espacio de trabajo |
| `folio.texPath` | | Carpeta de los ejecutables de TeX |
| `folio.compileOnSave` | `true` | Compilar al guardar `.tex`, `.bib`, `.sty`, `.cls` |
| `folio.shellEscape` | `false` | `-shell-escape` (p. ej. para `minted`); solo con documentos de confianza |
| `folio.pdf.openAfterCompile` | `true` | Abrir el PDF al lado tras compilar |
| `folio.pdf.invertInDarkTheme` | `false` | PDF con colores invertidos en temas oscuros |
| `folio.lint.enabled` | `true` | Revisión en vivo |
| `folio.checks.enabled` | `true` | Revisión del proyecto al guardar |

## Desarrollo

El código de la extensión vive en `extension/` y reutiliza los módulos de Overfree en `../src`
(parser del registro, revisión, SyncTeX, visor PDF, tablas, DOI), así que una mejora en la app
llega también a la extensión.

```bash
npm install            # en la raíz del repo (pdf.js) y en extension/
cd extension
npm test               # pruebas sin VS Code (TeX simulado)
npm run test:integration   # dentro de VS Code con TeX real (xvfb-run si no hay pantalla)
FOLIO_VSIX=folio-latex.vsix npm run test:integration   # lo mismo, con el paquete instalado
FOLIO_SHOTS=/carpeta npm run test:integration          # guarda capturas de pantalla
npm run typecheck
npm run package        # → folio-latex.vsix
```

Para depurarla, abre `extension/` en VS Code y pulsa `F5` (*Run Extension*).

Licencia AGPL-3.0, como Overfree. Incluye código adaptado de Overleaf (AGPL-3.0).
