import "@fontsource-variable/inter";
import { EditorView, basicSetup } from "codemirror";
import { Annotation, Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { keymap } from "@codemirror/view";
import { HighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { acceptCompletion, autocompletion, startCompletion } from "@codemirror/autocomplete";
import { indentLess, indentMore } from "@codemirror/commands";
import { forceLinting, lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { decodeText, encodeText, unencodable } from "./encoding";
import { latex } from "./overleaf/latex-language";
import { latexLinter } from "./overleaf/linter/latex-linter";
import { mathPreview } from "./overleaf/math-preview";
import { mountToolbar } from "./overleaf/toolbar";
import { noSpellcheckLatex } from "./overleaf/no-spellcheck";
import { alignColumns, openEnvsAt, structureEditing, structureKeymap } from "./structure";
import { checkProject } from "./checks";
import { parseDelimited, parseTsv, toLatexTable, type Rows } from "./tables";
import { mountSymbolPalette } from "./symbols";
import { createGitPanel } from "./gitpanel";
import type { PdfMessage } from "./pdfwindow";
import { tags as t } from "@lezer/highlight";

import { cancelCompile, clearAuxCache, compileProject, engineReady, exportAux, importAux, onEngineProgress, warmUp, type Engine } from "./latex";
import { backend, desktop, isTextPath, migrateLegacy, newId, type ProjectMeta, type Snapshot, type StoredFile } from "./store";
import { parseLog, type Problem } from "./logparse";
import { parseSynctex, forward, inverse, type SyncData } from "./synctex";
import { PdfViewer, type FindHit, type Zoom } from "./pdfview";
import { latexCompletions, extractBibEntries, extractLabels } from "./complete";
import { TEMPLATES, fromZip, guessMain, orderedTexFiles, outline, toZip, wordCount } from "./project";
import { bibKey, fetchBibtex, findByDoi, parseDoi, renameKey } from "./doi";
import { ICONS } from "./icons";

// ---------- Utilidades ----------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function setStatus(text: string, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.dataset.kind = kind;
}

const icon = (name: string) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${(
    ICONS[name] ?? []
  )
    .map((d) => `<path d="${d}"/>`)
    .join("")}</svg>`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { cls?: string } = {}, ...children: (Node | string)[]) {
  const e = document.createElement(tag);
  const { cls, ...rest } = props;
  if (cls) e.className = cls;
  Object.assign(e, rest);
  e.append(...children);
  return e;
}

function iconBtn(name: string, title: string, onClick: (e: MouseEvent) => void) {
  const b = el("button", { type: "button", cls: "icon-btn", title });
  b.setAttribute("aria-label", title);
  b.innerHTML = icon(name);
  b.onclick = (e) => {
    e.stopPropagation();
    onClick(e);
  };
  return b;
}

/** Sustituto de prompt(), que no existe en Electron. */
function ask(label: string, value = ""): Promise<string | null> {
  const dlg = $<HTMLDialogElement>("ask-dlg");
  const input = $<HTMLInputElement>("ask-input");
  $("ask-label").textContent = label;
  input.value = value;
  dlg.returnValue = "";
  dlg.showModal();
  input.focus();
  const dot = value.lastIndexOf(".");
  input.setSelectionRange(0, dot > value.lastIndexOf("/") ? dot : value.length);
  // Enter acepta (el formulario enviaría con el primer botón, que es Cancelar)
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      dlg.close("ok");
    }
  };
  input.addEventListener("keydown", onKey);
  return new Promise((res) => {
    dlg.addEventListener(
      "close",
      () => {
        input.removeEventListener("keydown", onKey);
        res(dlg.returnValue === "ok" ? input.value : null);
      },
      { once: true },
    );
  });
}

function download(name: string, data: Uint8Array | Blob, type = "application/octet-stream") {
  const blob = data instanceof Blob ? data : new Blob([data.slice()], { type });
  if (desktop) {
    // en escritorio: diálogo nativo "Guardar como"
    void desktop
      .saveAs(name, blob)
      .then((p) => p && setStatus(`Guardado en ${p}`))
      .catch((e) => setStatus(`No se pudo guardar: ${e instanceof Error ? e.message : e}`, "error"));
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const fmtDate = (ms: number) =>
  new Date(ms).toLocaleString("es", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function cleanPath(raw: string | null | undefined) {
  const name = raw?.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
  if (!name) return null;
  const segs = name.split("/");
  const bad = segs.find(
    (s) =>
      s === ".." ||
      s === "." ||
      /[<>:"|?*\u0000-\u001f]/.test(s) || // no válidos en Windows
      /[. ]$/.test(s) || // Windows quita puntos y espacios finales
      WIN_RESERVED.test(s) ||
      /^\.(git|folio)$/i.test(s), // carpetas internas
  );
  if (bad !== undefined) {
    alert(`Nombre no válido: «${bad}». No uses < > : " | ? * ni nombres reservados de Windows.`);
    return null;
  }
  return name;
}

const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

// ---------- Ajustes (por usuario, en este navegador) ----------

type Settings = {
  theme: "system" | "light" | "dark";
  font: number;
  spell: boolean;
  wrap: boolean;
  pdfDark: boolean;
  delay: number;
  auto: boolean;
  sideW: number;
  edFrac: number;
  last?: string;
  zoom: Zoom;
  lint: boolean;
  mathPreview: boolean;
  toolbar: boolean;
  draft: boolean;
  spellLang: string;
  compiler: "builtin" | "system";
  /** Proyectos (id) a los que el usuario permitió -shell-escape. */
  shellEscapeProjects: string[];
  projectChecks: boolean;
};

const SET_KEY = "folio:settings";
const settings: Settings = {
  theme: "system",
  font: 14,
  spell: true,
  wrap: true,
  pdfDark: false,
  delay: 2000,
  auto: false,
  sideW: 240,
  edFrac: 0.5,
  zoom: "width",
  lint: true,
  mathPreview: true,
  toolbar: true,
  draft: true,
  spellLang: "es-MX",
  compiler: "builtin",
  shellEscapeProjects: [],
  projectChecks: true,
};
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SET_KEY) ?? "{}"));
} catch {
  /* sin ajustes guardados */
}
const saveSettings = () => {
  try {
    localStorage.setItem(SET_KEY, JSON.stringify(settings));
  } catch {
    /* almacenamiento no disponible */
  }
};

function applyTheme() {
  if (settings.theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
  document.documentElement.classList.toggle("pdf-dark", settings.pdfDark);
  themeHook?.();
}
/** Se asigna más abajo: avisa del tema a la ventana aparte del PDF. */
let themeHook: (() => void) | null = null;
applyTheme();

// ---------- Estado del proyecto ----------

let meta: ProjectMeta;
let files: StoredFile[] = [];
let current: string | null = null;
const states = new Map<string, EditorState>(); // conserva deshacer/rehacer por archivo
let problems: Problem[] = []; // del registro de la última compilación
/** Avisos de la revisión del proyecto (etiquetas, referencias, imágenes…), sin compilar. */
let checkProblems: Problem[] = [];
const allProblems = () => [...problems, ...checkProblems];
let sync: SyncData | null = null;
let lastPdf: Uint8Array | null = null;
const collapsed = new Set<string>();

const findFile = (path: string) => files.find((f) => f.path === path);

const pending = new Map<string, number>();
let saving = 0;
function markSaving(delta: number) {
  saving += delta;
  $("sb-save").textContent = saving > 0 ? "Guardando…" : "Guardado";
}

/** Último contenido que Folio escribió en cada archivo: así un guardado propio nunca
 *  se confunde con un cambio externo, aunque sigas escribiendo mientras tanto. */
const ownWrites = new Map<string, StoredFile>();
const ownKey = (pid: string, path: string) => `${pid}\0${path}`;

/** Lee un archivo subido o importado: texto (UTF-8 o Latin-1) o binario. */
async function readUpload(file: File, path: string): Promise<StoredFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isTextPath(path)) return { path, data: bytes };
  const { text, encoding } = decodeText(bytes);
  return encoding ? { path, text, encoding } : { path, text };
}

let encodingWarned = "";
function persist(f: StoredFile, delay = 400) {
  const pid = meta.id;
  if (f.encoding && f.text !== undefined) {
    // un archivo Latin-1 no puede guardar α, ≤…: se avisa una vez (se guardarían como «?»)
    const bad = unencodable(f.text);
    const key = `${f.path}:${bad.join("")}`;
    if (bad.length && key !== encodingWarned) {
      encodingWarned = key;
      setStatus(`${f.path} está en Latin-1 y no admite ${bad.slice(0, 5).join(" ")}: se guardarían como «?». Usa comandos LaTeX (p. ej. \\alpha) o conviértelo a UTF-8.`, "error");
    }
  }
  window.clearTimeout(pending.get(f.path));
  if (!pending.has(f.path)) markSaving(1);
  pending.set(
    f.path,
    window.setTimeout(async () => {
      pending.delete(f.path);
      // copia exacta de lo que se escribe en este momento
      const snapshot: StoredFile = { path: f.path, text: f.text, data: f.data, encoding: f.encoding };
      ownWrites.set(ownKey(pid, f.path), snapshot);
      try {
        await backend.writeFile(pid, snapshot);
      } catch (e) {
        setStatus(`No se pudo guardar ${f.path}: ${e instanceof Error ? e.message : e}`, "error");
      } finally {
        markSaving(-1);
      }
    }, delay),
  );
  touch();
}

let metaTimer: number | undefined;
function touch() {
  meta.updated = Date.now();
  window.clearTimeout(metaTimer);
  metaTimer = window.setTimeout(() => void backend.saveMeta(meta), 800);
}

async function flushPending() {
  const paths = [...pending.keys()];
  for (const p of paths) {
    window.clearTimeout(pending.get(p));
    pending.delete(p);
    const f = findFile(p);
    if (f) await backend.writeFile(meta.id, f);
    markSaving(-1);
  }
  window.clearTimeout(metaTimer);
  await backend.saveMeta(meta);
}

window.addEventListener("beforeunload", () => void flushPending());

// ---------- Editor ----------

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.tagName, t.atom], color: "var(--syn-command)", fontWeight: "600" },
  { tag: t.literal, color: "var(--syn-command)" },
  { tag: t.comment, color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.bracket, t.brace, t.squareBracket], color: "var(--syn-brace)" },
  { tag: t.string, color: "var(--syn-value)" },
  { tag: t.number, color: "var(--syn-value)" },
  { tag: [t.attributeValue, t.typeName], color: "var(--syn-arg)" },
  { tag: [t.link, t.url], color: "var(--syn-arg)", textDecoration: "underline" },
  { tag: t.strong, fontWeight: "700" },
]);

const baseTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--background)", color: "var(--foreground)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
  ".cm-gutters": { backgroundColor: "var(--background)", color: "var(--muted-foreground)", border: "none" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--accent) 50%, transparent)" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--accent)" },
  ".cm-tooltip": { backgroundColor: "var(--background)", border: "1px solid var(--border)", borderRadius: "var(--radius)" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--primary)", color: "var(--primary-foreground)" },
  ".cm-panels": { backgroundColor: "var(--muted)", color: "var(--foreground)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, #e9c46a 45%, transparent)" },
  ".cm-flash-line": { backgroundColor: "color-mix(in srgb, var(--primary) 22%, transparent)", transition: "background-color 1.2s" },
});

