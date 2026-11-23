// Parte pura de la revisión en vivo: traduce los errores del linter de Overleaf y los
// convierte en rangos. La usan el editor (CodeMirror) y la extensión de VS Code.
// Adaptado de overleaf/.../languages/latex/linter (errors-to-diagnostics.ts,
// merge-overlapping-diagnostics.ts). Copyright (C) Overleaf. Licencia AGPL-3.0 (ver LICENSE).

import type { LintError } from "./errors-to-diagnostics";

export type LintDiagnostic = { from: number; to: number; severity: LintError["type"]; message: string; source: string };

const rules: [RegExp, string][] = [
  [/^unclosed group \{$/, "Llave { sin cerrar"],
  [/^unclosed (.+) found at (.+)$/, "$1 sin cerrar (encontrado $2)"],
  [/^unclosed (.+)$/, "$1 sin cerrar"],
  [/^unexpected (.+) after (.+)$/, "$1 inesperado después de $2"],
  [/^unexpected (.+)$/, "$1 inesperado"],
  [/^(.+) must be inside math mode$/, "$1 solo se puede usar en modo matemático"],
  [/^(.+) used inside math mode$/, "$1 no se puede usar en modo matemático"],
  [/^(.+) not inside math mode$/, "$1 fuera del modo matemático"],
  [/^(.+) used inside existing math mode (.+)$/, "$1 dentro de un modo matemático ya abierto ($2)"],
  [/^\\left can only be used in math mode$/, "\\left solo se puede usar en modo matemático"],
  [/^(.+) is followed by unexpected end group \}$/, "Sobra una } después de $1"],
  [/^(.+) is followed by unexpected content$/, "Hay contenido después de $1"],
  [/^(.+) used inside an? (.+)$/, "$1 no se puede usar dentro de $2"],
];

export const translateLint = (msg: string) => {
  for (const [re, out] of rules) if (re.test(msg)) return msg.replace(re, out);
  return msg;
};

const intersects = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];

/** `cursor`: posición del cursor (oculta el error que se está escribiendo); -1 si no hay. */
export function errorsToDiagnostics(errors: LintError[], cursor: number, docLength: number): LintDiagnostic[] {
  const out: LintDiagnostic[] = [];
  const atEnd = cursor === docLength;
  const suppressions: [number, number][] = [];
  for (const e of errors) {
    const range: [number, number] = [e.startPos, e.endPos];
    if (range[0] > docLength || range[1] > docLength) continue;
    const inRange = cursor >= range[0] && cursor <= range[1];
    const atStart = cursor === range[0] + 1;
    const atStop = cursor === range[1];
    // mientras se escribe al principio o final del error, no se muestra
    if (e.suppressIfEditing && (atStart || atStop)) {
      suppressions.push(range);
      continue;
    }
    if (suppressions.some((s) => intersects(s, range))) continue; // error en cascada
    const errorAtStart = e.pos === e.startPos;
    const from = inRange && !errorAtStart && !atEnd ? cursor : range[0];
    const to = inRange && errorAtStart && !atEnd ? cursor : range[1];
    out.push({ from, to, severity: e.type, message: translateLint(e.text), source: "Revisión" });
  }
  // une avisos iguales que se tocan
  out.sort((a, b) => a.from - b.from);
  const merged: LintDiagnostic[] = [];
  for (const d of out) {
    const prev = merged.findLast((m) => m.message === d.message && m.severity === d.severity);
    if (prev && d.from <= prev.to) prev.to = Math.max(prev.to, d.to);
    else merged.push({ ...d });
  }
  return merged;
}
