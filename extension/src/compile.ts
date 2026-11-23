// Compilación con el TeX instalado (MiKTeX o TeX Live). Es la misma orquestación que la app
// de escritorio (src-tauri/src/native.rs), para que un proyecto compile igual en los dos:
// los auxiliares van a <proyecto>/.folio/build, biber/bibtex/makeindex tras la primera
// pasada y se repite mientras LaTeX lo pida (máximo 5 pasadas). Sin dependencias de VS Code.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ENGINES, type Engine } from "./texproject";

const WIN = process.platform === "win32";
const EXE = WIN ? ".exe" : "";
/** Separador de listas de rutas de kpathsea; el vacío final añade las rutas por defecto. */
const PATH_SEP = WIN ? ";" : ":";
const MAX_PASSES = 5;
const MAX_TOOL_OUTPUT = 512 * 1024;

export class CancelledError extends Error {
  constructor() {
    super("Compilación cancelada.");
  }
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Años de TeX Live instalados en `base` (2026, 2025…), del más reciente al más antiguo. */
function texliveYears(base: string): string[] {
  try {
    return readdirSync(base)
      .filter((n) => /^\d{4}$/.test(n))
      .sort()
      .reverse()
      .map((n) => path.join(base, n));
  } catch {
    return [];
  }
}

/** Carpeta con los binarios de TeX: ajuste del usuario, PATH y rutas habituales. */
export function findTexBin(custom?: string): string | null {
  const exe = "pdflatex" + EXE;
  const dirs: string[] = [];
  if (custom) dirs.push(custom);
  dirs.push(...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean));
  if (WIN) {
    const local = process.env.LOCALAPPDATA;
    if (local) dirs.push(path.join(local, "Programs", "MiKTeX", "miktex", "bin", "x64"));
    dirs.push("C:\\Program Files\\MiKTeX\\miktex\\bin\\x64");
    for (const y of texliveYears("C:\\texlive")) dirs.push(path.join(y, "bin", "windows"), path.join(y, "bin", "win64"));
  } else {
    dirs.push("/Library/TeX/texbin", "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin");
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    for (const y of texliveYears("/usr/local/texlive")) {
      dirs.push(path.join(y, "bin", `${arch}-linux`), path.join(y, "bin", "universal-darwin"));
    }
  }
  return dirs.find((d) => existsSync(path.join(d, exe))) ?? null;
}

export const isMiktex = (bin: string) => bin.toLowerCase().includes("miktex");

/** Primera línea de `pdflatex --version` (para mostrar qué TeX se usa). */
export async function texVersion(bin: string): Promise<string> {
  const r = await run(bin, "pdflatex", ["--version"], bin, {}, new AbortController().signal).catch(() => null);
  return r?.out.split("\n")[0]?.trim() ?? "";
}

/**
 * Ruta relativa simple dentro del proyecto (con /), que TeX no pueda leer como opción (-…),
 * primitiva (\…), formato (&…) ni código ({ } % # en el nombre). Mismas reglas que native.rs.
 */
export function validMain(main: string): boolean {
  if (!/[^/]\.tex$/.test(main) || /[:\\{}%#]/.test(main) || main.startsWith("/")) return false;
  return main.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".." && !/^[\s\-&]/.test(seg));
}

function killTree(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (WIN) {
      // taskkill /T cierra también los hijos; si no se puede lanzar, al menos el proceso
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
    } else {
      process.kill(-child.pid, "SIGKILL"); // el grupo entero (pdflatex puede lanzar hijos)
    }
  } catch {
    child.kill("SIGKILL");
  }
}

type Run = { code: number | null; out: string };

function run(bin: string, tool: string, args: string[], cwd: string, env: Record<string, string>, signal: AbortSignal): Promise<Run> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new CancelledError());
    const child = spawn(path.join(bin, tool + EXE), args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: !WIN, // grupo de procesos propio, para poder matarlo entero
    });
    let out = "";
    const take = (b: Buffer) => {
      if (out.length < MAX_TOOL_OUTPUT) out += b.toString("utf8");
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const onAbort = () => killTree(child);
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error(`No se pudo ejecutar ${tool}: ${e.message}`));
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) reject(new CancelledError());
      else resolve({ code, out: `$ ${tool} ${args.join(" ")}\n${out}\n` });
    });
  });
}

/** Replica las subcarpetas del proyecto en build/: \include escribe allí su .aux. */
async function mirrorDirs(src: string, dst: string) {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(src, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name !== ".folio" && e.name !== ".git" && e.name !== "node_modules") {
      await fs.mkdir(path.join(dst, e.name), { recursive: true });
      await mirrorDirs(path.join(src, e.name), path.join(dst, e.name));
    }
  }
}