const fontComp = new Compartment();
const spellComp = new Compartment();
const wrapComp = new Compartment();
const mathComp = new Compartment();
/** Cambia cada vez que cambia algún archivo: invalida cachés que dependen del proyecto. */
let filesVersion = 0;
let texSourceCache = { key: "", value: "" };
/** Texto de los demás .tex/.sty/.cls del proyecto (preámbulo, macros.tex…) para la vista previa. */
function otherTexSources(): string {
  const key = `${filesVersion}|${current}`;
  if (texSourceCache.key !== key) {
    const value = files
      .filter((f) => f.path !== current && f.text !== undefined && /\.(tex|sty|cls)$/i.test(f.path))
      .map((f) => f.text)
      .join("\n");
    texSourceCache = { key, value };
  }
  return texSourceCache.value;
}
const mathExt = () => (settings.mathPreview ? mathPreview(otherTexSources) : []);
const isTexLike = (p: string | null) => !!p && /\.(tex|sty|cls|ltx|dtx|def|tikz)$/i.test(p);
const fontExt = () => EditorView.theme({ ".cm-scroller": { fontSize: `${settings.font}px` } });
const spellExt = () =>
  settings.spell
    ? [EditorView.contentAttributes.of({ spellcheck: "true", lang: settings.spellLang, autocorrect: "off" }), noSpellcheckLatex]
    : EditorView.contentAttributes.of({ spellcheck: "false" });
const wrapExt = () => (settings.wrap ? EditorView.lineWrapping : []);

const index = {
  labels: () => extractLabels(files.filter((f) => f.path.endsWith(".tex")).map((f) => f.text ?? "")),
  citations: () => extractBibEntries(files.filter((f) => f.path.endsWith(".bib")).map((f) => f.text ?? "")),
  files: () => files.map((f) => f.path),
};

/** Envuelve la selección con un comando (Ctrl+B, Ctrl+I). */
const wrapWith = (cmd: string) => (view: EditorView) => {
  view.dispatch(
    view.state.changeByRange((r) => {
      const text = view.state.sliceDoc(r.from, r.to);
      const ins = `\\${cmd}{${text}}`;
      return {
        changes: { from: r.from, to: r.to, insert: ins },
        range: text ? EditorSelection.range(r.from, r.from + ins.length) : EditorSelection.cursor(r.from + cmd.length + 2),
      };
    }),
  );
  return true;
};

/** Sin selección inserta la unidad de indentación en el cursor; con varias líneas, las indenta. */
const tabIndent = (view: EditorView) => {
  const { state } = view;
  const multiLine = state.selection.ranges.some((r) => state.doc.lineAt(r.from).number !== state.doc.lineAt(r.to).number);
  if (multiLine) return indentMore(view);
  // misma unidad que usan la indentación automática y los snippets (no un \t suelto)
  const unit = state.facet(indentUnit);
  view.dispatch(state.replaceSelection(unit), { scrollIntoView: true, userEvent: "input.indent" });
  return true;
};

let autoTimer: number | undefined;
/** Marca los cambios que vienen del disco (no hay que volver a guardarlos). */
const externalChange = Annotation.define<boolean>();

const extensions: Extension[] = [
  keymap.of([
    // Tab: acepta la sugerencia abierta; si no, indenta (antes sacaba el foco del editor)
    { key: "Tab", run: (v) => acceptCompletion(v) || tabIndent(v) },
    { key: "Shift-Tab", run: indentLess },
    ...structureKeymap, // Enter en listas (\item) y Ctrl+Alt+A para alinear &
    { key: "Mod-b", run: wrapWith("textbf") },
    { key: "Mod-i", run: wrapWith("textit") },
    { key: "Mod-Alt-j", run: () => (syncForward(), true) },
  ]),
  basicSetup,
  latex(),
  syntaxHighlighting(highlight),
  autocompletion({ override: [latexCompletions(index)], icons: false }),
  lintGutter(),
  // revisión mientras se escribe (Overleaf) + errores de la última compilación
  latexLinter(
    () => settings.lint && isTexLike(current),
    (v) => (current ? diagnosticsFor(current, v.state) : []),
  ),
  mathComp.of(mathExt()),
  structureEditing, // \begin{x} y \end{x} cambian a la vez
  baseTheme,
  fontComp.of(fontExt()),
  spellComp.of(spellExt()),
  wrapComp.of(wrapExt()),
  EditorView.updateListener.of((u) => {
    if (u.selectionSet || u.docChanged) {
      toolbar?.update(u.state);
      const pos = u.state.selection.main.head;
      const line = u.state.doc.lineAt(pos);
      $("sb-pos").textContent = `Línea ${line.number}, col ${pos - line.from + 1}`;
    }
    if (u.docChanged && u.transactions.some((tr) => tr.isUserEvent("input"))) {
      // abre el autocompletado al escribir "{" tras \ref, \cite, \begin, \includegraphics...
      const pos = u.state.selection.main.head;
      const before = u.state.sliceDoc(Math.max(0, pos - 60), pos);
      if (/\\[A-Za-z]+\*?(\[[^\]]*\])?\{$/.test(before)) setTimeout(() => startCompletion(view), 0);
    }
    if (u.docChanged && current && !u.transactions.some((tr) => tr.annotation(externalChange))) {
      const f = findFile(current);
      // nunca escribir texto sobre un archivo binario (imagen, PDF…)
      if (f && f.text !== undefined) {
        f.text = u.state.doc.toString();
        persist(f);
        scheduleIndex();
        if (settings.auto) {
          window.clearTimeout(autoTimer);
          autoTimer = window.setTimeout(() => void compile(true), settings.delay);
        }
      }
    }
  }),
  EditorView.domEventHandlers({ paste: onPaste, drop: onEditorDrop }),
];

const makeState = (doc: string) => EditorState.create({ doc, extensions });
let toolbar: ReturnType<typeof mountToolbar> | null = null;
const view = new EditorView({ parent: $("editor"), state: makeState("") });
const symbolPalette = mountSymbolPalette($("symbol-palette"), () => view);
toolbar = mountToolbar($("editor-toolbar"), () => view, icon, [
  { icon: "omega", title: "Paleta de símbolos", run: () => symbolPalette.toggle() },
  {
    icon: "align-cols",
    title: "Alinear columnas & de la tabla, align o matriz (Ctrl+Alt+A)",
    run: () => {
      if (!alignColumns(view)) setStatus("Pon el cursor dentro de una tabla, align o matriz para alinear sus columnas.");
      view.focus();
    },
  },
  { icon: "book", title: "Añadir referencia por DOI", run: () => void addReferenceByDoi() },
  { icon: "external", title: "Abrir el PDF en otra ventana", run: () => void openPdfWindow() },
]);
$("editor-toolbar").hidden = !settings.toolbar;

function reconfigureAll() {
  const effects = [
    fontComp.reconfigure(fontExt()),
    spellComp.reconfigure(spellExt()),
    wrapComp.reconfigure(wrapExt()),
    mathComp.reconfigure(mathExt()),
  ];
  view.dispatch({ effects });
  for (const [p, st] of states) states.set(p, st.update({ effects }).state);
}

function diagnosticsFor(path: string, state: EditorState): Diagnostic[] {
  return allProblems()
    .filter((p) => p.file === path && p.line)
    .map((p) => {
      const ln = state.doc.line(Math.min(Math.max(1, p.line!), state.doc.lines));
      return {
        from: ln.from,
        to: ln.to,
        severity: p.level,
        message: p.message,
        source: p.source ?? "LaTeX",
      } satisfies Diagnostic;
    });
}

function openFile(path: string, line?: number) {
  const f = findFile(path);
  if (!f) return;
  if (current && current !== path && findFile(current)?.text !== undefined) states.set(current, view.state);
  current = path;
  $("crumb").replaceChildren(
    ...path.split("/").flatMap((seg, i, arr) => [
      el("span", { cls: i === arr.length - 1 ? "crumb-file" : "" }, seg),
      ...(i < arr.length - 1 ? [el("span", { cls: "crumb-sep" }, "/")] : []),
    ]),
    ...(path === meta.main ? [el("span", { cls: "badge" }, "principal")] : []),
    ...(f.encoding ? [el("span", { cls: "badge", title: "Este archivo no está en UTF-8: se guarda y compila en Latin-1 (Windows-1252)" }, "Latin-1")] : []),
  );

  const bin = $("binary-view");
  if (f.text === undefined) {
    $("editor").hidden = true;
    // sin editor de texto no hay barra ni paleta (insertarían en el archivo anterior)
    $("editor-toolbar").hidden = true;
    $("symbol-palette").hidden = true;
    bin.hidden = false;
    showBinary(f);
    $<HTMLButtonElement>("sync-fwd").disabled = true;
  } else {
    $("editor").hidden = false;
    $("editor-toolbar").hidden = !settings.toolbar;
    bin.hidden = true;
    bin.replaceChildren();
    $<HTMLButtonElement>("sync-fwd").disabled = false;
    const st = states.get(path) ?? makeState(f.text);
    view.setState(st);
    view.dispatch(setDiagnostics(view.state, diagnosticsFor(path, view.state)));
    if (line) goToLine(line);
    else view.focus();
  }
  renderTree();
}

function goToLine(line: number, flash = true) {
  const doc = view.state.doc;
  const ln = doc.line(Math.min(Math.max(1, line), doc.lines));
  view.dispatch({ selection: { anchor: ln.from }, effects: EditorView.scrollIntoView(ln.from, { y: "center" }) });
  view.focus();
  if (flash) {
    requestAnimationFrame(() => {
      const dom = view.domAtPos(ln.from).node;
      const lineEl = (dom instanceof HTMLElement ? dom : dom.parentElement)?.closest(".cm-line");
      lineEl?.classList.add("cm-flash-line");
      setTimeout(() => lineEl?.classList.remove("cm-flash-line"), 1400);
    });
  }
}

let binUrl: string | null = null;
function showBinary(f: StoredFile) {
  const bin = $("binary-view");
  if (binUrl) URL.revokeObjectURL(binUrl);
  binUrl = null;
  const size = f.data?.byteLength ?? 0;
  const info = el("p", { cls: "muted" }, `${basename(f.path)} · ${(size / 1024).toFixed(1)} KB`);
  const ext = f.path.split(".").pop()?.toLowerCase() ?? "";
  const mime: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp" };
  const nodes: Node[] = [];
  if (f.data && mime[ext]) {
    binUrl = URL.createObjectURL(new Blob([f.data.slice()], { type: mime[ext] }));
    nodes.push(el("img", { src: binUrl, alt: f.path }));
  } else if (f.data && ext === "pdf") {
    const box = el("div", { cls: "mini-pdf" });
    nodes.push(box);
    const v = new PdfViewer(box);
    void v.load(f.data);
  } else {
    nodes.push(el("p", {}, "Archivo binario. Se usa al compilar."));
  }
  const snippet = `\\includegraphics[width=0.8\\linewidth]{${f.path}}`;
  const copy = el("button", { type: "button", cls: "btn ghost-inline small" }, "Copiar \\includegraphics");
  copy.onclick = () => void navigator.clipboard.writeText(snippet).then(() => setStatus("Copiado al portapapeles."));
  bin.replaceChildren(...nodes, info, ...(mime[ext] || ext === "pdf" ? [copy] : []));
}

