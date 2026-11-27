// Pruebas sin VS Code: compilación con un TeX simulado, detección del proyecto y los
// módulos de Overfree que reutiliza la extensión. `npm test`.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { checkProject } from "../../src/checks";
import { parseLog } from "../../src/logparse";
import { Parse } from "../../src/overleaf/linter/latex-linter.worker";
import { errorsToDiagnostics } from "../../src/overleaf/linter/lint-core";
import { forward, inverse, parseSynctex } from "../../src/synctex";
import { parseTsv, toLatexTable } from "../../src/tables";
import { CancelledError, compile, findTexBin, validMain } from "../src/compile";
import { engineFromSource, resolveProject } from "../src/texproject";
import { toSnippet } from "../src/snippet";
import { appLocations, listAppProjects } from "../src/projects";
import { newer, pickUpdate } from "../src/releases";
import { argAt, endOf, findBibEntry, findLabel, quickFix } from "../src/texargs";

const tests: [string, () => Promise<void> | void][] = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);
const tmp = () => mkdtempSync(path.join(tmpdir(), "folio-ext-"));

// ---------- TeX simulado ----------
// pdflatex: pasada 1 escribe \bibdata en el .aux; pasada 2 pide «Rerun»; pasada 3 termina.
// FAKE_SLOW=1 hace que tarde 30 s (para probar la cancelación).
function fakeTex(): string {
  const bin = tmp();
  const pdflatex = `#!/bin/sh
for a; do case "$a" in -output-directory=*) OUT="\${a#-output-directory=}";; esac; done
for a; do MAIN="$a"; done
JOB=$(basename "$MAIN" .tex)
N=$(cat "$OUT/count" 2>/dev/null || echo 0); N=$((N+1)); echo $N > "$OUT/count"
[ -n "$FAKE_SLOW" ] && sleep 30
if grep -q FATAL "$MAIN"; then echo "! Emergency stop." > "$OUT/$JOB.log"; exit 1; fi
printf '%s\\n' '\\bibdata{refs}' > "$OUT/$JOB.aux"
if [ "$N" = 2 ]; then echo "LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right." > "$OUT/$JOB.log";
else printf '%s\\n' "(./$MAIN" "! Undefined control sequence." "l.3 \\\\foo" ")" > "$OUT/$JOB.log"; fi
echo "%PDF-1.4 pasada $N" > "$OUT/$JOB.pdf"
`;
  const bibtex = `#!/bin/sh
echo "$BIBINPUTS" > bibinputs.txt
echo "bibtex $1" >> tools.txt
`;
  for (const [name, body] of [["pdflatex", pdflatex], ["bibtex", bibtex]]) {
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  }
  return bin;
}

const isWin = process.platform === "win32";

test("validMain: mismas reglas que la app", () => {
  assert.ok(validMain("main.tex"));
  assert.ok(validMain("tesis/main.tex"));
  assert.ok(validMain("Mi tesis.tex"), "espacios en medio del nombre");
  for (const bad of ["../main.tex", "/etc/x.tex", "-x.tex", "&fmt.tex", "a/-b.tex", "C:/a.tex", "main.txt", "a//b.tex",
    " &fmt.tex", " \\input{x}.tex", "a \\input{x}.tex", "a\\b.tex", ".tex", "dir/.tex", "x{y}.tex", "100%.tex", "MAIN.TEX"]) {
    assert.equal(validMain(bad), false, bad);
  }
});

