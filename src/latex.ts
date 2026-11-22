// Compilador LaTeX en el navegador con BusyTeX (WebAssembly), API de texlyre-busytex 1.x.

import { decodeText } from "./encoding";

type Runner = InstanceType<typeof import("texlyre-busytex").BusyTexRunner>;

export type Engine = "pdflatex" | "xelatex" | "lualatex";
export type ProjectFile = { path: string; content: string | Uint8Array };
export type CompileResult = {
  success: boolean;
  pdf: Uint8Array | null;
  synctex: Uint8Array | null;
  log: string;
};

// Ruta relativa: funciona igual con Vite que dentro de la app de escritorio.
const BASE = new URL("core/busytex", document.baseURI).href.replace(/\/$/, "");
const pkg = (name: string) => `${BASE}/texlive-${name}.js`;
// Se precargan los paquetes comunes; "extra" queda en el catálogo y el motor
// lo carga solo cuando el documento usa algo que vive ahí (memoir, tikz-cd...).
const PRELOAD = [pkg("basic"), pkg("recommended")];
const CATALOG = [pkg("basic"), pkg("recommended"), pkg("extra")];
// Servidor público de TeXlyre: entrega bajo demanda lo que no está en ningún
// paquete local (idiomas de babel, fuentes, etc.). Solo se usa con internet.
const REMOTE_ENDPOINT = "https://texlive2026.texlyre.org";

let runner: Promise<Runner> | null = null;
let ready = false;
let queue: Promise<unknown> = Promise.resolve();
let progressCb: ((pct: number) => void) | null = null;

export const engineReady = () => ready;
export const onEngineProgress = (cb: (pct: number) => void) => (progressCb = cb);

function loadRunner(): Promise<Runner> {
  if (runner) return runner;
  const p: Promise<Runner> = import("texlyre-busytex")
    .then(async ({ BusyTexRunner }) => {
      const r = new BusyTexRunner({
        busytexBasePath: BASE,
        preloadDataPackages: PRELOAD,
        catalogDataPackages: CATALOG,
        onDownloadProgress: (pr) => progressCb?.(pr.percent),
      });
      await r.initialize(true); // true = Web Worker
      if (runner !== p) {
        // se canceló mientras cargaba: este motor ya no se usa
        r.terminate();
        throw new Error("Compilación cancelada");
      }
      ready = true;
      return r;
    })
    .catch((error) => {
      if (runner === p) runner = null; // permite reintentar (sin pisar un motor más nuevo)
      throw error;
    });
  runner = p;
  return p;
}

/** Empieza a cargar el motor en segundo plano para que la primera compilación sea rápida. */
export function warmUp() {
  void loadRunner().catch(() => undefined);
}

const texSources = (files: ProjectFile[]) =>
  files
    .filter((f) => /\.(tex|sty|cls)$/.test(f.path))
    // los .tex en Latin-1 llegan como bytes: se decodifican solo para detectar paquetes
    .map((f) => (typeof f.content === "string" ? f.content : decodeText(f.content).text))
    .join("\n");

/** Decide BibTeX/Biber/makeindex según lo que use el proyecto. */
function detectTools(files: ProjectFile[]) {
  const hasBib = files.some((f) => f.path.endsWith(".bib"));
  const tex = texSources(files).replace(/(^|[^\\])%.*$/gm, "$1");
  const usesBiblatex = /\\usepackage(\[[^\]]*\])?\{[^}]*biblatex[^}]*\}/.test(tex);
  const bibtexBackend = /backend\s*=\s*bibtex/.test(tex);
  const biber = usesBiblatex && !bibtexBackend;
  const makeindex = /\\makeindex\b|\\usepackage(\[[^\]]*\])?\{[^}]*(imakeidx|makeidx)[^}]*\}/.test(tex);
  return { biber, bibtex: hasBib && !biber, makeindex };
}

// Archivos auxiliares de la compilación anterior (referencias, índice, bibliografía...).
// Reutilizarlos, como hace Overleaf, permite que una sola pasada de TeX baste casi siempre.
const AUX_RE = /\.(aux|toc|lof|lot|out|bbl|nav|snm|vrb|ind|idx|gls|glo|glg|acn|acr|alg|ist|slo|sls|slg|nlo|nls|nlg|glsdefs|loa|thm|brf|xref)$/i;
const auxCache = new Map<string, ProjectFile[]>();

/** Olvida los auxiliares guardados (p. ej. si una compilación falla de forma rara). */
export const clearAuxCache = (key?: string) => (key ? auxCache.delete(key) : auxCache.clear());

const auxKey = (cacheKey: string, main: string, engine: Engine) => `${cacheKey}|${main}|${engine}`;
type AuxFile = { path: string; data: string };
const enc = (c: string | Uint8Array) => (typeof c === "string" ? c : new TextDecoder().decode(c));

/** Auxiliares de la última compilación, para guardarlos junto al PDF. */
export function exportAux(cacheKey: string, main: string, engine: Engine): AuxFile[] {
  return (auxCache.get(auxKey(cacheKey, main, engine)) ?? []).map((f) => ({ path: f.path, data: enc(f.content) }));
}