// Pegar o soltar imágenes en el editor: se guardan en figuras/ y se inserta el código.
async function addImageFromEditor(file: File, view: EditorView, pos: number) {
  // solo letras y números (image/x-icon daría «x-icon» y el bucle de abajo no terminaría)
  const ext = ((file.type.split("/")[1] || "png").replace("jpeg", "jpg").replace("svg+xml", "svg").replace(/^x-/, "").replace(/\W/g, "")) || "png";
  let base = file.name && file.name !== "image.png" ? file.name.replace(/\s+/g, "-") : `imagen-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${ext}`;
  // sin extensión, el bucle de nombres únicos de abajo no terminaría nunca
  if (!/\.\w+$/.test(base)) base = `${base.replace(/\.+$/, "") || "imagen"}.${ext}`;
  const pid = meta.id;
  const editing = current;
  const docBefore = view.state.doc;
  const data = new Uint8Array(await file.arrayBuffer());
  if (pid !== meta.id || editing !== current) return; // cambiaste de proyecto o de archivo
  let path = `figuras/${base}`;
  for (let i = 2; findFile(path) && i < 10_000; i++) path = `figuras/${base.replace(/(\.[^./]+)$/, `-${i}$1`)}`;
  const f: StoredFile = { path, data };
  files.push(f);
  persist(f, 0);
  // si el documento cambió mientras se leía la imagen, se inserta donde está el cursor
  if (view.state.doc !== docBefore) pos = view.state.doc.lineAt(view.state.selection.main.head).from;
  const code = `\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${path}}\n  \\caption{}\n  \\label{fig:${basename(path).replace(/\.\w+$/, "")}}\n\\end{figure}\n`;
  view.dispatch({ changes: { from: pos, insert: code }, selection: { anchor: pos + code.indexOf("\\caption{") + 9 } });
  renderTree();
  setStatus(`Imagen guardada como ${path}`);
}

function onPaste(e: ClipboardEvent, v: EditorView) {
  const img = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
  if (!img) {
    // celdas de una hoja de cálculo → tabla LaTeX
    const rows = parseTsv(e.clipboardData?.getData("text/plain") ?? "");
    if (!rows || !isTexLike(current)) return false;
    e.preventDefault();
    insertTable(v, rows, e.clipboardData!.getData("text/plain"));
    return true;
  }
  e.preventDefault();
  void addImageFromEditor(img, v, v.state.selection.main.head);
  return true;
}

/** Paquetes cargados en el proyecto (para decidir columnas S de siunitx y booktabs). */
const projectUses = (pkg: string) =>
  files.some(
    (f) =>
      f.text !== undefined &&
      // sin comentarios: un "% \usepackage{booktabs}" no cuenta
      new RegExp(`\\\\usepackage(\\[[^\\]]*\\])?\\{[^}]*\\b${pkg}\\b`).test(f.text.replace(/(^|[^\\])%.*$/gm, "$1")),
  );

/**
 * Inserta una tabla. Si `plain` se da (pegado), primero se pega el texto tal cual y después
 * se convierte en un paso aparte del historial: Ctrl+Z deja el texto original.
 */
function insertTable(v: EditorView, rows: Rows, plain?: string) {
  const { state } = v;
  const r = state.selection.main;
  const siunitx = projectUses("siunitx");
  const booktabs = projectUses("booktabs");
  // dentro de una tabla que ya existe: solo se añaden las filas
  const inTable = openEnvsAt(state.doc.toString(), r.from).some((e) => /^(tabular\*?|tabularx|longtable|array)$/.test(e.name));
  const line = state.doc.lineAt(r.from);
  const indent = /^\s*/.exec(line.text)![0];
  let tex = toLatexTable(rows, { siunitx, booktabs, wrap: !inTable, indent: inTable ? indent + "  " : "" });
  if (inTable) tex = tex.replace(/^\s+/, "");
  if (plain !== undefined) {
    // el editor guarda los saltos como \n: con \r\n (Excel en Windows) la longitud no cuadraría
    const pasted = plain.replace(/\r\n?/g, "\n");
    v.dispatch({ changes: { from: r.from, to: r.to, insert: pasted }, userEvent: "input.paste", scrollIntoView: true });
    v.dispatch({
      changes: { from: r.from, to: r.from + pasted.length, insert: tex },
      selection: { anchor: r.from + tex.length },
      annotations: isolateHistory.of("full"),
      userEvent: "input.paste.table",
    });
  } else {
    v.dispatch({ changes: { from: r.from, to: r.to, insert: tex }, selection: { anchor: r.from + tex.length }, userEvent: "input.paste.table" });
  }
  const falta = [!booktabs && "booktabs", !siunitx && rows.some((row) => row.some((c) => /\d/.test(c))) && "siunitx (alineación decimal)"].filter(Boolean);
  setStatus(
    `Tabla de ${rows.length}×${rows[0].length} insertada${plain !== undefined ? " (Ctrl+Z la deja como texto)" : ""}.` +
      (falta.length ? ` Sugerencia: añade \\usepackage{${falta.map((x) => String(x).split(" ")[0]).join(",")}} al preámbulo.` : ""),
  );
}

function onEditorDrop(e: DragEvent, v: EditorView) {
  const dropped = [...(e.dataTransfer?.files ?? [])];
  const csv = dropped.find((f) => /\.(csv|tsv)$/i.test(f.name));
  if (csv && isTexLike(current)) {
    // un .csv soltado en el editor se convierte en tabla en esa línea
    e.preventDefault();
    const pos = v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head;
    v.dispatch({ selection: { anchor: v.state.doc.lineAt(pos).from } });
    void csv.arrayBuffer().then((buf) => {
      const rows = parseDelimited(decodeText(new Uint8Array(buf)).text); // UTF-8 o Latin-1 (Excel)
      if (rows) insertTable(v, rows);
      else setStatus(`${csv.name} no parece una tabla.`, "error");
    });
    return true;
  }
  const img = dropped.find((f) => f.type.startsWith("image/"));
  if (!img) {
    if (!dropped.length) return false; // texto arrastrado: lo maneja el editor
    // otros archivos (PDF, .bib…): al proyecto, no como texto dentro del documento
    e.preventDefault();
    void uploadFiles(dropped);
    return true;
  }
  e.preventDefault();
  const pos = v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head;
  void addImageFromEditor(img, v, v.state.doc.lineAt(pos).from);
  return true;
}

// ---------- Árbol de archivos ----------

type Node_ = { name: string; path: string; dir: boolean; children: Node_[]; file?: StoredFile };

function buildTree(): Node_ {
  const root: Node_ = { name: "", path: "", dir: true, children: [] };
  const ensureDir = (path: string): Node_ => {
    if (!path) return root;
    const parent = ensureDir(dirname(path));
    let d = parent.children.find((c) => c.dir && c.path === path);
    if (!d) {
      d = { name: basename(path), path, dir: true, children: [] };
      parent.children.push(d);
    }
    return d;
  };
  for (const d of meta.folders) ensureDir(d);
  for (const f of files) ensureDir(dirname(f.path)).children.push({ name: basename(f.path), path: f.path, dir: false, children: [], file: f });
  const sort = (n: Node_) => {
    n.children.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

let dragPath: string | null = null;

function renderTree() {
  const ul = $("tree");
  ul.replaceChildren();
  const walk = (n: Node_, depth: number, parent: HTMLElement) => {
    for (const c of n.children) {
      const li = el("li", { cls: c.dir ? "dir" : "" });
      li.style.setProperty("--depth", String(depth));
      if (c.path === current) li.classList.add("active");
      const row = el("div", { cls: "row" });
      const name = el("button", { type: "button", cls: "name" });
      const ic = el("span", { cls: "ic" });
      const isOpen = c.dir && !collapsed.has(c.path);
      ic.innerHTML = icon(c.dir ? (isOpen ? "folder-open" : "folder") : c.file?.text === undefined ? (/\.(png|jpe?g|gif|svg|webp)$/i.test(c.path) ? "photo" : "file") : "file-text");
      name.append(ic, el("span", { cls: "label" }, c.name));
      if (c.path === meta.main) name.append(el("span", { cls: "star", title: "Archivo principal" }, "★"));
      name.title = c.path;
      name.onclick = () => {
        if (c.dir) {
          if (isOpen) collapsed.add(c.path);
          else collapsed.delete(c.path);
          renderTree();
        } else openFile(c.path);
      };
      name.ondblclick = () => void renamePath(c.path, c.dir);

      const actions = el("span", { cls: "actions" });
      if (c.dir) {
        actions.append(iconBtn("file-plus", "Nuevo archivo aquí", () => void newFile(c.path)));
      } else if (c.path.endsWith(".tex") && c.path !== meta.main) {
        actions.append(iconBtn("star", "Usar como archivo principal", () => setMain(c.path)));
      }
      actions.append(
        iconBtn("pencil", "Renombrar o mover", () => void renamePath(c.path, c.dir)),
        iconBtn("trash", "Eliminar", () => void deletePath(c.path, c.dir)),
      );
      row.append(name, actions);
      li.append(row);

      // arrastrar para mover
      row.draggable = true;
      row.addEventListener("dragstart", (e) => {
        dragPath = c.path;
        e.dataTransfer!.effectAllowed = "move";
        e.dataTransfer!.setData("text/plain", c.path);
      });
      row.addEventListener("dragend", () => (dragPath = null));
      if (c.dir) {
        row.addEventListener("dragover", (e) => {
          e.preventDefault();
          e.stopPropagation();
          row.classList.add("drop");
        });
        row.addEventListener("dragleave", () => row.classList.remove("drop"));
        row.addEventListener("drop", (e) => {
          e.preventDefault();
          e.stopPropagation();
          row.classList.remove("drop");
          void handleDrop(e, c.path);
        });
      }
      parent.append(li);
      if (c.dir && isOpen) walk(c, depth + 1, parent);
    }
  };
  walk(buildTree(), 0, ul);
  refreshMainSelect();
}

async function handleDrop(e: DragEvent, dir: string) {
  const dropped = [...(e.dataTransfer?.files ?? [])];
  if (dropped.length) return uploadFiles(dropped, dir);
  if (dragPath) {
    const src = dragPath;
    dragPath = null;
    const isDir = !findFile(src);
    const target = (dir ? dir + "/" : "") + basename(src);
    if (target === src || target.startsWith(src + "/")) return;
    await movePath(src, target, isDir);
  }
}

// Archivos soltados en cualquier otra parte de la ventana: se ignoran (si no, el visor
// navegaría al archivo y sacaría al usuario de Folio). Va en fase de burbuja, así que el
// árbol y el editor ya los habrán procesado si les correspondía.
window.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});

const side = $("side");
side.addEventListener("dragover", (e) => {
  e.preventDefault();
  side.classList.add("dropping");
});
side.addEventListener("dragleave", (e) => {
  if (!side.contains(e.relatedTarget as Node)) side.classList.remove("dropping");
});
side.addEventListener("drop", (e) => {
  e.preventDefault();
  side.classList.remove("dropping");
  void handleDrop(e, "");
});

