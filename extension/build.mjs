// Empaqueta la extensión (Node, CommonJS) y el visor PDF del webview (navegador, IIFE).
// Reutiliza los módulos de ../src: el código de Folio se comparte, no se copia.
//   node build.mjs               desarrollo
//   node build.mjs --production  minificado, sin sourcemaps (para el .vsix)
//   node build.mjs --watch
//   node build.mjs --test        además, dist/test.js (pruebas sin VS Code)
import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "package.json"));
const args = new Set(process.argv.slice(2));
const production = args.has("--production");

mkdirSync(join(here, "dist"), { recursive: true });
// pdf.js necesita su worker como archivo aparte; el webview lo carga desde dist/
copyFileSync(require.resolve("pdfjs-dist/build/pdf.worker.min.mjs"), join(here, "dist", "pdf.worker.min.mjs"));
copyFileSync(join(here, "webview", "pdf.css"), join(here, "dist", "webview.css"));
// vsce exige la licencia junto al package.json
copyFileSync(join(here, "..", "LICENSE"), join(here, "LICENSE"));

/** `import url from "x?url"` (sintaxis de Vite en src/pdfview.ts): en el webview la URL la da la página. */
const viteUrlImports = {
  name: "vite-url",
  setup(b) {
    b.onResolve({ filter: /\?url$/ }, (a) => ({ path: a.path, namespace: "vite-url" }));
    b.onLoad({ filter: /.*/, namespace: "vite-url" }, () => ({
      contents: "export default globalThis.__FOLIO_PDF_WORKER__ || '';",
      loader: "js",
    }));
  },
};

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: "info",
  legalComments: "none",
};

const builds = [
  {
    ...common,
    entryPoints: [join(here, "src", "extension.ts")],
    outfile: join(here, "dist", "extension.js"),
    platform: "node",
    format: "cjs",
    target: "node18",
    external: ["vscode"],
  },
  {
    ...common,
    entryPoints: [join(here, "webview", "pdf.ts")],
    outfile: join(here, "dist", "webview.js"),
    platform: "browser",
    format: "iife",
    target: "chrome114",
    plugins: [viteUrlImports],
  },
];
if (args.has("--test")) {
  builds.push({
    ...common,
    entryPoints: [join(here, "test", "test.ts")],
    outfile: join(here, "dist", "test.js"),
    platform: "node",
    format: "cjs",
    target: "node18",
  });
}

if (args.has("--watch")) {
  for (const o of builds) await (await esbuild.context(o)).watch();
} else {
  await Promise.all(builds.map((o) => esbuild.build(o)));
}
