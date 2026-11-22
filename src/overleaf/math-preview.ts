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

/**
 * Macros definidas en un texto LaTeX (\newcommand, \renewcommand, \providecommand,
 * \DeclareMathOperator, \def) en el formato que entiende KaTeX.
 */
export function macrosFromSource(raw: string): Record<string, string> {
  const src = raw.replace(/(^|[^\\])%.*$/gm, "$1"); // sin comentarios
  const macros: Record<string, string> = {};
  // \newcommand{\x}[2][opcional]{cuerpo}: el argumento opcional se ignora (KaTeX no lo admite)
  const re = /\\(?:re|provide)?newcommand\*?\s*\{?\s*(\\[A-Za-z@]+)\s*\}?\s*(?:\[(\d)\])?\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g;
  for (const m of src.matchAll(re)) macros[m[1]] = m[3];
  for (const m of src.matchAll(/\\DeclareMathOperator(\*?)\s*\{(\\[A-Za-z]+)\}\s*\{([^}]*)\}/g))
    macros[m[2]] = m[1] ? `\\operatorname*{${m[3]}}` : `\\operatorname{${m[3]}}`;
  for (const m of src.matchAll(/\\def\s*(\\[A-Za-z]+)\s*\{([^{}]*)\}/g)) macros[m[1]] = m[2];
  return macros;
}

// Comandos de siunitx más comunes (KaTeX no los trae): se aproximan con texto recto.
const SIUNITX: Record<string, string> = {
  "\\qty": "#1\\,\\mathrm{#2}", "\\SI": "#1\\,\\mathrm{#2}", "\\unit": "\\mathrm{#1}", "\\si": "\\mathrm{#1}",
  "\\num": "#1", "\\ang": "#1^{\\circ}", "\\qtyrange": "#1\\text{ a }#2\\,\\mathrm{#3}",
  "\\meter": "m", "\\metre": "m", "\\second": "s", "\\gram": "g", "\\kilogram": "kg", "\\newton": "N", "\\joule": "J",
  "\\watt": "W", "\\pascal": "Pa", "\\kelvin": "K", "\\ampere": "A", "\\volt": "V", "\\ohm": "\\Omega", "\\hertz": "Hz",
  "\\coulomb": "C", "\\mole": "mol", "\\tesla": "T", "\\farad": "F", "\\henry": "H", "\\candela": "cd", "\\liter": "L", "\\litre": "L",
  "\\electronvolt": "eV", "\\degreeCelsius": "{}^{\\circ}\\mathrm{C}", "\\percent": "\\%", "\\radian": "rad", "\\hour": "h", "\\minute": "min",
  "\\kilo": "k", "\\mega": "M", "\\giga": "G", "\\milli": "m", "\\micro": "\\mu ", "\\nano": "n", "\\pico": "p", "\\centi": "c",
  "\\per": "/", "\\squared": "^{2}", "\\cubed": "^{3}", // \\square no: es también un símbolo de KaTeX
};

// Paquete physics (solo si el proyecto lo usa: redefine \div, \grad…).
const PHYSICS: Record<string, string> = {
  "\\dv": "\\frac{\\mathrm{d}#1}{\\mathrm{d}#2}", "\\pdv": "\\frac{\\partial #1}{\\partial #2}",
  "\\ket": "\\left|#1\\right\\rangle", "\\bra": "\\left\\langle#1\\right|", "\\braket": "\\left\\langle #1\\middle|#2\\right\\rangle",
  "\\expval": "\\left\\langle #1\\right\\rangle", "\\abs": "\\left|#1\\right|", "\\norm": "\\left\\|#1\\right\\|",
  "\\vb": "\\mathbf{#1}", "\\va": "\\vec{#1}", "\\vu": "\\hat{\\mathbf{#1}}", "\\grad": "\\nabla", "\\div": "\\nabla\\cdot",
  "\\curl": "\\nabla\\times", "\\laplacian": "\\nabla^{2}", "\\dd": "\\mathrm{d}", "\\order": "\\mathcal{O}\\left(#1\\right)",
  "\\comm": "\\left[#1,#2\\right]", "\\acomm": "\\left\\{#1,#2\\right\\}", "\\tr": "\\operatorname{tr}", "\\Tr": "\\operatorname{Tr}",
  "\\qty": "\\left(#1\\right)", "\\eval": "\\left.#1\\right|",
};

const uses = (src: string, pkg: string) =>
  new RegExp(`\\\\usepackage(\\[[^\\]]*\\])?\\{[^}]*\\b${pkg}\\b[^}]*\\}`).test(src.replace(/(^|[^\\])%.*$/gm, "$1"));

/** Macros para la vista previa: paquetes que use el proyecto + todas sus definiciones. */
export function previewMacros(projectSource: string): Record<string, string> {
  return {
    "\\bm": "\\boldsymbol{#1}",
    ...(uses(projectSource, "siunitx") ? SIUNITX : {}),
    // si usa ambos, \qty de physics (paréntesis) cede ante el de siunitx (cantidad con unidad)
    ...(uses(projectSource, "physics") ? (uses(projectSource, "siunitx") ? { ...PHYSICS, "\\qty": SIUNITX["\\qty"] } : PHYSICS) : {}),
    ...macrosFromSource(projectSource),
  };
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

let macroCache: { doc: unknown; project: unknown; macros: Record<string, string> } | null = null;
/** Lo asigna mathPreview(): texto de los demás archivos del proyecto (preámbulo, macros.tex…). */
let projectSource: () => string = () => "";

function buildTooltip(state: EditorState): Tooltip | null {
  const m = findMath(state);
  if (!m || !m.content.trim()) return null;
  const project = projectSource();
  if (macroCache?.doc !== state.doc || macroCache.project !== project)
    // las definiciones del archivo abierto tienen prioridad sobre las del resto del proyecto
    macroCache = { doc: state.doc, project, macros: previewMacros(project + "\n" + state.doc.toString()) };
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

/**
 * @param source texto de los demás archivos del proyecto (para sus \newcommand y paquetes).
 *   Debe devolver la misma cadena mientras no cambien (se usa como clave de caché).
 */
export const mathPreview = (source: () => string = () => ""): Extension => {
  projectSource = source;
  return [mathField, theme];
};