test("compile: pasadas, bibtex con el separador de rutas del sistema y PDF", async () => {
  if (isWin) return;
  const bin = fakeTex();
  const root = tmp();
  writeFileSync(path.join(root, "main.tex"), "\\documentclass{article}\n\\begin{document}\n\\foo\n\\end{document}\n");
  mkdirSync(path.join(root, "capitulos"));
  const r = await compile({ root, main: "main.tex", engine: "pdflatex", texPath: bin, signal: new AbortController().signal });
  assert.equal(r.success, true);
  assert.equal(r.passes, 3, "1: bibtex → 2: «Rerun» → 3: fin");
  assert.equal(r.bin, bin);
  const build = path.join(root, ".folio", "build");
  assert.equal(readFileSync(path.join(build, "bibinputs.txt"), "utf8").trim(), root + ":", "BIBINPUTS con ':' fuera de Windows");
  assert.equal(readFileSync(path.join(build, "tools.txt"), "utf8").trim(), "bibtex main", "bibtex una sola vez");
  assert.ok(readFileSync(path.join(build, "main.pdf"), "utf8").includes("pasada 3"));
  assert.ok(statSync(path.join(build, "capitulos")).isDirectory(), "subcarpetas replicadas en build/");
  // el registro se interpreta con el parser de Overfree
  const problems = parseLog(r.log, ["main.tex"], "main.tex");
  const err = problems.find((p) => p.level === "error");
  assert.ok(err, "error del registro");
  assert.equal(err!.file, "main.tex");
  assert.equal(err!.line, 3);
  assert.match(err!.message, /Comando no definido/);
});

test("compile: sin PDF no se muestra el de la compilación anterior", async () => {
  if (isWin) return;
  const bin = fakeTex();
  const root = tmp();
  writeFileSync(path.join(root, "main.tex"), "\\documentclass{article}\n");
  await compile({ root, main: "main.tex", engine: "pdflatex", texPath: bin, signal: new AbortController().signal });
  writeFileSync(path.join(root, "main.tex"), "FATAL\n");
  const r = await compile({ root, main: "main.tex", engine: "pdflatex", texPath: bin, signal: new AbortController().signal });
  assert.equal(r.success, false);
  assert.equal(r.pdfPath, null);
  assert.equal(r.passes, 1);
});

