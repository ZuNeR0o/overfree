// Página del visor PDF dentro del webview. Reutiliza src/pdfview.ts de Folio tal cual.

import * as pdfjs from "pdfjs-dist";
import { PdfViewer, type FindHit, type Zoom } from "../../src/pdfview";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };
const vscode = acquireVsCodeApi();

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// Los webviews no pueden crear un Worker desde su URL de recursos (otro origen):
// se descarga el script y se arranca desde un blob.
const workerReady = (async () => {
  const url = (globalThis as { __FOLIO_PDF_WORKER__?: string }).__FOLIO_PDF_WORKER__ ?? "";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const code = await res.text();
  const blob = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  pdfjs.GlobalWorkerOptions.workerPort = new Worker(blob, { type: "module" });
})();

const root = $("pdf-root");
const viewer = new PdfViewer(root);
const zoomSel = $<HTMLSelectElement>("zoom");

// El visor no expone su modo de zoom: se lleva aquí ("width"/"page" o un número).
let zoom: Zoom = "width";
const setZoom = (z: Zoom) => {
  zoom = z;
  viewer.setZoom(z);
};
// Ctrl+rueda cambia el zoom dentro del visor: pasa a ser un número
root.addEventListener("wheel", (e) => e.ctrlKey && requestAnimationFrame(() => (zoom = viewer.currentScale)), { passive: true });

viewer.onChange = () => {
  $("page-info").textContent = viewer.pageCount ? `${viewer.currentPage} / ${viewer.pageCount}` : "";
  const opt = [...zoomSel.options].find((o) => !o.hidden && o.value === String(zoom));
  if (opt) zoomSel.value = opt.value;
  else {
    const custom = zoomSel.querySelector<HTMLOptionElement>('option[value="custom"]')!;
    custom.textContent = `${Math.round(viewer.currentScale * 100)} %`;
    zoomSel.value = "custom";
  }
};
viewer.onDblClick = (page, x, y) => vscode.postMessage({ type: "inverse", page, x, y });
viewer.onExternalLink = (url) => vscode.postMessage({ type: "link", url });

zoomSel.addEventListener("change", () => {
  const v = zoomSel.value;
  if (v !== "custom") setZoom(v === "width" || v === "page" ? v : Number(v));
});
const step = (factor: number) => setZoom(Math.min(5, Math.max(0.25, viewer.currentScale * factor)));
$("zoom-in").addEventListener("click", () => step(1.2));
$("zoom-out").addEventListener("click", () => step(1 / 1.2));

// ---------- Buscar ----------
const findInput = $<HTMLInputElement>("find");
let hits: FindHit[] = [];
let hitIndex = 0;
let findTimer = 0;
const showHit = () => {
  $("find-info").textContent = findInput.value ? (hits.length ? `${hitIndex + 1} / ${hits.length}` : "0") : "";
  if (hits.length) viewer.showHit(hits[hitIndex], hits);
  else viewer.clearFind();
};
findInput.addEventListener("input", () => {
  clearTimeout(findTimer);
  findTimer = window.setTimeout(async () => {
    hits = findInput.value.trim() ? await viewer.find(findInput.value) : [];
    hitIndex = 0;
    showHit();
  }, 200);
});
findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && hits.length) {
    hitIndex = (hitIndex + (e.shiftKey ? hits.length - 1 : 1)) % hits.length;
    showHit();
  } else if (e.key === "Escape") {
    findInput.value = "";
    hits = [];
    showHit();
  }
});
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    e.preventDefault();
    findInput.focus();
    findInput.select();
  }
});

// ---------- Mensajes de la extensión ----------
type ToWebview =
  | { type: "load"; data: Uint8Array }
  | { type: "reveal"; page: number; top: number; bottom: number; left: number; right: number };

// un «Ir al PDF» que llega mientras se carga el PDF espera a que termine
let loaded: Promise<void> = Promise.resolve();

async function load(data: Uint8Array) {
  try {
    await workerReady;
  } catch (e) {
    root.innerHTML = "";
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = `No se pudo iniciar pdf.js: ${e instanceof Error ? e.message : e}`;
    root.append(p);
    vscode.postMessage({ type: "error", message: p.textContent });
    return;
  }
  root.querySelector(".empty")?.remove();
  try {
    await viewer.load(data);
    vscode.postMessage({ type: "rendered", pages: viewer.pageCount });
  } catch (e) {
    vscode.postMessage({ type: "error", message: e instanceof Error ? e.message : String(e) });
    return;
  }
  if (findInput.value.trim()) {
    hits = await viewer.find(findInput.value);
    hitIndex = Math.min(hitIndex, Math.max(0, hits.length - 1));
    showHit();
  }
}

window.addEventListener("message", (ev: MessageEvent<ToWebview>) => {
  const m = ev.data;
  if (m.type === "load") loaded = loaded.then(() => load(m.data)).catch((e) => console.error("Folio:", e));
  else if (m.type === "reveal") void loaded.then(() => viewer.reveal(m.page, m.top, m.bottom, m.left, m.right));
});

vscode.postMessage({ type: "ready" });
