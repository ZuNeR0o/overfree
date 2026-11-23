// Folio para VS Code y Antigravity (fork de VS Code): mismo .vsix para los dos.

import * as path from "node:path";
import * as vscode from "vscode";
import { parseLog } from "../../src/logparse";
import { CancelledError, cleanBuild, compile, findTexBin } from "./compile";
import { FolioDiagnostics } from "./diagnostics";
import { PdfPanel } from "./pdfPanel";
import { isInside, listProjectFiles, resolveProject, type EngineSetting, type TexProject } from "./texproject";
import { addReferenceByDoi, pasteTable, registerDrop } from "./tools";

const isLatex = (doc: vscode.TextDocument) => doc.languageId === "latex" || doc.languageId === "tex" || /\.(tex|ltx)$/i.test(doc.fileName);
const cfg = (uri?: vscode.Uri) => vscode.workspace.getConfiguration("folio", uri);

function debounce<A extends unknown[]>(ms: number, fn: (...a: A) => void) {
  const timers = new Map<string, NodeJS.Timeout>();
  return (key: string, ...a: A) => {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => (timers.delete(key), fn(...a)), ms));
  };
}

/** Para no dejar procesos de TeX huérfanos al cerrar el editor. */
let abortRunning: () => void = () => {};

export function activate(ctx: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Folio");
  const diags = new FolioDiagnostics();
  const pdf = new PdfPanel(ctx);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  status.command = "folio.compile";
  status.text = "$(file-pdf) Folio";
  status.tooltip = "Compilar con Folio (Ctrl+Alt+B)";
  ctx.subscriptions.push(output, diags, pdf, status);

  let lastProject: TexProject | null = null;
  let running: { ctrl: AbortController; done: Promise<void> } | null = null;
  let texWarned = false; // el aviso de «no hay TeX» al guardar, una sola vez

  async function projectFor(doc?: vscode.TextDocument): Promise<TexProject | null> {
    doc ??= vscode.window.activeTextEditor?.document;
    if (!doc || doc.uri.scheme !== "file" || !/\.(tex|ltx|bib|sty|cls)$/i.test(doc.fileName)) return lastProject;
    const ws = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath;
    const c = cfg(doc.uri);
    // un .bib/.sty no es un documento: se usa el último proyecto si es de la misma carpeta
    if (!isLatex(doc) && lastProject && isInside(doc.fileName, lastProject.root)) return lastProject;
    const p = await resolveProject(doc.fileName, {
      workspaceRoot: ws,
      mainFile: c.get<string>("mainFile") || undefined,
      engine: c.get<EngineSetting>("engine", "auto"),
      text: isLatex(doc) ? doc.getText() : undefined,
    });
    if (p) lastProject = p;
    return p ?? lastProject;
  }

  const setCompiling = (on: boolean) => void vscode.commands.executeCommand("setContext", "folio.compiling", on);

  async function runCompile(auto: boolean, doc?: vscode.TextDocument) {
    const project = await projectFor(doc);
    if (!project) {
      if (!auto) void vscode.window.showWarningMessage("Folio: abre un archivo .tex (con \\documentclass o con % !TEX root = …).");
      return;
    }
    // una compilación nueva sustituye a la que esté en marcha (en bucle: pudieron llegar varias)
    while (running) {
      running.ctrl.abort();
      await running.done;
    }
    const ctrl = new AbortController();
    let finish!: () => void;
    running = { ctrl, done: new Promise((r) => (finish = r)) };
    setCompiling(true);
    status.text = "$(sync~spin) Folio: compilando…";
    status.tooltip = "Esc o clic: cancelar";
    status.command = "folio.cancel";
    const c = cfg(vscode.Uri.file(project.root));
    const started = Date.now();
    try {
      if (!auto) await vscode.workspace.saveAll(false);
      const r = await compile({
        root: project.root,
        main: project.main,
        engine: project.engine,
        texPath: c.get<string>("texPath") || undefined,
        shellEscape: c.get<boolean>("shellEscape", false),
        signal: ctrl.signal,
      });
      output.clear();
      output.appendLine(r.toolsLog);
      output.appendLine("==== Registro de LaTeX ====");
      output.appendLine(r.log);
      const problems = parseLog(r.log, await listProjectFiles(project.root), project.main);
      diags.setLog(project, problems);
      const errors = problems.filter((p) => p.level === "error").length;
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (r.success && r.pdfPath) {
        status.text = errors ? `$(warning) Folio: ${errors} error(es)` : `$(check) Folio`;
        status.tooltip = `${project.main} · ${project.engine} · ${r.passes} pasada(s) · ${secs} s`;
        if (c.get<boolean>("pdf.openAfterCompile", true) || pdf.isOpen) await pdf.show(project, r.pdfPath, r.synctexPath);
      } else {
        status.text = `$(error) Folio: sin PDF`;
        status.tooltip = `${errors} error(es). Clic: compilar de nuevo`;
        // al guardar basta con la barra de estado y la lista de problemas
        const choice = auto
          ? undefined
          : await vscode.window.showErrorMessage(
          `Folio: la compilación de ${project.main} falló${errors ? ` con ${errors} error(es)` : ""}.`,
          "Ver problemas",
          "Ver registro",
        );
        if (choice === "Ver problemas") void vscode.commands.executeCommand("workbench.actions.view.problems");
        if (choice === "Ver registro") output.show(true);
      }
    } catch (e) {
      if (e instanceof CancelledError) {
        status.text = "$(circle-slash) Folio: cancelado";
      } else {
        status.text = "$(error) Folio";
        const msg = e instanceof Error ? e.message : String(e);
        const noTex = !findTexBin(c.get<string>("texPath") || undefined);
        if (auto && noTex && texWarned) return;
        texWarned ||= noTex;
        status.tooltip = msg;
        const choice = await vscode.window.showErrorMessage(`Folio: ${msg}`, ...(noTex ? ["Ajustes"] : []));
        if (choice === "Ajustes") void vscode.commands.executeCommand("workbench.action.openSettings", "folio.texPath");
      }
    } finally {
      if (running?.ctrl === ctrl) {
        running = null;
        setCompiling(false);
        status.command = "folio.compile";
      }
      finish();
    }
  }

  // ---------- Revisión en vivo y del proyecto ----------
  const lint = debounce(500, (doc: vscode.TextDocument) => {
    if (!doc.isClosed && cfg(doc.uri).get<boolean>("lint.enabled", true)) diags.lintDocument(doc);
  });
  const check = debounce(800, async (doc: vscode.TextDocument) => {
    if (!cfg(doc.uri).get<boolean>("checks.enabled", true)) return;
    const p = await projectFor(doc);
    if (p) await diags.checkProject(p);
  });
  const compileSoon = debounce(300, (doc: vscode.TextDocument) => void runCompile(true, doc));

  const watchDoc = (doc: vscode.TextDocument) => {
    if (!isLatex(doc)) return;
    lint(doc.uri.toString(), doc);
  };
  vscode.workspace.textDocuments.forEach(watchDoc);

  ctx.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(watchDoc),
    vscode.workspace.onDidChangeTextDocument((e) => watchDoc(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => diags.lint.delete(d.uri)),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!/\.(tex|ltx|bib|sty|cls)$/i.test(doc.fileName)) return;
      check("project", doc);
      if (cfg(doc.uri).get<boolean>("compileOnSave", true)) compileSoon("compile", doc);
    }),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed && isLatex(ed.document)) {
        status.show();
        check("project", ed.document);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("folio.lint.enabled") && !cfg().get<boolean>("lint.enabled", true)) diags.lint.clear();
      if (e.affectsConfiguration("folio.checks.enabled") && !cfg().get<boolean>("checks.enabled", true)) diags.checks.clear();
    }),
    registerDrop(projectFor),
  );
  const active = vscode.window.activeTextEditor?.document;
  if (active && isLatex(active)) {
    status.show();
    check("project", active);
  }

  // ---------- Comandos ----------
  const command = (id: string, fn: (...a: never[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  command("folio.compile", () => runCompile(false));
  abortRunning = () => running?.ctrl.abort();
  command("folio.cancel", () => running?.ctrl.abort());
  command("folio.showLog", () => output.show());
  command("folio.showPdf", async () => {
    const p = await projectFor();
    if (!p) return void vscode.window.showWarningMessage("Folio: abre un archivo .tex del proyecto.");
    const pdfPath = path.join(p.root, ".folio", "build", p.main.replace(/^.*[/\\]/, "").replace(/\.tex$/, ".pdf"));
    try {
      await pdf.show(p, pdfPath, pdfPath.replace(/\.pdf$/, ".synctex.gz"), false);
    } catch {
      await runCompile(false); // aún no hay PDF
    }
  });
  command("folio.syncForward", async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    if (!pdf.isOpen) await vscode.commands.executeCommand("folio.showPdf");
    if (!pdf.revealSource(ed.document.fileName, ed.selection.active.line + 1)) {
      vscode.window.setStatusBarMessage("Folio: no hay correspondencia en el PDF (compila de nuevo).", 4000);
    }
  });
  command("folio.checkProject", async () => {
    const p = await projectFor();
    if (!p) return void vscode.window.showWarningMessage("Folio: abre un archivo .tex del proyecto.");
    await diags.checkProject(p);
    void vscode.commands.executeCommand("workbench.actions.view.problems");
  });
  command("folio.pasteTable", async () => pasteTable(await projectFor()));
  command("folio.addReferenceByDoi", async () => addReferenceByDoi(await projectFor()));
  command("folio.clean", async () => {
    const p = await projectFor();
    if (!p) return void vscode.window.showWarningMessage("Folio: abre un archivo .tex del proyecto.");
    await cleanBuild(p.root);
    vscode.window.setStatusBarMessage(`Folio: auxiliares de ${p.main} borrados.`, 4000);
  });

  // Barra lateral (icono de Folio en la barra de actividad): accesos directos a los comandos
  const actions: [string, string, string, unknown[]?][] = [
    ["Compilar", "play", "folio.compile"],
    ["Ver PDF", "open-preview", "folio.showPdf"],
    ["Ir al PDF (SyncTeX)", "go-to-file", "folio.syncForward"],
    ["Revisar el proyecto", "checklist", "folio.checkProject"],
    ["Pegar como tabla LaTeX", "table", "folio.pasteTable"],
    ["Añadir referencia por DOI", "book", "folio.addReferenceByDoi"],
    ["Ver registro de compilación", "output", "folio.showLog"],
    ["Borrar archivos auxiliares", "trash", "folio.clean"],
    ["Ajustes", "gear", "workbench.action.openSettings", ["@ext:zuner0o.folio-latex"]],
  ];
  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider<vscode.TreeItem>("folio.actions", {
      getTreeItem: (i) => i,
      getChildren: (el) =>
        el ? [] : actions.map(([label, icon, id, args]) => {
          const item = new vscode.TreeItem(label);
          item.iconPath = new vscode.ThemeIcon(icon);
          item.command = { command: id, title: label, arguments: args };
          return item;
        }),
    }),
  );

  // API para las pruebas de integración (extension/test/integration); no forma parte de la interfaz
  return {
    pdf,
    diagnostics: diags,
    isCompiling: () => running !== null,
  };
}

export function deactivate() {
  abortRunning();
}
