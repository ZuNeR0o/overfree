// Utilidades sobre el contenido del proyecto: esquema, conteo de palabras,
// ZIP y plantillas.

import { strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { isTextPath, type StoredFile } from "./store";

// ---------- Esquema ----------

export type OutlineItem = { level: number; title: string; file: string; line: number };

const LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
};

const stripComments = (s: string) => s.replace(/(^|[^\\])%.*$/gm, "$1");

/** Recorre main.tex y los \input/\include en orden. */
export function orderedTexFiles(files: StoredFile[], main: string): StoredFile[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const out: StoredFile[] = [];
  const visit = (path: string, depth: number) => {
    const f = byPath.get(path) ?? byPath.get(path + ".tex");
    if (!f || f.text === undefined || out.includes(f) || depth > 20) return;
    out.push(f);
    const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/") + 1) : "";
    for (const m of stripComments(f.text).matchAll(/\\(?:input|include|subfile)\{([^}]+)\}/g)) {
      const target = m[1].trim();
      visit(target, depth + 1);
      if (dir) visit(dir + target, depth + 1);
    }
  };
  visit(main, 0);
  return out;
}

export function outline(files: StoredFile[], main: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  for (const f of orderedTexFiles(files, main)) {
    const lines = f.text!.split("\n");
    lines.forEach((l, i) => {
      const code = stripComments(l);
      const m = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{(.*)/.exec(code);
      if (!m) return;
      // toma el título respetando llaves anidadas
      let depth = 1;
      let title = "";
      for (const ch of m[2]) {
        if (ch === "{") depth++;
        if (ch === "}" && --depth === 0) break;
        title += ch;
      }
      title = title.replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?/g, "").replace(/[{}$]/g, "").trim();
      items.push({ level: LEVELS[m[1]], title: title || "(sin título)", file: f.path, line: i + 1 });
    });
  }
  return items;
}

// ---------- Conteo de palabras ----------

export function wordCount(files: StoredFile[], main: string) {
  let text = orderedTexFiles(files, main)
    .map((f) => stripComments(f.text!))
    .join("\n");
  const body = /\\begin\{document\}([\s\S]*?)(\\end\{document\}|$)/.exec(text);
  if (body) text = body[1];
  text = text
    .replace(/\\begin\{(equation|align|gather|multline|eqnarray|tikzpicture|verbatim|lstlisting)\*?\}[\s\S]*?\\end\{\1\*?\}/g, " ")
    .replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/g, " ")
    .replace(/\\(label|ref|eqref|cite\w*|includegraphics|input|include|usepackage|begin|end|vspace|hspace)\*?(\[[^\]]*\])?\{[^}]*\}/g, " ")
    .replace(/\\[a-zA-Z@]+\*?/g, " ")
    .replace(/[{}[\]&~\\]/g, " ");
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

// ---------- ZIP ----------

export function toZip(files: StoredFile[]): Uint8Array {
  const z: Zippable = {};
  for (const f of files) z[f.path] = f.text !== undefined ? strToU8(f.text) : (f.data ?? new Uint8Array());
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
  const dec = new TextDecoder();
  return paths.map((path) =>
    isTextPath(path) ? { path, text: dec.decode(entries[path]) } : { path, data: entries[path] },
  );
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
