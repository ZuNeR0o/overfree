// Revisión de LaTeX mientras se escribe (sin compilar): entornos sin cerrar, $ sueltos,
// comandos matemáticos fuera de modo matemático, etc.
// Adaptado de overleaf/.../languages/latex/linter (latex-linter.ts,
// errors-to-diagnostics.ts, merge-overlapping-diagnostics.ts).
// Copyright (C) Overleaf. Licencia AGPL-3.0 (ver LICENSE).

import type { EditorView } from "@codemirror/view";
import { linter, type Diagnostic } from "@codemirror/lint";

type LintError = {
  startPos: number;
  endPos: number;
  pos: number;
  suppressIfEditing?: boolean;
  type: "info" | "warning" | "error";
  text: string;
};

// ---------- Traducción de mensajes ----------

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

const translate = (msg: string) => {
  for (const [re, out] of rules) if (re.test(msg)) return msg.replace(re, out);
  return msg;
};

// ---------- Conversión a diagnósticos de CodeMirror ----------

const intersects = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];

function errorsToDiagnostics(errors: LintError[], cursor: number, docLength: number): Diagnostic[] {
  const out: Diagnostic[] = [];
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
    out.push({ from, to, severity: e.type, message: translate(e.text), source: "Revisión" });
  }
  // une avisos iguales que se tocan
  out.sort((a, b) => a.from - b.from);
  const merged: Diagnostic[] = [];
  for (const d of out) {
    const prev = merged.findLast((m) => m.message === d.message && m.severity === d.severity);
    if (prev && d.from <= prev.to) prev.to = Math.max(prev.to, d.to);
    else merged.push({ ...d });
  }
  return merged;
}

// ---------- Worker ----------

let worker: Worker | null = null;
let pending: ((errors: LintError[]) => void) | null = null;

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./latex-linter.worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (ev) => {
      pending?.((ev.data?.errors as LintError[]) ?? []);
      pending = null;
    });
  }
  return worker;
}

async function lintView(view: EditorView): Promise<Diagnostic[]> {
  const text = view.state.doc.toString();
  const errors = await new Promise<LintError[]>((resolve) => {
    pending?.([]); // descarta una petición anterior sin responder
    pending = resolve;
    getWorker().postMessage({ text });
  });
  const st = view.state;
  return errorsToDiagnostics(errors, st.selection.main.head, st.doc.length);
}

/**
 * Extensión de CodeMirror: revisa el documento ~0,8 s después de dejar de escribir.
 * `extra` aporta los diagnósticos de la última compilación, para mostrar ambos juntos.
 */
export const latexLinter = (enabled: (view: EditorView) => boolean, extra: (view: EditorView) => Diagnostic[]) =>
  linter(async (view) => [...(enabled(view) ? await lintView(view) : []), ...extra(view)], { delay: 800 });