async function uploadFiles(list: File[], dir = "") {
  for (const file of list) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    if (file.name.toLowerCase().endsWith(".zip") && list.length === 1 && confirm(`¿Descomprimir ${file.name} dentro del proyecto?`)) {
      for (const f of fromZip(new Uint8Array(await file.arrayBuffer()))) {
        await putFile({ ...f, path: (dir ? dir + "/" : "") + f.path });
      }
      continue;
    }
    const path = (dir ? dir + "/" : "") + rel;
    await putFile(await readUpload(file, path));
  }
  renderTree();
  scheduleIndex();
  setStatus(`${list.length} archivo(s) añadidos.`);
}

async function putFile(f: StoredFile) {
  files = files.filter((x) => x.path !== f.path);
  files.push(f);
  states.delete(f.path);
  await backend.writeFile(meta.id, f);
  touch();
  if (current === f.path) openFile(f.path);
}

async function newFile(dir = "") {
  const path = cleanPath(await ask("Nombre del archivo (por ejemplo capitulos/intro.tex):", dir ? dir + "/" : ""));
  if (!path) return;
  if (findFile(path)) return void alert("Ya existe un archivo con ese nombre.");
  const f: StoredFile = { path, text: "" };
  files.push(f);
  meta.folders = meta.folders.filter((d) => !path.startsWith(d + "/"));
  persist(f, 0);
  collapsed.delete(dirname(path));
  openFile(path);
  scheduleIndex();
}

async function newFolder() {
  const path = cleanPath(await ask("Nombre de la carpeta:"));
  if (!path) return;
  if (!meta.folders.includes(path)) meta.folders.push(path);
  touch();
  renderTree();
}

/** Windows (NTFS) no distingue mayúsculas en los nombres de archivo; Linux y el navegador sí. */
const caseInsensitiveFS = /win/i.test(navigator.platform || navigator.userAgent);
const RENAME_TMP = ".folio-renombrando";

async function movePath(from: string, to: string, isDir: boolean): Promise<boolean> {
  // carpeta que solo cambia de mayúsculas en Windows: se pasa por un nombre temporal
  if (isDir && caseInsensitiveFS && from !== to && from.toLowerCase() === to.toLowerCase()) {
    const tmp = from + RENAME_TMP;
    if (!(await movePath(from, tmp, true))) return false; // si el primer paso falla, no se sigue
    return movePath(tmp, to, true);
  }
  const moves: [StoredFile, string][] = [];
  for (const f of files) {
    if (isDir ? f.path.startsWith(from + "/") : f.path === from) moves.push([f, isDir ? to + f.path.slice(from.length) : to]);
  }
  const moving = new Set(moves.map(([f]) => f));
  const same = (a: string, b: string) => (caseInsensitiveFS ? a.toLowerCase() === b.toLowerCase() : a === b);
  for (const [, np] of moves) {
    const other = files.find((x) => !moving.has(x) && same(x.path, np));
    if (other) {
      alert(`Ya existe ${other.path}.`);
      return false;
    }
  }
  await flushPending();
  let ok = true;
  for (const [f, np] of moves) {
    const op = f.path;
    // primero se escribe el destino y solo después se borra el original: si algo falla,
    // el archivo sigue donde estaba (antes se borraba primero y podía perderse)
    try {
      if (caseInsensitiveFS && op !== np && op.toLowerCase() === np.toLowerCase()) {
        // solo cambian mayúsculas: en Windows es el mismo archivo, se pasa por un nombre temporal
        const tmp = op + RENAME_TMP;
        await backend.writeFile(meta.id, { ...f, path: tmp });
        await backend.deleteFile(meta.id, op);
        try {
          await backend.writeFile(meta.id, { ...f, path: np });
        } catch (e) {
          await backend.writeFile(meta.id, { ...f, path: op }).catch(() => undefined); // restaura
          throw e;
        }
        await backend.deleteFile(meta.id, tmp);
      } else {
        await backend.writeFile(meta.id, { ...f, path: np });
        await backend.deleteFile(meta.id, op);
      }
    } catch (e) {
      alert(`No se pudo mover ${op}: ${e instanceof Error ? e.message : e}`);
      ok = false;
      break;
    }
    f.path = np;
    const st = states.get(op);
    states.delete(op);
    if (st) states.set(np, st);
    if (current === op) current = np;
    if (meta.main === op) meta.main = np;
  }
  if (isDir && ok) meta.folders = meta.folders.map((d) => (d === from || d.startsWith(from + "/") ? to + d.slice(from.length) : d));
  touch();
  if (current) openFile(current);
  else renderTree();
  return ok;
}

async function renamePath(path: string, isDir: boolean) {
  const next = cleanPath(await ask(isDir ? "Nuevo nombre de la carpeta:" : "Nuevo nombre (puedes usar carpeta/archivo.tex para moverlo):", path));
  if (!next || next === path) return;
  await movePath(path, next, isDir);
}

async function deletePath(path: string, isDir: boolean) {
  const victims = files.filter((f) => (isDir ? f.path.startsWith(path + "/") : f.path === path));
  if (!isDir && path === meta.main) return void alert("Es el archivo principal. Elige otro como principal antes de eliminarlo.");
  if (isDir && victims.some((f) => f.path === meta.main)) return void alert("La carpeta contiene el archivo principal.");
  const msg = isDir ? `¿Eliminar la carpeta ${path} y sus ${victims.length} archivo(s)?` : `¿Eliminar ${path}?`;
  if (!confirm(msg)) return;
  for (const f of victims) {
    window.clearTimeout(pending.get(f.path));
    if (pending.delete(f.path)) markSaving(-1);
    await backend.deleteFile(meta.id, f.path);
    states.delete(f.path);
  }
  files = files.filter((f) => !victims.includes(f));
  if (isDir) meta.folders = meta.folders.filter((d) => d !== path && !d.startsWith(path + "/"));
  touch();
  if (current && !findFile(current)) {
    current = null;
    openFile(meta.main);
  } else renderTree();
  scheduleIndex();
}

function setMain(path: string) {
  meta.main = path;
  touch();
  if (current) openFile(current);
  scheduleIndex();
  setStatus(`${path} es ahora el archivo principal.`);
}

function refreshMainSelect() {
  const sel = $<HTMLSelectElement>("set-main");
  sel.replaceChildren(...files.filter((f) => f.path.endsWith(".tex")).map((f) => el("option", { value: f.path, textContent: f.path })));
  sel.value = meta.main;
}

$("new-file").onclick = () => void newFile();
$("new-folder").onclick = () => void newFolder();
$("upload").onclick = () => $<HTMLInputElement>("file-input").click();
$<HTMLInputElement>("file-input").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  await uploadFiles([...(input.files ?? [])]);
  input.value = "";
});
$("export-zip").onclick = async () => {
  await flushPending();
  download(`${meta.name.replace(/[\\/:*?"<>|]+/g, "_")}.zip`, toZip(files), "application/zip");
};

// ---------- Panel lateral: pestañas, esquema y búsqueda ----------

document.querySelectorAll<HTMLButtonElement>(".side-tabs button").forEach((b) => {
  b.onclick = () => showTab(b.dataset.tab!);
});
function showTab(tab: string) {
  document.querySelectorAll<HTMLButtonElement>(".side-tabs button").forEach((x) => x.classList.toggle("active", x.dataset.tab === tab));
  document.querySelectorAll<HTMLElement>(".side-panel").forEach((p) => (p.hidden = p.dataset.panel !== tab));
  if (tab === "outline") renderOutline();
  if (tab === "search") $<HTMLInputElement>("search-input").focus();
  if (tab === "git") void gitPanel?.refresh();
}

const gitPanel = desktop
  ? createGitPanel($("git-panel"), {
      projectId: () => meta.id,
      flush: flushPending,
      status: setStatus,
      ask,
    })
  : null;
if (desktop) $("git-tab").hidden = false;

function renderOutline() {
  const ul = $("outline");
  const items = outline(files, meta.main);
  if (!items.length) {
    ul.replaceChildren(el("li", { cls: "muted pad" }, "Sin secciones todavía."));
    return;
  }
  const min = Math.min(...items.map((i) => i.level));
  ul.replaceChildren(
    ...items.map((it) => {
      const b = el("button", { type: "button", title: `${it.file}:${it.line}` }, it.title);
      b.style.paddingLeft = `${10 + (it.level - min) * 14}px`;
      b.onclick = () => openFile(it.file, it.line);
      return el("li", { cls: `lvl-${it.level}` }, b);
    }),
  );
}

let idxTimer: number | undefined;
function scheduleIndex() {
  filesVersion++;
  window.clearTimeout(idxTimer);
  idxTimer = window.setTimeout(() => {
    $("sb-words").textContent = `${wordCount(files, meta.main).toLocaleString("es")} palabras`;
    runProjectChecks();
    if (!document.querySelector<HTMLElement>('[data-panel="outline"]')!.hidden) renderOutline();
  }, 600);
}

/** Revisa el proyecto y actualiza la lista solo si cambió algo. */
let lastChecks = "";
function runProjectChecks() {
  const next = settings.projectChecks ? checkProject(files) : [];
  const key = JSON.stringify(next);
  if (key === lastChecks) return;
  lastChecks = key;
  checkProblems = next;
  renderProblems();
}

let searchTimer: number | undefined;
function runSearch() {
  const q = $<HTMLInputElement>("search-input").value;
  const box = $("search-results");
  if (!q) return void box.replaceChildren();
  let re: RegExp;
  try {
    const flags = $<HTMLInputElement>("search-case").checked ? "g" : "gi";
    re = new RegExp($<HTMLInputElement>("search-regex").checked ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  } catch {
    return void box.replaceChildren(el("p", { cls: "muted pad" }, "Expresión regular no válida."));
  }
  const out: HTMLElement[] = [];
  let total = 0;
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (f.text === undefined) continue;
    const hits: HTMLElement[] = [];
    f.text.split("\n").forEach((line, i) => {
      re.lastIndex = 0;
      const m = re.exec(line);
      if (!m || total > 500) return;
      total++;
      const start = Math.max(0, m.index - 30);
      const b = el(
        "button",
        { type: "button", cls: "hit" },
        el("span", { cls: "ln" }, String(i + 1)),
        (start > 0 ? "…" : "") + line.slice(start, m.index),
        el("mark", {}, m[0]),
        line.slice(m.index + m[0].length, m.index + m[0].length + 60),
      );
      b.onclick = () => {
        openFile(f.path, i + 1);
        const ln = view.state.doc.line(i + 1);
        view.dispatch({ selection: { anchor: ln.from + m.index, head: ln.from + m.index + m[0].length } });
      };
      hits.push(b);
    });
    if (hits.length) out.push(el("div", { cls: "hit-file" }, `${f.path} (${hits.length})`), ...hits);
  }
  box.replaceChildren(...(out.length ? out : [el("p", { cls: "muted pad" }, "Sin resultados.")]));
}
for (const id of ["search-input", "search-case", "search-regex"]) {
  $(id).addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(runSearch, 200);
  });
}

// ---------- Vista previa ----------

const viewer = new PdfViewer($("pdf-root"));
viewer.onChange = () => {
  $("page-info").textContent = viewer.pageCount ? `Página ${viewer.currentPage} de ${viewer.pageCount}` : "";
  const zsel = $<HTMLSelectElement>("zoom");
  const z = String(settings.zoom);
  if ([...zsel.options].some((o) => o.value === z && !o.hidden)) zsel.value = z;
  else {
    const custom = zsel.querySelector<HTMLOptionElement>('option[value="custom"]')!;
    custom.textContent = `${Math.round(viewer.currentScale * 100)} %`;
    zsel.value = "custom";
  }
};
viewer.onDblClick = (page, x, y) => {
  if (!sync) return setStatus("Compila de nuevo para activar la sincronización.");
  const hit = inverse(sync, page, x, y);
  if (hit && findFile(hit.file)) openFile(hit.file, hit.line);
};

