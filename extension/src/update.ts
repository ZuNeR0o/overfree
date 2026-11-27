// Actualización de la extensión desde GitHub Releases (no viene de ninguna tienda, así que
// el editor no la actualiza solo): consulta, pregunta, descarga el .vsix e instala.

import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { REPO, pickUpdate, type Release } from "./releases";

// al abrir el editor, pero no más de una vez por hora (GitHub admite 60 consultas/hora sin cuenta)
const MIN_GAP = 60 * 60 * 1000;
const LAST_CHECK = "folio.update.lastCheck";
const SKIPPED = "folio.update.skipped";

/** `manual`: desde el comando (avisa también si no hay nada nuevo y no respeta «omitir»). */
export async function checkForUpdate(ctx: vscode.ExtensionContext, manual = false) {
  if (!manual) {
    if (!vscode.workspace.getConfiguration("folio").get<boolean>("checkForUpdates", true)) return;
    if (Date.now() - ctx.globalState.get<number>(LAST_CHECK, 0) < MIN_GAP) return;
  }
  await ctx.globalState.update(LAST_CHECK, Date.now());

  const current = String(ctx.extension.packageJSON.version);
  let update;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "folio-latex" },
    });
    if (!r.ok) throw new Error(`GitHub respondió ${r.status}`);
    update = pickUpdate((await r.json()) as Release[], current);
  } catch (e) {
    if (manual) void vscode.window.showWarningMessage(`Overfree: no se pudo buscar actualizaciones (${e instanceof Error ? e.message : e}).`);
    return;
  }
  if (!update) {
    if (manual) void vscode.window.showInformationMessage(`Overfree: tienes la última versión (${current}).`);
    return;
  }
  if (!manual && ctx.globalState.get<string>(SKIPPED) === update.version) return;

  const choice = await vscode.window.showInformationMessage(
    `Overfree LaTeX ${update.version} está disponible (tienes ${current}).`,
    "Actualizar",
    "Novedades",
    "Omitir esta versión",
  );
  if (choice === "Novedades") {
    void vscode.env.openExternal(vscode.Uri.parse(update.page));
    return;
  }
  if (choice === "Omitir esta versión") {
    await ctx.globalState.update(SKIPPED, update.version);
    return;
  }
  if (choice !== "Actualizar") return;

  try {
    const file = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Overfree: descargando ${update.version}…` },
      async () => {
        const r = await fetch(update.url, { headers: { "User-Agent": "folio-latex" } });
        if (!r.ok) throw new Error(`descarga: HTTP ${r.status}`);
        const data = new Uint8Array(await r.arrayBuffer());
        // un .vsix es un ZIP: si no empieza por "PK", la descarga no es el paquete
        if (data[0] !== 0x50 || data[1] !== 0x4b) throw new Error("el archivo descargado no es un .vsix");
        await fs.mkdir(ctx.globalStorageUri.fsPath, { recursive: true });
        const uri = vscode.Uri.joinPath(ctx.globalStorageUri, `folio-latex-${update.version}.vsix`);
        await fs.writeFile(uri.fsPath, data);
        return uri;
      },
    );
    await vscode.commands.executeCommand("workbench.extensions.installExtension", file);
    void fs.rm(file.fsPath, { force: true }).catch(() => undefined);
  } catch (e) {
    const open = await vscode.window.showErrorMessage(
      `Overfree: no se pudo actualizar (${e instanceof Error ? e.message : e}). Puedes instalar el .vsix a mano.`,
      "Abrir la release",
    );
    if (open) void vscode.env.openExternal(vscode.Uri.parse(update.page));
    return;
  }
  // sin recargar, el editor sigue con los ajustes y menús de la versión anterior
  const reload = await vscode.window.showInformationMessage(
    `Overfree LaTeX ${update.version} instalada. Recarga la ventana para usarla.`,
    "Recargar ventana",
  );
  if (reload) void vscode.commands.executeCommand("workbench.action.reloadWindow");
}
