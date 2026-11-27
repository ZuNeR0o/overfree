// Proyectos de la app Overfree en este equipo, para abrirlos como carpeta en VS Code.
// La app los registra en <datos de app.folio.editor>/projects.json ({ id, dir }) y crea
// los nuevos en Documentos/Folio (ver src-tauri/src/store.rs y lib.rs). Sin vscode: se prueba en Node.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type AppProject = { name: string; dir: string };

/** Dónde guarda la app su registro de proyectos y su carpeta por defecto, según el sistema. */
export function appLocations(env = process.env, home = os.homedir(), platform = process.platform) {
  const data =
    platform === "win32"
      ? path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "app.folio.editor")
      : platform === "darwin"
        ? path.join(home, "Library", "Application Support", "app.folio.editor")
        : path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "app.folio.editor");
  const docs = [path.join(home, "Documents", "Folio"), path.join(home, "Documentos", "Folio")];
  return { registry: path.join(data, "projects.json"), docs };
}

async function nameOf(dir: string): Promise<string | null> {
  try {
    const meta = JSON.parse(await fs.readFile(path.join(dir, ".folio", "project.json"), "utf8"));
    return typeof meta.name === "string" && meta.name ? meta.name : path.basename(dir);
  } catch {
    return null; // sin .folio/project.json no es un proyecto de la app
  }
}

/** Proyectos registrados por la app y los de Documentos/Folio, sin repetir y solo los que existen. */
export async function listAppProjects(loc = appLocations()): Promise<AppProject[]> {
  const dirs: string[] = [];
  try {
    const list = JSON.parse(await fs.readFile(loc.registry, "utf8"));
    if (Array.isArray(list)) for (const e of list) if (e && typeof e.dir === "string") dirs.push(e.dir);
  } catch {
    /* la app no está instalada o aún no tiene proyectos */
  }
  for (const d of loc.docs) {
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) if (e.isDirectory()) dirs.push(path.join(d, e.name));
  }
  const seen = new Set<string>();
  const out: AppProject[] = [];
  for (const dir of dirs) {
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const name = await nameOf(dir);
    if (name) out.push({ name, dir });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "es"));
}
