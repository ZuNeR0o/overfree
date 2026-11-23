// Entornos LaTeX en texto plano (sin CodeMirror): qué \begin están abiertos en una
// posición, ignorando comentarios. Lo usan la edición estructural y la extensión de VS Code.

export const ENV_RE = /\\(begin|end)\s*\{([^}\n]*)\}/g;

/** Posición del % que inicia un comentario en la línea (con número par de \ antes), o -1. */
export function commentStart(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "%") continue;
    let bs = 0;
    for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) bs++;
    if (bs % 2 === 0) return i;
  }
  return -1;
}

/** Copia del texto con los comentarios sustituidos por espacios (mismas posiciones). */
export function maskComments(text: string): string {
  return text
    .split("\n")
    .map((l) => {
      const c = commentStart(l);
      return c < 0 ? l : l.slice(0, c) + " ".repeat(l.length - c);
    })
    .join("\n");
}

/** Busca el \end{name} que cierra un \begin{name} que termina en `from` (ignora comentarios). */
/** Entornos abiertos antes de `pos` (el último es el más interior), ignorando comentarios. */
export function openEnvsAt(rawText: string, pos: number): { name: string; end: number }[] {
  const text = maskComments(rawText.slice(0, pos));
  const stack: { name: string; end: number }[] = [];
  ENV_RE.lastIndex = Math.max(0, pos - 100_000);
  let m: RegExpExecArray | null;
  while ((m = ENV_RE.exec(text))) {
    if (m[1] === "begin") stack.push({ name: m[2], end: m.index + m[0].length });
    else {
      const i = stack.map((s) => s.name).lastIndexOf(m[2]);
      if (i >= 0) stack.length = i;
    }
  }
  return stack;
}