viewer.onExternalLink = (url) => {
  if (!/^(https?:|mailto:)/i.test(url)) return setStatus(`Enlace no admitido: ${url}`, "error");
  if (desktop) void desktop.openUrl(url);
  else window.open(url, "_blank", "noopener");
};

// ---------- Buscar en el PDF ----------

let findHits: FindHit[] = [];
let findIndex = 0;
let findTimer: number | undefined;
const findInput = $<HTMLInputElement>("pdf-find-input");

function openPdfFind() {
  $("pdf-find").hidden = false;
  findInput.focus();
  findInput.select();
}
function closePdfFind() {
  $("pdf-find").hidden = true;
  viewer.clearFind();
  findHits = [];
}
async function runPdfFind() {
  const q = findInput.value;
  findHits = q.trim() ? await viewer.find(q) : [];
  findIndex = 0;
  $("pdf-find-count").textContent = q.trim() ? (findHits.length ? `1 de ${findHits.length}` : "Sin resultados") : "";
  if (findHits.length) void viewer.showHit(findHits[0], findHits);
  else viewer.clearFind();
}
function stepPdfFind(dir: 1 | -1) {
  if (!findHits.length) return void runPdfFind();
  findIndex = (findIndex + dir + findHits.length) % findHits.length;
  $("pdf-find-count").textContent = `${findIndex + 1} de ${findHits.length}`;
  void viewer.showHit(findHits[findIndex], findHits);
}
findInput.addEventListener("input", () => {
  window.clearTimeout(findTimer);
  findTimer = window.setTimeout(() => void runPdfFind(), 250);
});
findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    stepPdfFind(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") closePdfFind();
});
$("pdf-find-btn").onclick = () => ($("pdf-find").hidden ? openPdfFind() : closePdfFind());
$("pdf-find-next").onclick = () => stepPdfFind(1);
$("pdf-find-prev").onclick = () => stepPdfFind(-1);
$("pdf-find-close").onclick = closePdfFind;
// Ctrl+F con el ratón o el foco sobre el PDF busca en el PDF (en el editor, busca en el código)
$("preview").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    e.preventDefault();
    openPdfFind();
  }
});
$("pdf-root").tabIndex = -1; // permite enfocar el PDF al hacer clic

function setZoom(z: Zoom) {
  settings.zoom = z;
  saveSettings();
  viewer.setZoom(z);
}
$<HTMLSelectElement>("zoom").onchange = (e) => {
  const v = (e.target as HTMLSelectElement).value;
  if (v !== "custom") setZoom(v === "width" || v === "page" ? v : +v);
};
$("zoom-in").onclick = () => setZoom(Math.round(viewer.currentScale * 1.2 * 100) / 100);
$("zoom-out").onclick = () => setZoom(Math.round((viewer.currentScale / 1.2) * 100) / 100);
viewer.setZoom(settings.zoom);

function syncForward() {
  if (!sync || !current) return setStatus("Compila primero para poder sincronizar.");
  const line = view.state.doc.lineAt(view.state.selection.main.head).number;
  const r = forward(sync, current, line);
  if (!r) return setStatus("Esta parte no aparece en el PDF.");
  viewer.reveal(r.page, r.top, r.bottom, r.left, r.right);
  pdfChannel.postMessage({ type: "reveal", ...r } satisfies PdfMessage);
}
$("sync-fwd").onclick = syncForward;

let pdfUrl: string | null = null;
async function showPdf(pdf: Uint8Array) {
  lastPdf = pdf;
  $("pdf-root").hidden = false;
  $("empty").hidden = true;
  await viewer.load(pdf);
  if (pdfUrl) URL.revokeObjectURL(pdfUrl);
  pdfUrl = URL.createObjectURL(new Blob([pdf.slice()], { type: "application/pdf" }));
  const a = $<HTMLAnchorElement>("download");
  a.href = pdfUrl;
  a.download = `${basename(meta.main).replace(/\.tex$/, "")}.pdf`;
  a.hidden = false;
  postPdf(); // a la ventana aparte, si está abierta
}
$("download").addEventListener("click", (e) => {
  if (!desktop || !lastPdf) return;
  e.preventDefault();
  download(`${basename(meta.main).replace(/\.tex$/, "")}.pdf`, lastPdf, "application/pdf");
});

// ---------- Problemas y registro ----------

function renderProblems() {
  const list = allProblems();
  const e = list.filter((p) => p.level === "error").length;
  const w = list.filter((p) => p.level === "warning").length;
  const b = list.filter((p) => p.level === "info").length;
  const parts = [];
  if (e) parts.push(`${e} error${e > 1 ? "es" : ""}`);
  if (w) parts.push(`${w} aviso${w > 1 ? "s" : ""}`);
  if (b) parts.push(`${b} de formato`);
  $("problems-summary").textContent = parts.length ? parts.join(" · ") : "Sin problemas";
  $("problems").dataset.kind = e ? "error" : w ? "warning" : "";
  const ul = $("problem-list");
  ul.replaceChildren(
    ...(list.length
      ? list.map((p) => {
          const btn = el(
            "button",
            { type: "button", cls: `problem ${p.level}` },
            el("span", { cls: "lvl" }, p.level === "error" ? "Error" : p.level === "warning" ? "Aviso" : "Formato"),
            el("span", { cls: "msg" }, p.message),
            el("span", { cls: "where" }, (p.file ? `${p.file}${p.line ? ":" + p.line : ""}` : "") + (p.source ? ` · revisión del ${p.source.toLowerCase()}` : "")),
          );
          if (p.file) btn.onclick = () => openFile(p.file!, p.line ?? undefined);
          else btn.disabled = true;
          return el("li", {}, btn);
        })
      : [el("li", { cls: "muted pad" }, "Todo en orden.")]),
  );
  // aplica los marcadores al archivo abierto y a los demás estados guardados
  if (current && findFile(current)?.text !== undefined) {
    view.dispatch(setDiagnostics(view.state, diagnosticsFor(current, view.state)));
    forceLinting(view); // vuelve a unir con la revisión en vivo
  }
  for (const [p, st] of states) if (p !== current) states.set(p, st.update(setDiagnostics(st, diagnosticsFor(p, st))).state);
}

function setProblemsOpen(open: boolean) {
  $("problems-body").hidden = !open;
  $("problems").classList.toggle("open", open);
}
$("problems-toggle").onclick = () => setProblemsOpen($("problems-body").hidden === true);
document.querySelectorAll<HTMLButtonElement>("[data-log]").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll<HTMLButtonElement>("[data-log]").forEach((x) => x.classList.toggle("active", x === b));
    $("problem-list").hidden = b.dataset.log !== "list";
    $("log").hidden = b.dataset.log !== "raw";
    setProblemsOpen(true);
  };
});

// ---------- Compilación ----------

let busy = false;
let again = false;
/** La compilación pendiente la pediste tú (completa), no la automática (rápida). */
let againFull = false;
let cancelling = false;
/** Identificador de la compilación enviada al TeX del sistema (null si no hay ninguna). */
let nativeJob: string | null = null;

/** Detiene la compilación en curso (motor integrado o TeX del sistema). */
function cancelCompilation() {
  if (!busy || cancelling) return;
  cancelling = true;
  again = false;
  againFull = false;
  window.clearTimeout(autoTimer);
  setStatus("Cancelando…");
  if (nativeJob) void desktop?.cancelNative(nativeJob).catch(() => undefined);
  else cancelCompile(); // motor integrado (o aún no se envió nada: compile() lo detecta)
}

onEngineProgress((pct) => {
  if (pct < 100) $("sb-engine").textContent = `Cargando motor ${Math.round(pct)} %`;
  else updateCompilerBadge();
});

/** Borra los auxiliares guardados (.aux, .toc, glosarios…) y compila desde cero. */
$("clear-cache").onclick = async () => {
  clearAuxCache();
  if (desktop) await desktop.cleanNative(meta.id).catch(() => undefined);
  setStatus("Archivos auxiliares borrados. Compilando desde cero…");
  void compile();
};

async function compile(auto = false) {
  if (busy) {
    again = true; // se compila otra vez al terminar
    if (!auto) againFull = true;
    return;
  }
  busy = true;
  window.clearTimeout(autoTimer);
  // mientras compila, el mismo botón sirve para cancelar
  const btn = $<HTMLButtonElement>("compile");
  btn.classList.add("cancel");
  btn.title = "Cancelar la compilación (Esc)";
  $("compile-label").textContent = "Cancelar";
  setStatus(engineReady() ? "Compilando…" : "Compilando… la primera vez se carga el motor y puede tardar.");
  const t0 = performance.now();
  const pid = meta.id; // si cambias de proyecto mientras compila, el resultado es de este
  const pMain = meta.main;
  const pEngine = meta.engine;
  try {
    if (current && findFile(current)?.text !== undefined) states.set(current, view.state);
    const draft = auto && settings.draft;
    const useSystem = !!desktop && settings.compiler === "system";
    let r: Awaited<ReturnType<typeof compileProject>>;
    if (useSystem) {
      await flushPending(); // el TeX del sistema lee los archivos del disco
      if (cancelling || pid !== meta.id) throw new Error("Compilación cancelada");
      nativeJob = newId();
      r = await desktop!.compileNative(pid, {
        job: nativeJob,
        main: pMain,
        engine: pEngine,
        // solo si lo permitiste para ESTE proyecto, y nunca en compilaciones automáticas
        shellEscape: !auto && settings.shellEscapeProjects.includes(pid),
        draft,
      }).finally(() => (nativeJob = null));
    } else {
      r = await compileProject(
        // los archivos en Latin-1 se compilan con sus bytes originales (inputenc latin1)
        files.map((f) => ({
          path: f.path,
          content: f.text !== undefined ? (f.encoding ? encodeText(f.text, f.encoding) : f.text) : (f.data ?? new Uint8Array()),
        })),
        // la compilación automática usa el modo rápido (una pasada) si está activado
        { main: pMain, engine: pEngine, cacheKey: pid, draft },
      );
    }
    if (pid !== meta.id) {
      // se guarda en su proyecto, pero no se muestra en el que tienes abierto ahora
      if (r.pdf) void backend.saveOutput(pid, { pdf: r.pdf, synctex: r.synctex, time: Date.now(), aux: { main: pMain, engine: pEngine, files: exportAux(pid, pMain, pEngine) } }).catch(() => undefined);
      return;
    }
    $("log").textContent = r.log;
    const known = files.map((f) => f.path);
    problems = parseLog(r.log, known, meta.main);
    if (!r.success && !problems.some((p) => p.level === "error")) {
      problems.unshift({ level: "error", message: "La compilación falló. Revisa el registro completo.", file: null, line: null });
    }
    renderProblems();
    if (r.pdf) await showPdf(r.pdf);
    if (pid !== meta.id) return; // cambiaste de proyecto mientras se cargaba el PDF
    const newSync = r.synctex ? await parseSynctex(r.synctex, known).catch(() => null) : null;
    if (pid !== meta.id) return; // cambiaste de proyecto mientras se mostraba
    if (newSync) sync = newSync;
    if (r.pdf)
      void backend
        .saveOutput(meta.id, {
          pdf: r.pdf,
          synctex: r.synctex,
          time: Date.now(),
          aux: { main: meta.main, engine: meta.engine, files: exportAux(meta.id, meta.main, meta.engine) },
        })
        .catch(() => undefined);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const nErr = problems.filter((p) => p.level === "error").length;
    if (r.success && nErr) {
      // como Overleaf: hay PDF, pero conviene revisar los errores
      setStatus(`PDF generado con ${nErr} error${nErr > 1 ? "es" : ""} (${secs} s)`, "error");
      if (!auto) setProblemsOpen(true);
      void autoSnapshot();
    } else if (r.success) {
      setStatus(`Listo en ${secs} s`);
      void autoSnapshot();
    } else {
      setStatus(r.pdf ? `Con errores (${secs} s)` : "La compilación falló.", "error");
      if (!auto) setProblemsOpen(true);
    }
  } catch (error) {
    if (pid !== meta.id) {
      // era de otro proyecto: no se mezcla con el que tienes abierto
    } else if (cancelling) {
      // el PDF y los problemas anteriores se conservan
      setStatus(`Compilación cancelada (${((performance.now() - t0) / 1000).toFixed(1)} s).`);
    } else {
      $("log").textContent = error instanceof Error ? error.stack ?? error.message : String(error);
      problems = [{ level: "error", message: "No se pudo ejecutar el motor LaTeX. Revisa el registro completo.", file: null, line: null }];
      renderProblems();
      setStatus("No se pudo compilar.", "error");
      setProblemsOpen(true);
    }
  } finally {
    busy = false;
    cancelling = false;
    nativeJob = null;
    const btn = $<HTMLButtonElement>("compile");
    btn.classList.remove("cancel");
    btn.title = "Compilar (Ctrl+Enter o Ctrl+S)";
    $("compile-label").textContent = "Compilar";
    if (again) {
      const full = againFull;
      again = false;
      againFull = false;
      void compile(!full); // si pediste una completa, se hace completa (no en modo rápido)
    }
  }
}

