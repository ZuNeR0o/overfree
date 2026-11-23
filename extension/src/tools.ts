// Ayudas de edición de Folio: tablas desde Excel/CSV, figuras al soltar imágenes y
// referencias por DOI.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { bibKey, fetchBibtex, findByDoi, parseDoi, renameKey } from "../../src/doi";
import { decodeText, encodeText } from "../../src/encoding";
import { extractBibEntries } from "../../src/refs";
import { openEnvsAt } from "../../src/envs";
import { parseDelimited, parseTsv, toLatexTable } from "../../src/tables";
import { isInside, listProjectFiles, relPath, stripComments, type TexProject } from "./texproject";

const LATEX = [{ language: "latex" }, { language: "tex" }];

const samePath = (a: string, b: string) =>
  process.platform === "win32" ? path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase() : path.normalize(a) === path.normalize(b);
const openDoc = (abs: string) => vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && samePath(d.uri.fsPath, abs));

/** Texto actual de un archivo: el del editor si está abierto (aunque no se haya guardado). */
async function readProjectText(abs: string): Promise<string> {
  const doc = openDoc(abs);
  if (doc) return doc.getText();
  return fs.readFile(abs).then((b) => decodeText(b).text, () => "");
}

async function projectTexts(project: TexProject, ext: RegExp) {
  const files = (await listProjectFiles(project.root)).filter((f) => ext.test(f));
  return Promise.all(files.map(async (f) => ({ path: f, text: await readProjectText(path.join(project.root, f)) })));
}

async function projectUses(project: TexProject, pkg: string) {
  const re = new RegExp(`\\\\usepackage(\\[[^\\]]*\\])?\\{[^}]*\\b${pkg}\\b`);
  return (await projectTexts(project, /\.(tex|sty|cls)$/i)).some((f) => re.test(stripComments(f.text)));
}

// ---------- Tablas ----------

/** Código de la tabla para insertar en `offset` de `doc` (solo filas si ya estamos dentro de un tabular). */
async function tableFor(project: TexProject | null, doc: vscode.TextDocument, offset: number, text: string) {
  const rows = parseTsv(text) ?? parseDelimited(text);
  if (!rows) return null;
  const [siunitx, booktabs] = project ? await Promise.all([projectUses(project, "siunitx"), projectUses(project, "booktabs")]) : [false, true];
  const inTable = openEnvsAt(doc.getText(), offset).some((e) => /^(tabular\*?|tabularx|longtable|array)$/.test(e.name));
  const indent = /^\s*/.exec(doc.lineAt(doc.positionAt(offset).line).text)![0];
  let tex = toLatexTable(rows, { siunitx, booktabs, wrap: !inTable, indent: inTable ? indent + "  " : "" });
  if (inTable) tex = tex.replace(/^\s+/, "");
  const missing = [!booktabs && "booktabs", !siunitx && rows.some((r) => r.some((c) => /\d/.test(c))) && "siunitx"].filter(Boolean);
  return { tex, rows, missing };
}

export async function pasteTable(project: TexProject | null) {
  const editor = vscode.window.activeTextEditor;
  // desde la barra lateral se puede pulsar con cualquier archivo delante
  if (!editor || !/^(la)?tex$/.test(editor.document.languageId)) {
    void vscode.window.showWarningMessage("Folio: abre un archivo .tex para pegar la tabla.");
    return;
  }
  const clip = await vscode.env.clipboard.readText();
  const t = await tableFor(project, editor.document, editor.document.offsetAt(editor.selection.start), clip);
  if (!t) {
    void vscode.window.showWarningMessage("Folio: el portapapeles no tiene celdas (copia un rango de Excel, LibreOffice o un CSV).");
    return;
  }
  await editor.edit((e) => e.replace(editor.selection, t.tex));
  const hint = t.missing.length ? ` Añade \\usepackage{${t.missing.join(",")}} al preámbulo.` : "";
  vscode.window.setStatusBarMessage(`Folio: tabla de ${t.rows.length}×${t.rows[0].length} insertada.${hint}`, 6000);
}

// ---------- Soltar archivos en el editor ----------

const IMAGE = /\.(png|jpe?g|pdf|eps|svg)$/i;

