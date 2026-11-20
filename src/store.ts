// Almacenamiento de proyectos. En el navegador usa IndexedDB (sin el límite de
// ~5 MB de localStorage). En la app de escritorio se sustituye por carpetas reales
// en disco (ver electron/preload.cjs), con la misma interfaz.

import type { Engine } from "./latex";

export type ProjectMeta = {
  id: string;
  name: string;
  main: string;
  engine: Engine;
  folders: string[]; // carpetas vacías (las demás se deducen de las rutas)
  created: number;
  updated: number;
  /** Solo escritorio: carpeta real del proyecto. */
  dir?: string;
};

export type StoredFile = { path: string; text?: string; data?: Uint8Array };

export type Snapshot = {
  id: string;
  time: number;
  label: string;
  files: { path: string; text: string }[];
};

export interface Backend {
  readonly kind: "browser" | "desktop";
  listProjects(): Promise<ProjectMeta[]>;
  saveMeta(meta: ProjectMeta): Promise<void>;
  deleteProject(id: string): Promise<void>;
  loadFiles(id: string): Promise<StoredFile[]>;
  writeFile(id: string, file: StoredFile): Promise<void>;
  deleteFile(id: string, path: string): Promise<void>;
  listSnapshots(id: string): Promise<Snapshot[]>;
  addSnapshot(id: string, snap: Snapshot): Promise<void>;
  deleteSnapshot(id: string, snapId: string): Promise<void>;
  /** Último PDF y SyncTeX, para mostrarlos al abrir sin recompilar. */
  saveOutput(id: string, out: Output): Promise<void>;
  loadOutput(id: string): Promise<Output | null>;
}

export type Output = {
  pdf: Uint8Array;
  synctex: Uint8Array | null;
  time: number;
  /** Auxiliares (.aux, .toc, .bbl…) para que la siguiente compilación haga una sola pasada. */
  aux?: { main: string; engine: string; files: { path: string; data: string }[] };
};

export const TEXT_EXT = /\.(tex|bib|sty|cls|bst|bbx|cbx|lbx|def|cfg|clo|dtx|ins|ltx|txt|md|csv|dat|tsv|json|xml|lua|py|r|m|tikz|pgf|gp|asy|mp|bbl|ist|idx|gls|nlo|log)$/i;
export const isTextPath = (p: string) => TEXT_EXT.test(p) || !/\.[^/]+$/.test(p);

export const newId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------- IndexedDB ----------

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}

class BrowserBackend implements Backend {
  readonly kind = "browser" as const;
  private db: Promise<IDBDatabase>;

