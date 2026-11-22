// Revisión del proyecto completo sin compilar: etiquetas repetidas entre capítulos,
// \ref y \cite rotos, imágenes o archivos que no existen, funciones matemáticas sin barra
// (sin → \sin), comillas rectas y $$…$$. Complementa a la revisión en vivo, que solo mira
// la sintaxis del archivo abierto.

import type { Problem } from "./logparse";
import type { StoredFile } from "./store";
import { extractBibEntries } from "./complete";

const SOURCE = "Proyecto";
const MAX_PER_KIND = 40; // para no inundar la lista en proyectos grandes

/** Sustituye por espacios (mismas posiciones) los comentarios y el contenido literal. */
function mask(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  // primero el código literal: en \verb|%| el % no inicia un comentario
  let out = text
    .replace(/\\begin\{(verbatim\*?|lstlisting|minted|comment)\}[\s\S]*?\\end\{\1\}/g, blank)
    .replace(/\\lstinline\*?(\[[^\]]*\])?\{[^}\n]*\}/g, blank) // \lstinline{…}
    .replace(/\\(verb|lstinline)\*?([^\sA-Za-z{])(.*?)\2/g, blank); // \verb|…|, \lstinline!…!
  out = out
    .split("\n")
    .map((l) => {
      for (let i = 0; i < l.length; i++) {
        if (l[i] !== "%") continue;
        let bs = 0;
        for (let j = i - 1; j >= 0 && l[j] === "\\"; j--) bs++;
        if (bs % 2 === 0) return l.slice(0, i) + " ".repeat(l.length - i);
      }
      return l;
    })
    .join("\n");
  return out;
}

const lineAt = (text: string, idx: number) => {
  let n = 1;
  for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

/** Zonas matemáticas: $…$, $$…$$, \(…\), \[…\] y entornos equation/align/gather… */
function mathRanges(t: string): [number, number][] {
  const out: [number, number][] = [];
  const envs = /\\begin\{(equation|align|alignat|gather|multline|flalign|eqnarray|math|displaymath)(\*?)\}([\s\S]*?)\\end\{\1\2\}/g;
  for (const m of t.matchAll(envs)) out.push([m.index!, m.index! + m[0].length]);
  for (const m of t.matchAll(/\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)/g)) out.push([m.index!, m.index! + m[0].length]);
  for (const m of t.matchAll(/(?<!\\)\$\$([\s\S]*?)(?<!\\)\$\$|(?<![\\$])\$(?!\$)((?:\\.|[^$\\])+?)(?<!\\)\$/g)) out.push([m.index!, m.index! + m[0].length]);
  return out.sort((a, b) => a[0] - b[0]);
}

const inRanges = (rs: [number, number][], i: number) => rs.some(([a, b]) => i >= a && i < b);

