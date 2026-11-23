// Genera el parser Lezer de LaTeX a partir de la gramática de Overleaf (AGPL-3.0).
// Ejecutar tras modificar src/overleaf/lezer-latex/latex.grammar: node scripts/gen-latex-parser.mjs
import { buildParserFile } from "@lezer/generator";
import { readFileSync, writeFileSync } from "node:fs";

const dir = "src/overleaf/lezer-latex";
const { parser, terms } = buildParserFile(readFileSync(`${dir}/latex.grammar`, "utf8"), {
  fileName: `${dir}/latex.grammar`,
  moduleStyle: "es",
});
writeFileSync(`${dir}/latex.mjs`, parser);
writeFileSync(`${dir}/latex.terms.mjs`, terms);
console.log("Parser LaTeX generado.");
