// Elección automática del motor de LaTeX según lo que pide el documento.
// Lo usan la app (src/main.ts) y la extensión (extension/src/texproject.ts).

import type { Engine } from "./latex";

export type EngineSetting = Engine | "auto";

const ENGINES: Engine[] = ["pdflatex", "xelatex", "lualatex"];
const asEngine = (v: unknown): Engine | null => {
  const s = String(v ?? "").toLowerCase();
  return (ENGINES as string[]).includes(s) ? (s as Engine) : null;
};

const strip = (t: string) => t.replace(/(^|[^\\])%.*$/gm, "$1");

// Solo funcionan con LuaTeX: babel con bidi=basic u onchar=, código Lua, paquetes lua*.
const LUA_ONLY =
  /bidi\s*=\s*basic|onchar\s*=|\\directlua|\\begin\{luacode\*?\}|\\usepackage(\[[^\]]*\])?\{[^}]*\b(luacode|luatexbase|luaotfload|luamplib|lua-ul|luacolor|selnolig|lua-visual-debug)\b/;
// Solo funcionan con XeTeX.
const XE_ONLY = /\\usepackage(\[[^\]]*\])?\{[^}]*\b(xeCJK|xltxtra|xunicode|xepersian|bidi)\b|\\XeTeX\w+/;
// Necesitan un motor Unicode (cualquiera de los dos).
const UNICODE = /\\usepackage(\[[^\]]*\])?\{[^}]*\b(fontspec|unicode-math|polyglossia)\b|\\babelfont\b|\\set(main|sans|mono|math)font\b/;

/**
 * Motor que pide el propio documento, o null si basta pdfLaTeX.
 * `main` es el archivo principal (allí se busca `% !TEX program`); `rest`, el resto de .tex del proyecto.
 */
export function engineFromSource(main: string, rest = ""): Engine | null {
  const magic = /^\s*%\s*!TEX\s+(?:TS-)?program\s*=\s*(\w+)/im.exec(main.slice(0, 4000))?.[1];
  if (asEngine(magic)) return asEngine(magic);
  const tex = strip(main + "\n" + rest);
  if (LUA_ONLY.test(tex)) return "lualatex";
  if (XE_ONLY.test(tex)) return "xelatex";
  if (UNICODE.test(tex)) return "xelatex";
  return null;
}

export const resolveEngine = (setting: EngineSetting, main: string, rest = ""): Engine =>
  setting === "auto" ? (engineFromSource(main, rest) ?? "pdflatex") : setting;
