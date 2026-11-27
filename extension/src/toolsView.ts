// Panel «Herramientas» en la barra lateral de Overfree: la barra de herramientas de la app con
// botones rotulados. La barra del editor solo admite unos pocos iconos (comparte sitio con las
// pestañas); aquí caben todos y no dependen del ancho del editor.

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

type Btn = [label: string, title: string, command: string];
const GROUPS: [string, Btn[]][] = [
  [
    "Compilar",
    [
      ["▶ Compilar", "Compilar (Ctrl+Alt+B)", "folio.compile"],
      ["Ver PDF", "Abrir el visor PDF", "folio.showPdf"],
      ["Ir al PDF", "SyncTeX: del código al PDF (Ctrl+Alt+J)", "folio.syncForward"],
      ["Revisar", "Revisar el proyecto", "folio.checkProject"],
    ],
  ],
  [
    "Texto",
    [
      ["Párrafo…", "Estilo del párrafo: sección, subsección…", "folio.format.heading"],
      ["<b>B</b>", "Negrita (Ctrl+B)", "folio.format.bold"],
      ["<i>I</i>", "Cursiva (Ctrl+I)", "folio.format.italic"],
      ["<u>U</u>", "Subrayado", "folio.format.underline"],
      ["<em>Énf</em>", "Énfasis (\\emph)", "folio.format.emph"],
      ["Nota", "Nota al pie", "folio.format.footnote"],
      ["• Lista", "Lista con viñetas", "folio.format.itemize"],
      ["1. Lista", "Lista numerada", "folio.format.enumerate"],
    ],
  ],
  [
    "Matemáticas",
    [
      ["$x$", "Fórmula en línea", "folio.format.inlineMath"],
      ["Ecuación", "Entorno equation", "folio.format.equation"],
    ],
  ],
  [
    "Insertar",
    [
      ["Figura", "Entorno figure", "folio.format.figure"],
      ["Tabla", "Entorno table", "folio.format.table"],
      ["De Excel", "Pegar celdas copiadas de Excel como tabla", "folio.pasteTable"],
      ["Enlace", "\\href", "folio.format.link"],
      ["Cita (DOI)", "Añadir referencia por DOI", "folio.addReferenceByDoi"],
    ],
  ],
];
const ALLOWED = new Set(GROUPS.flatMap(([, bs]) => bs.map((b) => b[2])).concat(["folio.selectEngine", "folio.toggleAutoCompile"]));

export class ToolsView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private state = { engine: "", auto: false };

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage(async (m: { command?: unknown }) => {
      // el webview solo puede pedir los comandos de este panel
      if (typeof m?.command !== "string" || !ALLOWED.has(m.command)) return;
      const toEditor = m.command.startsWith("folio.format.") || m.command === "folio.pasteTable" || m.command === "folio.addReferenceByDoi";
      if (toEditor) await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
      await vscode.commands.executeCommand(m.command);
    });
    view.onDidDispose(() => (this.view = null));
    this.post();
  }

  /** Motor y «Auto» actuales (los muestra el panel). */
  setState(engine: string, auto: boolean) {
    this.state = { engine, auto };
    this.post();
  }

  private post() {
    void this.view?.webview.postMessage({ type: "state", ...this.state });
  }

  private html() {
    const nonce = randomBytes(16).toString("hex");
    const group = ([name, bs]: [string, Btn[]]) =>
      `<h3>${name}</h3><div class="grid">${bs.map(([l, t, c]) => `<button data-cmd="${c}" title="${t}">${l}</button>`).join("")}</div>`;
    return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
  body { padding: 4px 10px 10px; color: var(--vscode-foreground); font: var(--vscode-font-size) var(--vscode-font-family); }
  h3 { margin: 10px 0 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(78px, 1fr)); gap: 4px; }
  button { font: inherit; padding: 4px 6px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; cursor: pointer;
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  button.primary, button.on { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.primary:hover, button.on:hover { background: var(--vscode-button-hoverBackground); }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-top: 4px; }
</style></head><body>
${group(GROUPS[0])}
<div class="row"><button id="engine" data-cmd="folio.selectEngine" title="Motor de compilación (clic: cambiarlo)">Motor…</button><button id="auto" data-cmd="folio.toggleAutoCompile" title="Compilar automáticamente al escribir">Auto</button></div>
${GROUPS.slice(1).map(group).join("")}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.querySelector('[data-cmd="folio.compile"]').classList.add("primary");
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-cmd]");
    if (b) vscode.postMessage({ command: b.dataset.cmd });
  });
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type !== "state") return;
    document.getElementById("engine").textContent = m.engine || "Motor…";
    const auto = document.getElementById("auto");
    auto.textContent = m.auto ? "Auto: sí" : "Auto: no";
    auto.classList.toggle("on", m.auto);
  });
</script></body></html>`;
  }
}
