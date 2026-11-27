// Pruebas de integración: se ejecutan dentro de VS Code (ver run.mjs) con el TeX real.
// Compilan un proyecto de verdad y comprueban errores, revisión, visor PDF, SyncTeX,
// tablas y DOI. Guardan capturas de pantalla en $FOLIO_SHOTS si está definida.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { inverse, parseSynctex } from "../../../src/synctex";
import type { PdfPanel } from "../../src/pdfPanel";

type Api = { pdf: PdfPanel; isCompiling: () => boolean; outline: { rebuildOutline: () => Promise<void>; outlineRoots: () => { label: string; children: { label: string }[] }[] } };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(what: string, fn: () => T | undefined | null | false, ms = 30000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`Tiempo agotado esperando: ${what}`);
    await sleep(200);
  }
}

function shot(name: string) {
  const dir = process.env.FOLIO_SHOTS;
  if (!dir) return;
  try {
    execFileSync("import", ["-window", "root", path.join(dir, `${name}.png`)]);
  } catch (e) {
    console.log(`  (sin captura ${name}: ${e instanceof Error ? e.message : e})`);
  }
}

const diagText = (uri: vscode.Uri, source?: string) =>
  vscode.languages
    .getDiagnostics(uri)
    .filter((d) => !source || d.source === source)
    .map((d) => `${d.range.start.line + 1}: ${d.message}`);

