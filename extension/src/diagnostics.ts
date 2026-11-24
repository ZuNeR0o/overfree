// Tres fuentes de problemas, como en Overfree, cada una en su colección para que no se pisen:
//  - "Overfree · LaTeX": el registro de la última compilación (errores traducidos).
//  - "Overfree · Revisión": la revisión en vivo del archivo abierto (linter de Overleaf).
//  - "Overfree · Proyecto": la revisión del proyecto sin compilar (refs, citas, imágenes…).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { checkProject } from "../../src/checks";
import { decodeText } from "../../src/encoding";
import type { Problem } from "../../src/logparse";
import { Parse } from "../../src/overleaf/linter/latex-linter.worker";
import { errorsToDiagnostics } from "../../src/overleaf/linter/lint-core";
import type { StoredFile } from "../../src/store";
import { listProjectFiles, type TexProject } from "./texproject";

const SEVERITY: Record<Problem["level"], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

const lineRange = (line: number | null) => {
  const l = Math.max(0, (line ?? 1) - 1);
  return new vscode.Range(l, 0, l, Number.MAX_SAFE_INTEGER);
};

/** Agrupa problemas con archivo/línea por archivo del disco. Los que no tienen archivo van al principal. */
function toDiagnostics(project: TexProject, problems: Problem[], source: string) {
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const p of problems) {
    const abs = path.resolve(project.root, p.file ?? project.main);
    const d = new vscode.Diagnostic(lineRange(p.file ? p.line : null), p.message, SEVERITY[p.level]);
    d.source = p.source ?? source;
    byFile.set(abs, [...(byFile.get(abs) ?? []), d]);
  }
  return byFile;
}

export class FolioDiagnostics implements vscode.Disposable {
  readonly log = vscode.languages.createDiagnosticCollection("Overfree · LaTeX");
  readonly lint = vscode.languages.createDiagnosticCollection("Overfree · Revisión");
  readonly checks = vscode.languages.createDiagnosticCollection("Overfree · Proyecto");

  setLog(project: TexProject, problems: Problem[]) {
    this.log.clear();
    for (const [file, ds] of toDiagnostics(project, problems, "LaTeX")) this.log.set(vscode.Uri.file(file), ds);
  }

  /** Revisión en vivo de un documento (sin compilar). */
  lintDocument(doc: vscode.TextDocument) {
    const text = doc.getText();
    let errors;
    try {
      errors = Parse(text).errors;
    } catch {
      return; // el linter no debe romper nada: sin diagnósticos
    }
    const editor = vscode.window.activeTextEditor;
    const cursor = editor?.document === doc ? doc.offsetAt(editor.selection.active) : -1;
    const ds = errorsToDiagnostics(errors, cursor, text.length).map((e) => {
      const d = new vscode.Diagnostic(new vscode.Range(doc.positionAt(e.from), doc.positionAt(e.to)), e.message, SEVERITY[e.severity]);
      d.source = e.source;
      return d;
    });
    this.lint.set(doc.uri, ds);
  }

  /** Revisión del proyecto completo; usa el texto sin guardar de los documentos abiertos. */
  async checkProject(project: TexProject) {
    const open = new Map(vscode.workspace.textDocuments.map((d) => [path.normalize(d.uri.fsPath), d]));
    const files: StoredFile[] = [];
    for (const rel of await listProjectFiles(project.root)) {
      if (!/\.(tex|ltx|bib)$/i.test(rel)) {
        files.push({ path: rel }); // imágenes y demás: basta con saber que existen
        continue;
      }
      const abs = path.join(project.root, rel);
      const doc = open.get(path.normalize(abs));
      const text = doc ? doc.getText() : await fs.readFile(abs).then((b) => decodeText(b).text, () => undefined);
      files.push({ path: rel, text });
    }
    this.checks.clear();
    for (const [file, ds] of toDiagnostics(project, checkProject(files), "Proyecto")) this.checks.set(vscode.Uri.file(file), ds);
  }

  dispose() {
    this.log.dispose();
    this.lint.dispose();
    this.checks.dispose();
  }
}
