// Utilidades de texto para navegación, hover y correcciones rápidas (sin vscode: se prueban en Node).

/** Corrección de un aviso de la revisión del proyecto a partir del texto que señala, o null. */
export function quickFix(marked: string): { title: string; text: string } | null {
  if (/^[a-z]+$/.test(marked)) return { title: `Cambiar por \\${marked}`, text: `\\${marked}` };
  const dd = /^\$\$([\s\S]*)\$\$$/.exec(marked);
  if (dd) return { title: "Cambiar $$ … $$ por \\[ … \\]", text: `\\[${dd[1]}\\]` };
  const q = /^"([^"\n]*)"$/.exec(marked);
  if (q) return { title: "Usar comillas de LaTeX ``…''", text: `\`\`${q[1]}''` };
  return null;
}

/** Fin (línea y columna desde 0) de un tramo de `length` caracteres que empieza en line/col de `text`. */
export function endOf(text: string, line: number, col: number, length: number) {
  const lines = text.split("\n");
  let l = line;
  let c = col + length;
  while (l < lines.length - 1 && c > lines[l].length) {
    c -= lines[l].length + 1;
    l++;
  }
  return { line: l, col: c };
}

/** Argumento de \cmd{a,b,c} bajo la columna `ch` de `line`: comando, clave y sus columnas. */
export function argAt(line: string, ch: number): { cmd: string; key: string; start: number; end: number } | null {
  for (const m of line.matchAll(/\\([A-Za-z]+)\*?\s*(?:\[[^\]]*\]\s*)*\{([^}]*)\}/g)) {
    const open = m.index! + m[0].length - m[2].length - 2; // posición de la «{» (el match acaba en «}»)
    if (ch <= open || ch > open + m[2].length + 1) continue;
    let start = open + 1;
    for (const part of m[2].split(",")) {
      const end = start + part.length;
      if (ch >= start && ch <= end) {
        const lead = part.length - part.trimStart().length;
        const key = part.trim();
        return key ? { cmd: m[1], key, start: start + lead, end: start + lead + key.length } : null;
      }
      start = end + 1;
    }
  }
  return null;
}

type Src = { path: string; text: string };

/** Primer \label{key} del proyecto: archivo y línea (desde 0). */
export function findLabel(texts: Src[], key: string) {
  for (const f of texts) {
    const lines = f.text.split("\n");
    const i = lines.findIndex((l) => l.replace(/(^|[^\\])%.*$/, "$1").includes(`\\label{${key}}`));
    if (i >= 0) return { path: f.path, line: i, lines };
  }
  return null;
}

/** Entrada @tipo{key, …} de los .bib: archivo, línea (desde 0) y campos principales. */
export function findBibEntry(bibs: Src[], key: string) {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const f of bibs) {
    const m = new RegExp(`@(\\w+)\\s*\\{\\s*${esc}\\s*,([\\s\\S]*?)(?=\\n\\s*@|$)`).exec(f.text);
    if (!m) continue;
    const field = (name: string) =>
      new RegExp(`\\b${name}\\s*=\\s*[{"]?([^\\n]*?)[}"]?\\s*,?\\s*$`, "im").exec(m[2])?.[1].replace(/[{}]/g, "").trim() ?? "";
    return {
      path: f.path,
      line: f.text.slice(0, m.index).split("\n").length - 1,
      type: m[1].toLowerCase(),
      author: field("author"),
      title: field("title"),
      year: field("year"),
      venue: field("journal") || field("booktitle") || field("publisher"),
    };
  }
  return null;
}
