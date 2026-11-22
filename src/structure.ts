// Edición estructural de LaTeX:
//  - Al cambiar el nombre en \begin{…}, su \end{…} se actualiza a la vez.
//  - Enter dentro de itemize/enumerate/description añade un \item; en un \item vacío
//    sale de la lista.
//  - Alinear las columnas & de tablas, align y matrices.

import { Annotation, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, type KeyBinding } from "@codemirror/view";

/** Marca los cambios hechos por la sincronización (para no reaccionar a ellos). */
const syncAnnotation = Annotation.define<boolean>();

const ENV_RE = /\\(begin|end)\s*\{([^}\n]*)\}/g;

/** Posición del % que inicia un comentario en la línea (con número par de \ antes), o -1. */
function commentStart(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "%") continue;
    let bs = 0;
    for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) bs++;
    if (bs % 2 === 0) return i;
  }
  return -1;
}

/** Copia del texto con los comentarios sustituidos por espacios (mismas posiciones). */
function maskComments(text: string): string {
  return text
    .split("\n")
    .map((l) => {
      const c = commentStart(l);
      return c < 0 ? l : l.slice(0, c) + " ".repeat(l.length - c);
    })
    .join("\n");
}

/** Busca el \end{name} que cierra un \begin{name} que termina en `from` (ignora comentarios). */
function findMatchingEnd(rawText: string, from: number, name: string): { start: number; end: number } | null {
  const text = maskComments(rawText);
  ENV_RE.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  const limit = from + 400_000;
  while ((m = ENV_RE.exec(text)) && m.index < limit) {
    if (m[2] !== name) continue;
    depth += m[1] === "begin" ? 1 : -1;
    if (depth === 0) {
      const nameStart = m.index + m[0].indexOf("{") + 1;
      return { start: nameStart, end: nameStart + m[2].length };
    }
  }
  return null;
}

/** El \begin{…} de la línea cuyo nombre contiene la posición `pos`. */
function beginAt(state: EditorState, pos: number) {
  const line = state.doc.lineAt(pos);
  const cs = commentStart(line.text);
  if (cs >= 0 && pos - line.from > cs) return null; // dentro de un comentario
  const re = /\\begin\s*\{([^}\n]*)\}?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line.text))) {
    const nameStart = line.from + m.index + m[0].indexOf("{") + 1;
    const nameEnd = nameStart + m[1].length;
    if (pos >= nameStart && pos <= nameEnd) {
      const closed = state.sliceDoc(nameEnd, nameEnd + 1) === "}";
      return { nameStart, nameEnd, name: m[1], closed };
    }
  }
  return null;
}

const syncBeginEnd = EditorView.updateListener.of((u) => {
  if (!u.docChanged || u.transactions.some((tr) => tr.annotation(syncAnnotation))) return;
  if (!u.transactions.some((tr) => tr.isUserEvent("input") || tr.isUserEvent("delete"))) return;
  const sel = u.state.selection.main;
  if (!sel.empty) return;
  const now = beginAt(u.state, sel.head);
  if (!now || !now.closed) return;
  // el mismo \begin antes del cambio
  const oldPos = u.changes.invertedDesc.mapPos(now.nameStart, -1);
  const before = beginAt(u.startState, oldPos);
  if (!before || !before.closed || before.name === now.name) return;
  const oldText = u.startState.doc.toString();
  const oldEnd = findMatchingEnd(oldText, before.nameEnd + 1, before.name);
  if (!oldEnd) return;
  // posición de ese \end en el documento nuevo (el cambio fue antes, en el \begin)
  const start = u.changes.mapPos(oldEnd.start, 1);
  const end = u.changes.mapPos(oldEnd.end, -1);
  if (u.state.sliceDoc(start, end) !== before.name) return;
  const view = u.view;
  queueMicrotask(() => {
    if (view.state.sliceDoc(start, end) !== before.name) return;
    view.dispatch({ changes: { from: start, to: end, insert: now.name }, annotations: [syncAnnotation.of(true)], userEvent: "input.sync" });
  });
});

// ---------- Enter en listas ----------

const LIST_ENVS = new Set(["itemize", "enumerate", "description"]);

/** Entornos abiertos antes de `pos` (el último es el más interior), ignorando comentarios. */
export function openEnvsAt(rawText: string, pos: number): { name: string; end: number }[] {
  const text = maskComments(rawText.slice(0, pos));
  const stack: { name: string; end: number }[] = [];
  ENV_RE.lastIndex = Math.max(0, pos - 100_000);
  let m: RegExpExecArray | null;
  while ((m = ENV_RE.exec(text))) {
    if (m[1] === "begin") stack.push({ name: m[2], end: m.index + m[0].length });
    else {
      const i = stack.map((s) => s.name).lastIndexOf(m[2]);
      if (i >= 0) stack.length = i;
    }
  }
  return stack;
}

