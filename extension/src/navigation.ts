// Moverse por el proyecto: F12 / Ctrl+Clic en \ref y \cite, enlaces en \input e
// \includegraphics, hover con la cita, la etiqueta o la imagen, y el esquema de todo el
// documento (siguiendo los \input/\include) en la barra lateral de Overfree.

import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { outline } from "../../src/outline";
import { argAt, findBibEntry, findLabel } from "./texargs";
import { isInside, type TexProject } from "./texproject";
import { projectTexts } from "./tools";

type GetProject = (doc?: vscode.TextDocument) => Promise<TexProject | null>;

const SELECTOR: vscode.DocumentSelector = [
  { language: "latex", scheme: "file" },
  { language: "tex", scheme: "file" },
];
const REF = /^(ref|eqref|pageref|autoref|cref|Cref|vref|nameref|labelcref|cpageref)$/;
const CITE = /cite/i;
const IMG_EXT = ["", ".pdf", ".png", ".jpg", ".jpeg", ".eps", ".svg"];

/** Archivo del proyecto al que apunta \input{x} / \includegraphics{x}…, si existe (y está dentro). */
function resolveFile(project: TexProject, docDir: string, cmd: string, name: string): string | null {
  const exts = cmd === "includegraphics" ? IMG_EXT : cmd === "bibliography" ? [".bib", ""] : cmd === "addbibresource" ? [""] : ["", ".tex"];
  for (const base of [project.root, docDir])
    for (const ext of exts) {
      const abs = path.resolve(base, name + ext);
      if (isInside(abs, project.root) && existsSync(abs) && !abs.endsWith(path.sep)) return abs;
    }
  return null;
}

async function labelOf(project: TexProject, key: string) {
  const hit = findLabel(await projectTexts(project, /\.tex$/i), key);
  return hit && { ...hit, uri: vscode.Uri.file(path.join(project.root, hit.path)) };
}

async function bibOf(project: TexProject, key: string) {
  const hit = findBibEntry(await projectTexts(project, /\.bib$/i), key);
  return hit && { ...hit, uri: vscode.Uri.file(path.join(project.root, hit.path)) };
}

function argUnderCursor(doc: vscode.TextDocument, pos: vscode.Position) {
  const a = argAt(doc.lineAt(pos.line).text, pos.character);
  return a && { ...a, range: new vscode.Range(pos.line, a.start, pos.line, a.end) };
}