export async function run() {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(ws, "hay carpeta de trabajo");
  const main = vscode.Uri.file(path.join(ws, "main.tex"));
  const cap = vscode.Uri.file(path.join(ws, "capitulo.tex"));
  const results: { name: string; ok: boolean; detail?: string }[] = [];
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`  ✓ ${name}`);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      results.push({ name, ok: false, detail });
      console.log(`  ✗ ${name}\n    ${detail}`);
    }
  };

  const ext = vscode.extensions.getExtension<Api>("zuner0o.folio-latex");
  assert.ok(ext, "extensión instalada");
  let api!: Api;

  await step("se activa al abrir un .tex", async () => {
    await vscode.window.showTextDocument(main);
    api = await ext.activate();
    assert.ok(ext.isActive);
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ["folio.compile", "folio.syncForward", "folio.pasteTable", "folio.addReferenceByDoi"]) assert.ok(cmds.includes(c), c);
  });

  await step("icono de Overfree en la barra de actividad", async () => {
    assert.ok(existsSync(path.join(ext.extensionPath, "media", "overfree.svg")), "media/overfree.svg en el paquete");
    await vscode.commands.executeCommand("workbench.view.extension.folio");
    await sleep(3000);
    shot("0-barra-lateral");
    await vscode.commands.executeCommand("workbench.view.explorer");
  });

  await step("compila con TeX Live y muestra el PDF en el webview", async () => {
    await vscode.commands.executeCommand("folio.compile");
    assert.ok(existsSync(path.join(ws, ".folio", "build", "main.pdf")), "main.pdf en .folio/build");
    const st = await waitFor("PDF dibujado", () => api.pdf.renderState);
    assert.equal(st.error, undefined, st.error);
    assert.ok(st.pages >= 1, `páginas: ${st.pages}`);
    assert.ok((st.ink ?? -1) > 0.001, `la página 1 está en blanco (tinta: ${st.ink})`);
    await sleep(1500); // que termine de pintar antes de la captura
    shot("1-compilado");
  });

  await step("error del registro traducido, en su línea", async () => {
    const ds = diagText(main, "LaTeX");
    const err = ds.find((d) => d.includes("Comando no definido"));
    assert.ok(err, `diagnósticos: ${JSON.stringify(ds)}`);
    assert.match(err, /^9: /, "\\foo está en la línea 9");
  });

  await step("BibTeX resuelve las citas (BIBINPUTS con ':')", async () => {
    const log = readFileSync(path.join(ws, ".folio", "build", "main.log"), "latin1");
    assert.doesNotMatch(log, /Citation `einstein' .*undefined/);
    assert.ok(existsSync(path.join(ws, ".folio", "build", "main.bbl")), "main.bbl");
    assert.match(readFileSync(path.join(ws, ".folio", "build", "main.bbl"), "utf8"), /Einstein/);
  });

  await step("revisión del proyecto: \\ref roto en otro archivo", async () => {
    await vscode.commands.executeCommand("folio.checkProject");
    const ds = await waitFor("diagnóstico de proyecto", () => {
      const d = diagText(cap, "Proyecto");
      return d.length ? d : null;
    }, 10000);
    assert.ok(ds.some((d) => d.includes("noexiste")), JSON.stringify(ds));
  });

  let rect: { page: number; top: number; bottom: number; left: number; right: number } | null = null;
  await step("SyncTeX: del código al PDF", async () => {
    await vscode.window.showTextDocument(main, { viewColumn: vscode.ViewColumn.One });
    rect = api.pdf.revealSource(main.fsPath, 6);
    assert.ok(rect, "hay correspondencia para la línea 6");
    assert.equal(rect.page, 1);
    await sleep(500);
    shot("2-ir-al-pdf");
  });

  await step("SyncTeX: del PDF al código (doble clic)", async () => {
    assert.ok(rect);
    const r = rect;
    await api.pdf.inverseAt(r.page, (r.left + r.right) / 2, (r.top + r.bottom) / 2);
    const ed = await waitFor("editor en main.tex", () => vscode.window.activeTextEditor?.document.fileName === main.fsPath && vscode.window.activeTextEditor, 5000).catch(async (e) => {
      const data = await parseSynctex(new Uint8Array(readFileSync(path.join(ws, ".folio", "build", "main.synctex.gz"))), ["main.tex", "capitulo.tex"]);
      const hit = inverse(data, r.page, (r.left + r.right) / 2, (r.top + r.bottom) / 2);
      const ae = vscode.window.activeTextEditor;
      throw new Error(`${e.message}; rect=${JSON.stringify(r)} inverse=${JSON.stringify(hit)} files=${JSON.stringify(data.files)} activo=${ae?.document.fileName}:${ae?.selection.active.line}`);
    });
    const line = ed.selection.active.line + 1;
    assert.ok(Math.abs(line - 6) <= 1, `línea ${line}`);
  });

  await step("revisión en vivo: entorno sin cerrar", async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(ws, "lint.tex"));
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    const ds = await waitFor("diagnóstico en vivo", () => {
      const d = diagText(doc.uri, "Revisión");
      return d.length ? d : null;
    }, 10000);
    assert.ok(ds.some((d) => /sin cerrar/.test(d)), JSON.stringify(ds));
    shot("3-revision-en-vivo");
  });

  await step("pegar celdas de Excel como tabla booktabs", async () => {
    const ed = await vscode.window.showTextDocument(main, { viewColumn: vscode.ViewColumn.One });
    const end = ed.document.lineAt(5).range.end;
    ed.selection = new vscode.Selection(end, end);
    await vscode.env.clipboard.writeText("Muestra\tMasa\nA\t1.5\nB\t2.25\n");
    await vscode.commands.executeCommand("folio.pasteTable");
    const text = ed.document.getText();
    assert.match(text, /\\toprule/);
    assert.match(text, /Muestra\s*& Masa/);
    await vscode.commands.executeCommand("workbench.action.files.revert");
  });

  await step("referencia por DOI (doi.org)", async () => {
    // cada extensión tiene su propio objeto vscode: solo se puede sustituir el cuadro de texto
    // cuando la extensión es la de desarrollo (no con el .vsix instalado)
    if (!ext.extensionPath.startsWith(path.resolve(__dirname, ".."))) {
      console.log("    (omitida: con el .vsix instalado no se puede simular el cuadro del DOI)");
      return;
    }
    const ed = await vscode.window.showTextDocument(main, { viewColumn: vscode.ViewColumn.One });
    const pos = ed.document.lineAt(6).range.end;
    ed.selection = new vscode.Selection(pos, pos);
    const original = vscode.window.showInputBox;
    (vscode.window as { showInputBox: unknown }).showInputBox = async () => "https://doi.org/10.1103/PhysRev.47.777";
    try {
      await vscode.commands.executeCommand("folio.addReferenceByDoi");
    } finally {
      (vscode.window as { showInputBox: unknown }).showInputBox = original;
    }
    const bib = readFileSync(path.join(ws, "refs.bib"), "utf8");
    assert.match(bib, /10\.1103\/PhysRev\.47\.777/i, "entrada añadida a refs.bib");
    assert.match(ed.document.lineAt(6).text, /\\cite\{[^}]+\}$/, "\\cite insertado");
    await vscode.commands.executeCommand("workbench.action.files.revert");
  });

  await step("autocompletado: \\ref con las etiquetas del proyecto y \\begin", async () => {
    const ed = await vscode.window.showTextDocument(cap, { viewColumn: vscode.ViewColumn.One });
    const end = ed.document.lineAt(ed.document.lineCount - 1).range.end;
    await ed.edit((e) => e.insert(end, "\nVer \\ref{"));
    const pos = ed.document.lineAt(ed.document.lineCount - 1).range.end;
    const list = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", ed.document.uri, pos, "{");
    const labels = list.items.map((i) => (typeof i.label === "string" ? i.label : i.label.label));
    assert.ok(labels.includes("sec:intro"), `etiquetas: ${labels.slice(0, 20).join(", ")}`);
    await ed.edit((e) => e.insert(pos, "}\n\\begin{"));
    const pos2 = ed.document.lineAt(ed.document.lineCount - 1).range.end;
    const envs = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", ed.document.uri, pos2, "{");
    assert.ok(envs.items.some((i) => i.label === "equation"), "entorno equation");
    await vscode.commands.executeCommand("workbench.action.files.revert");
  });

  await step("esquema: secciones en la vista Outline", async () => {
    const syms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", main);
    assert.ok(syms?.some((s) => s.name === "Introducción"), `símbolos: ${JSON.stringify(syms?.map((s) => s.name))}`);
  });

  await step("formato: Ctrl+B pone en negrita y lo quita", async () => {
    const ed = await vscode.window.showTextDocument(cap, { viewColumn: vscode.ViewColumn.One });
    const line = ed.document.lineAt(2);
    const word = line.text.indexOf("Texto");
    ed.selection = new vscode.Selection(2, word, 2, word + 5);
    await vscode.commands.executeCommand("folio.format.bold");
    assert.match(ed.document.lineAt(2).text, /\\textbf\{Texto\}/);
    ed.selection = new vscode.Selection(2, word, 2, word + "\\textbf{Texto}".length);
    await vscode.commands.executeCommand("folio.format.bold");
    assert.equal(ed.document.lineAt(2).text, line.text, "segunda vez: se quita");
    await vscode.commands.executeCommand("workbench.action.files.revert");
  });

  await step("barra de estado: motor y ajuste de línea", async () => {
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ["folio.selectEngine", "folio.toggleAutoCompile", "folio.format.heading", "folio.openProject", "folio.checkForUpdates", "workbench.extensions.installExtension"]) assert.ok(cmds.includes(c), c);
    const wrapCfg = vscode.workspace.getConfiguration("editor", { languageId: "latex" }).get("wordWrap");
    assert.equal(wrapCfg, "on", "editor.wordWrap en LaTeX");
  });

  await step("Auto: compila al dejar de escribir, sin guardar a mano", async () => {
    const c = vscode.workspace.getConfiguration("folio");
    await c.update("compileOnType", true, vscode.ConfigurationTarget.Workspace);
    try {
      while (api.isCompiling()) await sleep(200);
      const ed = await vscode.window.showTextDocument(cap, { viewColumn: vscode.ViewColumn.One });
      await ed.edit((e) => e.insert(new vscode.Position(ed.document.lineCount, 0), "\nEscrito sin guardar.\n"));
      await waitFor("guardado automático", () => !ed.document.isDirty, 5000);
      await waitFor("compilación automática", () => api.isCompiling(), 5000);
      await waitFor("fin de la compilación", () => !api.isCompiling(), 60000);
    } finally {
      await c.update("compileOnType", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  await step("F12 en \\ref y \\cite, hover de la cita y enlaces de \\input", async () => {
    const doc = await vscode.workspace.openTextDocument(main);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    const line = doc.lineAt(6).text;
    const at = (s: string) => new vscode.Position(6, line.indexOf(s) + 2);
    const ref = await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeDefinitionProvider", main, at("sec:intro"));
    assert.equal(ref?.[0]?.range.start.line, 4, "\\label en la línea 5");
    const cite = await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeDefinitionProvider", main, at("einstein"));
    assert.ok(cite?.[0]?.uri.fsPath.endsWith("refs.bib"), "entrada en refs.bib");
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", main, at("einstein"));
    const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === "string" ? c : c.value))).join("\n");
    assert.match(text, /Albert(&nbsp;|\s)Einstein/, text); // appendText escapa los espacios
    const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>("vscode.executeLinkProvider", main);
    const targets = links.map((l) => l.target?.fsPath ?? "");
    assert.ok(targets.some((t) => t.endsWith("capitulo.tex")) && targets.some((t) => t.endsWith("refs.bib")), targets.join(", "));
  });

  await step("esquema del proyecto: sigue los \\input", async () => {
    await api.outline.rebuildOutline();
    const roots = api.outline.outlineRoots();
    const intro = roots.find((r) => r.label === "Introducción");
    assert.ok(intro?.children.some((c) => c.label === "Capítulo"), JSON.stringify(roots));
  });

  await step("corrección rápida: sin → \\sin", async () => {
    const ed = await vscode.window.showTextDocument(cap, { viewColumn: vscode.ViewColumn.One });
    await ed.edit((e) => e.insert(new vscode.Position(ed.document.lineCount, 0), "\n$sin x$\n"));
    await vscode.commands.executeCommand("folio.checkProject");
    const d = await waitFor("aviso de sin", () => vscode.languages.getDiagnostics(cap).find((x) => x.source === "Proyecto" && x.message.includes("\\sin")), 10000);
    assert.equal(ed.document.getText(d.range), "sin", "el aviso marca solo la palabra");
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", cap, d.range);
    const fix = actions.find((a) => a.title.includes("\\sin"));
    assert.ok(fix?.edit, `acciones: ${actions.map((a) => a.title).join(", ")}`);
    await vscode.workspace.applyEdit(fix.edit);
    assert.match(ed.document.getText(), /\$\\sin x\$/);
    await vscode.commands.executeCommand("workbench.action.files.revert");
  });

  await step("compilar al guardar y cancelar", async () => {
    const before = api.pdf.renderState?.at ?? 0;
    const doc = await vscode.workspace.openTextDocument(cap);
    const ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    await ed.edit((e) => e.insert(new vscode.Position(doc.lineCount, 0), "\nTexto añadido al guardar.\n"));
    await doc.save();
    await waitFor("compilación al guardar", () => api.isCompiling(), 5000);
    await vscode.commands.executeCommand("folio.cancel");
    await waitFor("cancelada", () => !api.isCompiling(), 5000);
    // y una compilación normal después funciona
    await vscode.commands.executeCommand("folio.compile");
    await waitFor("PDF actualizado", () => (api.pdf.renderState?.at ?? 0) > before && api.pdf.renderState, 30000);
    shot("4-final");
  });

  await step("captura de la interfaz", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
    await vscode.commands.executeCommand("workbench.action.closePanel");
    await vscode.commands.executeCommand("notifications.clearAll");
    await vscode.commands.executeCommand("workbench.view.extension.folio");
    await vscode.commands.executeCommand("folio.tools.focus"); // el panel Herramientas existe y se abre
    await vscode.window.showTextDocument(main, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(6, 0, 6, 0) });
    await vscode.commands.executeCommand("folio.showPdf");
    await vscode.window.showTextDocument(main, { viewColumn: vscode.ViewColumn.One });
    await sleep(4000);
    shot("5-interfaz");
  });

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `\n${failed.length} de ${results.length} fallidas` : `\n${results.length} pruebas de integración correctas`);
  if (failed.length) throw new Error(failed.map((f) => `${f.name}: ${f.detail}`).join("\n"));
}
