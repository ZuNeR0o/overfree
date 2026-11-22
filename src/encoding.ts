// Archivos de texto que no están en UTF-8 (típicamente .tex o .bib antiguos guardados en
// Latin-1 / Windows-1252, con \usepackage[latin1]{inputenc}). Se editan como texto normal y
// se guardan y compilan de nuevo en su codificación original, para no romper los acentos.

export type TextEncodingName = "latin1";

// Windows-1252 coincide con Latin-1 salvo en 0x80–0x9F (comillas tipográficas, €, —, …).
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];
const REVERSE = new Map<number, number>(CP1252_HIGH.map((cp, i) => [cp, 0x80 + i]));

/** Decodifica bytes de un archivo de texto: UTF-8 si es válido; si no, Windows-1252. */
export function decodeText(bytes: Uint8Array): { text: string; encoding?: TextEncodingName } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    let text = "";
    for (const b of bytes) text += String.fromCharCode(b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b);
    return { text, encoding: "latin1" };
  }
}

/** Caracteres que no caben en Windows-1252 (para avisar antes de guardar). */
export function unencodable(text: string): string[] {
  const bad = new Set<string>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0xff && !REVERSE.has(cp)) bad.add(ch);
  }
  return [...bad];
}

/** Texto → bytes en su codificación. Lo que no cabe en Windows-1252 se escribe como «?». */
export function encodeText(text: string, encoding?: TextEncodingName): Uint8Array {
  if (encoding !== "latin1") return new TextEncoder().encode(text);
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    out.push(cp <= 0xff && !(cp >= 0x80 && cp <= 0x9f) ? cp : (REVERSE.get(cp) ?? 0x3f));
  }
  return Uint8Array.from(out);
}
