// Visor de PDF propio con pdf.js: zoom, páginas perezosas, conserva la posición
// entre compilaciones y permite saltar al código con doble clic (SyncTeX).

import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Doc = Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;

export type Zoom = number | "width" | "page";

export class PdfViewer {
  private doc: Doc | null = null;
  private task: ReturnType<typeof pdfjs.getDocument> | null = null;
  private pages: { el: HTMLDivElement; w: number; h: number; rendered: number }[] = [];
  private zoom: Zoom = "width";
  private scale = 1;
  private io: IntersectionObserver;
  private renderToken = 0;
  onDblClick: ((page: number, x: number, y: number) => void) | null = null;
  onChange: (() => void) | null = null;

  constructor(private root: HTMLElement) {
    this.io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) void this.renderPage(+((e.target as HTMLElement).dataset.page ?? 1));
        }
      },
      { root, rootMargin: "600px 0px" },
    );
    new ResizeObserver(() => {
      if (typeof this.zoom === "string") this.relayout();
    }).observe(root);
    root.addEventListener("scroll", () => this.onChange?.(), { passive: true });
    root.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        this.setZoom(this.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      },
      { passive: false },
    );
  }

  get pageCount() {
    return this.pages.length;
  }

  get currentScale() {
    return this.scale;
  }

  /** Página visible en el centro del visor. */
  get currentPage() {
    const mid = this.root.scrollTop + this.root.clientHeight / 3;
    for (let i = 0; i < this.pages.length; i++) {
      const el = this.pages[i].el;
      if (el.offsetTop + el.offsetHeight > mid) return i + 1;
    }
    return this.pages.length;
  }

  async load(data: Uint8Array) {
    // conserva la posición relativa al reemplazar el documento
    const prevPage = this.currentPage;
    const prevEl = this.pages[prevPage - 1]?.el;
    const within = prevEl ? (this.root.scrollTop - prevEl.offsetTop) / prevEl.offsetHeight : 0;

    const task = pdfjs.getDocument({ data: data.slice() });
    const doc = await task.promise;
    const sizes = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
      sizes.push({ w: vp.width, h: vp.height });
    }
    const old = this.task;
    this.doc = doc;
    this.task = task;
    this.io.disconnect();
    this.root.replaceChildren();
    this.pages = sizes.map((s, i) => {
      const el = document.createElement("div");
      el.className = "pdf-page";
      el.dataset.page = String(i + 1);
      el.addEventListener("dblclick", (e) => {
        const r = el.getBoundingClientRect();
        this.onDblClick?.(i + 1, (e.clientX - r.left) / this.scale, (e.clientY - r.top) / this.scale);
      });
      this.root.append(el);
      return { el, ...s, rendered: 0 };
    });
    this.relayout();
    const target = this.pages[Math.min(prevPage, this.pages.length) - 1]?.el;
    if (target) this.root.scrollTop = target.offsetTop + within * target.offsetHeight;
    void old?.destroy();
    this.onChange?.();
  }

  setZoom(z: Zoom) {
    if (typeof z === "number") z = Math.min(5, Math.max(0.25, z));
    const page = this.currentPage;
    const el = this.pages[page - 1]?.el;
    const within = el ? (this.root.scrollTop - el.offsetTop) / el.offsetHeight : 0;
    this.zoom = z;
    this.relayout();
    const el2 = this.pages[page - 1]?.el;
    if (el2) this.root.scrollTop = el2.offsetTop + within * el2.offsetHeight;
    this.onChange?.();
  }

  private computeScale() {
    if (!this.pages.length) return 1;
    const w = Math.max(...this.pages.map((p) => p.w));
    const h = Math.max(...this.pages.map((p) => p.h));
    const availW = this.root.clientWidth - 32;
    const availH = this.root.clientHeight - 32;
    if (this.zoom === "width") return Math.max(0.25, availW / w);
    if (this.zoom === "page") return Math.max(0.25, Math.min(availW / w, availH / h));
    return this.zoom;
  }

  private relayout() {
    const s = this.computeScale();
    if (Math.abs(s - this.scale) < 0.001 && this.pages.every((p) => p.el.style.width)) return;
    this.scale = s;
    this.renderToken++;
    for (const p of this.pages) {
      p.el.style.width = `${Math.floor(p.w * s)}px`;
      p.el.style.height = `${Math.floor(p.h * s)}px`;
      p.rendered = 0;
      this.io.unobserve(p.el);
      this.io.observe(p.el);
    }
  }

  private async renderPage(n: number) {
    const p = this.pages[n - 1];
    if (!p || !this.doc || p.rendered === this.scale) return;
    p.rendered = this.scale;
    const token = this.renderToken;
    const doc = this.doc;
    const page = await doc.getPage(n);
    const dpr = window.devicePixelRatio || 1;
    const vp = page.getViewport({ scale: this.scale * dpr });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    await page.render({ canvas, viewport: vp }).promise;
    if (token !== this.renderToken || doc !== this.doc) return; // ya cambió el zoom o el documento
    p.el.querySelector("canvas")?.remove();
    p.el.prepend(canvas);
  }

  /** Desplaza hasta una zona (en puntos PDF) y la resalta un momento. */
  reveal(page: number, top: number, bottom: number, left: number, right: number) {
    const p = this.pages[page - 1];
    if (!p) return;
    const s = this.scale;
    this.root.scrollTo({
      top: p.el.offsetTop + top * s - this.root.clientHeight / 3,
      behavior: "smooth",
    });
    const mark = document.createElement("div");
    mark.className = "sync-mark";
    Object.assign(mark.style, {
      top: `${top * s - 2}px`,
      left: `${left * s - 4}px`,
      width: `${(right - left) * s + 8}px`,
      height: `${Math.max(12, (bottom - top) * s + 4)}px`,
    });
    p.el.append(mark);
    window.setTimeout(() => mark.remove(), 1600);
  }

  clear() {
    this.io.disconnect();
    this.root.replaceChildren();
    this.pages = [];
    void this.task?.destroy();
    this.task = null;
    this.doc = null;
  }
}
