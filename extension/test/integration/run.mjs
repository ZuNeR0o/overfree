// Lanza VS Code (el instalado, o $VSCODE_BIN) con la extensión en desarrollo y las pruebas de
// integración, sobre un proyecto LaTeX temporal. En un servidor sin pantalla: xvfb-run.
//   npm run test:integration
//   FOLIO_SHOTS=/ruta npm run test:integration   (guarda capturas de pantalla)
//   FOLIO_VSIX=folio-latex.vsix npm run test:integration   (prueba el paquete instalado, no la carpeta)
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ext = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bin = process.env.VSCODE_BIN ?? ["/usr/share/code/code", "/usr/bin/code"].find(existsSync);
if (!bin) {
  console.error("No encuentro VS Code (define VSCODE_BIN).");
  process.exit(2);
}

const ws = mkdtempSync(join(tmpdir(), "folio-int-ws-"));
const files = {
  "main.tex": [
    "\\documentclass{article}",
    "\\usepackage{booktabs}",
    "\\usepackage{hyperref}",
    "\\begin{document}",
    "\\section{Introducción}\\label{sec:intro}",
    "Texto de prueba en la línea seis, con suficiente contenido para ocupar una línea del PDF.",
    "Véase la sección~\\ref{sec:intro} y el artículo~\\cite{einstein}.",
    "\\input{capitulo}",
    "\\foo",
    "\\bibliographystyle{plain}",
    "\\bibliography{refs}",
    "\\end{document}",
    "",
  ].join("\n"),
  "capitulo.tex": "% !TEX root = main.tex\n\\subsection{Capítulo}\nTexto del capítulo con una referencia rota~\\ref{noexiste}.\n",
  "lint.tex": "% !TEX root = main.tex\n\\begin{itemize}\n\\item uno\n",
  "refs.bib": "@article{einstein,\n  author = {Albert Einstein},\n  title = {Zur Elektrodynamik bewegter K{\\\"o}rper},\n  journal = {Annalen der Physik},\n  year = {1905}\n}\n",
};
for (const [name, text] of Object.entries(files)) writeFileSync(join(ws, name), text);

const user = mkdtempSync(join(tmpdir(), "folio-int-user-"));
const extensionsDir = join(user, "extensions");
let devPath = ext;
const vsix = process.env.FOLIO_VSIX;
if (vsix) {
  // el paquete se instala de verdad; como VS Code exige una extensión «en desarrollo» para
  // lanzar pruebas, se le da una vacía
  const cli = existsSync("/usr/bin/code") ? "/usr/bin/code" : bin;
  const inst = spawnSync(cli, [`--extensions-dir=${extensionsDir}`, "--install-extension", vsix, "--force"], { stdio: "inherit" });
  if (inst.status !== 0) process.exit(inst.status ?? 1);
  devPath = mkdtempSync(join(tmpdir(), "folio-int-dummy-"));
  writeFileSync(join(devPath, "package.json"), JSON.stringify({ name: "dummy", publisher: "test", version: "0.0.0", engines: { vscode: "*" } }));
}
const args = [
  `--extensionDevelopmentPath=${devPath}`,
  `--extensionTestsPath=${join(ext, "dist", "integration.js")}`,
  `--user-data-dir=${user}`,
  `--extensions-dir=${extensionsDir}`,
  ...(vsix ? [] : ["--disable-extensions"]),
  "--disable-workspace-trust",
  "--skip-welcome",
  "--skip-release-notes",
  "--disable-gpu",
  "--no-sandbox",
  ws,
];
const headless = !process.env.DISPLAY;
const cmd = headless ? "xvfb-run" : bin;
const full = headless ? ["-a", "-s", "-screen 0 1600x1000x24", bin, ...args] : args;
console.log(`Proyecto de prueba: ${ws}`);
const r = spawnSync(cmd, full, { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
process.exit(r.status ?? 1);