test("compile: cancelar mata el proceso y responde enseguida", async () => {
  if (isWin) return;
  const bin = fakeTex();
  const root = tmp();
  writeFileSync(path.join(root, "main.tex"), "\\documentclass{article}\n");
  const ctrl = new AbortController();
  process.env.FAKE_SLOW = "1";
  const t0 = Date.now();
  const p = compile({ root, main: "main.tex", engine: "pdflatex", texPath: bin, signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 300);
  await assert.rejects(p, CancelledError);
  delete process.env.FAKE_SLOW;
  assert.ok(Date.now() - t0 < 5000, "no espera a que termine el sleep de 30 s");
});

test("compile: error claro si no hay TeX", async () => {
  const root = tmp();
  writeFileSync(path.join(root, "main.tex"), "x");
  const saved = process.env.PATH;
  process.env.PATH = "";
  try {
    if (findTexBin(path.join(root, "no-existe"))) return; // hay TeX en rutas fijas del sistema
    await assert.rejects(compile({ root, main: "main.tex", engine: "pdflatex", texPath: path.join(root, "no-existe"), signal: new AbortController().signal }), /No se encontró TeX/);
  } finally {
    process.env.PATH = saved;
  }
});

test("resolveProject: proyecto de Overfree, % !TEX root y \\documentclass", async () => {
  const ws = tmp();
  // proyecto de la app Overfree en una subcarpeta
  const folio = path.join(ws, "tesis");
  mkdirSync(path.join(folio, ".folio"), { recursive: true });
  mkdirSync(path.join(folio, "cap"));
  writeFileSync(path.join(folio, ".folio", "project.json"), JSON.stringify({ main: "tesis.tex", engine: "lualatex" }));
  writeFileSync(path.join(folio, "cap", "uno.tex"), "\\section{Uno}");
  let p = await resolveProject(path.join(folio, "cap", "uno.tex"), { workspaceRoot: ws });
  assert.deepEqual(p, { root: folio, main: "tesis.tex", engine: "lualatex", folio: true });

  // % !TEX root
  const art = path.join(ws, "articulo");
  mkdirSync(path.join(art, "secciones"), { recursive: true });
  writeFileSync(path.join(art, "principal.tex"), "\\documentclass{article}\n\\usepackage{fontspec}\n");
  writeFileSync(path.join(art, "secciones", "intro.tex"), "% !TEX root = ../principal.tex\nHola");
  p = await resolveProject(path.join(art, "secciones", "intro.tex"), { workspaceRoot: ws });
  assert.deepEqual(p, { root: art, main: "principal.tex", engine: "xelatex", folio: false });

  // el ajuste del motor manda sobre la detección
  p = await resolveProject(path.join(art, "principal.tex"), { workspaceRoot: ws, engine: "pdflatex" });
  assert.equal(p?.engine, "pdflatex");

  // sin pistas: el main.tex del espacio de trabajo
  const ws2 = tmp();
  writeFileSync(path.join(ws2, "otro.tex"), "\\documentclass{book}");
  mkdirSync(path.join(ws2, "src"));
  writeFileSync(path.join(ws2, "src", "main.tex"), "\\documentclass{article}");
  writeFileSync(path.join(ws2, "suelto.tex"), "texto");
  p = await resolveProject(path.join(ws2, "suelto.tex"), { workspaceRoot: ws2 });
  assert.equal(p?.root, path.join(ws2, "src"));
  assert.equal(p?.main, "main.tex");
});

test("seguridad: motor desconocido y % !TEX root fuera del espacio de trabajo", async () => {
  const root = tmp();
  writeFileSync(path.join(root, "main.tex"), "\\documentclass{article}");
  await assert.rejects(
    compile({ root, main: "main.tex", engine: "../../bin/sh" as never, texPath: fakeTex(), signal: new AbortController().signal }),
    /Motor no válido/,
  );
  const p = await resolveProject(path.join(root, "main.tex"), { workspaceRoot: root, engine: "../../bin/sh" as never });
  assert.equal(p?.engine, "pdflatex", "un ajuste de motor raro se ignora");
  const ws = tmp();
  writeFileSync(path.join(ws, "cap.tex"), `% !TEX root = ${path.join(root, "main.tex")}\nHola`);
  assert.equal(await resolveProject(path.join(ws, "cap.tex"), { workspaceRoot: ws }), null);
});

test("engineFromSource", () => {
  assert.equal(engineFromSource("% !TEX program = lualatex\n\\documentclass{article}"), "lualatex");
  assert.equal(engineFromSource("\\usepackage[math]{unicode-math}"), "xelatex");
  assert.equal(engineFromSource("% \\usepackage{fontspec}\n\\documentclass{article}"), null);
  assert.equal(engineFromSource("\\usepackage[spanish, bidi=basic, provide=*]{babel}\n\\usepackage{fontspec}"), "lualatex");
  assert.equal(engineFromSource("\\babelprovide[import, onchar=ids fonts]{english}"), "lualatex");
  assert.equal(engineFromSource("\\documentclass{article}", "\\usepackage{fontspec}"), "xelatex", "preámbulo en otro .tex");
  assert.equal(engineFromSource("\\usepackage{amsmath}\n\\usepackage{xcolor}"), null);
});

test("toSnippet: plantillas de la app a snippets de VS Code", () => {
  assert.equal(toSnippet("\\textbf{${}}"), "\\\\textbf{${1}\\}");
  assert.equal(toSnippet("\\begin{${env}}\n\t${}\n\\end{${env}}"), "\\\\begin{${1:env}\\}\n\t${2}\n\\\\end{${1:env}\\}");
  assert.equal(toSnippet("\\date{${\\today}}"), "\\\\date{${1:\\\\today}\\}");
});

test("listAppProjects: registro de la app y Documentos/Folio", async () => {
  const home = tmp();
  const loc = appLocations({ APPDATA: path.join(home, "roaming") }, home, "win32");
  assert.equal(loc.registry, path.join(home, "roaming", "app.folio.editor", "projects.json"));
  const mk = (dir: string, name?: string) => {
    mkdirSync(path.join(dir, ".folio"), { recursive: true });
    writeFileSync(path.join(dir, ".folio", "project.json"), JSON.stringify(name ? { name, main: "main.tex" } : { main: "main.tex" }));
  };
  const fuera = path.join(home, "tareas", "kalman");
  mk(fuera, "Tarea Kalman");
  mk(path.join(home, "Documents", "Folio", "RP2"));
  mkdirSync(path.join(home, "Documents", "Folio", "suelta"), { recursive: true }); // sin .folio: no cuenta
  mkdirSync(path.dirname(loc.registry), { recursive: true });
  writeFileSync(loc.registry, JSON.stringify([{ id: "a", dir: fuera }, { id: "b", dir: path.join(home, "Documents", "Folio", "RP2") }, { id: "c", dir: path.join(home, "borrado") }]));
  const list = await listAppProjects(loc);
  assert.deepEqual(list.map((p) => p.name), ["RP2", "Tarea Kalman"]);
});

test("actualizaciones: elige la release de la extensión más nueva y segura", () => {
  assert.ok(newer("0.1.10", "0.1.9") && !newer("0.1.7", "0.1.7") && !newer("0.1.6", "0.2.0"));
  const dl = (v: string) => ({ name: "folio-latex.vsix", browser_download_url: `https://github.com/ZuNeR0o/overfree/releases/download/extension-v${v}/folio-latex.vsix` });
  const releases = [
    { tag_name: "v0.1.10", assets: [] }, // la app, no la extensión
    { tag_name: "extension-v0.1.8", assets: [dl("0.1.8")] },
    { tag_name: "extension-v0.2.0", prerelease: true, assets: [dl("0.2.0")] },
    { tag_name: "extension-v0.1.9", assets: [{ name: "folio-latex.vsix", browser_download_url: "https://evil.example/folio-latex.vsix" }] },
    { tag_name: "extension-v0.1.6", assets: [dl("0.1.6")] },
  ];
  assert.equal(pickUpdate(releases, "0.1.7")?.version, "0.1.8");
  assert.equal(pickUpdate(releases, "0.1.8"), null);
});

test("texargs: correcciones, argumento bajo el cursor, \\label y .bib", () => {
  assert.equal(quickFix("sin")?.text, "\\sin");
  assert.equal(quickFix("$$x^2$$")?.text, "\\[x^2\\]");
  assert.equal(quickFix('"hola"')?.text, "``hola''");
  assert.equal(quickFix("Hola"), null);
  assert.deepEqual(endOf("ab\ncd$$\nx\n$$", 1, 2, 7), { line: 3, col: 2 });

  const line = "Ver \\ref{fig:a} y \\cite[p.~3]{knuth, lamport}.";
  assert.deepEqual(argAt(line, line.indexOf("fig:a") + 2), { cmd: "ref", key: "fig:a", start: 9, end: 14 });
  const c = line.indexOf("lamport");
  assert.deepEqual(argAt(line, c + 1), { cmd: "cite", key: "lamport", start: c, end: c + 7 });
  assert.equal(argAt(line, 1), null);

  const tex = [{ path: "a.tex", text: "% \\label{fig:a}\nx" }, { path: "b.tex", text: "y\n\\label{fig:a}" }];
  assert.equal(findLabel(tex, "fig:a")?.path, "b.tex", "ignora el \\label comentado");
  const bib = "@book{knuth,\n  author = {Donald Knuth},\n  title = {The {TeX}book},\n  year = 1984\n}\n@misc{x, title={X}}";
  const e = findBibEntry([{ path: "r.bib", text: bib }], "knuth");
  assert.deepEqual([e?.line, e?.author, e?.title, e?.year], [0, "Donald Knuth", "The TeXbook", "1984"]);
});

test("revisión en vivo: linter de Overleaf sin Worker", () => {
  const text = "\\begin{itemize}\n\\item a\n";
  const errors = Parse(text).errors;
  const ds = errorsToDiagnostics(errors, -1, text.length);
  assert.ok(ds.length > 0);
  assert.match(ds[0].message, /sin cerrar/);
  assert.equal(Parse("\\begin{itemize}\\item a\\end{itemize}").errors.length, 0);
});

test("revisión del proyecto", () => {
  const problems = checkProject([
    { path: "main.tex", text: "\\documentclass{article}\\begin{document}\\ref{nada}\\cite{x}\\includegraphics{fig.png}\\end{document}" },
    { path: "refs.bib", text: "@article{y, title={T}}" },
  ]);
  const msgs = problems.map((p) => p.message).join("\n");
  assert.match(msgs, /\\ref\{nada\}/);
  assert.match(msgs, /Cita «x»/);
  assert.match(msgs, /fig\.png/);
});

test("tablas desde Excel", () => {
  const rows = parseTsv("Muestra\tMasa\nA\t1.5\nB\t2.25\n")!;
  const tex = toLatexTable(rows, { siunitx: true, booktabs: true });
  assert.match(tex, /\\begin\{tabular\}\{lS\}/);
  assert.match(tex, /\\toprule/);
});

test("SyncTeX: ida y vuelta", async () => {
  // unidades en sp (1 bp = 65781.76 sp); una caja horizontal de main.tex:10 en la página 1
  const syn = [
    "SyncTeX Version:1",
    "Input:1:/proyecto/./main.tex",
    "Output:pdf",
    "Magnification:1000",
    "Unit:1",
    "X Offset:0",
    "Y Offset:0",
    "Content:",
    "{1",
    "[1,10:6578176,13156352:32890880,657818,0",
    "h1,10:6578176,13156352:32890880,657818,0",
    "]",
    "}1",
    "Postamble:",
    "",
  ].join("\n");
  const data = await parseSynctex(new Uint8Array(gzipSync(syn)), ["main.tex"]);
  const fwd = forward(data, "main.tex", 10);
  assert.ok(fwd, "forward");
  assert.equal(fwd!.page, 1);
  const inv = inverse(data, 1, fwd!.left + 5, (fwd!.top + fwd!.bottom) / 2);
  assert.deepEqual(inv, { file: "main.tex", line: 10 });
});

test("SyncTeX: la caja de línea lleva la etiqueta del \\input siguiente; manda el carácter", async () => {
  // como genera pdflatex: el párrafo de main.tex:6 lo cierra el \\subsection de capitulo.tex:2
  const syn = [
    "SyncTeX Version:1", "Input:1:/p/./main.tex", "Input:2:/p/./capitulo.tex", "Output:pdf",
    "Magnification:1000", "Unit:1", "X Offset:0", "Y Offset:0", "Content:", "{1",
    "(2,2:8799518,10300473:22609920,455111,127431",
    "x2,2:9272834,10300473",
    "x1,6:10437921,10300473",
    "k1,6:10642291,10300473:204370",
    "x1,6:20000000,10300473",
    ")",
    "}1", "Postamble:", "",
  ].join("\n");
  const data = await parseSynctex(new Uint8Array(gzipSync(syn)), ["main.tex", "capitulo.tex"]);
  const y = 10300473 / 65781.76 - 2; // un poco por encima de la línea base, dentro de la caja
  for (const xsp of [9000000, 15000000, 30000000]) {
    assert.deepEqual(inverse(data, 1, xsp / 65781.76, y), { file: "main.tex", line: 6 }, `x=${xsp}`);
  }
});

async function main() {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${name}\n    ${e instanceof Error ? (e.stack ?? e.message) : e}`);
    }
  }
  console.log(failed ? `\n${failed} prueba(s) fallida(s)` : `\n${tests.length} pruebas correctas`);
  process.exit(failed ? 1 : 0);
}
void main();
