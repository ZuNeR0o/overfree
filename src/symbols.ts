// Paleta de símbolos matemáticos y físicos con buscador. Los símbolos se dibujan con
// KaTeX (sin conexión) y al pulsarlos se inserta el comando en el cursor.

import katex from "katex";
import type { EditorView } from "@codemirror/view";

type Sym = [cmd: string, name: string];

// Plantillas con {} dejan el cursor dentro de la primera llave.
const CATEGORIES: Record<string, Sym[]> = {
  Griegas: [
    ["\\alpha", "alfa"], ["\\beta", "beta"], ["\\gamma", "gamma"], ["\\delta", "delta"], ["\\epsilon", "épsilon"], ["\\varepsilon", "épsilon variante"],
    ["\\zeta", "zeta"], ["\\eta", "eta"], ["\\theta", "theta"], ["\\vartheta", "theta variante"], ["\\iota", "iota"], ["\\kappa", "kappa"],
    ["\\lambda", "lambda"], ["\\mu", "mu"], ["\\nu", "nu"], ["\\xi", "xi"], ["\\pi", "pi"], ["\\varpi", "pi variante"], ["\\rho", "rho"],
    ["\\varrho", "rho variante"], ["\\sigma", "sigma"], ["\\varsigma", "sigma final"], ["\\tau", "tau"], ["\\upsilon", "ípsilon"], ["\\phi", "phi"],
    ["\\varphi", "phi variante"], ["\\chi", "chi"], ["\\psi", "psi"], ["\\omega", "omega"], ["\\Gamma", "Gamma mayúscula"], ["\\Delta", "Delta mayúscula"],
    ["\\Theta", "Theta mayúscula"], ["\\Lambda", "Lambda mayúscula"], ["\\Xi", "Xi mayúscula"], ["\\Pi", "Pi mayúscula"], ["\\Sigma", "Sigma mayúscula"],
    ["\\Upsilon", "Ípsilon mayúscula"], ["\\Phi", "Phi mayúscula"], ["\\Psi", "Psi mayúscula"], ["\\Omega", "Omega mayúscula"],
  ],
  Operadores: [
    ["\\pm", "más menos"], ["\\mp", "menos más"], ["\\times", "por, producto cruz"], ["\\div", "división"], ["\\cdot", "punto, producto escalar"],
    ["\\ast", "asterisco"], ["\\star", "estrella"], ["\\circ", "composición"], ["\\bullet", "viñeta"], ["\\oplus", "suma directa"], ["\\ominus", "resta directa"],
    ["\\otimes", "producto tensorial"], ["\\odot", "producto de Hadamard"], ["\\wedge", "producto exterior, y lógico"], ["\\vee", "o lógico"],
    ["\\cap", "intersección"], ["\\cup", "unión"], ["\\setminus", "diferencia de conjuntos"], ["\\dagger", "daga, adjunto"], ["\\ddagger", "doble daga"],
    ["\\frac{}{}", "fracción"], ["\\dfrac{}{}", "fracción grande"], ["\\sqrt{}", "raíz cuadrada"], ["\\sqrt[n]{}", "raíz n-ésima"], ["\\binom{}{}", "binomial"],
  ],
  Relaciones: [
    ["\\leq", "menor o igual"], ["\\geq", "mayor o igual"], ["\\neq", "distinto"], ["\\approx", "aproximadamente"], ["\\equiv", "idéntico, congruente"],
    ["\\sim", "similar, del orden de"], ["\\simeq", "asintóticamente igual"], ["\\cong", "congruente"], ["\\propto", "proporcional"], ["\\ll", "mucho menor"],
    ["\\gg", "mucho mayor"], ["\\doteq", "igual por definición (punto)"], ["\\triangleq", "igual por definición"], ["\\coloneqq", "se define como"],
    ["\\prec", "precede"], ["\\succ", "sucede"], ["\\perp", "perpendicular"], ["\\parallel", "paralelo"], ["\\mid", "divide, tal que"], ["\\models", "modela"],
  ],
  Flechas: [
    ["\\to", "a, tiende a"], ["\\rightarrow", "flecha derecha"], ["\\leftarrow", "flecha izquierda"], ["\\leftrightarrow", "doble flecha"],
    ["\\Rightarrow", "implica"], ["\\Leftarrow", "es implicado por"], ["\\Leftrightarrow", "si y solo si"], ["\\iff", "si y solo si (largo)"],
    ["\\implies", "implica (largo)"], ["\\mapsto", "se asigna a"], ["\\longrightarrow", "flecha larga"], ["\\uparrow", "flecha arriba"],
    ["\\downarrow", "flecha abajo"], ["\\updownarrow", "arriba y abajo"], ["\\nearrow", "noreste"], ["\\searrow", "sureste"], ["\\rightleftharpoons", "equilibrio"],
    ["\\hookrightarrow", "inclusión"], ["\\xrightarrow{}", "flecha con texto"],
  ],
  "Cálculo": [
    ["\\sum_{i=1}^{n}", "sumatoria"], ["\\prod_{i=1}^{n}", "productoria"], ["\\int_{a}^{b}", "integral"], ["\\iint", "integral doble"],
    ["\\iiint", "integral triple"], ["\\oint", "integral de contorno"], ["\\lim_{x \\to \\infty}", "límite"], ["\\partial", "derivada parcial"],
    ["\\nabla", "nabla, gradiente"], ["\\infty", "infinito"], ["\\frac{d}{dx}", "derivada"], ["\\frac{\\partial}{\\partial x}", "derivada parcial"],
    ["\\mathrm{d}", "d recta (diferencial)"], ["\\Delta", "incremento"], ["\\sup", "supremo"], ["\\inf", "ínfimo"], ["\\max", "máximo"], ["\\min", "mínimo"],
    ["\\log", "logaritmo"], ["\\ln", "logaritmo natural"], ["\\exp", "exponencial"], ["\\sin", "seno"], ["\\cos", "coseno"], ["\\tan", "tangente"],
  ],
  "Conjuntos y lógica": [
    ["\\in", "pertenece"], ["\\notin", "no pertenece"], ["\\ni", "contiene como elemento"], ["\\subset", "subconjunto"], ["\\subseteq", "subconjunto o igual"],
    ["\\supset", "superconjunto"], ["\\supseteq", "superconjunto o igual"], ["\\emptyset", "conjunto vacío"], ["\\varnothing", "vacío (variante)"],
    ["\\forall", "para todo"], ["\\exists", "existe"], ["\\nexists", "no existe"], ["\\neg", "negación"], ["\\land", "y lógico"], ["\\lor", "o lógico"],
    ["\\mathbb{R}", "números reales"], ["\\mathbb{C}", "números complejos"], ["\\mathbb{N}", "naturales"], ["\\mathbb{Z}", "enteros"], ["\\mathbb{Q}", "racionales"],
    ["\\therefore", "por lo tanto"], ["\\because", "porque"],
  ],
  "Acentos y estilos": [
    ["\\hat{}", "sombrero, vector unitario"], ["\\bar{}", "barra, promedio"], ["\\vec{}", "vector"], ["\\dot{}", "derivada temporal"],
    ["\\ddot{}", "segunda derivada temporal"], ["\\tilde{}", "tilde"], ["\\widehat{}", "sombrero ancho"], ["\\overline{}", "línea encima"],
    ["\\underline{}", "subrayado"], ["\\overrightarrow{}", "vector (flecha larga)"], ["\\mathbf{}", "negrita"], ["\\boldsymbol{}", "símbolo en negrita"],
    ["\\mathrm{}", "romana (texto recto)"], ["\\mathcal{}", "caligráfica"], ["\\mathfrak{}", "gótica"], ["\\mathbb{}", "pizarra"], ["\\text{}", "texto"],
  ],
  Delimitadores: [
    ["\\left( \\right)", "paréntesis ajustables"], ["\\left[ \\right]", "corchetes ajustables"], ["\\left\\{ \\right\\}", "llaves ajustables"],
    ["\\langle \\rangle", "ángulos"], ["\\lvert \\rvert", "valor absoluto"], ["\\lVert \\rVert", "norma"], ["\\lfloor \\rfloor", "parte entera"],
    ["\\lceil \\rceil", "techo"], ["\\overbrace{}", "llave superior"], ["\\underbrace{}", "llave inferior"],
  ],
  "Física": [
    ["\\hbar", "h barra (Planck reducida)"], ["\\ell", "ele cursiva, longitud"], ["\\langle \\psi |", "bra"], ["| \\psi \\rangle", "ket"],
    ["\\langle \\phi | \\psi \\rangle", "braket"], ["\\nabla \\cdot", "divergencia"], ["\\nabla \\times", "rotacional"], ["\\nabla^2", "laplaciano"],
    ["\\vec{F}", "fuerza"], ["\\hat{\\imath}", "i unitario"], ["\\hat{\\jmath}", "j unitario"], ["\\hat{k}", "k unitario"], ["\\dagger", "adjunto"],
    ["\\degree", "grado"], ["^\\circ", "grado (superíndice)"], ["\\Re", "parte real"], ["\\Im", "parte imaginaria"], ["\\aleph", "álef"], ["\\angle", "ángulo"],
  ],
};

