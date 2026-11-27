// Ayudas de escritura de la app Overfree dentro de VS Code: autocompletado (comandos,
// entornos, \ref, \cite, archivos, paquetes), esquema (Outline) y comandos de formato.
// Los datos salen de src/latexdata.ts y src/outline.ts, los mismos que usa la app.

import * as vscode from "vscode";
import { CMDS, ENVS, PACKAGES, SYMBOLS } from "../../src/latexdata";
import { outline } from "../../src/outline";
import { extractBibEntries, extractLabels } from "../../src/refs";
import { listProjectFiles, type TexProject } from "./texproject";
import { toSnippet } from "./snippet";
import { projectTexts } from "./tools";

const SELECTOR: vscode.DocumentSelector = [
  { language: "latex", scheme: "file" },
  { language: "tex", scheme: "file" },
  { language: "latex", scheme: "untitled" },
];

// ---------- Autocompletado ----------

const ARG_RE = /\\(\w+)\*?(?:\[[^\]]*\])?\{([^{}]*)$/;
const REF_CMDS = /^(ref|eqref|pageref|autoref|cref|Cref|nameref|vref)$/;

function cmdItems(range: vscode.Range): vscode.CompletionItem[] {
  const items = CMDS.map(([name, tpl, detail]) => {
    const it = new vscode.CompletionItem({ label: "\\" + name, description: detail }, vscode.CompletionItemKind.Function);
    if (tpl) it.insertText = new vscode.SnippetString(toSnippet("\\" + tpl));
    it.range = range;
    return it;
  });
  for (const s of SYMBOLS) {
    const it = new vscode.CompletionItem("\\" + s, vscode.CompletionItemKind.Constant);
    it.range = range;
    items.push(it);
  }
  const begin = new vscode.CompletionItem({ label: "\\begin", description: "Entorno" }, vscode.CompletionItemKind.Keyword);
  begin.insertText = new vscode.SnippetString("\\\\begin{${1:entorno}}\n\t$0\n\\\\end{$1}");
  begin.range = range;
  items.push(begin);
  return items;
}

function plain(labels: { label: string; detail?: string }[], kind: vscode.CompletionItemKind, range: vscode.Range) {
  return labels.map(({ label, detail }) => {
    const it = new vscode.CompletionItem({ label, description: detail }, kind);
    it.range = range;
    return it;
  });
}

export function completionProvider(getProject: (doc: vscode.TextDocument) => Promise<TexProject | null>): vscode.CompletionItemProvider {
  return {
    async provideCompletionItems(doc, pos) {
      const line = doc.lineAt(pos.line).text;
      const before = line.slice(0, pos.character);

      // dentro de un argumento: \cmd{...|  (admite varias claves separadas por comas)
      const arg = ARG_RE.exec(before);
      if (arg) {
        const [, cmd, typed] = arg;
        const start = pos.translate(0, -(typed.length - typed.lastIndexOf(",") - 1));
        // el editor ya cerró la llave: la sugerencia de entorno la sustituye
        const closing = line[pos.character] === "}";
        const withBrace = new vscode.Range(start, closing ? pos.translate(0, 1) : pos);
        const range = new vscode.Range(start, pos);

        if (cmd === "begin") {
          const boost: Record<string, number> = { equation: 0, align: 1, figure: 2, itemize: 3, enumerate: 4, table: 5 };
          return ENVS.map(([env, body]) => {
            const it = new vscode.CompletionItem(env, vscode.CompletionItemKind.Module);
            it.insertText = new vscode.SnippetString(toSnippet(`${env}}\n${body ?? "\t${}"}\n\\end{${env}}`));
            it.range = { inserting: range, replacing: withBrace };
            it.sortText = String(boost[env] ?? 9) + env;
            return it;
          });
        }
        if (cmd === "end") {
          // cierra los entornos abiertos, el más reciente primero
          const text = doc.getText(new vscode.Range(new vscode.Position(0, 0), pos));
          const stack: string[] = [];
          for (const m of text.matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
            if (m[1] === "begin") stack.push(m[2]);
            else stack.pop();
          }
          return [...new Set(stack.reverse())].map((env, i) => {
            const it = new vscode.CompletionItem(env, vscode.CompletionItemKind.Module);
            it.insertText = env + "}";
            it.range = { inserting: range, replacing: withBrace };
            it.sortText = String(i).padStart(3, "0");
            return it;
          });
        }
        if (cmd === "usepackage" || cmd === "RequirePackage") {
          return plain(PACKAGES.map((p) => ({ label: p })), vscode.CompletionItemKind.Module, range);
        }

        const project = await getProject(doc);
        if (!project) return null;
        if (REF_CMDS.test(cmd)) {
          const texts = (await projectTexts(project, /\.tex$/i)).map((f) => f.text);
          return plain(extractLabels(texts).map((l) => ({ label: l })), vscode.CompletionItemKind.Reference, range);
        }
        if (/cite/i.test(cmd)) {
          const bibs = (await projectTexts(project, /\.bib$/i)).map((f) => f.text);
          return plain(
            extractBibEntries(bibs).map((e) => ({ label: e.key, detail: e.info })),
            vscode.CompletionItemKind.Reference,
            range,
          );
        }
        const files = await listProjectFiles(project.root);
        const pick = (re: RegExp, strip?: RegExp) =>
          plain(files.filter((f) => re.test(f)).map((f) => ({ label: strip ? f.replace(strip, "") : f })), vscode.CompletionItemKind.File, range);
        if (cmd === "includegraphics") return pick(/\.(png|jpe?g|pdf|eps|svg)$/i);
        if (cmd === "input" || cmd === "subfile") return pick(/\.tex$/i);
        if (cmd === "include") return pick(/\.tex$/i, /\.tex$/i);
        if (cmd === "bibliography") return pick(/\.bib$/i, /\.bib$/i);
        if (cmd === "addbibresource") return pick(/\.bib$/i);
        return null;
      }

      // comando: \abc|
      const word = /\\[A-Za-z]*\*?$/.exec(before);
      if (word) return cmdItems(new vscode.Range(pos.translate(0, -word[0].length), pos));
      return null;
    },
  };
}

// ---------- Esquema (vista Outline, migas de pan, Ctrl+Shift+O) ----------

export const symbolProvider: vscode.DocumentSymbolProvider = {
  provideDocumentSymbols(doc) {
    const items = outline([{ path: "doc", text: doc.getText() }], "doc");
    const roots: vscode.DocumentSymbol[] = [];
    const stack: { level: number; sym: vscode.DocumentSymbol }[] = [];
    const last = doc.lineAt(doc.lineCount - 1).range.end;
    items.forEach((it, i) => {
      const startLine = it.line - 1;
      // la sección llega hasta la siguiente de su nivel o superior
      const next = items.slice(i + 1).find((o) => o.level <= it.level);
      const end = next ? doc.lineAt(Math.max(startLine, next.line - 2)).range.end : last;
      const sym = new vscode.DocumentSymbol(
        it.title,
        "",
        it.level <= 1 ? vscode.SymbolKind.Namespace : vscode.SymbolKind.Module,
        new vscode.Range(new vscode.Position(startLine, 0), end),
        doc.lineAt(startLine).range,
      );
      while (stack.length && stack[stack.length - 1].level >= it.level) stack.pop();
      (stack.length ? stack[stack.length - 1].sym.children : roots).push(sym);
      stack.push({ level: it.level, sym });
    });
    return roots;
  },
};

// ---------- Formato (como la barra de herramientas de la app) ----------

/** \cmd{selección}; si la selección ya es \cmd{…}, lo quita. */
async function wrap(cmd: string) {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const unwrap = new RegExp(`^\\\\${cmd}\\{([\\s\\S]*)\\}$`);
  if (ed.selections.every((s) => !s.isEmpty && unwrap.test(ed.document.getText(s)))) {
    await ed.edit((e) => ed.selections.forEach((s) => e.replace(s, unwrap.exec(ed.document.getText(s))![1])));
    return;
  }
  await ed.insertSnippet(new vscode.SnippetString(`\\\\${cmd}{\${TM_SELECTED_TEXT}$0}`));
}

const insert = (snippet: string) => vscode.window.activeTextEditor?.insertSnippet(new vscode.SnippetString(snippet));

/** Las líneas seleccionadas pasan a ser \item de una lista. */
async function list(env: "itemize" | "enumerate") {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const sel = ed.selection;
  if (sel.isEmpty) return insert(`\\\\begin{${env}}\n\t\\\\item $0\n\\\\end{${env}}`);
  const range = new vscode.Range(sel.start.line, 0, sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line, Number.MAX_SAFE_INTEGER);
  const full = ed.document.validateRange(range);
  const indent = /^\s*/.exec(ed.document.lineAt(sel.start.line).text)![0];
  const lines = ed.document
    .getText(full)
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => `${indent}\t\\item ${l.trim().replace(/^\\item\s*/, "")}`);
  await ed.edit((e) => e.replace(full, `${indent}\\begin{${env}}\n${lines.join("\n")}\n${indent}\\end{${env}}`));
}

