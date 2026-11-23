// Barra de herramientas del editor (negrita, cursiva, secciones, listas, fórmulas,
// figura, tabla, referencias...). Los comandos de sección y el diseño general están
// adaptados de overleaf/.../extensions/toolbar (AGPL-3.0); la interfaz es propia de Folio.

import { EditorSelection, type EditorState, type SelectionRange } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { snippet } from "@codemirror/autocomplete";
import { undo, redo, toggleComment } from "@codemirror/commands";
import { openSearchPanel, closeSearchPanel, searchPanelOpen } from "@codemirror/search";
import type { SyntaxNode } from "@lezer/common";

// ---------- Formato de texto (activar / desactivar) ----------

/** Envuelve la selección en \cmd{...} o lo quita si ya está envuelta. */
export const toggleCommand = (cmd: string) => (view: EditorView) => {
  const { state } = view;
  view.dispatch(
    state.changeByRange((r) => {
      const open = `\\${cmd}{`;
      const before = state.sliceDoc(r.from - open.length, r.from);
      const after = state.sliceDoc(r.to, r.to + 1);
      if (before === open && after === "}") {
        // ya tiene el formato: se quita
        return {
          changes: [
            { from: r.from - open.length, to: r.from, insert: "" },
            { from: r.to, to: r.to + 1, insert: "" },
          ],
          range: EditorSelection.range(r.from - open.length, r.to - open.length),
        };
      }
      const text = state.sliceDoc(r.from, r.to);
      return {
        changes: { from: r.from, to: r.to, insert: `${open}${text}}` },
        range: text ? EditorSelection.range(r.from + open.length, r.to + open.length) : EditorSelection.cursor(r.from + open.length),
      };
    }),
  );
  view.focus();
  return true;
};

const wrap = (prefix: string, suffix: string) => (view: EditorView) => {
  view.dispatch(
    view.state.changeByRange((r) => ({
      changes: [
        { from: r.from, insert: prefix },
        { from: r.to, insert: suffix },
      ],
      range: EditorSelection.range(r.from + prefix.length, r.to + prefix.length),
    })),
  );
  view.focus();
  return true;
};

// ---------- Secciones (adaptado de Overleaf toolbar/sections.ts) ----------

const ancestor = (node: SyntaxNode | null, type: string) => {
  for (let n = node; n; n = n.parent) if (n.type.is(type)) return n;
  return null;
};

function rangeInfo(state: EditorState, range: SelectionRange) {
  const tree = syntaxTree(state);
  const from = ancestor(tree.resolveInner(range.from, 1), "SectioningCommand");
  const to = ancestor(tree.resolveInner(range.to, -1), "SectioningCommand");
  const command = from ?? to;
  if (!command || (from && to && from !== to) || (!(from && to) && !range.empty)) return { level: "text" as string };
  const ctrlSeq = command.firstChild;
  if (!ctrlSeq) return { level: "text" };
  return { command, ctrlSeq, level: state.sliceDoc(ctrlSeq.from + 1, ctrlSeq.to).trim() };
}

export const currentSectionLevel = (state: EditorState) => rangeInfo(state, state.selection.main).level.replace(/\*$/, "");

export function setSectionLevel(view: EditorView, level: string) {
  view.dispatch(
    view.state.changeByRange((range) => {
      const info = rangeInfo(view.state, range);
      if (level === info.level) return { range };
      if (level === "text" && info.command) {
        const arg = info.command.getChild("SectioningArgument");
        if (!arg) return { range };
        const content = view.state.sliceDoc(arg.from + 1, arg.to - 1);
        const mapped = range.map(view.state.changes([{ from: info.command.from, to: arg.from + 1, insert: "" }]), 1);
        return { range: mapped, changes: [{ from: info.command.from, to: info.command.to, insert: content }] };
      }
      if (info.level === "text") {
        const line = view.state.doc.lineAt(range.anchor);
        const target = range.empty ? EditorSelection.range(line.from, line.to) : range;
        let prefix = `\\${level}{`;
        let suffix = "}";
        if (!range.empty) {
          if (range.from !== line.from) prefix = "\n" + prefix;
          if (range.to !== line.to) suffix += "\n";
        }
        const content = view.state.sliceDoc(target.from, target.to);
        const mapped = range.map(view.state.changes([{ from: target.from, insert: prefix }]), 1);
        return { range: mapped, changes: [{ from: target.from, to: target.to, insert: prefix + content + suffix }] };
      }
      if (!info.ctrlSeq) return { range };
      const changes = view.state.changes([{ from: info.ctrlSeq.from + 1, to: info.ctrlSeq.to, insert: level }]);
      return { range: range.map(changes), changes };
    }),
    { scrollIntoView: true },
  );
  view.focus();
}

