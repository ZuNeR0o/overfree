// Compilador LaTeX en el navegador con BusyTeX (WebAssembly), API de texlyre-busytex 1.x.

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
  runner ??= import("texlyre-busytex")
    .then(async ({ BusyTexRunner }) => {
      const r = new BusyTexRunner({
        busytexBasePath: BASE,
        preloadDataPackages: PRELOAD,
        catalogDataPackages: CATALOG,
        onDownloadProgress: (p) => progressCb?.(p.percent),
      });
      await r.initialize(true); // true = Web Worker
      ready = true;
      return r;
    })
    .catch((error) => {
      runner = null; // permite reintentar
      throw error;
    });
  return runner;
}

/** Empieza a cargar el motor en segundo plano para que la primera compilación sea rápida. */
export function warmUp() {
  void loadRunner().catch(() => undefined);
}

const texSources = (files: ProjectFile[]) =>
  files
    .filter((f) => /\.(tex|sty|cls)$/.test(f.path) && typeof f.content === "string")
    .map((f) => f.content as string)
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
const AUX_RE = /\.(aux|toc|lof|lot|out|bbl|nav|snm|vrb|ind|idx|gls|glo|glg|acn|acr|alg|ist|loa|thm|brf|xref)$/i;
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
  if (!mainFile || typeof mainFile.content !== "string") {
    throw new Error(`No se encontró el archivo principal ${main}.`);
  }

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
    input: mainFile.content,
    mainTexPath: main,
    // modo rápido: una pasada, sin bibliografía ni índice (usa los de la última vez)
    bibtex: tools.bibtex && !draft,
    biber: tools.biber && !draft,
    makeindex: tools.makeindex && !draft,
    rerun: !draft, // pasadas extra solo si TeX las pide (ver scripts/patch-busytex.mjs)
    additionalFiles: [...files.filter((f) => f !== mainFile), ...aux],
    remoteEndpoint: online ? REMOTE_ENDPOINT : undefined,
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

/** Compila de una en una: si se pulsa dos veces, la segunda espera a la primera. */
export function compileProject(
  files: ProjectFile[],
  opts: { main?: string; engine?: Engine; cacheKey?: string; draft?: boolean } = {},
): Promise<CompileResult> {
  const { main = "main.tex", engine = "pdflatex", cacheKey = "default", draft = false } = opts;
  const key = auxKey(cacheKey, main, engine);
  const job = queue.then(() => run(files, main, engine, navigator.onLine, key, draft));
  queue = job.catch(() => undefined);
  return job;
}
