// Vista previa de fórmulas: al poner el cursor dentro de $…$, \[…\], \(…\) o de un
// entorno matemático (equation, align…), se muestra la fórmula renderizada.
// Idea y detección de nodos adaptadas de overleaf/.../extensions/math-preview.ts y
// utils/tree-operations/math.ts (AGPL-3.0); el renderizado usa KaTeX para funcionar sin conexión.

import { EditorState, StateField, type Extension } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import katex from "katex";
import "katex/dist/katex.min.css";

type MathContainer = { content: string; display: boolean; pos: number; env: string | null };

function envName(node: SyntaxNode, state: EditorState) {
  const begin = node.getChild("BeginEnv");
  const m = begin && /\\begin\s*\{([^}]+)\}/.exec(state.sliceDoc(begin.from, begin.to));
  return m?.[1] ?? null;
}

function findMath(state: EditorState): MathContainer | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = tree.resolveInner(sel.head, side); n; n = n.parent) {
      if (n.type.is("EquationEnvironment") || n.type.is("EquationArrayEnvironment")) {
        const env = envName(n, state);
        const content = n.getChild("Content");
        if (!content) return null;
        return { content: state.sliceDoc(content.from, content.to), display: true, pos: n.from, env };
      }
      if (n.type.is("$MathContainer")) {
        const math = n.getChild("InlineMath") ?? n.getChild("DisplayMath") ?? n;
        const inner = math.getChild("Math") ?? math;
        let text = state.sliceDoc(inner.from, inner.to);
        if (inner === n) text = text.replace(/^(\$\$?|\\\[|\\\()|(\$\$?|\\\]|\\\))$/g, "");
        const display = n.type.is("BracketMath") || !!n.getChild("DisplayMath");
        return { content: text, display, pos: n.from, env: null };
      }
    }
  }
  return null;
}

/** Macros del documento (\newcommand, \renewcommand, \DeclareMathOperator, \def) para KaTeX. */
function documentMacros(state: EditorState): Record<string, string> {
  const src = state.doc.toString();
  const macros: Record<string, string> = { "\\bm": "\\boldsymbol{#1}" };
  const re = /\\(?:re)?newcommand\*?\s*\{?\s*(\\[A-Za-z@]+)\s*\}?\s*(?:\[(\d)\])?\s*\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g;
  for (const m of src.matchAll(re)) macros[m[1]] = m[3];
  for (const m of src.matchAll(/\\DeclareMathOperator\*?\s*\{(\\[A-Za-z]+)\}\s*\{([^}]*)\}/g)) macros[m[1]] = `\\operatorname{${m[2]}}`;
  for (const m of src.matchAll(/\\def\s*(\\[A-Za-z]+)\s*\{([^{}]*)\}/g)) macros[m[1]] = m[2];
  return macros;
}

const ALIGN_ENVS = new Set(["align", "align*", "eqnarray", "eqnarray*", "flalign", "flalign*", "alignat", "alignat*"]);
const GATHER_ENVS = new Set(["gather", "gather*", "multline", "multline*"]);

function toKatex(m: MathContainer) {
  let tex = m.content
    .replace(/\\label\s*\{[^}]*\}/g, "")
    .replace(/\\(nonumber|notag)\b/g, "")
    .replace(/(^|[^\\])%.*$/gm, "$1");
  // KaTeX necesita los entornos de varias líneas como "aligned"/"gathered"
  if (m.env && ALIGN_ENVS.has(m.env)) tex = `\\begin{aligned}${tex}\\end{aligned}`;
  else if (m.env && GATHER_ENVS.has(m.env)) tex = `\\begin{gathered}${tex}\\end{gathered}`;
  return tex.trim();
}

let macroCache: { doc: unknown; macros: Record<string, string> } | null = null;

function buildTooltip(state: EditorState): Tooltip | null {
  const m = findMath(state);
  if (!m || !m.content.trim()) return null;
  if (macroCache?.doc !== state.doc) macroCache = { doc: state.doc, macros: documentMacros(state) };
  const html = katex.renderToString(toKatex(m), {
    displayMode: m.display,
    throwOnError: false,
    strict: "ignore",
    trust: false,
    macros: { ...macroCache.macros },
    errorColor: "var(--destructive)",
  });
  return {
    pos: m.pos,
    above: true,
    strictSide: false,
    arrow: false,
    create() {
      const dom = document.createElement("div");
      dom.className = "math-tooltip";
      dom.innerHTML = html;
      return { dom, offset: { x: 0, y: 6 } };
    },
  };
}

const mathField = StateField.define<Tooltip | null>({
  create: (s) => buildTooltip(s),
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value;
    return buildTooltip(tr.state);
  },
  provide: (f) => showTooltip.from(f),
});

const theme = EditorView.baseTheme({
  ".cm-tooltip.math-tooltip, .math-tooltip": {
    padding: "8px 12px",
    maxWidth: "min(640px, 90vw)",
    overflowX: "auto",
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    boxShadow: "0 2px 8px rgb(0 0 0 / 0.12)",
    fontSize: "15px",
  },
  ".math-tooltip .katex-display": { margin: "0" },
});

export const mathPreview = (): Extension => [mathField, theme];