/** Restaura los auxiliares guardados al abrir un proyecto. */
export function importAux(cacheKey: string, main: string, engine: Engine, files: AuxFile[]) {
  auxCache.set(auxKey(cacheKey, main, engine), files.map((f) => ({ path: f.path, content: f.data })));
}

async function run(
  files: ProjectFile[],
  main: string,
  engine: Engine,
  online: boolean,
  cacheKey: string,
  draft: boolean,
): Promise<CompileResult> {
  const mainFile = files.find((f) => f.path === main);
  if (!mainFile) {
    throw new Error(`No se encontró el archivo principal ${main}.`);
  }
  // BusyTeX escribe el archivo principal como UTF-8. Si está en otra codificación (Latin-1),
  // se compila un envoltorio que hace \input del original con sus bytes intactos.
  const wrapped = typeof mainFile.content !== "string";
  const dir = main.includes("/") ? main.slice(0, main.lastIndexOf("/") + 1) : "";
  const mainPath = wrapped ? `${dir}__folio_main.tex` : main;
  const input = wrapped ? `\\input{${main.slice(dir.length)}}\n` : (mainFile.content as string);

  const [lib, r] = await Promise.all([import("texlyre-busytex"), loadRunner()]);
  const Compiler = {
    pdflatex: lib.PdfLatex,
    xelatex: lib.XeLatex,
    lualatex: lib.LuaLatex,
  }[engine];

  const tools = detectTools(files);
  const own = new Set(files.map((f) => f.path));
  const aux = (auxCache.get(cacheKey) ?? []).filter((f) => !own.has(f.path));
  const result = await new Compiler(r).compile({
    input,
    mainTexPath: mainPath,
    // modo rápido: una pasada, sin bibliografía ni índice (usa los de la última vez)
    bibtex: tools.bibtex && !draft,
    biber: tools.biber && !draft,
    makeindex: tools.makeindex && !draft,
    rerun: !draft, // pasadas extra solo si TeX las pide (ver scripts/patch-busytex.mjs)
    additionalFiles: [...files.filter((f) => wrapped || f !== mainFile), ...aux],
    remoteEndpoint: online ? REMOTE_ENDPOINT : undefined,
    // con el envoltorio, BusyTeX no ve los \usepackage del original: se cargan todos los paquetes
    ...(wrapped ? { dataPackagesJs: CATALOG } : {}),
  });

  if (result.pdf) {
    try {
      const out = await r.readProjectFiles();
      auxCache.set(
        cacheKey,
        out.filter((f) => AUX_RE.test(f.path) && !own.has(f.path)).map((f) => ({ path: f.path, content: f.content })),
      );
    } catch {
      /* sin caché: la próxima compilación hará más pasadas */
    }
  } else {
    auxCache.delete(cacheKey);
  }

  return {
    success: result.success,
    pdf: result.pdf ?? null,
    synctex: result.synctex ?? null,
    log: result.log,
  };
}

/** Rechaza la compilación en curso (la asigna compileProject mientras corre). */
let abortCurrent: ((reason: Error) => void) | null = null;
/** Compilaciones en cola que aún no empezaron, y cancelación pedida para la siguiente. */
let waiting = 0;
let cancelNext = false;

/**
 * Cancela la compilación en curso. BusyTeX no se puede interrumpir a mitad de una
 * pasada, así que se detiene su worker; la siguiente compilación vuelve a cargar el
 * motor (tarda unos segundos más). Devuelve false si no había nada que cancelar.
 */
export function cancelCompile(): boolean {
  const abort = abortCurrent;
  if (!abort) {
    // aún en cola: se cancela en cuanto le toque (si no hay nada en cola, no hace nada)
    if (waiting > 0) cancelNext = true;
    return waiting > 0;
  }
  abortCurrent = null;
  const old = runner;
  runner = null;
  ready = false;
  void old?.then((r) => r.terminate()).catch(() => undefined);
  abort(new Error("Compilación cancelada"));
  return true;
}

/** Compila de una en una: si se pulsa dos veces, la segunda espera a la primera. */
export function compileProject(
  files: ProjectFile[],
  opts: { main?: string; engine?: Engine; cacheKey?: string; draft?: boolean } = {},
): Promise<CompileResult> {
  const { main = "main.tex", engine = "pdflatex", cacheKey = "default", draft = false } = opts;
  const key = auxKey(cacheKey, main, engine);
  waiting++;
  const job = queue.then(
    () =>
      new Promise<CompileResult>((resolve, reject) => {
        waiting--;
        if (cancelNext) {
          cancelNext = false;
          return reject(new Error("Compilación cancelada"));
        }
        abortCurrent = reject;
        run(files, main, engine, navigator.onLine, key, draft)
          .then(resolve, reject)
          .finally(() => {
            if (abortCurrent === reject) abortCurrent = null;
          });
      }),
  );
  queue = job.catch(() => undefined);
  return job;
}
