// Referencias por DOI: descarga la entrada BibTeX desde doi.org (Crossref/DataCite).

/** Acepta "10.1000/xyz", "doi:10.1000/xyz" o una URL https://doi.org/10.1000/xyz. */
export function parseDoi(input: string): string | null {
  let text = input.trim();
  try {
    text = decodeURIComponent(text);
  } catch {
    /* % sueltos: se usa el texto tal cual */
  }
  const m = /(10\.\d{4,9}\/[^\s"<>]+)/i.exec(text);
  return m ? m[1].replace(/[.,;]+$/, "") : null;
}

/** Codifica el DOI para la URL sin romper las barras (algunos DOI llevan # o ?). */
const doiPath = (doi: string) => doi.split("/").map(encodeURIComponent).join("/");

/** Cambia la clave de una entrada solo en su cabecera (@tipo{clave,). */
export const renameKey = (entry: string, key: string) => entry.replace(/^(\s*@\w+\s*\{\s*)[^,\s]+/, `$1${key}`);

export async function fetchBibtex(doi: string): Promise<string> {
  const urls = [
    [`https://doi.org/${doiPath(doi)}`, { Accept: "application/x-bibtex; charset=utf-8" }],
    [`https://api.crossref.org/works/${encodeURIComponent(doi)}/transform/application/x-bibtex`, {}],
  ] as const;
  let last = "";
  for (const [url, headers] of urls) {
    try {
      const r = await fetch(url, { headers });
      const text = (await r.text()).trim();
      if (r.ok && text.startsWith("@")) return tidy(text);
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`No se encontró el DOI ${doi} (${last}). Revisa que esté bien escrito y que haya conexión a internet.`);
}

/** Pone cada campo en su línea, como se suele escribir a mano. */
function tidy(bib: string) {
  if (bib.includes("\n  ")) return bib + "\n";
  return (
    bib
      .replace(/^(@\w+\{[^,]+,)\s*/, "$1\n  ")
      .replace(/,\s*(\w+)\s*=\s*/g, ",\n  $1 = ")
      .replace(/\s*\}\s*$/, "\n}") + "\n"
  );
}

export const bibKey = (entry: string) => /@\w+\s*\{\s*([^,\s]+)\s*,/.exec(entry)?.[1] ?? null;

/** Busca una entrada con el mismo DOI en el contenido de un .bib. */
export function findByDoi(bib: string, doi: string): string | null {
  const re = /@\w+\s*\{\s*([^,\s]+)\s*,([\s\S]*?)(?=\n\s*@|$)/g;
  for (const m of bib.matchAll(re)) {
    const d = /doi\s*=\s*[{"]\s*([^}"]+)/i.exec(m[2])?.[1];
    if (d && d.trim().toLowerCase() === doi.toLowerCase()) return m[1];
  }
  return null;
}