$("compile").onclick = () => (busy ? cancelCompilation() : void compile());
// Esc cancela una compilación en curso (si no hay un diálogo o sugerencia abiertos)
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !busy || e.defaultPrevented) return;
  // Esc también cierra búsquedas, paneles y sugerencias: en esos casos no cancela
  const busyUi = document.querySelector("dialog[open], .cm-tooltip-autocomplete, .cm-panels .cm-panel");
  const inField = (e.target as HTMLElement | null)?.closest?.("input, textarea, select");
  if (busyUi || inField || !$("pdf-find").hidden || !$("symbol-palette").hidden) return;
  cancelCompilation();
});

const engineSelect = $<HTMLSelectElement>("engine");
engineSelect.onchange = () => {
  meta.engine = engineSelect.value as Engine;
  touch();
};

const autoBox = $<HTMLInputElement>("auto");
autoBox.checked = settings.auto;
autoBox.onchange = () => {
  settings.auto = autoBox.checked;
  saveSettings();
  if (settings.auto) void compile(true);
};

window.addEventListener(
  "keydown",
  (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && !e.shiftKey && (e.key === "Enter" || e.key.toLowerCase() === "s")) {
      e.preventDefault();
      e.stopPropagation();
      void compile();
    } else if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      const sel = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
      showTab("search");
      if (sel && !sel.includes("\n")) {
        $<HTMLInputElement>("search-input").value = sel;
        runSearch();
      }
    }
  },
  true,
);

// ---------- Historial ----------

const textFiles = () => files.filter((f) => f.text !== undefined).map((f) => ({ path: f.path, text: f.text! }));
const fingerprint = (fs: { path: string; text: string }[]) =>
  fs
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => f.path + "\0" + f.text)
    .join("\u0001");

let lastPrint = "";
async function autoSnapshot() {
  const fs = textFiles();
  const fp = fingerprint(fs);
  if (fp === lastPrint) return;
  const snaps = await backend.listSnapshots(meta.id);
  if (snaps[0] && fingerprint(snaps[0].files) === fp) {
    lastPrint = fp;
    return;
  }
  lastPrint = fp;
  await backend.addSnapshot(meta.id, { id: newId(), time: Date.now(), label: "", files: fs });
  // conserva las 200 últimas automáticas (las con nombre no se borran)
  const autos = snaps.filter((s) => !s.label);
  for (const s of autos.slice(199)) await backend.deleteSnapshot(meta.id, s.id);
}

function lineDiff(a: string, b: string) {
  const A = a.split("\n");
  const B = b.split("\n");
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);
  const out: { t: " " | "-" | "+"; s: string; n: number }[] = [];
  if (a2.length * b2.length > 4_000_000) {
    a2.forEach((s, i) => out.push({ t: "-", s, n: pre + i + 1 }));
    b2.forEach((s, i) => out.push({ t: "+", s, n: pre + i + 1 }));
  } else {
    // LCS clásico sobre la parte que cambió
    const m = a2.length;
    const n = b2.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < m || j < n) {
      if (i < m && j < n && a2[i] === b2[j]) {
        out.push({ t: " ", s: a2[i], n: pre + j + 1 });
        i++;
        j++;
      } else if (i < m && (j >= n || dp[i + 1][j] >= dp[i][j + 1])) {
        out.push({ t: "-", s: a2[i], n: pre + i + 1 });
        i++;
      } else {
        out.push({ t: "+", s: b2[j], n: pre + j + 1 });
        j++;
      }
    }
  }
  return { pre, out };
}

async function openHistory() {
  await flushPending();
  const dlg = $<HTMLDialogElement>("history-dlg");
  const list = $("snap-list");
  const detail = $("snap-detail");
  detail.replaceChildren(el("p", { cls: "muted" }, "Elige una versión para ver qué cambió desde entonces."));
  const snaps = await backend.listSnapshots(meta.id);
  list.replaceChildren(
    ...(snaps.length
      ? snaps.map((s) => {
          const b = el("button", { type: "button" }, el("strong", {}, s.label || "Automática"), el("span", { cls: "muted" }, fmtDate(s.time)));
          b.onclick = () => {
            list.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
            showSnapshot(s);
          };
          return el("li", {}, b);
        })
      : [el("li", { cls: "muted pad" }, "Todavía no hay versiones. Compila o guarda una versión.")]),
  );
  dlg.showModal();
}

function showSnapshot(s: Snapshot) {
  const detail = $("snap-detail");
  const now = new Map(textFiles().map((f) => [f.path, f.text]));
  const then = new Map(s.files.map((f) => [f.path, f.text]));
  const paths = [...new Set([...now.keys(), ...then.keys()])].sort();
  const changed = paths.filter((p) => now.get(p) !== then.get(p));
  const restore = el("button", { type: "button", cls: "btn primary small" }, "Restaurar esta versión");
  restore.onclick = () => void restoreSnapshot(s);
  const dl = el("button", { type: "button", cls: "btn ghost-inline small" }, "Descargar .zip");
  dl.onclick = () => download(`${meta.name}-${new Date(s.time).toISOString().slice(0, 16)}.zip`, toZip(s.files), "application/zip");
  const del = el("button", { type: "button", cls: "btn ghost-inline small" }, "Borrar");
  del.onclick = async () => {
    if (!confirm("¿Borrar esta versión del historial?")) return;
    await backend.deleteSnapshot(meta.id, s.id);
    void openHistory();
  };
  const nodes: Node[] = [el("div", { cls: "snap-tools" }, restore, dl, del)];
  if (!changed.length) nodes.push(el("p", { cls: "muted" }, "Es idéntica al estado actual."));
  else nodes.push(el("p", { cls: "muted" }, `Cambios desde esta versión hasta ahora (${changed.length} archivo${changed.length > 1 ? "s" : ""}):`));
  for (const p of changed) {
    const a = then.get(p);
    const b = now.get(p);
    const tag = a === undefined ? "nuevo" : b === undefined ? "eliminado" : "modificado";
    const { out } = lineDiff(a ?? "", b ?? "");
    const pre = el("pre", { cls: "diff" });
    // muestra solo los cambios con 2 líneas de contexto
    const keep = new Set<number>();
    out.forEach((d, i) => {
      if (d.t !== " ") for (let k = i - 2; k <= i + 2; k++) keep.add(k);
    });
    let last = -1;
    out.forEach((d, i) => {
      if (!keep.has(i)) return;
      if (last >= 0 && i > last + 1) pre.append(el("span", { cls: "gap" }, "⋯\n"));
      pre.append(el("span", { cls: d.t === "+" ? "add" : d.t === "-" ? "del" : "" }, `${d.t} ${d.s}\n`));
      last = i;
    });
    nodes.push(el("details", { open: changed.length <= 3 }, el("summary", {}, `${p} · ${tag}`), pre));
  }
  detail.replaceChildren(...nodes);
}

async function restoreSnapshot(s: Snapshot) {
  if (!confirm("¿Restaurar esta versión? El estado actual se guarda antes en el historial.")) return;
  await flushPending();
  await backend.addSnapshot(meta.id, { id: newId(), time: Date.now(), label: "Antes de restaurar", files: textFiles() });
  for (const f of files.filter((f) => f.text !== undefined && !s.files.some((x) => x.path === f.path))) await backend.deleteFile(meta.id, f.path);
  files = files.filter((f) => f.text === undefined || s.files.some((x) => x.path === f.path));
  for (const sf of s.files) {
    const f = findFile(sf.path);
    if (f) f.text = sf.text;
    else files.push({ path: sf.path, text: sf.text });
    await backend.writeFile(meta.id, findFile(sf.path)!);
  }
  states.clear();
  if (!findFile(meta.main)) meta.main = guessMain(files);
  touch();
  $<HTMLDialogElement>("history-dlg").close();
  openFile(current && findFile(current) ? current : meta.main);
  scheduleIndex();
  setStatus("Versión restaurada.");
}

$("history-btn").onclick = () => void openHistory();
$("snapshot-now").onclick = async () => {
  const label = await ask("Nombre de la versión:", `Versión del ${new Date().toLocaleDateString("es")}`);
  if (label === null) return;
  await flushPending();
  await backend.addSnapshot(meta.id, { id: newId(), time: Date.now(), label: label.trim() || "Sin nombre", files: textFiles() });
  void openHistory();
};

// ---------- Proyectos ----------

