// Utilidades sobre el contenido del proyecto: esquema, conteo de palabras,
// ZIP y plantillas.

import { decodeText, encodeText } from "./encoding";
import { strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { isTextPath, type StoredFile } from "./store";

import { stripComments } from "./outline";
export { orderedTexFiles, outline, wordCount, type OutlineItem } from "./outline";

export function toZip(files: StoredFile[]): Uint8Array {
  const z: Zippable = {};
  for (const f of files)
    z[f.path] = f.text !== undefined ? (f.encoding ? encodeText(f.text, f.encoding) : strToU8(f.text)) : (f.data ?? new Uint8Array());
  return zipSync(z, { level: 6 });
}

export function fromZip(bytes: Uint8Array): StoredFile[] {
  const entries = unzipSync(bytes);
  let paths = Object.keys(entries).filter(
    (p) =>
      !p.endsWith("/") &&
      !p.startsWith("__MACOSX/") &&
      !/(^|\/)\.DS_Store$/.test(p) &&
      // nunca importar carpetas internas (.git podría traer configuración peligrosa)
      !/(^|\/)\.(git|folio)(\/|$)/i.test(p),
  );
  // si todo viene dentro de una única carpeta, se quita ese prefijo
  const first = paths[0]?.split("/")[0];
  if (first && paths.every((p) => p.startsWith(first + "/"))) {
    paths = paths.map((p) => p.slice(first.length + 1));
    for (const p of paths) entries[p] = entries[first + "/" + p];
  }
  return paths.map((path) => {
    if (!isTextPath(path)) return { path, data: entries[path] };
    const { text, encoding } = decodeText(entries[path]); // UTF-8 o, si no lo es, Latin-1
    return encoding ? { path, text, encoding } : { path, text };
  });
}

/** Adivina el archivo principal: el que tiene \documentclass, preferiblemente main.tex. */
export function guessMain(files: StoredFile[]): string {
  const docs = files.filter((f) => f.path.endsWith(".tex") && f.text && /\\documentclass/.test(stripComments(f.text)));
  const pref = docs.find((f) => /(^|\/)main\.tex$/.test(f.path)) ?? docs.sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0];
  return pref?.path ?? files.find((f) => f.path.endsWith(".tex"))?.path ?? "main.tex";
}

// ---------- Plantillas ----------

export const TEMPLATES: Record<string, { name: string; files: StoredFile[] }> = {
  article: {
    name: "Artículo",
    files: [
      {
        path: "main.tex",
        text: String.raw`\documentclass[11pt]{article}
\usepackage[spanish]{babel}
\usepackage{amsmath, amssymb}
\usepackage{graphicx}
\usepackage[margin=2.5cm]{geometry}
\usepackage{hyperref}

\title{Título del artículo}
\author{Tu nombre}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
Resumen breve del trabajo.
\end{abstract}

\section{Introducción}
\label{sec:intro}
Texto de la introducción. Ver la ecuación~\eqref{eq:euler}.

\begin{equation}
  e^{i\pi} + 1 = 0
  \label{eq:euler}
\end{equation}

\section{Conclusiones}
Como se dijo en la sección~\ref{sec:intro}\dots

\end{document}
`,
      },
    ],
  },
  report: {
    name: "Informe con bibliografía",
    files: [
      {
        path: "main.tex",
        text: String.raw`\documentclass[12pt]{report}
\usepackage[spanish]{babel}
\usepackage{csquotes}
\usepackage[style=apa]{biblatex}
\addbibresource{referencias.bib}
\usepackage{graphicx}
\usepackage{hyperref}

\title{Informe}
\author{Tu nombre}

\begin{document}
\maketitle
\tableofcontents

\chapter{Introducción}
\input{capitulos/introduccion}

\printbibliography
\end{document}
`,
      },
      {
        path: "capitulos/introduccion.tex",
        text: String.raw`Este informe cita a \textcite{knuth1984}.
`,
      },
      {
        path: "referencias.bib",
        text: `@book{knuth1984,
  author    = {Donald E. Knuth},
  title     = {The TeXbook},
  publisher = {Addison-Wesley},
  year      = {1984}
}
`,
      },
    ],
  },
  beamer: {
    name: "Presentación (Beamer)",
    files: [
      {
        path: "main.tex",
        text: String.raw`\documentclass{beamer}
\usepackage[spanish]{babel}
\usetheme{metropolis}

\title{Mi presentación}
\author{Tu nombre}
\date{\today}

\begin{document}
\frame{\titlepage}

\begin{frame}{Primera diapositiva}
  \begin{itemize}
    \item Punto uno
    \item Punto dos
  \end{itemize}
\end{frame}
\end{document}
`,
      },
    ],
  },
  blank: { name: "En blanco", files: [{ path: "main.tex", text: "\\documentclass{article}\n\\begin{document}\n\n\\end{document}\n" }] },
};
