// Ventana aparte con solo el PDF (útil con dos monitores). Se comunica con la
// ventana principal por BroadcastChannel: recibe cada PDF nuevo y le devuelve los
// dobles clics para saltar al código (SyncTeX).

import "@fontsource-variable/inter";
import { PdfViewer, type Zoom } from "./pdfview";

export type PdfMessage =
  | { type: "hello" }
  | { type: "pdf"; pdf: Uint8Array; name: string }
  | { type: "reveal"; page: number; top: number; bottom: number; left: number; right: number }
  | { type: "inverse"; page: number; x: number; y: number }
  | { type: "theme"; theme: string | null; pdfDark: boolean };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const channel = new BroadcastChannel("folio-pdf");
const viewer = new PdfViewer($("pdf-root"));

let zoom: Zoom = "width";
const setZoom = (z: Zoom) => {
  zoom = z;
  viewer.setZoom(z);
};
viewer.onChange = () => {
  $("page-info").textContent = viewer.pageCount ? `Página ${viewer.currentPage} de ${viewer.pageCount}` : "";
};
viewer.onDblClick = (page, x, y) => channel.postMessage({ type: "inverse", page, x, y } satisfies PdfMessage);
$<HTMLSelectElement>("zoom").onchange = (e) => {
  const v = (e.target as HTMLSelectElement).value;
  setZoom(v === "width" || v === "page" ? v : +v);
};
$("zoom-in").onclick = () => setZoom(Math.round(viewer.currentScale * 1.2 * 100) / 100);
$("zoom-out").onclick = () => setZoom(Math.round((viewer.currentScale / 1.2) * 100) / 100);
setZoom(zoom);

channel.onmessage = async (ev: MessageEvent<PdfMessage>) => {
  const m = ev.data;
  if (m.type === "pdf") {
    $("empty").hidden = true;
    document.title = `${m.name} · Folio`;
    await viewer.load(m.pdf);
  } else if (m.type === "reveal") {
    viewer.reveal(m.page, m.top, m.bottom, m.left, m.right);
  } else if (m.type === "theme") {
    if (m.theme) document.documentElement.dataset.theme = m.theme;
    else delete document.documentElement.dataset.theme;
    document.documentElement.classList.toggle("pdf-dark", m.pdfDark);
  }
};
// pide el PDF actual al abrirse
channel.postMessage({ type: "hello" } satisfies PdfMessage);
