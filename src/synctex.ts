// Lector mínimo de SyncTeX: relaciona posiciones del PDF con archivo y línea.
// Formato: https://github.com/jlaurens/synctex (synctex_parser.c)

export type SyncBox = {
  file: string;
  line: number;
  page: number;
  // en puntos PDF (bp), origen arriba a la izquierda
  x: number;
  y: number; // línea base
  w: number;
  h: number;
  d: number;
};

export type SyncData = { boxes: SyncBox[]; files: string[] };

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

export async function parseSynctex(gz: Uint8Array, knownFiles: string[]): Promise<SyncData> {
  const text = await gunzip(gz);
  const inputs = new Map<number, string>();
  const boxes: SyncBox[] = [];
  let unit = 1;
  let xoff = 0;
  let yoff = 0;
  let mag = 1000;
  let page = 0;

  const resolve = (raw: string) => {
    // el TeX del sistema en Windows escribe C:\…\cap\intro.tex y termina las líneas en \r\n
    const clean = raw.replace(/\r$/, "").replace(/\\/g, "/").replace(/\/\.\//g, "/").replace(/^\.\//, "");
    return (
      knownFiles.find((k) => clean === k || clean.endsWith("/" + k)) ?? clean
    );
  };

  // sp -> bp
  let scale = 1;
  const conv = () => (scale = (unit * mag) / 1000 / 65536 * (72 / 72.27));

  // split por \n y sin el \r final: con \r\n (TeX del sistema en Windows), "Input:…$" no coincidía
  for (const line of text.split("\n").map((l) => l.replace(/\r$/, ""))) {
    if (!line) continue;
    const c = line[0];
    if (c === "I" && line.startsWith("Input:")) {
      const m = /^Input:(\d+):(.*)$/.exec(line);
      if (m) inputs.set(+m[1], resolve(m[2]));
      continue;
    }
    if (line.startsWith("Unit:")) { unit = +line.slice(5); conv(); continue; }
    if (line.startsWith("Magnification:")) { mag = +line.slice(14); conv(); continue; }
    if (line.startsWith("X Offset:")) { xoff = +line.slice(9); continue; }
    if (line.startsWith("Y Offset:")) { yoff = +line.slice(9); continue; }
    if (c === "{") { page = +line.slice(1); continue; }
    if (c === "[" || c === "(" || c === "h" || c === "v" || c === "x" || c === "k" || c === "g" || c === "$") {
      // T tag,line(,col)?:x,y(:w,h,d)?
      const m = /^.(\d+),(\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+),(-?\d+),(-?\d+))?/.exec(line);
      if (!m) continue;
      const file = inputs.get(+m[1]);
      if (!file) continue;
      boxes.push({
        file,
        line: +m[2],
        page,
        x: (+m[3] + xoff) * scale,
        y: (+m[4] + yoff) * scale,
        w: m[5] ? Math.abs(+m[5]) * scale : 0,
        h: m[6] ? +m[6] * scale : 0,
        d: m[7] ? +m[7] * scale : 0,
      });
    }
  }
  if (scale === 1) conv();
  return { boxes, files: [...new Set(inputs.values())] };
}

/** Del código al PDF: devuelve dónde aparece una línea de un archivo. */
export function forward(data: SyncData, file: string, line: number) {
  const inFile = data.boxes.filter((b) => b.file === file);
  if (!inFile.length) return null;
  // la línea exacta o la más cercana por encima/abajo
  let best = Infinity;
  for (const b of inFile) best = Math.min(best, Math.abs(b.line - line) + (b.line < line ? 0.5 : 0));
  const hits = inFile.filter((b) => Math.abs(b.line - line) + (b.line < line ? 0.5 : 0) === best);
  const page = hits[0].page;
  const same = hits.filter((b) => b.page === page);
  const top = Math.min(...same.map((b) => b.y - (b.h || 10)));
  const bottom = Math.max(...same.map((b) => b.y + b.d));
  const left = Math.min(...same.map((b) => b.x));
  const right = Math.max(...same.map((b) => b.x + b.w));
  return { page, top, bottom, left, right: right > left ? right : left + 40 };
}

/** Del PDF al código: qué archivo y línea generó el punto (x, y) de una página. */
export function inverse(data: SyncData, page: number, x: number, y: number) {
  let best: SyncBox | null = null;
  let bestScore = Infinity;
  for (const b of data.boxes) {
    if (b.page !== page) continue;
    const top = b.y - b.h;
    const bottom = b.y + b.d;
    const inside = x >= b.x && x <= b.x + b.w && y >= top && y <= bottom;
    // preferir la caja más pequeña que contenga el punto; si no, la más cercana
    const dx = x < b.x ? b.x - x : x > b.x + b.w ? x - b.x - b.w : 0;
    const dy = y < top ? top - y : y > bottom ? y - bottom : 0;
    const score = inside ? (b.w * (b.h + b.d)) / 1e6 : 1000 + dy * 4 + dx;
    if (score < bestScore) {
      bestScore = score;
      best = b;
    }
  }
  return best ? { file: best.file, line: best.line } : null;
}
