// El corrector ortográfico del sistema solo revisa el texto, no el código LaTeX:
// se marcan con spellcheck="false" los comandos, nombres de entorno, etiquetas,
// referencias, claves de cita, rutas, URLs y fórmulas.
// Idea adaptada de noSpellCheckProp en overleaf/.../languages/latex/latex-language.ts (AGPL-3.0).

import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";

const mark = Decoration.mark({ attributes: { spellcheck: "false" } });

const SKIP = [
  "$CtrlSeq",
  "$EnvName",
  "LabelArgument",
  "RefArgument",
  "BibKeyArgument",
  "BibliographyArgument",
  "BibliographyStyleArgument",
  "PackageArgument",
  "DocumentClassArgument",
  "FilePathArgument",
  "BareFilePathArgument",
  "UrlArgument",
  "OptionalArgument",
  "$MathContainer",
  "EquationEnvironment",
  "EquationArrayEnvironment",
  "VerbContent",
  "VerbatimContent",
  "LstInlineContent",
  "LiteralArgContent",
];

function build(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  let last = -1; // las marcas deben ir en orden y sin repetirse entre zonas visibles
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (n) => {
        // ya marcado por completo en una zona visible anterior
        if (n.to <= last) return false;
        if (SKIP.some((t) => n.type.is(t))) {
          const start = Math.max(n.from, last);
          if (n.to > start) b.add(start, n.to, mark);
          last = n.to;
          return false; // no hace falta mirar dentro
        }
      },
    });
  }
  return b.finish();
}

export const noSpellcheckLatex = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