function insertSymbol(view: EditorView, cmd: string) {
  const { state } = view;
  const r = state.selection.main;
  const selected = state.sliceDoc(r.from, r.to);
  // con texto seleccionado, se mete dentro de la primera {} (p. ej. \vec{ seleccionado })
  let text = cmd;
  let cursor = cmd.length;
  const brace = cmd.indexOf("{}");
  if (brace >= 0) {
    text = cmd.slice(0, brace + 1) + selected + cmd.slice(brace + 1);
    cursor = brace + 1 + selected.length;
  } else if (/^\\[A-Za-z]+$/.test(cmd) && /^[A-Za-z]/.test(state.sliceDoc(r.to, r.to + 1))) {
    text += " "; // \alpha seguido de letra necesita un espacio
    cursor = text.length;
  }
  view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor: r.from + cursor }, userEvent: "input" });
  view.focus();
}

const preview = (cmd: string) => {
  const tex = cmd.replace(/\{\}/g, "{x}");
  try {
    return katex.renderToString(tex, { throwOnError: false, strict: "ignore", displayMode: false });
  } catch {
    return cmd;
  }
};

export function mountSymbolPalette(root: HTMLElement, getView: () => EditorView) {
  const search = Object.assign(document.createElement("input"), { type: "search", placeholder: "Buscar símbolo (p. ej. «integral», «flecha», \\alpha)…", className: "sym-search" });
  const tabs = document.createElement("div");
  tabs.className = "sym-tabs";
  const grid = document.createElement("div");
  grid.className = "sym-grid";
  let current = Object.keys(CATEGORIES)[0];

  const cache = new Map<string, string>();
  const html = (cmd: string) => {
    let h = cache.get(cmd);
    if (!h) cache.set(cmd, (h = preview(cmd)));
    return h;
  };

  function render() {
    const q = search.value.trim().toLowerCase();
    const list: Sym[] = q
      ? Object.values(CATEGORIES).flat().filter(([c, n]) => c.toLowerCase().includes(q) || n.toLowerCase().includes(q))
      : CATEGORIES[current];
    tabs.querySelectorAll("button").forEach((b) => b.classList.toggle("active", !q && b.dataset.cat === current));
    grid.replaceChildren(
      ...(list.length
        ? list.map(([cmd, name]) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "sym";
            b.title = `${cmd}  —  ${name}`;
            b.innerHTML = html(cmd);
            b.addEventListener("mousedown", (e) => e.preventDefault()); // conserva el foco del editor
            b.onclick = () => insertSymbol(getView(), cmd);
            return b;
          })
        : [Object.assign(document.createElement("p"), { className: "muted", textContent: "Sin resultados." })]),
    );
  }

  for (const cat of Object.keys(CATEGORIES)) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = cat;
    b.dataset.cat = cat;
    b.onclick = () => {
      current = cat;
      search.value = "";
      render();
    };
    tabs.append(b);
  }
  search.addEventListener("input", render);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") root.hidden = true;
  });
  root.replaceChildren(search, tabs, grid);
  render();
  return {
    toggle() {
      root.hidden = !root.hidden;
      if (!root.hidden) search.focus();
    },
  };
}
