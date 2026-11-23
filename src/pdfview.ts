// Visor de PDF propio con pdf.js: zoom, páginas perezosas, conserva la posición
// entre compilaciones y permite saltar al código con doble clic (SyncTeX).

import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Doc = Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;
type TextContent = Awaited<ReturnType<Awaited<ReturnType<Doc["getPage"]>>["getTextContent"]>>;

export type Zoom = number | "width" | "page";
export type FindHit = { page: number; start: number; end: number };

export class PdfViewer {
  private doc: Doc | null = null;
  private task: ReturnType<typeof pdfjs.getDocument> | null = null;
  private pages: { el: HTMLDivElement; w: number; h: number; rendered: number; textDivs?: HTMLElement[] }[] = [];
  private zoom: Zoom = "width";
  private scale = 1;
  private io: IntersectionObserver;
  private renderToken = 0;
  /** Texto de cada página (para buscar), calculado bajo demanda. */
  private texts = new Map<number, { str: string; offsets: number[] }>();
  private textContents = new Map<number, TextContent>();
  onDblClick: ((page: number, x: number, y: number) => void) | null = null;
  onChange: (() => void) | null = null;
  /** Enlace externo (URL) pulsado en el PDF. */
  onExternalLink: ((url: string) => void) | null = null;

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

  /** Sube con cada load()/clear(): una carga que termina tarde y ya no es la última se descarta. */
  private loadGen = 0;