export function checkProject(files: StoredFile[]): Problem[] {
  const tex = files
    .filter((f) => f.text !== undefined && /\.(tex|ltx)$/i.test(f.path))
    .map((f) => ({ path: f.path, raw: f.text!, t: mask(f.text!) }));
  const paths = new Set(files.map((f) => f.path.toLowerCase()));
  const out: Problem[] = [];
  const counts = new Map<string, number>();
  const add = (kind: string, p: Omit<Problem, "source">) => {
    const n = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, n);
    if (n <= MAX_PER_KIND) out.push({ ...p, source: SOURCE });
  };

  // ---------- etiquetas ----------
  const labels = new Map<string, { file: string; line: number }[]>();
  for (const f of tex)
    for (const m of f.t.matchAll(/\\label\s*\{([^}#]+)\}/g)) {
      const key = m[1].trim();
      labels.set(key, [...(labels.get(key) ?? []), { file: f.path, line: lineAt(f.t, m.index!) }]);
    }
  for (const [key, where] of labels)
    if (where.length > 1)
      for (const w of where) {
        const others = where.filter((o) => o !== w).map((o) => `${o.file}:${o.line}`);
        add("dup", { level: "warning", message: `Etiqueta «${key}» repetida (también en ${others.join(", ")}): \\ref apuntará a solo una.`, ...w });
      }

  // ---------- referencias ----------
  for (const f of tex)
    for (const m of f.t.matchAll(/\\(ref|eqref|pageref|autoref|cref|Cref|vref|nameref|labelcref|cpageref)\*?\s*\{([^}#]+)\}/g))
      for (const key of m[2].split(",").map((k) => k.trim()).filter(Boolean))
        if (!labels.has(key))
          add("ref", { level: "warning", message: `\\${m[1]}{${key}}: no hay ningún \\label{${key}} en el proyecto (saldrá «??»).`, file: f.path, line: lineAt(f.t, m.index!) });

  // ---------- citas ----------
  const bibKeys = new Set(extractBibEntries(files.filter((f) => f.path.endsWith(".bib")).map((f) => f.text ?? "")).map((e) => e.key));
  for (const f of tex) for (const m of f.t.matchAll(/\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) bibKeys.add(m[1].trim());
  const citeRe = /\\(?:[Pp]arencite|[Tt]extcite|[Aa]utocite|[Ff]ootcite|[Cc]ite[pt]?|citeauthor|citeyear|smartcite|supercite|nocite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}#]+)\}/g;
  let anyCite: { file: string; line: number } | null = null;
  for (const f of tex)
    for (const m of f.t.matchAll(citeRe)) {
      anyCite ??= { file: f.path, line: lineAt(f.t, m.index!) };
      if (!bibKeys.size) continue;
      for (const key of m[1].split(",").map((k) => k.trim()).filter((k) => k && k !== "*"))
        if (!bibKeys.has(key))
          add("cite", { level: "warning", message: `Cita «${key}»: no está en ningún .bib ni \\bibitem (saldrá «?»).`, file: f.path, line: lineAt(f.t, m.index!) });
    }
  if (anyCite && !bibKeys.size) add("nobib", { level: "warning", message: "Hay citas (\\cite) pero el proyecto no tiene ningún .bib ni thebibliography.", ...anyCite });

  // ---------- imágenes y archivos incluidos ----------
  const graphicsDirs = new Set<string>([""]);
  for (const f of tex) for (const m of f.t.matchAll(/\\graphicspath\s*\{((?:\{[^}]*\}\s*)+)\}/g)) for (const d of m[1].matchAll(/\{([^}]*)\}/g)) graphicsDirs.add(d[1].replace(/^\.\//, ""));
  const exists = (p: string) => paths.has(p.replace(/^\.\//, "").toLowerCase());
  for (const f of tex) {
    const here = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/") + 1) : "";
    for (const m of f.t.matchAll(/\\includegraphics\*?\s*(?:\[[^\]]*\])?\s*\{([^}#]+)\}/g)) {
      const name = m[1].trim();
      const bases = [...graphicsDirs].flatMap((d) => [d + name, here + d + name]);
      const found = bases.some((b) => exists(b) || ["pdf", "png", "jpg", "jpeg", "eps", "svg"].some((e) => exists(`${b}.${e}`)));
      if (!found) add("img", { level: "warning", message: `\\includegraphics{${name}}: la imagen no está en el proyecto.`, file: f.path, line: lineAt(f.t, m.index!) });
    }
    for (const m of f.t.matchAll(/\\(input|include|subfile)\s*\{([^}#]+)\}/g)) {
      const name = m[2].trim();
      const cands = [name, `${name}.tex`, here + name, `${here}${name}.tex`];
      if (!cands.some(exists)) add("inc", { level: "warning", message: `\\${m[1]}{${name}}: el archivo no está en el proyecto.`, file: f.path, line: lineAt(f.t, m.index!) });
    }
  }

  // ---------- estilo matemático y tipográfico ----------
  for (const f of tex) {
    const math = mathRanges(f.t);
    // texto dentro de \text{…}, \mathrm{…}… no es matemática (sin ahí puede ser una palabra)
    const plainInMath = f.t.replace(/\\(text\w*|mathrm|operatorname\*?|mbox|textrm|label|ref|eqref)\s*\{[^{}]*\}/g, (m) => " ".repeat(m.length));
    for (const m of plainInMath.matchAll(/(?<![\\A-Za-z])(sin|cos|tan|cot|sec|csc|sinh|cosh|tanh|arcsin|arccos|arctan|log|ln|exp|lim|max|min|sup|inf|det|deg|gcd)(?![A-Za-z])/g))
      if (inRanges(math, m.index!))
        add("fn", { level: "info", message: `Escribe \\${m[1]} en vez de ${m[1]}: sin la barra se ve en cursiva, como un producto de variables.`, file: f.path, line: lineAt(f.t, m.index!) });
    const dd = /(?<!\\)\$\$/.exec(f.t); // con un aviso por archivo basta
    if (dd) add("dd", { level: "info", message: "$$ … $$ es obsoleto en LaTeX: usa \\[ … \\] (espaciado correcto).", file: f.path, line: lineAt(f.t, dd.index) });
    for (const m of f.t.matchAll(/"([^"\n]{1,120})"/g))
      if (!inRanges(math, m.index!))
        add("q", { level: "info", message: `Comillas rectas en "${m[1].slice(0, 30)}": usa \`\`…'' o \\enquote{…} (con csquotes).`, file: f.path, line: lineAt(f.t, m.index!) });
  }

  return out;
}
