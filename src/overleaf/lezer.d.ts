// Tipos de los módulos generados por @lezer/generator.
declare module "*/lezer-latex/latex.mjs" {
  import type { LRParser } from "@lezer/lr";
  export const parser: LRParser;
}
declare module "*/lezer-latex/latex.terms.mjs" {
  const terms: Record<string, number>;
  export = terms;
}
declare module "*/lezer-latex/tokens.mjs";