const read = (p: string) => fs.readFile(p, "latin1").catch(() => ""); // el .log no siempre es UTF-8

export type CompileOptions = {
  root: string;
  main: string;
  engine: Engine;
  texPath?: string;
  shellEscape?: boolean;
  /** Una sola pasada, sin bibliografía (más rápido). */
  draft?: boolean;
  signal: AbortSignal;
};

export type CompileResult = {
  success: boolean;
  pdfPath: string | null;
  synctexPath: string | null;
  /** Registro de la última pasada de LaTeX (lo que se analiza). */
  log: string;
  /** Salida de todas las herramientas, para el canal de salida. */
  toolsLog: string;
  passes: number;
  bin: string;
};

export async function compile(o: CompileOptions): Promise<CompileResult> {
  const bin = findTexBin(o.texPath);
  if (!bin) {
    throw new Error("No se encontró TeX en el equipo (MiKTeX o TeX Live). Instálalo o indica su carpeta en el ajuste folio.texPath.");
  }
  if (!ENGINES.includes(o.engine)) throw new Error(`Motor no válido: ${o.engine}`);
  if (!validMain(o.main) || !existsSync(path.join(o.root, o.main))) throw new Error(`Archivo principal no válido: ${o.main}`);
  if (!isDir(o.root)) throw new Error(`No existe la carpeta del proyecto: ${o.root}`);

  const build = path.join(o.root, ".folio", "build");
  await fs.mkdir(build, { recursive: true });
  await mirrorDirs(o.root, build);

  const stem = o.main.replace(/\.tex$/, "");
  const job = path.posix.basename(stem.replace(/\\/g, "/"));
  const args = ["-interaction=nonstopmode", "-synctex=1", `-output-directory=${build}`];
  if (isMiktex(bin)) args.push("-enable-installer"); // instala los paquetes que falten, sin preguntar
  if (o.shellEscape) args.push("-shell-escape");
  args.push(o.main);

  const f = (ext: string) => path.join(build, `${job}.${ext}`);
  // si esta compilación no genera PDF, no se debe mostrar el de la anterior
  await fs.rm(f("pdf"), { force: true });
  await fs.rm(f("synctex.gz"), { force: true });

  let toolsLog = "";
  let prevAux = await read(f("aux"));
  let log = "";
  let passes = 0;
  for (;;) {
    passes++;
    toolsLog += (await run(bin, o.engine, args, o.root, {}, o.signal)).out;
    log = await read(f("log"));
    const nowAux = await read(f("aux"));
    // error fatal (sin PDF): no tiene sentido seguir con bibliografía ni más pasadas
    if (o.draft || !existsSync(f("pdf"))) break;

    let extra = false;
    if (passes === 1) {
      const inputs = { BIBINPUTS: o.root + PATH_SEP, BSTINPUTS: o.root + PATH_SEP };
      if (existsSync(f("bcf"))) {
        toolsLog += (await run(bin, "biber", [`--input-directory=${o.root}`, job], build, {}, o.signal)).out;
        extra = true;
      } else if (nowAux.includes("\\bibdata")) {
        toolsLog += (await run(bin, "bibtex", [job], build, inputs, o.signal)).out;
        extra = true;
      }
      // glosarios y acrónimos (como makeglossaries)
      for (const [i, out, lg] of [["glo", "gls", "glg"], ["acn", "acr", "alg"], ["slo", "sls", "slg"]]) {
        if (existsSync(f(i)) && existsSync(f("ist")) && (await read(f(i))).trim()) {
          toolsLog += (await run(bin, "makeindex", ["-s", `${job}.ist`, "-t", `${job}.${lg}`, "-o", `${job}.${out}`, `${job}.${i}`], build, {}, o.signal)).out;
          extra = true;
        }
      }
      if (existsSync(f("idx"))) {
        toolsLog += (await run(bin, "makeindex", [`${job}.idx`], build, {}, o.signal)).out;
        extra = true;
      }
    }

    const strong = /Rerun to get|Label\(s\) may have changed|Rerun LaTeX/.test(log);
    const auxChanged = nowAux !== prevAux;
    prevAux = nowAux;
    if (passes >= MAX_PASSES || !(extra || strong || (auxChanged && log.includes("undefined references")))) break;
  }

  const pdf = existsSync(f("pdf"));
  return {
    success: pdf,
    pdfPath: pdf ? f("pdf") : null,
    synctexPath: existsSync(f("synctex.gz")) ? f("synctex.gz") : null,
    log,
    toolsLog: `${toolsLog}\n==== ${passes} pasada(s) de ${o.engine} (${bin}) ====\n`,
    passes,
    bin,
  };
}

export async function cleanBuild(root: string) {
  await fs.rm(path.join(root, ".folio", "build"), { recursive: true, force: true });
}