  constructor() {
    this.db = new Promise((res, rej) => {
      const open = indexedDB.open("folio", 2);
      open.onupgradeneeded = () => {
        const db = open.result;
        const has = (n: string) => db.objectStoreNames.contains(n);
        if (!has("projects")) db.createObjectStore("projects", { keyPath: "id" });
        if (!has("files")) db.createObjectStore("files", { keyPath: ["pid", "path"] }).createIndex("pid", "pid");
        if (!has("snapshots")) db.createObjectStore("snapshots", { keyPath: ["pid", "id"] }).createIndex("pid", "pid");
        if (!has("outputs")) db.createObjectStore("outputs");
      };
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
    // Pide almacenamiento persistente para que el navegador no lo borre solo.
    void navigator.storage?.persist?.();
  }

  private async store(name: string, mode: IDBTransactionMode = "readonly") {
    const tx = (await this.db).transaction(name, mode);
    return { tx, os: tx.objectStore(name) };
  }

  async listProjects() {
    const { os } = await this.store("projects");
    const all = (await req(os.getAll())) as ProjectMeta[];
    return all.sort((a, b) => b.updated - a.updated);
  }

  async saveMeta(meta: ProjectMeta) {
    const { tx, os } = await this.store("projects", "readwrite");
    os.put(meta);
    await done(tx);
  }

  async deleteProject(id: string) {
    const db = await this.db;
    const tx = db.transaction(["projects", "files", "snapshots", "outputs"], "readwrite");
    tx.objectStore("projects").delete(id);
    tx.objectStore("outputs").delete(id);
    for (const s of ["files", "snapshots"]) {
      const os = tx.objectStore(s);
      const keys = await req(os.index("pid").getAllKeys(id));
      for (const k of keys) os.delete(k);
    }
    await done(tx);
  }

  async loadFiles(id: string) {
    const { os } = await this.store("files");
    const rows = (await req(os.index("pid").getAll(id))) as (StoredFile & { pid: string })[];
    return rows.map(({ path, text, data }) => ({ path, text, data }));
  }

  async writeFile(id: string, file: StoredFile) {
    const { tx, os } = await this.store("files", "readwrite");
    os.put({ pid: id, ...file });
    await done(tx);
  }

  async deleteFile(id: string, path: string) {
    const { tx, os } = await this.store("files", "readwrite");
    os.delete([id, path]);
    await done(tx);
  }

  async listSnapshots(id: string) {
    const { os } = await this.store("snapshots");
    const rows = (await req(os.index("pid").getAll(id))) as (Snapshot & { pid: string })[];
    return rows.sort((a, b) => b.time - a.time);
  }

  async addSnapshot(id: string, snap: Snapshot) {
    const { tx, os } = await this.store("snapshots", "readwrite");
    os.put({ pid: id, ...snap });
    await done(tx);
  }

  async deleteSnapshot(id: string, snapId: string) {
    const { tx, os } = await this.store("snapshots", "readwrite");
    os.delete([id, snapId]);
    await done(tx);
  }

  async saveOutput(id: string, out: Output) {
    const { tx, os } = await this.store("outputs", "readwrite");
    os.put(out, id);
    await done(tx);
  }

  async loadOutput(id: string) {
    const { os } = await this.store("outputs");
    return ((await req(os.get(id))) as Output | undefined) ?? null;
  }
}

// ---------- Escritorio (Tauri): carpetas reales a través del servidor local en Rust ----------

declare global {
  interface Window {
    __FOLIO?: { token: string; api: string };
  }
}

class DesktopBackend implements Backend {
  readonly kind = "desktop" as const;
  constructor(private cfg: { token: string; api: string }) {}

  private async call(method: string, path: string, body?: BodyInit, query?: Record<string, string>) {
    const qs = query ? "?" + new URLSearchParams(query).toString() : "";
    const r = await fetch(`${this.cfg.api}${path}${qs}`, {
      method,
      body,
      headers: { "X-Folio-Token": this.cfg.token },
    });
    if (!r.ok && r.status !== 404) {
      const msg = await r.json().then((j: { error?: string }) => j.error).catch(() => r.statusText);
      throw new Error(msg || `Error ${r.status}`);
    }
    return r;
  }
  private json = async <T>(method: string, path: string, body?: BodyInit, query?: Record<string, string>) =>
    (await (await this.call(method, path, body, query)).json()) as T;
  private p = (id: string) => `/projects/${encodeURIComponent(id)}`;

  listProjects() {
    return this.json<ProjectMeta[]>("GET", "/projects");
  }
  async saveMeta(meta: ProjectMeta) {
    const { dir: _dir, ...rest } = meta;
    await this.call("PUT", `${this.p(meta.id)}/meta`, JSON.stringify(rest));
  }
  async deleteProject(id: string) {
    await this.call("DELETE", this.p(id));
  }
  async loadFiles(id: string) {
    const rows = await this.json<{ path: string; text?: string; b64?: string }[]>("GET", `${this.p(id)}/files`);
    return rows.map((r) =>
      r.text !== undefined ? { path: r.path, text: r.text } : { path: r.path, data: Uint8Array.from(atob(r.b64 ?? ""), (c) => c.charCodeAt(0)) },
    );
  }
  async writeFile(id: string, file: StoredFile) {
    const body = file.text !== undefined ? file.text : new Blob([(file.data ?? new Uint8Array()).slice()]);
    await this.call("PUT", `${this.p(id)}/file`, body, { path: file.path });
  }
  async deleteFile(id: string, path: string) {
    await this.call("DELETE", `${this.p(id)}/file`, undefined, { path });
  }
  listSnapshots(id: string) {
    return this.json<Snapshot[]>("GET", `${this.p(id)}/snapshots`);
  }
  async addSnapshot(id: string, snap: Snapshot) {
    await this.call("PUT", `${this.p(id)}/snapshots`, JSON.stringify(snap));
  }
  async deleteSnapshot(id: string, snapId: string) {
    await this.call("DELETE", `${this.p(id)}/snapshots/${encodeURIComponent(snapId)}`);
  }
  async saveOutput(id: string, out: Output) {
    await this.call("PUT", `${this.p(id)}/output/pdf`, new Blob([out.pdf.slice()]));
    if (out.synctex) await this.call("PUT", `${this.p(id)}/output/synctex`, new Blob([out.synctex.slice()]));
    await this.call("PUT", `${this.p(id)}/output/info`, JSON.stringify({ time: out.time, aux: out.aux }));
  }
  async loadOutput(id: string) {
    const get = async (w: string) => {
      const r = await this.call("GET", `${this.p(id)}/output/${w}`);
      return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
    };
    const pdf = await get("pdf");
    if (!pdf) return null;
    const info = await get("info");
    let time = Date.now();
    let aux: Output["aux"];
    try {
      if (info) ({ time = time, aux } = JSON.parse(new TextDecoder().decode(info)));
    } catch {
      /* sin fecha */
    }
    return { pdf, synctex: await get("synctex"), time, aux };
  }

  // extras de escritorio
  /** Ruta, tamaño y fecha de cada archivo: sirve para notar cambios hechos fuera de Folio. */
  manifest(id: string) {
    return this.json<{ path: string; size: number; mtime: number }[]>("GET", `${this.p(id)}/manifest`);
  }
  async readFile(id: string, path: string): Promise<StoredFile> {
    const r = await this.json<{ path: string; text?: string; b64?: string }>("GET", `${this.p(id)}/file`, undefined, { path });
    return r.text !== undefined ? { path, text: r.text } : { path, data: Uint8Array.from(atob(r.b64 ?? ""), (c) => c.charCodeAt(0)) };
  }
  /** Control de versiones con Git (status, log, init, commit, remote, sync). */
  git<T = unknown>(id: string, action: string, body?: Record<string, string>) {
    const method = action === "status" || action === "log" ? "GET" : "POST";
    return this.json<T>(method, `${this.p(id)}/git/${action}`, body ? JSON.stringify(body) : undefined);
  }
  /** Abre una URL en el navegador predeterminado del sistema. */
  async openUrl(url: string) {
    await this.call("POST", "/open-url", undefined, { url });
  }
  /** TeX instalado en el equipo (MiKTeX / TeX Live), si lo hay. */
  nativeInfo() {
    return this.json<{ available: boolean; version?: string; path?: string; miktex?: boolean }>("GET", "/native");
  }
  async compileNative(id: string, opts: { main: string; engine: string; shellEscape: boolean; draft: boolean }) {
    const r = await this.json<{ success: boolean; pdf: string | null; synctex: string | null; log: string }>(
      "POST",
      `${this.p(id)}/native/compile`,
      JSON.stringify(opts),
    );
    const dec = (b: string | null) => (b ? Uint8Array.from(atob(b), (c) => c.charCodeAt(0)) : null);
    return { success: r.success, pdf: dec(r.pdf), synctex: dec(r.synctex), log: r.log };
  }
  async cleanNative(id: string) {
    await this.call("POST", `${this.p(id)}/native/clean`);
  }
  /** Abre una ventana nativa adicional (p. ej. el PDF en otro monitor). */
  async openWindow(page: string) {
    await this.call("POST", "/open-window", undefined, { page });
  }
  openFolder() {
    return this.json<ProjectMeta | null>("POST", "/open-folder");
  }
  async reveal(id: string) {
    await this.call("POST", `${this.p(id)}/reveal`);
  }
  async saveAs(name: string, data: Blob) {
    const r = await this.json<{ saved: string | null }>("POST", "/save-as", data, { name });
    return r.saved;
  }
}

// ---------- Selección del backend ----------

export const desktop: DesktopBackend | null = window.__FOLIO ? new DesktopBackend(window.__FOLIO) : null;
export const backend: Backend = desktop ?? new BrowserBackend();

/** Migra el proyecto único de la versión anterior (localStorage). */
export async function migrateLegacy(): Promise<void> {
  if (desktop) return;
  const KEY = "folio:project:v1";
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const old = JSON.parse(raw) as {
      files: { path: string; text?: string; b64?: string }[];
      engine: Engine;
    };
    const meta: ProjectMeta = {
      id: newId(),
      name: "Mi proyecto",
      main: "main.tex",
      engine: old.engine ?? "pdflatex",
      folders: [],
      created: Date.now(),
      updated: Date.now(),
    };
    await backend.saveMeta(meta);
    for (const f of old.files) {
      await backend.writeFile(meta.id, {
        path: f.path,
        text: f.text,
        data: f.b64 ? Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)) : undefined,
      });
    }
    localStorage.removeItem(KEY);
  } catch {
    // si falla se deja el dato antiguo intacto
  }
}
