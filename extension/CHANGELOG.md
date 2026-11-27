# Cambios

## 0.1.8

- **Se actualiza sola** desde GitHub Releases: una vez al día busca una versión nueva, pregunta, descarga el `.vsix` (solo de las releases de este repositorio), lo instala y ofrece recargar la ventana. Ajuste `folio.checkForUpdates` y comando *Overfree: Buscar actualizaciones de la extensión*.

## 0.1.7

- **Abrir proyecto…**: lista los proyectos de la app Overfree (y los de Documentos/Folio) y abre el elegido como carpeta; también «Abrir otra carpeta…». En la vista *Acciones* y en su barra.
- Los botones del editor (Compilar, Ver PDF, Formato LaTeX) desaparecían al hacer clic en el PDF: ahora dependen del archivo del editor, no del foco.
- Si el editor aún no conoce un ajuste nuevo tras actualizar el .vsix, se ofrece *Recargar ventana* en vez de un error.

## 0.1.6

- **Auto**: compilación automática al escribir (botón en la barra de estado o `folio.compileOnType`).
- **Motor en la barra de estado**, con clic para elegir Automático, pdfLaTeX, XeLaTeX o LuaLaTeX.
- **Formato** como en la app: botón *Formato LaTeX* en la barra del editor y en el menú contextual; `Ctrl+B` / `Ctrl+I` en LaTeX.
- **Autocompletado**: comandos, entornos, `\ref` con las etiquetas del proyecto, `\cite` con los `.bib`, archivos y paquetes.
- **Esquema** de secciones (vista Outline, migas de pan, `Ctrl+Shift+O`) y **conteo de palabras**.
- Ajuste de línea (`editor.wordWrap`) activado por defecto en LaTeX.

## 0.1.5

- El visor PDF se veía en blanco en Antigravity (y en VS Code anteriores a ~1.14x): pdf.js usaba funciones de JavaScript que su navegador no tiene. Ahora se usa la versión compatible de pdf.js.
- Si una página no se puede dibujar, el error se muestra en vez de dejar la página en blanco.

## 0.1.4

- Motor automático más listo: los documentos con babel `bidi=basic` u `onchar=` (p. ej. `\babelprovide[import, onchar=ids fonts]`), `luacode` o paquetes `lua*` se compilan con **LuaLaTeX**. Antes iban a XeLaTeX y fallaban.
- Los proyectos de la app Overfree con motor «Automático» (`"engine": "auto"` en `.folio/project.json`) detectan el motor en vez de usar pdfLaTeX.

## 0.1.3

- Folio pasa a llamarse **Overfree**, con logo nuevo (la «O» abierta y el cubículo 246). Los comandos y ajustes (`folio.*`) no cambian: tu configuración se conserva.

## 0.1.2

- Icono de Folio en la barra de actividad (como PlatformIO), con una vista *Acciones*: compilar, ver el PDF, SyncTeX, revisar, tablas, DOI, registro, limpiar y ajustes.

## 0.1.1

- SyncTeX: el doble clic en el PDF podía llevar al archivo equivocado (p. ej. al \input siguiente)
  cuando el párrafo terminaba justo antes de un \section o \input. Ahora manda el carácter pulsado.
- Barra del visor PDF: en paneles estrechos el número de página se partía en varias líneas y el buscador
  se cortaba.
- Pruebas de integración dentro de VS Code con TeX real (`npm run test:integration`).

## 0.1.0

Primera versión: compilación con el TeX del sistema (mismas pasadas que la app Folio, auxiliares en
`.folio/build`), errores traducidos en Problemas, visor PDF con SyncTeX en los dos sentidos, revisión
en vivo y del proyecto, tablas desde Excel/CSV, figuras al soltar imágenes y referencias por DOI.