const HEADINGS: [string, string][] = [
  ["Texto normal", ""],
  ["Capítulo", "chapter"],
  ["Sección", "section"],
  ["Subsección", "subsection"],
  ["Subsubsección", "subsubsection"],
  ["Párrafo", "paragraph"],
];

/** Como el desplegable «Texto normal» de la app: convierte la línea en un título (o al revés). */
async function heading() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const pick = await vscode.window.showQuickPick(
    HEADINGS.map(([label, cmd]) => ({ label, description: cmd && `\\${cmd}{…}`, cmd })),
    { placeHolder: "Estilo del párrafo" },
  );
  if (!pick) return;
  await ed.edit((e) => {
    for (const s of ed.selections) {
      const line = ed.document.lineAt(s.active.line);
      const m = /^(\s*)\\(?:part|chapter|section|subsection|subsubsection|paragraph)\*?\s*\{(.*)\}\s*$/.exec(line.text);
      const indent = m?.[1] ?? /^\s*/.exec(line.text)![0];
      const body = m ? m[2] : line.text.trim();
      e.replace(line.range, pick.cmd ? `${indent}\\${pick.cmd}{${body}}` : indent + body);
    }
  });
}

const envSnippet = (env: string) => {
  const body = ENVS.find(([e]) => e === env)?.[1] ?? "\t${}";
  return toSnippet(`\\begin{${env}}\n${body}\n\\end{${env}}`);
};