// ---------- Listas ----------

const toggleList = (env: "itemize" | "enumerate") => {
  const envRe = new RegExp(`^\\s*\\\\begin\\{${env}\\}\\n([\\s\\S]*)\\n\\s*\\\\end\\{${env}\\}\\s*$`);
  return (view: EditorView) => {
    const { state } = view;
    const r = state.selection.main;
    const first = state.doc.lineAt(r.from);
    const last = state.doc.lineAt(r.to);
    const text = state.sliceDoc(first.from, last.to);
    const m = envRe.exec(text);
    let insert: string;
    if (m) {
      // quitar la lista
      insert = m[1]
        .split("\n")
        .map((l) => l.replace(/^\s*\\item\s?/, ""))
        .join("\n");
    } else {
      const items = text.split("\n").map((l) => `\t\\item ${l.trim()}`);
      insert = `\\begin{${env}}\n${items.join("\n")}\n\\end{${env}}`;
    }
    const cursor = m ? first.from : first.from + `\\begin{${env}}\n\t\\item `.length;
    view.dispatch({
      changes: { from: first.from, to: last.to, insert },
      selection: text.trim() && !m ? EditorSelection.range(first.from, first.from + insert.length) : EditorSelection.cursor(Math.min(cursor, first.from + insert.length)),
    });
    view.focus();
    return true;
  };
};

// ---------- Inserción de bloques (adaptado de Overleaf toolbar/commands.ts) ----------

function emptyLineBelow(state: EditorState) {
  const line = state.doc.lineAt(state.selection.main.anchor);
  if (!line.text.trim()) return { pos: line.from, suffix: "" };
  const pos = Math.min(line.to + 1, state.doc.length);
  return { pos, suffix: state.doc.lineAt(pos).length ? "\n" : "", prefix: pos === line.to ? "\n" : "" };
}

const insertSnippet = (tpl: string, block = false) => (view: EditorView) => {
  const { state, dispatch } = view;
  if (block) {
    const { pos, suffix, prefix = "" } = emptyLineBelow(state);
    snippet(`${prefix}${tpl}\n${suffix}`)({ state, dispatch }, { label: "" }, pos, pos);
  } else {
    const r = state.selection.main;
    snippet(tpl)({ state, dispatch }, { label: "" }, r.from, r.to);
  }
  view.focus();
  return true;
};

const FIGURE = "\\begin{figure}[h]\n\t\\centering\n\t\\includegraphics[width=0.8\\linewidth]{#{imagen}}\n\t\\caption{#{Título}}\n\t\\label{fig:#{etiqueta}}\n\\end{figure}";
const table = (cols: number, rows: number) =>
  `\\begin{table}[h]\n\t\\centering\n\t\\begin{tabular}{${"c".repeat(cols)}}\n\t\t\\hline\n${(
    "\t\t" + Array.from({ length: cols }, () => "#{}").join(" & ") + " \\\\\n"
  ).repeat(rows)}\t\t\\hline\n\t\\end{tabular}\n\t\\caption{#{Título}}\n\t\\label{tab:#{etiqueta}}\n\\end{table}`;

// ---------- Construcción de la barra ----------

type Icon = (name: string) => string;

export type ToolbarExtra = { icon: string; title: string; run: () => void };