async function openProject(id: string) {
  const list = await backend.listProjects();
  const m = list.find((p) => p.id === id) ?? list[0];
  if (!m) return createProject("Mi proyecto", TEMPLATES.article.files);
  if (meta) await flushPending();
  diskReady = false; // pausa la vigilancia hasta tener la referencia del nuevo proyecto
  meta = { ...m, folders: m.folders ?? [] };
  // referencia del disco ANTES de leer: cualquier cambio posterior se detectará
  const sigs = desktop
    ? await desktop
        .manifest(meta.id)
        .then((l) => new Map(l.map((f) => [f.path, `${f.size}:${f.mtime}`])))
        .catch(() => new Map<string, string>())
    : new Map<string, string>();
  files = await backend.loadFiles(meta.id);
  if (!files.length) {
    files = [{ path: "main.tex", text: TEMPLATES.blank.files[0].text }];
    await backend.writeFile(meta.id, files[0]);
  }
  if (!findFile(meta.main)) meta.main = guessMain(files);
  states.clear();
  problems = [];
  checkProblems = []; // los del proyecto anterior apuntarían a otros archivos
  lastChecks = "";
  sync = null;
  lastPdf = null;
  lastPrint = "";
  diskSigs = sigs;
  diskReady = true;
  current = null;
  collapsed.clear();
  viewer.clear();
  $("pdf-root").hidden = true;
  $("empty").hidden = false;
  $("download").hidden = true;
  $("log").textContent = "";
  renderProblems();
  $("problems-summary").textContent = "Registro";
  $("project-name").textContent = meta.name;
  document.title = `${meta.name} · Folio`;
  engineSelect.value = meta.engine;
  settings.last = meta.id;
  saveSettings();
  openFile(meta.main);
  scheduleIndex();
  markSaving(0);
  // el panel de Git debe mostrar (y operar sobre) el proyecto recién abierto
  if (!document.querySelector<HTMLElement>('[data-panel="git"]')!.hidden) void gitPanel?.refresh();
  setStatus("Pulsa Compilar o Ctrl+Enter.");
  // muestra el último PDF guardado mientras tanto
  const pid = meta.id;
  const out = await backend.loadOutput(pid).catch(() => null);
  if (out && meta.id === pid) {
    if (out.aux?.files.length) importAux(pid, out.aux.main, out.aux.engine as Engine, out.aux.files);
    await showPdf(out.pdf);
    if (out.synctex) sync = await parseSynctex(out.synctex, files.map((f) => f.path)).catch(() => null);
    setStatus(`PDF de la última compilación (${fmtDate(out.time)}).`);
  }
  if (settings.auto) void compile(true);
}

async function createProject(name: string, initial: StoredFile[], extra: Partial<ProjectMeta> = {}) {
  const m: ProjectMeta = {
    id: newId(),
    name,
    main: guessMain(initial),
    engine: /\\usepackage(\[[^\]]*\])?\{fontspec\}/.test(initial.map((f) => f.text ?? "").join("")) ? "xelatex" : "pdflatex",
    folders: [],
    created: Date.now(),
    updated: Date.now(),
    ...extra,
  };
  await backend.saveMeta(m);
  for (const f of initial) await backend.writeFile(m.id, f);
  await openProject(m.id);
}

async function renderProjectList() {
  const ul = $("project-list");
  const list = await backend.listProjects();
  ul.replaceChildren(
    ...list.map((p) => {
      const open = el(
        "button",
        { type: "button", cls: "proj-open" },
        el("strong", {}, p.name),
        el("span", { cls: "muted" }, `${p.main} · ${p.engine} · editado ${fmtDate(p.updated)}${p.dir ? " · " + p.dir : ""}`),
      );
      open.onclick = async () => {
        $<HTMLDialogElement>("projects-dlg").close();
        await openProject(p.id);
      };
      const li = el("li", { cls: p.id === meta?.id ? "active" : "" }, open);
      const actions = el(
        "span",
        { cls: "actions" },
        iconBtn("pencil", "Renombrar", async () => {
          const n = await ask("Nombre del proyecto:", p.name);
          if (!n?.trim()) return;
          p.name = n.trim();
          if (p.id === meta.id) {
            meta.name = p.name;
            $("project-name").textContent = p.name;
            await backend.saveMeta(meta);
          } else await backend.saveMeta(p);
          void renderProjectList();
        }),
        iconBtn("copy", "Duplicar", async () => {
          if (p.id === meta.id) await flushPending();
          const fs = await backend.loadFiles(p.id);
          $<HTMLDialogElement>("projects-dlg").close();
          await createProject(`${p.name} (copia)`, fs, { main: p.main, engine: p.engine, folders: p.folders });
        }),
        iconBtn("archive", "Descargar .zip", async () => {
          if (p.id === meta.id) await flushPending();
          download(`${p.name}.zip`, toZip(await backend.loadFiles(p.id)), "application/zip");
        }),
        iconBtn("trash", "Eliminar", async () => {
          if (!confirm(`¿Eliminar el proyecto «${p.name}» con todos sus archivos e historial? No se puede deshacer.`)) return;
          await backend.deleteProject(p.id);
          if (p.id === meta.id) {
            const rest = await backend.listProjects();
            if (rest[0]) await openProject(rest[0].id);
            else await createProject("Mi proyecto", TEMPLATES.article.files);
          }
          void renderProjectList();
        }),
      );
      li.append(actions);
      return li;
    }),
  );
}

$("project-btn").onclick = async () => {
  await flushPending();
  await renderProjectList();
  $<HTMLDialogElement>("projects-dlg").showModal();
};

const tplSel = $<HTMLSelectElement>("template");
tplSel.replaceChildren(...Object.entries(TEMPLATES).map(([k, v]) => el("option", { value: k, textContent: v.name })));
$("create-project").onclick = async () => {
  const tpl = TEMPLATES[tplSel.value];
  const name = await ask("Nombre del nuevo proyecto:", tpl.name);
  if (!name?.trim()) return;
  $<HTMLDialogElement>("projects-dlg").close();
  await createProject(name.trim(), structuredClone(tpl.files));
};
$("import-zip").onclick = () => $<HTMLInputElement>("zip-input").click();
$<HTMLInputElement>("zip-input").onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    const fs = fromZip(new Uint8Array(await file.arrayBuffer()));
    $<HTMLDialogElement>("projects-dlg").close();
    await createProject(file.name.replace(/\.zip$/i, ""), fs);
    setStatus(`Importado: ${fs.length} archivos.`);
  } catch (err) {
    alert(`No se pudo leer el ZIP: ${err instanceof Error ? err.message : err}`);
  }
};
$("import-files").onclick = () => $<HTMLInputElement>("import-input").click();
$<HTMLInputElement>("import-input").onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  const list = [...(input.files ?? [])];
  input.value = "";
  if (!list.length) return;
  const fs: StoredFile[] = [];
  for (const f of list) fs.push(await readUpload(f, f.name));
  const main = guessMain(fs);
  $<HTMLDialogElement>("projects-dlg").close();
  await createProject(basename(main).replace(/\.tex$/, "") || "Proyecto importado", fs);
};

// ---------- Ajustes ----------

function openSettings() {
  $<HTMLSelectElement>("set-theme").value = settings.theme;
  $<HTMLSelectElement>("set-font").value = String(settings.font);
  $<HTMLInputElement>("set-spell").checked = settings.spell;
  $<HTMLInputElement>("set-wrap").checked = settings.wrap;
  $<HTMLInputElement>("set-pdfdark").checked = settings.pdfDark;
  $<HTMLSelectElement>("set-delay").value = String(settings.delay);
  $<HTMLInputElement>("set-lint").checked = settings.lint;
  $<HTMLInputElement>("set-math").checked = settings.mathPreview;
  $<HTMLInputElement>("set-toolbar").checked = settings.toolbar;
  $<HTMLInputElement>("set-draft").checked = settings.draft;
  $<HTMLSelectElement>("set-spell-lang").value = settings.spellLang;
  $<HTMLInputElement>("set-checks").checked = settings.projectChecks;
  $<HTMLSelectElement>("set-compiler").value = settings.compiler;
  $<HTMLInputElement>("set-shell").checked = settings.shellEscapeProjects.includes(meta.id);
  void refreshCompilerInfo();
  refreshMainSelect();
  $<HTMLDialogElement>("settings-dlg").showModal();
}
$("settings-btn").onclick = openSettings;
$("set-theme").onchange = (e) => {
  settings.theme = (e.target as HTMLSelectElement).value as Settings["theme"];
  applyTheme();
  saveSettings();
};
$("set-font").onchange = (e) => {
  settings.font = +(e.target as HTMLSelectElement).value;
  saveSettings();
  reconfigureAll();
};
$("set-spell").onchange = (e) => {
  settings.spell = (e.target as HTMLInputElement).checked;
  saveSettings();
  reconfigureAll();
};
$("set-wrap").onchange = (e) => {
  settings.wrap = (e.target as HTMLInputElement).checked;
  saveSettings();
  reconfigureAll();
};
$("set-pdfdark").onchange = (e) => {
  settings.pdfDark = (e.target as HTMLInputElement).checked;
  applyTheme();
  saveSettings();
};
$("set-delay").onchange = (e) => {
  settings.delay = +(e.target as HTMLSelectElement).value;
  saveSettings();
};
$("set-main").onchange = (e) => setMain((e.target as HTMLSelectElement).value);
$("set-lint").onchange = (e) => {
  settings.lint = (e.target as HTMLInputElement).checked;
  saveSettings();
  forceLinting(view);
};
$("set-math").onchange = (e) => {
  settings.mathPreview = (e.target as HTMLInputElement).checked;
  saveSettings();
  reconfigureAll();
};
$("set-toolbar").onchange = (e) => {
  settings.toolbar = (e.target as HTMLInputElement).checked;
  $("editor-toolbar").hidden = !settings.toolbar;
  saveSettings();
};
async function refreshCompilerInfo() {
  const sel = $<HTMLSelectElement>("set-compiler");
  const info = $("compiler-info");
  if (!desktop) {
    sel.disabled = true;
    info.textContent = "El TeX del sistema solo está disponible en la app de escritorio.";
    return;
  }
  const n = await desktop.nativeInfo().catch(() => ({ available: false }) as { available: boolean; version?: string });
  sel.querySelector<HTMLOptionElement>('option[value="system"]')!.disabled = !n.available;
  info.textContent = n.available
    ? `Detectado: ${n.version}. Úsalo si un paquete no funciona en el integrado o necesitas -shell-escape (minted, svg).`
    : "No se encontró MiKTeX ni TeX Live en este equipo.";
  if (!n.available && settings.compiler === "system") {
    settings.compiler = "builtin";
    sel.value = "builtin";
    saveSettings();
  }
}
$("set-compiler").onchange = (e) => {
  settings.compiler = (e.target as HTMLSelectElement).value as Settings["compiler"];
  saveSettings();
  updateCompilerBadge();
};
$("set-shell").onchange = (e) => {
  const on = (e.target as HTMLInputElement).checked;
  settings.shellEscapeProjects = settings.shellEscapeProjects.filter((id) => id !== meta.id);
  if (on) settings.shellEscapeProjects.push(meta.id);
  saveSettings();
};
function updateCompilerBadge() {
  $("sb-engine").textContent = desktop && settings.compiler === "system" ? "TeX del sistema" : "";
}
updateCompilerBadge();
$("set-checks").onchange = (e) => {
  settings.projectChecks = (e.target as HTMLInputElement).checked;
  saveSettings();
  runProjectChecks();
};
$("set-spell-lang").onchange = (e) => {
  settings.spellLang = (e.target as HTMLSelectElement).value;
  saveSettings();
  reconfigureAll();
};
$("set-draft").onchange = (e) => {
  settings.draft = (e.target as HTMLInputElement).checked;
  saveSettings();
};

// ---------- Paneles redimensionables ----------