export const FORMAT_COMMANDS: Record<string, () => unknown> = {
  "folio.format.bold": () => wrap("textbf"),
  "folio.format.italic": () => wrap("textit"),
  "folio.format.underline": () => wrap("underline"),
  "folio.format.emph": () => wrap("emph"),
  "folio.format.inlineMath": () => insert("\\$${TM_SELECTED_TEXT}$0\\$"),
  "folio.format.equation": () => insert("\\\\begin{equation}\n\t${TM_SELECTED_TEXT}$0\n\\\\end{equation}"),
  "folio.format.itemize": () => list("itemize"),
  "folio.format.enumerate": () => list("enumerate"),
  "folio.format.heading": heading,
  "folio.format.link": () => insert("\\\\href{${1:https://}}{${2:${TM_SELECTED_TEXT:texto}}}$0"),
  "folio.format.footnote": () => wrap("footnote"),
  "folio.format.figure": () => insert(envSnippet("figure")),
  "folio.format.table": () => insert(envSnippet("table")),
};

export function registerEditing(ctx: vscode.ExtensionContext, getProject: (doc: vscode.TextDocument) => Promise<TexProject | null>) {
  ctx.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(SELECTOR, completionProvider(getProject), "\\", "{", ","),
    vscode.languages.registerDocumentSymbolProvider(SELECTOR, symbolProvider, { label: "Overfree" }),
    ...Object.entries(FORMAT_COMMANDS).map(([id, fn]) => vscode.commands.registerCommand(id, fn)),
  );
}
