// Visor PDF de Overfree en un panel de VS Code: el mismo PdfViewer (pdf.js) de la app, con
// SyncTeX en los dos sentidos. El SyncTeX se interpreta aquí (extensión) y el webview
// solo dibuja y avisa de los dobles clics y enlaces.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { forward, inverse, parseSynctex, type SyncData } from "../../src/synctex";
import { isInside, listProjectFiles, type TexProject } from "./texproject";

type FromWebview =
  | { type: "ready" }
  | { type: "inverse"; page: number; x: number; y: number }
  | { type: "link"; url: string }
  | { type: "rendered"; pages: number }
  | { type: "error"; message: string };

/** Último resultado del webview: cuántas páginas dibujó o por qué falló. */
export type RenderState = { pages: number; error?: string; at: number };

export class PdfPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private ready: Promise<void> | null = null;
  private markReady: (() => void) | null = null;
  private project: TexProject | null = null;
  private sync: SyncData | null = null;
  private pdfPath: string | null = null;
  renderState: RenderState | null = null;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  get isOpen() {
    return this.panel !== null;
  }

  /** Muestra (o actualiza) el PDF de un proyecto. `preserveFocus`: no quitar el foco al editor. */
  async show(project: TexProject, pdfPath: string, synctexPath: string | null, preserveFocus = true) {
    const [pdf, gz] = await Promise.all([fs.readFile(pdfPath), synctexPath ? fs.readFile(synctexPath).catch(() => null) : null]);
    this.project = project;
    this.pdfPath = pdfPath;
    this.sync = null;
    if (gz) {
      try {
        this.sync = await parseSynctex(new Uint8Array(gz), await listProjectFiles(project.root));
      } catch {
        this.sync = null; // sin SyncTeX el PDF se ve igual
      }
    }
    this.ensurePanel(preserveFocus);
    this.panel!.title = `PDF · ${path.basename(pdfPath)}`;
    await this.ready; // se resuelve también si el panel se cierra antes de estar listo
    // Uint8Array se transfiere sin pasar por base64
    void this.panel?.webview.postMessage({ type: "load", data: new Uint8Array(pdf) });
  }

  /** Ir al PDF: resalta lo que generó esa línea del código. */
  /** Devuelve la zona del PDF resaltada (puntos PDF), o null si no hay correspondencia. */
  revealSource(file: string, line: number) {
    if (!this.panel || !this.project || !this.sync) return null;
    const rel = path.relative(this.project.root, file).split(path.sep).join("/");
    const r = forward(this.sync, rel, line);
    if (!r) return null;
    this.panel.reveal(undefined, true);
    void this.panel.webview.postMessage({ type: "reveal", ...r });
    return r;
  }

  /** Lo mismo que un doble clic en el PDF (para las pruebas de integración). */
  inverseAt(page: number, x: number, y: number) {
    return this.onMessage({ type: "inverse", page, x, y });
  }

  get currentProject() {
    return this.project;
  }

  /** Vuelve a cargar el último PDF (p. ej. al reabrir el panel). */
  async reopen() {
    if (this.project && this.pdfPath) await this.show(this.project, this.pdfPath, this.pdfPath.replace(/\.pdf$/, ".synctex.gz"), false);
  }

  private ensurePanel(preserveFocus: boolean) {
    if (this.panel) {
      if (!this.panel.visible) this.panel.reveal(undefined, preserveFocus);
      return;
    }
    const dist = vscode.Uri.joinPath(this.ctx.extensionUri, "dist");
    this.panel = vscode.window.createWebviewPanel(
      "folio.pdf",
      "PDF",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [dist] },
    );
    this.panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, "media", "icon.png");
    this.ready = new Promise((r) => (this.markReady = r));
    this.panel.webview.html = this.html(this.panel.webview, dist);
    this.panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m));
    this.panel.onDidDispose(() => {
      this.panel = null;
      this.markReady?.(); // nadie debe quedarse esperando a un panel cerrado
      this.ready = null;
    });
  }

  private async onMessage(m: FromWebview) {
    if (!m || typeof m !== "object") return;
    if (m.type === "ready") this.markReady?.();
    else if (m.type === "rendered") this.renderState = { pages: Number(m.pages) || 0, at: Date.now() };
    else if (m.type === "error") this.renderState = { pages: 0, error: String(m.message), at: Date.now() };
    else if (m.type === "link") {
      if (typeof m.url !== "string" || !/^(https?:|mailto:)/i.test(m.url)) return;
      try {
        void vscode.env.openExternal(vscode.Uri.parse(m.url, true));
      } catch {
        /* URL mal formada: se ignora */
      }
    } else if (m.type === "inverse") {
      if (![m.page, m.x, m.y].every(Number.isFinite)) return;
      if (!this.sync || !this.project) {
        void vscode.window.showInformationMessage("Overfree: este PDF no tiene datos de SyncTeX.");
        return;
      }
      const hit = inverse(this.sync, m.page, m.x, m.y);
      if (!hit) return;
      // el .synctex.gz lo escribe TeX: solo se abren archivos del proyecto
      const abs = path.resolve(this.project.root, hit.file);
      if (!isInside(abs, this.project.root)) return;
      const uri = vscode.Uri.file(abs);
      const pos = new vscode.Position(Math.max(0, hit.line - 1), 0);
      // en la columna del editor de texto, no encima del PDF
      const column = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === uri.fsPath)?.viewColumn ?? vscode.ViewColumn.One;
      try {
        await vscode.window.showTextDocument(uri, { viewColumn: column, selection: new vscode.Range(pos, pos) });
      } catch {
        void vscode.window.showWarningMessage(`Overfree: no se puede abrir ${hit.file}.`);
      }
    }
  }

  private html(webview: vscode.Webview, dist: vscode.Uri) {
    const nonce = randomBytes(16).toString("hex");
    const src = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(dist, f)).toString();
    const invert = vscode.workspace.getConfiguration("folio").get<boolean>("pdf.invertInDarkTheme") ? "invert" : "";
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`, // pdf.js decodifica algunas imágenes con WASM
      `connect-src ${webview.cspSource}`,
      "worker-src blob:",
    ].join("; ");
    return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${src("webview.css")}">
</head>
<body class="${invert}">
  <div class="bar">
    <button id="zoom-out" title="Alejar (Ctrl+rueda)">−</button>
    <button id="zoom-in" title="Acercar (Ctrl+rueda)">+</button>
    <select id="zoom" title="Zoom">
      <option value="width">Ancho</option><option value="page">Página</option>
      <option value="0.75">75 %</option><option value="1">100 %</option><option value="1.5">150 %</option><option value="2">200 %</option>
      <option value="custom" hidden></option>
    </select>
    <span id="page-info" class="muted"></span>
    <span class="spacer"></span>
    <input id="find" type="search" placeholder="Buscar (Ctrl+F)" title="Buscar en el PDF (Ctrl+F; Enter: siguiente)" spellcheck="false">
    <span id="find-info" class="muted"></span>
  </div>
  <div id="pdf-root" class="pdf-root"><p class="empty">Compila para ver el PDF.</p></div>
  <script nonce="${nonce}">globalThis.__FOLIO_PDF_WORKER__ = ${JSON.stringify(src("pdf.worker.min.mjs")).replace(/</g, "\\u003c")};</script>
  <script nonce="${nonce}" src="${src("webview.js")}"></script>
</body>
</html>`;
  }

  dispose() {
    this.panel?.dispose();
  }
}