export function registerDrop(getProject: (doc: vscode.TextDocument) => Promise<TexProject | null>) {
  return vscode.languages.registerDocumentDropEditProvider(LATEX, {
    async provideDocumentDropEdits(doc, position, data) {
      const list = await data.get("text/uri-list")?.asString();
      const uris = (list ?? "")
        .split(/\r?\n/)
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => vscode.Uri.parse(l))
        .filter((u) => u.scheme === "file");
      if (uris.length !== 1) return undefined;
      const file = uris[0].fsPath;
      const project = await getProject(doc);

      // un .csv/.tsv se convierte en tabla
      if (/\.(csv|tsv)$/i.test(file)) {
        const text = await fs.readFile(file).then((b) => decodeText(b).text, () => "");
        const t = await tableFor(project, doc, doc.offsetAt(position), text);
        return t ? new vscode.DocumentDropEdit(t.tex) : undefined;
      }
      // una imagen del proyecto, en un figure
      if (IMAGE.test(file) && project) {
        if (!isInside(file, project.root)) return undefined;
        const rel = relPath(project.root, file);
        const name = path.basename(file).replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-");
        const s = new vscode.SnippetString();
        s.appendText(`\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${rel}}\n  \\caption{`);
        s.appendPlaceholder("");
        s.appendText(`}\n  \\label{fig:${name}}\n\\end{figure}\n`);
        return new vscode.DocumentDropEdit(s);
      }
      return undefined;
    },
  });
}

// ---------- Referencias por DOI ----------

/** El .bib que cita el documento, o el primero del proyecto; si no hay, referencias.bib (nuevo). */
async function targetBib(project: TexProject) {
  const bibs = (await listProjectFiles(project.root)).filter((f) => /\.bib$/i.test(f));
  const tex = (await projectTexts(project, /\.tex$/i)).map((f) => f.text).join("\n");
  for (const m of stripComments(tex).matchAll(/\\(?:addbibresource|bibliography)(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
    for (const name of m[1].split(",").map((s) => s.trim().replace(/^\.\//, ""))) {
      const hit = bibs.find((b) => b === name || b === `${name}.bib` || b.endsWith(`/${name}`) || b.endsWith(`/${name}.bib`));
      if (hit) return { rel: hit, created: false };
    }
  }
  return bibs[0] ? { rel: bibs[0], created: false } : { rel: "referencias.bib", created: true };
}

export async function addReferenceByDoi(project: TexProject | null) {
  if (!project) {
    void vscode.window.showWarningMessage("Folio: abre un archivo .tex del proyecto.");
    return;
  }
  const input = await vscode.window.showInputBox({
    title: "Añadir referencia por DOI",
    prompt: "DOI o enlace del artículo",
    placeHolder: "10.1103/PhysRev.47.777",
    ignoreFocusOut: true,
  });
  if (!input) return;
  const doi = parseDoi(input);
  if (!doi) {
    void vscode.window.showErrorMessage("Folio: no reconozco un DOI en ese texto. Debe empezar por 10.");
    return;
  }
  const editor = vscode.window.activeTextEditor;
  const { rel, created } = await targetBib(project);
  const abs = path.join(project.root, rel);
  try {
    let key = findByDoi(await readProjectText(abs), doi);
    if (!key) {
      let entry = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Folio: buscando ${doi}…` },
        () => fetchBibtex(doi),
      );
      key = bibKey(entry) ?? `ref${Date.now()}`;
      // se vuelve a leer: el .bib pudo cambiar durante la descarga
      const bibText = await readProjectText(abs);
      const existing = new Set(extractBibEntries([bibText]).map((e) => e.key));
      let unique = key;
      for (let i = 0; existing.has(unique); i++) unique = key + (i < 26 ? String.fromCharCode(97 + i) : String(i - 25));
      if (unique !== key) entry = renameKey(entry, unique);
      key = unique;
      const sep = bibText && !bibText.endsWith("\n\n") ? (bibText.endsWith("\n") ? "\n" : "\n\n") : "";
      const open = openDoc(abs);
      if (open) {
        const we = new vscode.WorkspaceEdit();
        we.insert(open.uri, open.lineAt(open.lineCount - 1).range.end, sep + entry);
        if (!(await vscode.workspace.applyEdit(we))) throw new Error(`no se pudo modificar ${rel}.`);
        await open.save();
      } else {
        // se respeta la codificación del archivo (un .bib en Latin-1 sigue en Latin-1)
        const raw = await fs.readFile(abs).catch(() => null);
        const { text, encoding } = raw ? decodeText(raw) : { text: "", encoding: undefined };
        await fs.writeFile(abs, encodeText(text + sep + entry, encoding));
      }
    }
    if (editor && /^(la)?tex$/.test(editor.document.languageId)) {
      const k = key;
      await editor.edit((e) => e.insert(editor.selection.active, `\\cite{${k}}`));
    }
    void vscode.window.showInformationMessage(
      created
        ? `Folio: «${key}» añadida a referencias.bib. Añade \\bibliography{referencias} (o \\addbibresource{referencias.bib}) al documento.`
        : `Folio: «${key}» añadida a ${rel}.`,
    );
  } catch (e) {
    void vscode.window.showErrorMessage(`Folio: ${e instanceof Error ? e.message : String(e)}`);
  }
}