const work = $("work");
function applyLayout() {
  work.style.setProperty("--side-w", `${settings.sideW}px`);
  work.style.setProperty("--ed-frac", String(settings.edFrac));
}
applyLayout();
document.querySelectorAll<HTMLElement>(".resizer").forEach((r) => {
  r.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    r.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const which = r.dataset.resize;
    const move = (ev: PointerEvent) => {
      const box = work.getBoundingClientRect();
      if (which === "side") {
        settings.sideW = Math.round(Math.min(480, Math.max(0, ev.clientX - box.left)));
        if (settings.sideW < 80) settings.sideW = 0; // se colapsa
      } else {
        const start = box.left + settings.sideW + 4;
        const avail = box.width - settings.sideW - 8;
        settings.edFrac = Math.min(0.85, Math.max(0.15, (ev.clientX - start) / avail));
      }
      applyLayout();
    };
    const up = () => {
      r.removeEventListener("pointermove", move);
      document.body.classList.remove("resizing");
      saveSettings();
    };
    r.addEventListener("pointermove", move);
    r.addEventListener("pointerup", up, { once: true });
  });
  r.addEventListener("dblclick", () => {
    if (r.dataset.resize === "side") settings.sideW = settings.sideW ? 0 : 240;
    else settings.edFrac = 0.5;
    applyLayout();
    saveSettings();
  });
});

// ---------- PDF en otra ventana ----------

const pdfChannel = new BroadcastChannel("folio-pdf");
const pdfName = () => `${basename(meta.main).replace(/\.tex$/, "")}.pdf`;
const postPdf = () => lastPdf && pdfChannel.postMessage({ type: "pdf", pdf: lastPdf, name: pdfName() } satisfies PdfMessage);
const postTheme = () =>
  pdfChannel.postMessage({
    type: "theme",
    theme: settings.theme === "system" ? null : settings.theme,
    pdfDark: settings.pdfDark,
  } satisfies PdfMessage);

themeHook = postTheme;

pdfChannel.onmessage = (ev: MessageEvent<PdfMessage>) => {
  const m = ev.data;
  if (m.type === "hello") {
    postTheme();
    postPdf();
  } else if (m.type === "link") {
    viewer.onExternalLink?.(m.url);
  } else if (m.type === "inverse") {
    if (!sync) return setStatus("Compila de nuevo para activar la sincronización.");
    const hit = inverse(sync, m.page, m.x, m.y);
    if (hit && findFile(hit.file)) {
      openFile(hit.file, hit.line);
      window.focus();
    }
  }
};

async function openPdfWindow() {
  if (desktop) await desktop.openWindow("pdf.html");
  else window.open("/pdf.html", "folio-pdf", "popup,width=900,height=1000");
}

// ---------- Referencias por DOI ----------

/** Elige el .bib del proyecto: el que cite el documento o el primero; si no hay, lo crea. */
function targetBib(): { file: StoredFile; created: boolean } {
  const bibs = files.filter((f) => f.path.endsWith(".bib") && f.text !== undefined);
  const tex = orderedTexFiles(files, meta.main)
    .map((f) => f.text ?? "")
    .join("\n");
  for (const m of tex.matchAll(/\\(?:addbibresource|bibliography)\{([^}]+)\}/g)) {
    for (const name of m[1].split(",").map((s) => s.trim())) {
      const hit = bibs.find((b) => b.path === name || b.path === `${name}.bib` || b.path.endsWith(`/${name}`) || b.path.endsWith(`/${name}.bib`));
      if (hit) return { file: hit, created: false };
    }
  }
  if (bibs[0]) return { file: bibs[0], created: false };
  // se crea solo en memoria; se añade al proyecto cuando la descarga funcione
  return { file: { path: "referencias.bib", text: "" }, created: true };
}

async function addReferenceByDoi() {
  const input = await ask("DOI o enlace del artículo (p. ej. 10.1103/PhysRev.47.777):");
  if (!input) return;
  const doi = parseDoi(input);
  if (!doi) return void alert("No reconozco un DOI en ese texto. Debe empezar por 10.");
  const pid = meta.id;
  const editing = current;
  const docBefore = view.state.doc;
  const posBefore = view.state.selection.main.head;
  setStatus(`Buscando ${doi}…`);
  try {
    const { file, created } = targetBib();
    let key = findByDoi(file.text ?? "", doi);
    if (!key) {
      let entry = await fetchBibtex(doi);
      if (pid !== meta.id) return; // cambiaste de proyecto durante la descarga
      key = bibKey(entry) ?? `ref${Date.now()}`;
      // evita claves repetidas con otras entradas
      const existing = new Set(extractBibEntries([file.text ?? ""]).map((e) => e.key));
      let unique = key;
      for (let i = 0; existing.has(unique); i++) unique = key + String.fromCharCode(97 + i);
      if (unique !== key) entry = renameKey(entry, unique);
      key = unique;
      if (created && !findFile(file.path)) files.push(file);
      const sep = file.text && !file.text.endsWith("\n\n") ? (file.text.endsWith("\n") ? "\n" : "\n\n") : "";
      file.text = (file.text ?? "") + sep + entry;
      states.delete(file.path);
      if (current === file.path) openFile(file.path);
      persist(file, 0);
      renderTree();
    }
    if (pid === meta.id && editing === current && isTexLike(current)) {
      // si el documento cambió mientras se descargaba, se usa la posición actual del cursor
      const pos = view.state.doc === docBefore ? posBefore : view.state.selection.main.head;
      const ins = `\\cite{${key}}`;
      view.dispatch({ changes: { from: pos, insert: ins }, selection: { anchor: pos + ins.length } });
      view.focus();
    }
    setStatus(
      created
        ? `Referencia «${key}» añadida a referencias.bib. Añade \\bibliography{referencias} (o \\addbibresource{referencias.bib}) al documento.`
        : `Referencia «${key}» añadida a ${file.path}.`,
    );
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), "error");
  }
}

// ---------- Cambios hechos fuera de Folio (Google Drive, VS Code, Git...) ----------

let diskSigs = new Map<string, string>();
let diskReady = false; // la referencia inicial se toma al abrir el proyecto
let watching = false;

/** Los archivos de Windows pueden traer \r\n; el editor siempre trabaja con \n. */
const normEol = (s: string) => s.replace(/\r\n?/g, "\n");

const sameContent = (a: StoredFile, b: StoredFile) => {
  if (a.text !== undefined || b.text !== undefined)
    return a.text !== undefined && b.text !== undefined && (a.encoding ?? "") === (b.encoding ?? "") && normEol(a.text) === normEol(b.text);
  const x = a.data ?? new Uint8Array();
  const y = b.data ?? new Uint8Array();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** Compara el disco con lo que hay en memoria y aplica los cambios externos. */
async function checkExternalChanges() {
  if (!desktop || watching || !meta || !diskReady) return;
  watching = true;
  const pid = meta.id;
  try {
    const list = await desktop.manifest(pid);
    if (pid !== meta.id) return;
    const next = new Map(list.map((f) => [f.path, `${f.size}:${f.mtime}`]));
    const prev = diskSigs;
    diskSigs = next;

    const touched = [...next.keys()].filter((p) => prev.get(p) !== next.get(p));
    const removed = [...prev.keys()].filter((p) => !next.has(p));
    const updated: string[] = [];
    let snapshotted = false;

    for (const p of touched) {
      const disk = await desktop.readFile(pid, p).catch(() => null);
      if (pid !== meta.id) return; // cambiaste de proyecto mientras tanto
      if (!disk) {
        diskSigs.delete(p); // no se pudo leer (p. ej. bloqueado): se reintenta luego
        continue;
      }
      const local = findFile(p);
      if (local && sameContent(local, disk)) continue;
      const own = ownWrites.get(ownKey(pid, p));
      if (own && sameContent(own, disk)) continue; // es un guardado nuestro anterior

      if (local && pending.has(p)) {
        // hay cambios tuyos sin guardar en ese mismo archivo
        const takeDisk = confirm(
          `${p} se modificó fuera de Folio mientras lo editabas.\n\nAceptar: cargar la versión del disco (la tuya queda en el historial).\nCancelar: conservar la tuya y sobrescribir el disco.`,
        );
        if (!takeDisk) {
          persist(local, 0);
          continue;
        }
        window.clearTimeout(pending.get(p));
        pending.delete(p);
        markSaving(-1);
      }
      if (local?.text !== undefined && !snapshotted) {
        // por si acaso: guarda el estado actual antes de sustituirlo
        snapshotted = true;
        await backend.addSnapshot(pid, { id: newId(), time: Date.now(), label: "Antes de cambios externos", files: textFiles() });
        if (pid !== meta.id) return;
      }
      applyExternal(disk);
      updated.push(p);
    }

    if (pid !== meta.id) return;
    for (const p of removed) {
      if (!findFile(p) || pending.has(p) || p === meta.main) continue;
      files = files.filter((f) => f.path !== p);
      states.delete(p);
      updated.push(p);
      if (current === p) {
        current = null;
        openFile(meta.main);
      }
    }

    if (updated.length) {
      renderTree();
      scheduleIndex();
      setStatus(
        updated.length === 1 ? `${updated[0]} cambió fuera de Folio y se actualizó.` : `${updated.length} archivos cambiaron fuera de Folio y se actualizaron.`,
      );
      if (settings.auto) {
        window.clearTimeout(autoTimer);
        autoTimer = window.setTimeout(() => void compile(true), settings.delay);
      }
    }
  } catch {
    /* sin conexión con el servidor local: se reintenta en la siguiente vuelta */
  } finally {
    watching = false;
  }
}

function applyExternal(disk: StoredFile) {
  if (disk.text !== undefined) disk = { ...disk, text: normEol(disk.text) };
  const local = findFile(disk.path);
  if (!local) {
    files.push(disk);
    return;
  }
  local.text = disk.text;
  local.data = disk.data;
  local.encoding = disk.encoding;
  if (current === disk.path && disk.text !== undefined) {
    // sustituye el contenido conservando la posición del cursor y el deshacer
    const head = Math.min(view.state.selection.main.head, disk.text.length);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: disk.text },
      selection: { anchor: head },
      annotations: externalChange.of(true),
    });
  } else {
    states.delete(disk.path);
    if (current === disk.path) openFile(disk.path);
  }
}

if (desktop) {
  window.setInterval(() => {
    if (document.visibilityState === "visible") void checkExternalChanges();
  }, 2000);
  window.addEventListener("focus", () => void checkExternalChanges());
}

// ---------- Escritorio ----------

if (desktop) {
  const b = $("open-folder");
  b.hidden = false;
  b.onclick = async () => {
    const m = await desktop!.openFolder();
    if (!m) return;
    $<HTMLDialogElement>("projects-dlg").close();
    await openProject(m.id);
  };
  const reveal = $("reveal");
  reveal.hidden = false;
  reveal.onclick = () => void desktop!.reveal(meta.id);
}

// ---------- Inicio ----------

document.querySelectorAll<HTMLElement>("[data-icon]").forEach((e) => {
  e.innerHTML = icon(e.dataset.icon ?? "file");
});

void (async () => {
  await migrateLegacy();
  const list = await backend.listProjects();
  if (!list.length) await createProject("Mi primer proyecto", structuredClone(TEMPLATES.article.files));
  else await openProject(settings.last && list.some((p) => p.id === settings.last) ? settings.last : list[0].id);
  // precarga el motor sin bloquear la interfaz
  setTimeout(warmUp, 800);
})();
