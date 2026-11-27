// Overfree para VS Code y Antigravity (fork de VS Code): mismo .vsix para los dos.

import * as path from "node:path";
import * as vscode from "vscode";
import { parseLog } from "../../src/logparse";
import { CancelledError, cleanBuild, compile, findTexBin } from "./compile";
import { FolioDiagnostics, quickFixProvider } from "./diagnostics";
import { registerNavigation } from "./navigation";
import { ToolsView } from "./toolsView";
import { PdfPanel } from "./pdfPanel";
import { isInside, listProjectFiles, resolveProject, type EngineSetting, type TexProject } from "./texproject";
import { wordCount } from "../../src/outline";
import { registerEditing } from "./editing";
import { listAppProjects } from "./projects";
import { checkForUpdate } from "./update";
import { addReferenceByDoi, pasteTable, projectTexts, registerDrop } from "./tools";

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
  const output = vscode.window.createOutputChannel("Overfree");
  const diags = new FolioDiagnostics();
  const pdf = new PdfPanel(ctx);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  status.command = "folio.compile";
  status.text = "$(file-pdf) Overfree";
  status.tooltip = "Compilar con Overfree (Ctrl+Alt+B)";
  // como la app: motor (clic para cambiarlo), compilación automática y palabras
  const engineItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9);
  engineItem.command = "folio.selectEngine";
  const autoItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 8);
  autoItem.command = "folio.toggleAutoCompile";
  const wordsItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const tools = new ToolsView();
  ctx.subscriptions.push(output, diags, pdf, status, engineItem, autoItem, wordsItem, vscode.window.registerWebviewViewProvider("folio.tools", tools));

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

  const ENGINE_NAMES: Record<string, string> = { pdflatex: "pdfLaTeX", xelatex: "XeLaTeX", lualatex: "LuaLaTeX" };
  async function refreshStatus(doc = vscode.window.activeTextEditor?.document) {
    if (!doc || !isLatex(doc)) return;
    const p = await projectFor(doc);
    const setting = cfg(doc.uri).get<EngineSetting>("engine", "auto");
    engineItem.text = `$(symbol-misc) ${p ? ENGINE_NAMES[p.engine] : "LaTeX"}${setting === "auto" ? " (auto)" : ""}`;
    engineItem.tooltip = "Motor de compilación. Clic: cambiarlo";
    const on = cfg(doc.uri).get<boolean>("compileOnType", false);
    autoItem.text = `${on ? "$(check)" : "$(circle-large-outline)"} Auto`;
    autoItem.tooltip = on ? "Compilación automática al escribir: activada. Clic: desactivar" : "Compilación automática al escribir: desactivada. Clic: activar";
    engineItem.show();
    autoItem.show();
    tools.setState(`${p ? ENGINE_NAMES[p.engine] : "LaTeX"}${setting === "auto" ? " (auto)" : ""}`, on);
    if (p) {
      const files = await projectTexts(p, /\.tex$/i);
      wordsItem.text = `${wordCount(files, p.main).toLocaleString("es")} palabras`;
      wordsItem.tooltip = `Palabras del documento (${p.main} y sus \\input), sin fórmulas ni comandos`;
      wordsItem.show();
    }
  }
  const refreshSoon = debounce(1000, (doc?: vscode.TextDocument) => void refreshStatus(doc));

  const setCompiling = (on: boolean) => void vscode.commands.executeCommand("setContext", "folio.compiling", on);

  async function runCompile(auto: boolean, doc?: vscode.TextDocument) {
    const project = await projectFor(doc);
    if (!project) {
      if (!auto) void vscode.window.showWarningMessage("Overfree: abre un archivo .tex (con \\documentclass o con % !TEX root = …).");
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
    status.text = "$(sync~spin) Overfree: compilando…";
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
      void refreshStatus();
      const errors = problems.filter((p) => p.level === "error").length;
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (r.success && r.pdfPath) {
        status.text = errors ? `$(warning) Overfree: ${errors} error(es)` : `$(check) Overfree`;
        status.tooltip = `${project.main} · ${project.engine} · ${r.passes} pasada(s) · ${secs} s`;
        if (c.get<boolean>("pdf.openAfterCompile", true) || pdf.isOpen) await pdf.show(project, r.pdfPath, r.synctexPath);
      } else {
        status.text = `$(error) Overfree: sin PDF`;
        status.tooltip = `${errors} error(es). Clic: compilar de nuevo`;
        // al guardar basta con la barra de estado y la lista de problemas
        const choice = auto
          ? undefined
          : await vscode.window.showErrorMessage(
          `Overfree: la compilación de ${project.main} falló${errors ? ` con ${errors} error(es)` : ""}.`,
          "Ver problemas",
          "Ver registro",
        );
        if (choice === "Ver problemas") void vscode.commands.executeCommand("workbench.actions.view.problems");
        if (choice === "Ver registro") output.show(true);
      }
    } catch (e) {
      if (e instanceof CancelledError) {
        status.text = "$(circle-slash) Overfree: cancelado";
      } else {
        status.text = "$(error) Overfree";
        const msg = e instanceof Error ? e.message : String(e);
        const noTex = !findTexBin(c.get<string>("texPath") || undefined);
        if (auto && noTex && texWarned) return;
        texWarned ||= noTex;
        status.tooltip = msg;
        const choice = await vscode.window.showErrorMessage(`Overfree: ${msg}`, ...(noTex ? ["Ajustes"] : []));
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
  // compilación automática al escribir (el «Auto» de la app): guarda tras una pausa y el guardado compila
  const saveSoon = debounce(1500, (doc: vscode.TextDocument) => {
    if (!doc.isClosed && doc.isDirty && cfg(doc.uri).get<boolean>("compileOnType", false)) void doc.save();
  });

  const watchDoc = (doc: vscode.TextDocument) => {
    if (!isLatex(doc)) return;
    lint(doc.uri.toString(), doc);
  };
  vscode.workspace.textDocuments.forEach(watchDoc);

  ctx.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(watchDoc),
    vscode.workspace.onDidChangeTextDocument((e) => {
      watchDoc(e.document);
      if (e.contentChanges.length && isLatex(e.document) && e.document.uri.scheme === "file") {
        saveSoon(e.document.uri.toString(), e.document);
        refreshSoon("status", e.document);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((d) => diags.lint.delete(d.uri)),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!/\.(tex|ltx|bib|sty|cls)$/i.test(doc.fileName)) return;
      check("project", doc);
      const c = cfg(doc.uri);
      if (c.get<boolean>("compileOnSave", true) || c.get<boolean>("compileOnType", false)) compileSoon("compile", doc);
    }),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed && isLatex(ed.document)) {
        status.show();
        void refreshStatus(ed.document);
        check("project", ed.document);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("folio.engine") || e.affectsConfiguration("folio.compileOnType")) void refreshStatus();
      if (e.affectsConfiguration("folio.lint.enabled") && !cfg().get<boolean>("lint.enabled", true)) diags.lint.clear();
      if (e.affectsConfiguration("folio.checks.enabled") && !cfg().get<boolean>("checks.enabled", true)) diags.checks.clear();
    }),
    registerDrop(projectFor),
  );
  const active = vscode.window.activeTextEditor?.document;
  if (active && isLatex(active)) {
    status.show();
    void refreshStatus(active);
    check("project", active);
  }

  // ---------- Comandos ----------
  const command = (id: string, fn: (...a: never[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  command("folio.compile", () => runCompile(false));
  abortRunning = () => running?.ctrl.abort();
  command("folio.cancel", () => running?.ctrl.abort());
  command("folio.showLog", () => output.show());
  registerEditing(ctx, (doc) => projectFor(doc));
  const nav = registerNavigation(ctx, (doc) => projectFor(doc));
  ctx.subscriptions.push(
    vscode.languages.registerCodeActionsProvider([{ language: "latex" }, { language: "tex" }], quickFixProvider, {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
  );
  // donde se guarda el ajuste: en la carpeta abierta si la hay (cada proyecto el suyo)
  const target = () => (vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
  /** Tras instalar una versión nueva del .vsix, el editor no conoce sus ajustes hasta recargar la ventana. */
  async function setSetting(key: string, value: unknown) {
    try {
      await cfg().update(key, value, target());
      return true;
    } catch (e) {
      const choice = await vscode.window.showWarningMessage(
        `Overfree: no se pudo guardar el ajuste folio.${key}. Si acabas de actualizar la extensión, recarga la ventana. (${e instanceof Error ? e.message : e})`,
        "Recargar ventana",
      );
      if (choice) void vscode.commands.executeCommand("workbench.action.reloadWindow");
      return false;
    }
  }
  command("folio.selectEngine", async () => {
    const current = cfg().get<EngineSetting>("engine", "auto");
    const pick = await vscode.window.showQuickPick(
      [
        { label: "Automático", value: "auto", description: "Según el preámbulo (fontspec, babel con bidi=basic…)" },
        { label: "pdfLaTeX", value: "pdflatex" },
        { label: "XeLaTeX", value: "xelatex" },
        { label: "LuaLaTeX", value: "lualatex" },
      ].map((o) => ({ ...o, picked: o.value === current, detail: o.value === current ? "Actual" : undefined })),
      { placeHolder: "Motor de compilación" },
    );
    if (!pick) return;
    if (!(await setSetting("engine", pick.value))) return;
    lastProject = null; // el motor resuelto cambia
    await refreshStatus();
  });
  command("folio.openProject", async () => {
    const projects = await listAppProjects();
    const current = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    type Item = vscode.QuickPickItem & { dir?: string };
    const items: Item[] = [
      { label: "$(folder-opened) Abrir otra carpeta…", alwaysShow: true },
      ...(projects.length ? [{ label: "Proyectos de la app Overfree", kind: vscode.QuickPickItemKind.Separator }] : []),
      ...projects.map((p) => ({ label: p.name, description: p.dir === current ? "(abierto)" : p.dir, dir: p.dir })),
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: "Proyecto o carpeta para abrir", matchOnDescription: true });
    if (!pick) return;
    let uri = pick.dir ? vscode.Uri.file(pick.dir) : undefined;
    if (!uri) {
      const sel = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: "Abrir proyecto" });
      uri = sel?.[0];
    }
    if (uri) await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: false });
  });
  command("folio.checkForUpdates", () => checkForUpdate(ctx, true));
  // solo con la extensión instalada (no al desarrollarla ni en las pruebas)
  if (ctx.extensionMode === vscode.ExtensionMode.Production) setTimeout(() => void checkForUpdate(ctx), 5_000);
  command("folio.toggleAutoCompile", async () => {
    const on = !cfg().get<boolean>("compileOnType", false);
    if (!(await setSetting("compileOnType", on))) return;
    vscode.window.setStatusBarMessage(`Overfree: compilación automática ${on ? "activada" : "desactivada"}.`, 3000);
  });
  command("folio.showPdf", async () => {
    const p = await projectFor();
    if (!p) return void vscode.window.showWarningMessage("Overfree: abre un archivo .tex del proyecto.");
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
      vscode.window.setStatusBarMessage("Overfree: no hay correspondencia en el PDF (compila de nuevo).", 4000);
    }
  });
  command("folio.checkProject", async () => {
    const p = await projectFor();
    if (!p) return void vscode.window.showWarningMessage("Overfree: abre un archivo .tex del proyecto.");
    await diags.checkProject(p);
    void vscode.commands.executeCommand("workbench.actions.view.problems");
  });
  command("folio.pasteTable", async () => pasteTable(await projectFor()));
  command("folio.addReferenceByDoi", async () => addReferenceByDoi(await projectFor()));
  command("folio.clean", async () => {
    const p = await projectFor();
    if (!p) return void vscode.window.showWarningMessage("Overfree: abre un archivo .tex del proyecto.");
    await cleanBuild(p.root);
    vscode.window.setStatusBarMessage(`Overfree: auxiliares de ${p.main} borrados.`, 4000);
  });

  // Barra lateral (icono de Overfree en la barra de actividad): accesos directos a los comandos
  const actions: [string, string, string, unknown[]?][] = [
    ["Abrir proyecto…", "folder-opened", "folio.openProject"],
    ["Compilar", "play", "folio.compile"],
    ["Ver PDF", "open-preview", "folio.showPdf"],
    ["Ir al PDF (SyncTeX)", "go-to-file", "folio.syncForward"],
    ["Revisar el proyecto", "checklist", "folio.checkProject"],
    ["Formato: estilo del párrafo", "symbol-text", "folio.format.heading"],
    ["Elegir motor de compilación", "symbol-misc", "folio.selectEngine"],
    ["Compilación automática al escribir", "sync", "folio.toggleAutoCompile"],
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
    outline: nav,
  };
}

export function deactivate() {
  abortRunning();
}