export function mountToolbar(root: HTMLElement, getView: () => EditorView, icon: Icon, extras: ToolbarExtra[] = []) {
  const btn = (ic: string, title: string, run: (v: EditorView) => unknown) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tb-btn";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.innerHTML = icon(ic);
    b.addEventListener("mousedown", (e) => e.preventDefault()); // no quitar el foco al editor
    b.addEventListener("click", () => run(getView()));
    return b;
  };
  const sep = () => Object.assign(document.createElement("span"), { className: "tb-sep" });

  const section = document.createElement("select");
  section.className = "tb-select";
  section.title = "Nivel de sección";
  for (const [v, t] of [
    ["text", "Texto normal"],
    ["part", "Parte"],
    ["chapter", "Capítulo"],
    ["section", "Sección"],
    ["subsection", "Subsección"],
    ["subsubsection", "Subsubsección"],
    ["paragraph", "Párrafo"],
  ]) section.append(new Option(t, v));
  section.addEventListener("change", () => setSectionLevel(getView(), section.value));

  // tamaño de tabla
  const tableBtn = btn("table", "Insertar tabla", () => {
    grid.hidden = !grid.hidden;
  });
  const grid = document.createElement("div");
  grid.className = "tb-grid";
  grid.hidden = true;
  const gridLabel = document.createElement("div");
  gridLabel.className = "tb-grid-label";
  const cells: HTMLButtonElement[] = [];
  for (let r = 1; r <= 6; r++)
    for (let c = 1; c <= 6; c++) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.dataset.r = String(r);
      cell.dataset.c = String(c);
      cell.addEventListener("mouseenter", () => {
        cells.forEach((x) => x.classList.toggle("on", +x.dataset.r! <= r && +x.dataset.c! <= c));
        gridLabel.textContent = `${c} × ${r}`;
      });
      cell.addEventListener("mousedown", (e) => e.preventDefault());
      cell.addEventListener("click", () => {
        grid.hidden = true;
        insertSnippet(table(c, r), true)(getView());
      });
      cells.push(cell);
    }
  grid.append(...cells, gridLabel);
  document.addEventListener("click", (e) => {
    if (!grid.hidden && !grid.contains(e.target as Node) && !tableBtn.contains(e.target as Node)) grid.hidden = true;
  });
  const tableWrap = document.createElement("span");
  tableWrap.className = "tb-wrap";
  tableWrap.append(tableBtn, grid);

  root.replaceChildren(
    btn("undo", "Deshacer (Ctrl+Z)", (v) => undo(v)),
    btn("redo", "Rehacer (Ctrl+Y)", (v) => redo(v)),
    sep(),
    section,
    sep(),
    btn("bold", "Negrita (Ctrl+B)", toggleCommand("textbf")),
    btn("italic", "Cursiva (Ctrl+I)", toggleCommand("textit")),
    btn("underline", "Subrayado", toggleCommand("underline")),
    sep(),
    btn("math", "Fórmula en línea \\( \\)", wrap("\\(", "\\)")),
    btn("math-display", "Fórmula centrada \\[ \\]", wrap("\n\\[\n\t", "\n\\]\n")),
    sep(),
    btn("link", "Enlace", insertSnippet("\\href{#{url}}{#{texto}}")),
    btn("ref", "Referencia cruzada (\\ref)", insertSnippet("\\ref{#{}}")),
    btn("quote", "Cita bibliográfica (\\cite)", insertSnippet("\\cite{#{}}")),
    ...extras.map((x) => btn(x.icon, x.title, () => x.run())),
    sep(),
    btn("photo", "Insertar figura", insertSnippet(FIGURE, true)),
    tableWrap,
    btn("list", "Lista con viñetas", toggleList("itemize")),
    btn("list-numbers", "Lista numerada", toggleList("enumerate")),
    sep(),
    btn("comment", "Comentar / descomentar (Ctrl+/)", (v) => toggleComment(v)),
    btn("search", "Buscar y reemplazar (Ctrl+F)", (v) => (searchPanelOpen(v.state) ? closeSearchPanel(v) : openSearchPanel(v))),
  );

  return {
    /** Refleja en el selector el nivel de sección donde está el cursor. */
    update(state: EditorState) {
      const lvl = currentSectionLevel(state);
      section.value = [...section.options].some((o) => o.value === lvl) ? lvl : "text";
    },
  };
}
