// Esquema, orden de los archivos (\input/\include) y conteo de palabras. Sin dependencias:
// lo usan la app (src/project.ts) y la extensión de VS Code.

export type TexFile = { path: string; text?: string };

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

export const stripComments = (s: string) => s.replace(/(^|[^\\])%.*$/gm, "$1");

/** Recorre main.tex y los \input/\include en orden. */
export function orderedTexFiles<F extends TexFile>(files: F[], main: string): F[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const out: F[] = [];
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

export function outline(files: TexFile[], main: string): OutlineItem[] {
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

export function wordCount(files: TexFile[], main: string) {
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