  async load(data: Uint8Array) {
    const gen = ++this.loadGen;
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
    if (gen !== this.loadGen) {
      void task.destroy(); // llegó otro PDF (o se cambió de proyecto) mientras cargaba
      return;
    }
    const old = this.task;
    this.doc = doc;
    this.task = task;
    this.texts.clear();
    this.textContents.clear();
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

  private rendering = new Map<number, Promise<void>>();

  private renderPage(n: number): Promise<void> {
    const p = this.pages[n - 1];
    if (!p || !this.doc) return Promise.resolve();
    if (p.rendered === this.scale) return this.rendering.get(n) ?? Promise.resolve();
    p.rendered = this.scale;
    const job = this.doRender(n, p);
    this.rendering.set(n, job);
    return job;
  }

  private async doRender(n: number, p: PdfViewer["pages"][number]) {
    const token = this.renderToken;
    const doc = this.doc!;
    const scale = this.scale;
    const page = await doc.getPage(n);
    const dpr = window.devicePixelRatio || 1;
    const vp = page.getViewport({ scale: scale * dpr });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    await page.render({ canvas, viewport: vp }).promise;
    if (token !== this.renderToken || doc !== this.doc) return; // ya cambió el zoom o el documento
    p.el.querySelector("canvas")?.remove();
    p.el.prepend(canvas);

    // capa de texto: permite seleccionar, copiar y resaltar búsquedas
    const cssVp = page.getViewport({ scale });
    p.el.querySelector(".textLayer")?.remove();
    p.el.querySelector(".linkLayer")?.remove();
    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    textLayer.style.setProperty("--total-scale-factor", String(scale));
    p.el.append(textLayer);
    try {
      const tl = new pdfjs.TextLayer({ textContentSource: await this.textContent(n), container: textLayer, viewport: cssVp });
      await tl.render();
      if (token !== this.renderToken || doc !== this.doc) return;
      p.textDivs = tl.textDivs;
    } catch {
      /* sin capa de texto: el PDF se sigue viendo */
    }

    // enlaces: índice, \ref, \cite (internos) y URLs (externos)
    try {
      const annots = await page.getAnnotations({ intent: "display" });
      const links = annots.filter((a: { subtype: string }) => a.subtype === "Link");
      if (links.length && token === this.renderToken && doc === this.doc) {
        const layer = document.createElement("div");
        layer.className = "linkLayer";
        for (const a of links as { rect: number[]; url?: string; dest?: unknown }[]) {
          const [x1, y1] = cssVp.convertToViewportPoint(a.rect[0], a.rect[1]);
          const [x2, y2] = cssVp.convertToViewportPoint(a.rect[2], a.rect[3]);
          const link = document.createElement("a");
          link.className = "pdf-link";
          Object.assign(link.style, {
            left: `${Math.min(x1, x2)}px`,
            top: `${Math.min(y1, y2)}px`,
            width: `${Math.abs(x2 - x1)}px`,
            height: `${Math.abs(y2 - y1)}px`,
          });
          // nunca se pone href: así no se puede abrir con clic central, menú contextual ni
          // arrastrando; y solo se aceptan enlaces web o de correo (no javascript:, file:…)
          link.setAttribute("role", "link");
          link.addEventListener("auxclick", (e) => e.preventDefault());
          const url = a.url;
          if (url && /^(https?:|mailto:)/i.test(url)) {
            link.title = url;
            link.onclick = (e) => {
              e.preventDefault();
              this.onExternalLink?.(url);
            };
          } else if (a.dest) {
            link.onclick = (e) => {
              e.preventDefault();
              void this.goToDest(a.dest);
            };
          } else continue;
          layer.append(link);
        }
        p.el.append(layer);
      }
    } catch {
      /* sin enlaces */
    }
  }

  private async textContent(n: number) {
    let tc = this.textContents.get(n);
    if (!tc) {
      tc = await (await this.doc!.getPage(n)).getTextContent();
      this.textContents.set(n, tc);
    }
    return tc;
  }

  /** Salta a un destino interno del PDF (lo que generan hyperref, el índice y las citas). */
  private async goToDest(dest: unknown) {
    const doc = this.doc;
    if (!doc) return;
    const explicit = (typeof dest === "string" ? await doc.getDestination(dest) : dest) as unknown[] | null;
    if (!explicit?.length) return;
    const ref = explicit[0];
    const index = typeof ref === "number" ? ref : await doc.getPageIndex(ref as Parameters<Doc["getPageIndex"]>[0]);
    const p = this.pages[index];
    if (!p) return;
    // [ref, {name: "XYZ"}, left, top, zoom]: top en puntos desde abajo
    const kind = (explicit[1] as { name?: string })?.name;
    const top = kind === "XYZ" && typeof explicit[3] === "number" ? (explicit[3] as number) : kind === "FitH" && typeof explicit[2] === "number" ? (explicit[2] as number) : p.h;
    this.root.scrollTo({ top: p.el.offsetTop + (p.h - top) * this.scale - 12, behavior: "smooth" });
  }

  // ---------- Búsqueda ----------

  private async pageText(n: number) {
    let t = this.texts.get(n);
    if (!t) {
      const tc = await this.textContent(n);
      const offsets: number[] = [];
      let str = "";
      for (const it of tc.items as { str?: string; hasEOL?: boolean }[]) {
        offsets.push(str.length);
        str += (it.str ?? "") + (it.hasEOL ? " " : "");
      }
      t = { str: str.toLowerCase(), offsets };
      this.texts.set(n, t);
    }
    return t;
  }

  /** Todas las apariciones de `query` (sin distinguir mayúsculas) en el documento. */
  async find(query: string): Promise<FindHit[]> {
    const q = query.trim().toLowerCase();
    if (!q || !this.doc) return [];
    const hits: FindHit[] = [];
    for (let n = 1; n <= this.pages.length; n++) {
      const { str } = await this.pageText(n);
      for (let i = str.indexOf(q); i >= 0; i = str.indexOf(q, i + q.length)) hits.push({ page: n, start: i, end: i + q.length });
    }
    return hits;
  }

  /** Muestra y resalta una aparición encontrada con find(). */
  async showHit(hit: FindHit, all: FindHit[]) {
    const p = this.pages[hit.page - 1];
    if (!p) return;
    this.root.querySelectorAll(".find-hit").forEach((e) => e.classList.remove("find-hit", "find-current"));
    p.el.scrollIntoView({ block: "nearest" });
    await this.renderPage(hit.page);
    const { offsets } = await this.pageText(hit.page);
    const spansFor = (h: FindHit) => {
      const out: HTMLElement[] = [];
      offsets.forEach((start, i) => {
        const end = offsets[i + 1] ?? Infinity;
        if (start < h.end && end > h.start && p.textDivs?.[i]) out.push(p.textDivs[i]);
      });
      return out;
    };
    for (const h of all.filter((x) => x.page === hit.page)) spansFor(h).forEach((s) => s.classList.add("find-hit"));
    const cur = spansFor(hit);
    cur.forEach((s) => s.classList.add("find-current"));
    cur[0]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  clearFind() {
    this.root.querySelectorAll(".find-hit").forEach((e) => e.classList.remove("find-hit", "find-current"));
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
    this.loadGen++;
    this.io.disconnect();
    this.root.replaceChildren();
    this.pages = [];
    this.texts.clear();
    this.textContents.clear();
    void this.task?.destroy();
    this.task = null;
    this.doc = null;
  }
}
