// Autocompletado de LaTeX: comandos, entornos, \ref, \cite, archivos y paquetes.

import {
  insertCompletionText,
  snippetCompletion as snip,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { CMDS, ENVS, PACKAGES, SYMBOLS } from "./latexdata";

/**
 * El editor cierra las llaves solo (\begin{|}). La sugerencia debe sustituir también esa
 * "}" sobrante, pero sin incluirla en el rango de la sugerencia: CodeMirror filtra las
 * opciones con ese texto y, con "}", no coincidía ninguna (no aparecía la lista).
 */
const eatClosingBrace = (c: Completion): Completion => ({
  ...c,
  apply: (view: EditorView, completion: Completion, from: number, to: number) => {
    const end = view.state.sliceDoc(to, to + 1) === "}" ? to + 1 : to;
    const a = c.apply;
    if (typeof a === "function") a(view, completion, from, end);
    else view.dispatch(insertCompletionText(view.state, a ?? c.label, from, end));
  },
});

export type ProjectIndex = {
  labels: () => string[];
  citations: () => { key: string; info: string }[];
  files: () => string[];
};

const cmdOptions: Completion[] = [
  ...CMDS.map(([n, tpl, detail]) =>
    tpl ? snip("\\" + tpl, { label: "\\" + n, detail, type: "function" }) : { label: "\\" + n, type: "function", detail },
  ),
  ...SYMBOLS.map((s) => ({ label: "\\" + s, type: "constant" })),
  snip("\\begin{${env}}\n\t${}\n\\end{${env}}", { label: "\\begin", type: "keyword", detail: "Entorno" }),
];

// los entornos más usados aparecen primero aunque no se haya escrito nada
const ENV_BOOST: Record<string, number> = { equation: 9, align: 8, figure: 7, itemize: 6, enumerate: 5, table: 4, "equation*": 3, "align*": 3, tabular: 2, center: 1 };

const envOptions: Completion[] = ENVS.map(([e, body]) =>
  eatClosingBrace(snip(`${e}}\n${body ?? "\t${}"}\n\\end{${e}}`, { label: e, type: "type", boost: ENV_BOOST[e] ?? 0 })),
);

const ARG_RE = /\\(\w+)\*?(?:\[[^\]]*\])?\{([^{}]*)$/;

export function latexCompletions(index: ProjectIndex) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);

    // Dentro de un argumento: \cmd{...|
    const arg = ARG_RE.exec(before);
    if (arg) {
      const [, cmd, typed] = arg;
      // admite varias claves separadas por comas
      const lastComma = typed.lastIndexOf(",");
      const from = ctx.pos - (typed.length - lastComma - 1);
      let options: Completion[] | null = null;
      if (cmd === "begin" || cmd === "end") {
        if (cmd === "end") {
          // cierra el entorno abierto más reciente
          const text = ctx.state.sliceDoc(0, ctx.pos);
          const stack: string[] = [];
          for (const m of text.matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
            if (m[1] === "begin") stack.push(m[2]);
            else stack.pop();
          }
          options = [...new Set(stack.reverse())].map((e) => eatClosingBrace({ label: e, apply: e + "}", type: "type" }));
          return { from, options, validFor: /^[^,{}]*$/ };
        } else {
          return { from, options: envOptions, validFor: /^[^,{}]*$/ };
        }
      } else if (/^(ref|eqref|pageref|autoref|cref|Cref|nameref|vref)$/.test(cmd)) {
        options = index.labels().map((l) => ({ label: l, type: "variable" }));
      } else if (/cite/i.test(cmd)) {
        options = index.citations().map((c) => ({ label: c.key, detail: c.info, type: "text" }));
      } else if (cmd === "includegraphics") {
        options = index
          .files()
          .filter((f) => /\.(png|jpe?g|pdf|eps|svg)$/i.test(f))
          .map((f) => ({ label: f, type: "text" }));
      } else if (cmd === "input" || cmd === "include" || cmd === "subfile") {
        options = index
          .files()
          .filter((f) => f.endsWith(".tex"))
          .map((f) => ({ label: cmd === "include" ? f.replace(/\.tex$/, "") : f, type: "text" }));
      } else if (cmd === "bibliography" || cmd === "addbibresource") {
        options = index
          .files()
          .filter((f) => f.endsWith(".bib"))
          .map((f) => ({ label: cmd === "bibliography" ? f.replace(/\.bib$/, "") : f, type: "text" }));
      } else if (cmd === "usepackage" || cmd === "RequirePackage") {
        options = PACKAGES.map((p) => ({ label: p, type: "namespace" }));
      }
      if (!options) return null;
      return { from, options, validFor: /^[^,{}]*$/ };
    }

    // Comando: \abc|
    const word = ctx.matchBefore(/\\[A-Za-z]*\*?/);
    if (word && (word.from < word.to || ctx.explicit)) {
      return { from: word.from, options: cmdOptions, validFor: /^\\[A-Za-z]*\*?$/ };
    }
    return null;
  };
}

// ---------- Índice del proyecto ----------

export { extractLabels, extractBibEntries } from "./refs";
