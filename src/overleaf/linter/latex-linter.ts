// Revisión de LaTeX mientras se escribe (sin compilar): entornos sin cerrar, $ sueltos,
// comandos matemáticos fuera de modo matemático, etc.
// Adaptado de overleaf/.../languages/latex/linter (latex-linter.ts); la conversión de
// errores está en lint-core.ts.
// Copyright (C) Overleaf. Licencia AGPL-3.0 (ver LICENSE).

import type { EditorView } from "@codemirror/view";
import { linter, type Diagnostic } from "@codemirror/lint";
import type { LintError } from "./errors-to-diagnostics";
import { errorsToDiagnostics } from "./lint-core";

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