const enterInList = (view: EditorView): boolean => {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(sel.head);
  const m = /^(\s*)\\item\b(\[[^\]]*\])?\s*(.*)$/.exec(line.text);
  if (!m) return false;
  const text = state.doc.toString();
  const env = openEnvsAt(text, line.from).at(-1);
  if (!env || !LIST_ENVS.has(env.name)) return false;
  const [, indent, label, rest] = m;
  // \item[Término] sin texto: Enter normal (la descripción se escribe en la línea siguiente)
  if (label && !rest.trim()) return false;
  // \item vacío (sin etiqueta [..]): se quita y se sale de la lista.
  // \item[Término] sin texto NO se borra: es normal escribir la descripción debajo.
  if (!rest.trim() && !label && sel.head === line.to) {
    const close = findMatchingEnd(text, env.end, env.name); // respeta listas anidadas
    if (!close) return false;
    const endLine = state.doc.lineAt(close.start);
    const removeTo = Math.min(line.to + 1, state.doc.length);
    const changes = state.changes([
      { from: line.from, to: removeTo, insert: "" },
      { from: endLine.to, insert: "\n" },
    ]);
    // cursor en la línea nueva, justo después de \end{lista}
    view.dispatch({ changes, selection: { anchor: changes.mapPos(endLine.to, -1) + 1 }, scrollIntoView: true, userEvent: "input" });
    return true;
  }
  const ins = `\n${indent}\\item `;
  view.dispatch(state.update({ changes: { from: sel.head, insert: ins }, selection: { anchor: sel.head + ins.length }, scrollIntoView: true, userEvent: "input" }));
  return true;
};

// ---------- Alinear columnas & ----------

const ALIGN_ENVS = /^(tabular\*?|tabularx|tabulary|longtable|array|align\*?|alignat\*?|flalign\*?|eqnarray\*?|split|aligned|alignedat|cases|dcases|[pbBvV]?matrix|smallmatrix)$/;

/** Alinea las & del entorno (tabla, align, matriz…) donde está el cursor. */
export function alignColumns(view: EditorView): boolean {
  const { state } = view;
  const text = state.doc.toString();
  const pos = state.selection.main.head;
  // entorno alineable más cercano que contenga el cursor
  const env = [...openEnvsAt(text, pos)].reverse().find((s) => ALIGN_ENVS.test(s.name));
  if (!env) return false;
  const close = findMatchingEnd(text, env.end, env.name);
  if (!close) return false;
  const bodyFrom = state.doc.lineAt(env.end).to + 1;
  const bodyTo = state.doc.lineAt(close.start).from - 1;
  if (bodyTo <= bodyFrom) return false;

  const lines = state.sliceDoc(bodyFrom, bodyTo).split("\n");
  // separa por & reales: no \& (escapado), pero sí \\& (salto de línea seguido de &)
  const splitCells = (s: string) => {
    const cells: string[] = [];
    let cur = "";
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "&") {
        let bs = 0;
        for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) bs++;
        if (bs % 2 === 0) {
          cells.push(cur.trim());
          cur = "";
          continue;
        }
      }
      cur += s[i];
    }
    cells.push(cur.trim());
    return cells;
  };
  const rows = lines.map((l) => {
    // el comentario final (% …) no se toca ni cuenta para las columnas
    const c = commentStart(l);
    const code = c < 0 ? l : l.slice(0, c);
    const comment = c < 0 ? "" : l.slice(c);
    const cells = splitCells(code.trim());
    if (cells.length < 2) return null;
    return { indent: /^\s*/.exec(l)![0], cells, comment };
  });
  const widths: number[] = [];
  for (const r of rows) r?.cells.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, [...c].length)));
  const out = lines.map((l, k) => {
    const r = rows[k];
    if (!r) return l;
    const body = r.cells.map((c, i) => (i < r.cells.length - 1 ? c + " ".repeat(widths[i] - [...c].length) : c)).join(" & ");
    return r.indent + body + (r.comment ? " " + r.comment : "");
  });
  const insert = out.join("\n");
  if (insert === state.sliceDoc(bodyFrom, bodyTo)) return true;
  view.dispatch({ changes: { from: bodyFrom, to: bodyTo, insert }, userEvent: "input.format" });
  return true;
}

export const structureKeymap: KeyBinding[] = [
  { key: "Enter", run: enterInList },
  { key: "Mod-Alt-a", run: alignColumns },
];

export const structureEditing: Extension = [syncBeginEnd];
