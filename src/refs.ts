// Índice de etiquetas y entradas bibliográficas del proyecto. Sin dependencias, para
// poder usarlo desde el autocompletado, la revisión del proyecto y la extensión de VS Code.

export function extractLabels(texts: string[]) {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(/\\label\{([^}]+)\}/g)) out.add(m[1]);
  return [...out];
}

export function extractBibEntries(bibs: string[]) {
  const out: { key: string; info: string }[] = [];
  for (const b of bibs) {
    for (const m of b.matchAll(/@(\w+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)(?=\n\s*@|$)/g)) {
      if (/^(comment|string|preamble)$/i.test(m[1])) continue;
      const title = /title\s*=\s*[{"]+([^}"]+)/i.exec(m[3])?.[1] ?? "";
      const year = /year\s*=\s*[{"]?(\d{4})/i.exec(m[3])?.[1] ?? "";
      out.push({ key: m[2], info: [title.slice(0, 60), year].filter(Boolean).join(" · ") });
    }
  }
  return out;
}
