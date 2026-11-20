// Autocompletado de LaTeX: comandos, entornos, \ref, \cite, archivos y paquetes.

import {
  snippetCompletion as snip,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";

export type ProjectIndex = {
  labels: () => string[];
  citations: () => { key: string; info: string }[];
  files: () => string[];
};

const CMDS: [string, string?, string?][] = [
  // [nombre, plantilla de snippet, descripción]
  ["section", "section{${}}", "Sección"],
  ["subsection", "subsection{${}}", "Subsección"],
  ["subsubsection", "subsubsection{${}}", "Subsubsección"],
  ["chapter", "chapter{${}}", "Capítulo"],
  ["part", "part{${}}"],
  ["paragraph", "paragraph{${}}"],
  ["section*", "section*{${}}"],
  ["subsection*", "subsection*{${}}"],
  ["chapter*", "chapter*{${}}"],
  ["textbf", "textbf{${}}", "Negrita"],
  ["textit", "textit{${}}", "Cursiva"],
  ["emph", "emph{${}}", "Énfasis"],
  ["underline", "underline{${}}", "Subrayado"],
  ["texttt", "texttt{${}}", "Monoespaciado"],
  ["textsc", "textsc{${}}", "Versalitas"],
  ["textcolor", "textcolor{${color}}{${}}"],
  ["footnote", "footnote{${}}", "Nota al pie"],
  ["label", "label{${}}", "Etiqueta"],
  ["ref", "ref{${}}", "Referencia"],
  ["eqref", "eqref{${}}"],
  ["pageref", "pageref{${}}"],
  ["autoref", "autoref{${}}"],
  ["cref", "cref{${}}"],
  ["cite", "cite{${}}", "Cita"],
  ["citep", "citep{${}}"],
  ["citet", "citet{${}}"],
  ["parencite", "parencite{${}}"],
  ["textcite", "textcite{${}}"],
  ["autocite", "autocite{${}}"],
  ["url", "url{${}}"],
  ["href", "href{${url}}{${texto}}"],
  ["includegraphics", "includegraphics[width=${0.8}\\linewidth]{${}}", "Imagen"],
  ["input", "input{${}}"],
  ["include", "include{${}}"],
  ["usepackage", "usepackage{${}}"],
  ["documentclass", "documentclass{${article}}"],
  ["title", "title{${}}"],
  ["author", "author{${}}"],
  ["date", "date{${\\today}}"],
  ["maketitle"],
  ["tableofcontents"],
  ["listoffigures"],
  ["listoftables"],
  ["newpage"],
  ["clearpage"],
  ["noindent"],
  ["centering"],
  ["item"],
  ["caption", "caption{${}}"],
  ["frac", "frac{${}}{${}}", "Fracción"],
  ["dfrac", "dfrac{${}}{${}}"],
  ["sqrt", "sqrt{${}}"],
  ["sum", "sum_{${i=1}}^{${n}}"],
  ["prod", "prod_{${i=1}}^{${n}}"],
  ["int", "int_{${a}}^{${b}}"],
  ["lim", "lim_{${x \\to \\infty}}"],
  ["left(", "left( ${} \\right)"],
  ["left[", "left[ ${} \\right]"],
  ["mathbb", "mathbb{${}}"],
  ["mathcal", "mathcal{${}}"],
  ["mathrm", "mathrm{${}}"],
  ["mathbf", "mathbf{${}}"],
  ["text", "text{${}}"],
  ["hat", "hat{${}}"],
  ["bar", "bar{${}}"],
  ["vec", "vec{${}}"],
  ["dot", "dot{${}}"],
  ["overline", "overline{${}}"],
  ["binom", "binom{${n}}{${k}}"],
  ["newcommand", "newcommand{\\${nombre}}[${1}]{${}}"],
  ["renewcommand", "renewcommand{\\${nombre}}{${}}"],
  ["hspace", "hspace{${1em}}"],
  ["vspace", "vspace{${1em}}"],
  ["bibliography", "bibliography{${}}"],
  ["bibliographystyle", "bibliographystyle{${plain}}"],
  ["addbibresource", "addbibresource{${}}"],
  ["printbibliography"],
];

const SYMBOLS =
  "alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho sigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega infty partial nabla cdot cdots ldots vdots ddots times div pm mp leq geq neq approx equiv sim propto subset subseteq supset in notin cup cap forall exists neg wedge vee to rightarrow leftarrow Rightarrow Leftarrow iff mapsto quad qquad today LaTeX TeX hline toprule midrule bottomrule".split(
    " ",
  );

const ENVS: [string, string?][] = [
  ["itemize", "\t\\item ${}"],
  ["enumerate", "\t\\item ${}"],
  ["description", "\t\\item[${}] "],
  ["equation", "\t${}"],
  ["equation*", "\t${}"],
  ["align", "\t${} &= \\\\"],
  ["align*", "\t${} &= \\\\"],
  ["gather", "\t${}"],
  ["figure", "\t\\centering\n\t\\includegraphics[width=0.8\\linewidth]{${}}\n\t\\caption{${}}\n\t\\label{fig:${}}"],
  ["table", "\t\\centering\n\t\\begin{tabular}{${c c}}\n\t\t${}\n\t\\end{tabular}\n\t\\caption{${}}\n\t\\label{tab:${}}"],
  ["tabular", "\t${}"],
  ["center", "\t${}"],
  ["abstract", "\t${}"],
  ["quote", "\t${}"],
  ["verbatim", "${}"],
  ["minipage", "\t${}"],
  ["theorem", "\t${}"],
  ["lemma", "\t${}"],
  ["proof", "\t${}"],
  ["definition", "\t${}"],
  ["cases", "\t${} & ${} \\\\"],
  ["matrix", "\t${}"],
  ["pmatrix", "\t${}"],
  ["bmatrix", "\t${}"],
  ["frame", "\t\\frametitle{${}}\n\t${}"],
  ["tikzpicture", "\t${}"],
  ["lstlisting", "${}"],
  ["document", "${}"],
];

const PACKAGES =
  "amsmath amssymb amsthm mathtools graphicx xcolor hyperref geometry babel inputenc fontenc lmodern fontspec booktabs array tabularx longtable multirow caption subcaption float wrapfig tikz pgfplots listings minted siunitx biblatex natbib cleveref enumitem fancyhdr titlesec setspace parskip microtype csquotes url xspace todonotes lipsum blindtext appendix tocloft glossaries makeidx imakeidx physics bm cancel algorithm2e algorithmic algpseudocode tcolorbox mdframed etoolbox ifthen calc".split(
    " ",
  );

const cmdOptions: Completion[] = [
  ...CMDS.map(([n, tpl, detail]) =>
    tpl ? snip("\\" + tpl, { label: "\\" + n, detail, type: "function" }) : { label: "\\" + n, type: "function", detail },
  ),
  ...SYMBOLS.map((s) => ({ label: "\\" + s, type: "constant" })),
  snip("\\begin{${env}}\n\t${}\n\\end{${env}}", { label: "\\begin", type: "keyword", detail: "Entorno" }),
];

const envOptions: Completion[] = ENVS.map(([e, body]) =>
  snip(`${e}}\n${body ?? "\t${}"}\n\\end{${e}}`, { label: e, type: "type" }),
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
      const word = typed.slice(lastComma + 1);
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
          const to = ctx.state.sliceDoc(ctx.pos, ctx.pos + 1) === "}" ? ctx.pos + 1 : ctx.pos;
          options = [...new Set(stack.reverse())].map((e) => ({ label: e, apply: e + "}", type: "type" }));
          return { from, to, options, validFor: /^[^,{}]*$/ };
        } else {
          // si el editor ya cerró la llave, el snippet la reemplaza
          const to = ctx.state.sliceDoc(ctx.pos, ctx.pos + 1) === "}" ? ctx.pos + 1 : ctx.pos;
          return { from, to, options: envOptions, validFor: /^[^,{}]*$/ };
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

export function extractLabels(texts: string[]) {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(/\\label\{([^}]+)\}/g)) out.add(m[1]);
  return [...out];
}

export function extractBibEntries(bibs: string[]) {
  const out: { key: string; info: string }[] = [];
  for (const b of bibs) {
    for (const m of b.matchAll(/@(\w+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)(?=\n\s*@|$)/g)) {
      if (/^(comment|string|preamble)$/i.test(m[1])) continue;
      const title = /title\s*=\s*[{"]+([^}"]+)/i.exec(m[3])?.[1] ?? "";
      const year = /year\s*=\s*[{"]?(\d{4})/i.exec(m[3])?.[1] ?? "";
      out.push({ key: m[2], info: [title.slice(0, 60), year].filter(Boolean).join(" · ") });
    }
  }
  return out;
}
