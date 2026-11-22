// Tablas desde una hoja de cálculo: celdas copiadas de Excel/LibreOffice/Google Sheets
// (texto separado por tabuladores) o archivos .csv/.tsv → tabla LaTeX con booktabs y, si
// el proyecto usa siunitx, columnas S (alineación decimal e incertidumbres).

export type Rows = string[][];

/** Celdas copiadas de una hoja de cálculo (tabuladores). null si no parece una tabla. */
export function parseTsv(text: string): Rows | null {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  if (lines.length < 2 || !lines.every((l) => l.includes("\t"))) return null;
  const rows = lines.map((l) => l.split("\t").map((c) => c.trim()));
  const cols = Math.max(...rows.map((r) => r.length));
  if (cols < 2) return null;
  return rows.map((r) => [...r, ...Array(cols - r.length).fill("")]);
}

/** CSV/TSV con comillas ("a, b"), detectando el separador: tabulador, ; o ,. */
export function parseDelimited(text: string): Rows | null {
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const first = src.split("\n")[0] ?? "";
  const sep = first.includes("\t") ? "\t" : (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: Rows = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell.trim());
  rows.push(row);
  const cols = Math.max(...rows.map((r) => r.length));
  if (rows.length < 1 || cols < 2) return null;
  return rows.map((r) => [...r, ...Array(cols - r.length).fill("")]);
}

// 1.23 · -4,5 · 6.02e23 · 1.23 ± 0.04 · 1.23 +- 0.04 · 1.23(4)
const NUM = /^[+\-−]?(\d+([.,]\d*)?|[.,]\d+)([eE][+\-]?\d+)?(\s*(±|\+-|\\pm)\s*\d+([.,]\d*)?|\(\d+\))?$/;
const isNum = (s: string) => NUM.test(s.trim());

function escapeText(s: string) {
  return s.replace(/[\\&%$#_{}~^]/g, (c) =>
    c === "\\" ? "\\textbackslash{}" : c === "~" ? "\\textasciitilde{}" : c === "^" ? "\\textasciicircum{}" : "\\" + c,
  );
}

export type TableOptions = { siunitx: boolean; booktabs: boolean; indent?: string; wrap?: boolean };

/** Tabla LaTeX lista para pegar (con entorno table) o solo las filas (wrap: false). */
export function toLatexTable(rows: Rows, opts: TableOptions): string {
  const cols = rows[0].length;
  // ¿la primera fila es un encabezado? (texto encima de columnas numéricas)
  const body0 = rows.slice(1);
  const numericCol = (c: number, body: Rows) => {
    const vals = body.map((r) => r[c]).filter((v) => v !== "");
    return vals.length > 0 && vals.every(isNum);
  };
  const header = rows.length > 1 && rows[0].some((v, c) => v !== "" && !isNum(v) && numericCol(c, body0));
  const body = header ? body0 : rows;
  const numeric = Array.from({ length: cols }, (_, c) => numericCol(c, body));

  const fmtNum = (v: string) => {
    const t = v.trim().replace("−", "-");
    if (opts.siunitx) return t.replace(/\s*(±|\+-)\s*/, " +- ");
    return t.replace(/\s*(±|\+-|\\pm)\s*/, " $\\pm$ ");
  };
  const cell = (v: string, c: number, isHead: boolean) => {
    if (isHead) return numeric[c] && opts.siunitx ? `{${escapeText(v)}}` : escapeText(v); // en columnas S van entre llaves
    return numeric[c] && v !== "" ? fmtNum(v) : escapeText(v);
  };
  const lines = [
    ...(header ? [rows[0].map((v, c) => cell(v, c, true))] : []),
    ...body.map((r) => r.map((v, c) => cell(v, c, false))),
  ];
  // columnas alineadas para que el código se lea bien
  const widths = Array.from({ length: cols }, (_, c) => Math.max(...lines.map((l) => [...l[c]].length)));
  const row = (l: string[]) => l.map((v, c) => (c < cols - 1 ? v + " ".repeat(widths[c] - [...v].length) : v)).join(" & ") + " \\\\";
  const [top, mid, bottom] = opts.booktabs ? ["\\toprule", "\\midrule", "\\bottomrule"] : ["\\hline", "\\hline", "\\hline"];
  const ind = opts.indent ?? "";

  const rowsTex = lines.map(row);
  if (opts.wrap === false) return rowsTex.map((r) => ind + r).join("\n");

  const spec = numeric.map((n) => (n ? (opts.siunitx ? "S" : "r") : "l")).join("");
  const t = (n: number) => ind + "  ".repeat(n);
  return [
    `${ind}\\begin{table}[h]`,
    `${t(1)}\\centering`,
    `${t(1)}\\caption{}`,
    `${t(1)}\\label{tab:}`,
    `${t(1)}\\begin{tabular}{${spec}}`,
    `${t(2)}${top}`,
    ...(header ? [`${t(2)}${rowsTex[0]}`, `${t(2)}${mid}`] : []),
    ...rowsTex.slice(header ? 1 : 0).map((r) => `${t(2)}${r}`),
    `${t(2)}${bottom}`,
    `${t(1)}\\end{tabular}`,
    `${ind}\\end{table}`,
  ].join("\n");
}