export function registerNavigation(ctx: vscode.ExtensionContext, getProject: GetProject) {
  // ---------- F12 / Ctrl+Clic ----------
  const definitions: vscode.DefinitionProvider = {
    async provideDefinition(doc, pos) {
      const a = argUnderCursor(doc, pos);
      const project = a && (await getProject(doc));
      if (!a || !project) return null;
      if (REF.test(a.cmd)) {
        const hit = await labelOf(project, a.key);
        return hit && new vscode.Location(hit.uri, new vscode.Position(hit.line, 0));
      }
      if (CITE.test(a.cmd)) {
        const hit = await bibOf(project, a.key);
        return hit && new vscode.Location(hit.uri, new vscode.Position(hit.line, 0));
      }
      return null;
    },
  };

  // ---------- \input, \include, \includegraphics… como enlaces ----------
  const links: vscode.DocumentLinkProvider = {
    async provideDocumentLinks(doc) {
      const project = await getProject(doc);
      if (!project) return [];
      const out: vscode.DocumentLink[] = [];
      const re = /\\(input|include|subfile|includegraphics|bibliography|addbibresource)\*?\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g;
      const text = doc.getText();
      for (const m of text.matchAll(re)) {
        const start = m.index! + m[0].length - m[2].length - 1;
        // \bibliography{a,b}: un enlace por archivo
        let off = start;
        for (const part of m[2].split(",")) {
          const name = part.trim();
          const abs = name && resolveFile(project, path.dirname(doc.fileName), m[1], name);
          if (abs) {
            const s = off + part.indexOf(name);
            const link = new vscode.DocumentLink(new vscode.Range(doc.positionAt(s), doc.positionAt(s + name.length)), vscode.Uri.file(abs));
            link.tooltip = path.relative(project.root, abs);
            out.push(link);
          }
          off += part.length + 1;
        }
      }
      return out;
    },
  };

  // ---------- hover ----------
  const hover: vscode.HoverProvider = {
    async provideHover(doc, pos) {
      const a = argUnderCursor(doc, pos);
      const project = a && (await getProject(doc));
      if (!a || !project) return null;
      const md = new vscode.MarkdownString();
      if (CITE.test(a.cmd)) {
        const e = await bibOf(project, a.key);
        if (!e) return null;
        md.appendMarkdown(`**${e.title || a.key}**\n\n`);
        if (e.author) md.appendText(e.author.replace(/\s+and\s+/g, "; ")).appendMarkdown("\n\n");
        md.appendText([e.venue, e.year].filter(Boolean).join(", ") + ` · @${e.type} en ${e.path}`);
      } else if (REF.test(a.cmd)) {
        const hit = await labelOf(project, a.key);
        if (!hit) return null;
        // el entorno o la línea del \label, con un poco de contexto (suele estar el \caption)
        const from = Math.max(0, hit.line - 3);
        md.appendMarkdown(`\`${hit.path}:${hit.line + 1}\``);
        md.appendCodeblock(hit.lines.slice(from, hit.line + 3).join("\n"), "latex");
      } else if (a.cmd === "includegraphics") {
        const abs = resolveFile(project, path.dirname(doc.fileName), a.cmd, a.key);
        if (!abs) return null;
        md.appendMarkdown(`\`${path.relative(project.root, abs)}\``);
        if (/\.(png|jpe?g|svg)$/i.test(abs)) md.appendMarkdown(`\n\n![](${vscode.Uri.file(abs).toString()}|width=320)`);
      } else return null;
      return new vscode.Hover(md, a.range);
    },
  };

  // ---------- esquema del proyecto entero ----------
  type Node = { label: string; uri: vscode.Uri; line: number; level: number; children: Node[] };
  const changed = new vscode.EventEmitter<void>();
  let roots: Node[] = [];
  async function rebuild() {
    const project = await getProject();
    roots = [];
    if (project) {
      const files = await projectTexts(project, /\.tex$/i);
      const stack: Node[] = [];
      for (const it of outline(files, project.main)) {
        const node: Node = { label: it.title, uri: vscode.Uri.file(path.join(project.root, it.file)), line: it.line - 1, level: it.level, children: [] };
        while (stack.length && stack[stack.length - 1].level >= it.level) stack.pop();
        (stack.length ? stack[stack.length - 1].children : roots).push(node);
        stack.push(node);
      }
    }
    changed.fire();
  }
  const tree: vscode.TreeDataProvider<Node> = {
    onDidChangeTreeData: changed.event,
    getChildren: (n) => (n ? n.children : roots),
    getTreeItem: (n) => {
      const item = new vscode.TreeItem(n.label, n.children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
      item.description = path.basename(n.uri.fsPath);
      item.tooltip = `${path.basename(n.uri.fsPath)}:${n.line + 1}`;
      item.iconPath = new vscode.ThemeIcon(n.level <= 1 ? "book" : "symbol-namespace");
      item.command = { command: "vscode.open", title: "Abrir", arguments: [n.uri, { selection: new vscode.Range(n.line, 0, n.line, 0) }] };
      return item;
    },
  };
  let timer: NodeJS.Timeout | undefined;
  const rebuildSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void rebuild(), 800);
  };

  ctx.subscriptions.push(
    vscode.languages.registerDefinitionProvider(SELECTOR, definitions),
    vscode.languages.registerDocumentLinkProvider(SELECTOR, links),
    vscode.languages.registerHoverProvider(SELECTOR, hover),
    vscode.window.registerTreeDataProvider("folio.outline", tree),
    vscode.workspace.onDidChangeTextDocument((e) => /\.tex$/i.test(e.document.fileName) && rebuildSoon()),
    vscode.window.onDidChangeActiveTextEditor((ed) => ed && /\.tex$/i.test(ed.document.fileName) && rebuildSoon()),
    changed,
  );
  void rebuild();
  return { rebuildOutline: rebuild, outlineRoots: () => roots };
}
