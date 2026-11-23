// Qué proyecto LaTeX corresponde a un archivo: carpeta raíz, archivo principal y motor.
// Sin dependencias de VS Code, para poder probarlo con Node.
//
// Orden: 1) proyecto de Folio (.folio/project.json en la carpeta o en una superior),
// 2) `% !TEX root = …`, 3) el propio archivo si tiene \documentclass, 4) el ajuste
// folio.mainFile, 5) el archivo con \documentclass del espacio de trabajo (mejor main.tex).

import * as fs from "node:fs/promises";
import * as path from "node:path";

export type Engine = "pdflatex" | "xelatex" | "lualatex";
export type EngineSetting = Engine | "auto";

export type TexProject = {
  /** Carpeta desde la que se compila (las rutas de \input son relativas a ella). */
  root: string;
  /** Archivo principal relativo a `root`, con barras normales. */
  main: string;
  engine: Engine;
  /** Si viene de un proyecto de la app Folio (.folio/project.json). */
  folio: boolean;
};

const SKIP_DIRS = new Set([".folio", ".git", "node_modules", ".vscode", "__pycache__"]);

export const toPosix = (p: string) => p.split(path.sep).join("/");
export const relPath = (root: string, abs: string) => toPosix(path.relative(root, abs));
export const isInside = (child: string, parent: string) => {
  const r = path.relative(parent, child);
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
};

/** Quita los comentarios (% sin escapar) conservando las líneas. */
export const stripComments = (t: string) => t.replace(/(^|[^\\])%.*$/gm, "$1");

/** Archivos del proyecto (rutas relativas), sin .folio/.git/node_modules. Tope para carpetas enormes. */
export async function listProjectFiles(root: string, max = 5000): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(abs);
      } else if (e.isFile()) {
        out.push(relPath(root, abs));
      }
    }
  };
  await walk(root);
  return out;
}

async function readJson(p: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

export const ENGINES: Engine[] = ["pdflatex", "xelatex", "lualatex"];
export const asEngine = (v: unknown): Engine | null => {
  const s = String(v ?? "").toLowerCase();
  return (ENGINES as string[]).includes(s) ? (s as Engine) : null;
};

/** Motor que pide el propio documento: % !TEX program, o paquetes que solo van con XeLaTeX/LuaLaTeX. */
export function engineFromSource(text: string): Engine | null {
  const magic = /^\s*%\s*!TEX\s+(?:TS-)?program\s*=\s*(\w+)/im.exec(text.slice(0, 4000))?.[1];
  if (asEngine(magic)) return asEngine(magic);
  if (/\\usepackage(\[[^\]]*\])?\{[^}]*\b(fontspec|unicode-math|polyglossia)\b/.test(stripComments(text))) return "xelatex";
  return null;
}

/** Igual que Folio: el que tiene \documentclass, preferiblemente main.tex y poco profundo. */
export async function guessMain(root: string, files: string[]): Promise<string | null> {
  const docs: string[] = [];
  for (const f of files.filter((f) => /\.tex$/i.test(f)).slice(0, 400)) {
    const text = await fs.readFile(path.join(root, f), "utf8").catch(() => "");
    if (/\\documentclass/.test(stripComments(text))) docs.push(f);
  }
  return docs.find((f) => /(^|\/)main\.tex$/.test(f)) ?? docs.sort((a, b) => a.split("/").length - b.split("/").length)[0] ?? null;
}

export type ResolveOptions = {
  /** Carpeta del espacio de trabajo que contiene el archivo, si la hay. */
  workspaceRoot?: string;
  /** Ajuste folio.mainFile (relativo al espacio de trabajo). */
  mainFile?: string;
  engine?: EngineSetting;
  /** Texto actual del archivo (puede estar sin guardar). */
  text?: string;
};

export async function resolveProject(file: string, opts: ResolveOptions = {}): Promise<TexProject | null> {
  const ws = opts.workspaceRoot;
  // el ajuste puede venir de un .vscode/settings.json ajeno: solo motores conocidos
  const setting = asEngine(opts.engine);

  // 1. proyecto de la app Folio
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const meta = await readJson(path.join(dir, ".folio", "project.json"));
    if (meta && typeof meta.main === "string" && meta.main.endsWith(".tex")) {
      return { root: dir, main: meta.main, engine: setting ?? asEngine(meta.engine) ?? "pdflatex", folio: true };
    }
    if ((ws && dir === ws) || path.dirname(dir) === dir || (ws && !isInside(dir, ws))) break;
  }

  const text = opts.text ?? (await fs.readFile(file, "utf8").catch(() => ""));
  let mainAbs: string | null = null;
  const magicRoot = /^\s*%\s*!TEX\s+root\s*=\s*(.+?)\s*$/im.exec(text.slice(0, 4000))?.[1];
  if (magicRoot) mainAbs = path.resolve(path.dirname(file), magicRoot);
  else if (/\\documentclass/.test(stripComments(text))) mainAbs = file;
  else if (opts.mainFile && ws) mainAbs = path.resolve(ws, opts.mainFile);
  else {
    const base = ws ?? path.dirname(file);
    const guess = await guessMain(base, await listProjectFiles(base, 3000));
    if (guess) mainAbs = path.join(base, guess);
  }
  // el principal tiene que estar dentro del espacio de trabajo (un % !TEX root no puede sacarlo de él)
  if (!mainAbs || !mainAbs.endsWith(".tex") || (ws && !isInside(mainAbs, ws))) return null;

  // se compila desde la carpeta del principal, como haría pdflatex a mano
  const root = path.dirname(mainAbs);
  const main = path.basename(mainAbs);
  let engine = setting;
  if (!engine) {
    const mainText = mainAbs === file ? text : await fs.readFile(mainAbs, "utf8").catch(() => "");
    engine = engineFromSource(mainText) ?? "pdflatex";
  }
  return { root, main, engine, folio: false };
}
