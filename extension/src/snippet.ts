// Conversión de las plantillas de autocompletado de la app a snippets de VS Code (sin vscode: se prueba en Node).

/**
 * Plantilla de CodeMirror (${} y ${nombre}) → snippet de VS Code (${1}, ${2:nombre}).
 * Los huecos con el mismo nombre comparten número (\begin{${env}} … \end{${env}}).
 */
export function toSnippet(tpl: string): string {
  const esc = (t: string) => t.replace(/[\\$}]/g, (c) => "\\" + c);
  const named = new Map<string, number>();
  let n = 0;
  let out = "";
  let last = 0;
  for (const m of tpl.matchAll(/\$\{([^}]*)\}/g)) {
    out += esc(tpl.slice(last, m.index));
    const name = m[1];
    let i = name ? named.get(name) : undefined;
    if (i === undefined) {
      i = ++n;
      if (name) named.set(name, i);
    }
    out += name ? `\${${i}:${esc(name)}}` : `\${${i}}`;
    last = m.index! + m[0].length;
  }
  return out + esc(tpl.slice(last));
}
