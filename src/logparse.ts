// Interpreta el registro de LaTeX y extrae errores, avisos y cajas mal ajustadas
// con su archivo y línea, para marcarlos en el editor.

export type Level = "error" | "warning" | "info";
export type Problem = {
  level: Level;
  message: string;
  file: string | null;
  line: number | null;
  context?: string;
  /** Quién lo detectó (por defecto, el registro de LaTeX). */
  source?: string;
};

/** TeX corta las líneas a 79 caracteres; las une de nuevo. */
function unwrap(log: string) {
  const lines = log.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let buf = "";
  for (const l of lines) {
    buf += l;
    if (l.length !== 79) {
      out.push(buf);
      buf = "";
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** Traduce y explica los errores más frecuentes; deja el original entre paréntesis. */
function translate(msg: string): string {
  const rules: [RegExp, (m: RegExpExecArray) => string][] = [
    [/^Undefined control sequence (\\\S+)/, (m) => `Comando no definido: ${m[1]}. ¿Está mal escrito o falta cargar su paquete?`],
    [/^Undefined control sequence/, () => "Comando no definido. ¿Está mal escrito o falta cargar su paquete?"],
    [/^Missing \$ inserted/, () => "Falta un $: hay un símbolo matemático fuera del modo matemático."],
    [/^LaTeX Error: File `([^']+)' not found/, (m) => `No se encuentra el archivo ${m[1]}.`],
    [/^LaTeX Error: Environment (\S+) undefined/, (m) => `El entorno ${m[1]} no existe. ¿Falta cargar su paquete?`],
    [/^LaTeX Error: \\begin\{([^}]+)\} on input line (\d+) ended by \\end\{([^}]+)\}/, (m) => `\\begin{${m[1]}} (línea ${m[2]}) se cierra con \\end{${m[3]}}.`],
    [/^LaTeX Error: Missing \\begin\{document\}/, () => "Falta \\begin{document} o hay texto en el preámbulo."],
    [/^Misplaced alignment tab character &/, () => "Hay un & fuera de una tabla o entorno de alineación. Usa \\& para el símbolo."],
    [/^Extra \}, or forgotten/, () => "Sobra una } o falta su { de apertura."],
    [/^Missing \} inserted/, () => "Falta cerrar una llave }."],
    [/^Paragraph ended before (\S+) was complete/, (m) => `El argumento de ${m[1]} no se cerró antes del fin del párrafo (¿falta una }?).`],
    [/^File ended while scanning use of (\S+)/, (m) => `El archivo terminó sin cerrar el argumento de ${m[1]} (¿falta una }?).`],
    [/^LaTeX Error: Can be used only in preamble/, () => "Este comando solo se puede usar en el preámbulo."],
    [/^LaTeX Error: There's no line here to end/, () => "Hay un \\\\ donde no hay línea que terminar (p. ej. tras una línea en blanco)."],
    [/^Double superscript/, () => "Doble superíndice: usa llaves, p. ej. x^{a^b}."],
    [/^Double subscript/, () => "Doble subíndice: usa llaves, p. ej. x_{a_b}."],
  ];
  for (const [re, fn] of rules) {
    const m = re.exec(msg);
    if (m) return `${fn(m)} (${msg})`;
  }
  return msg;
}

const EXTS = "tex|sty|cls|bbl|aux|def|cfg|clo|ltx|fd|toc|lof|lot|out|ind|gls|nav|snm|vrb";
// (ruta) o, como hace MiKTeX con rutas que tienen espacios o paréntesis, ("ruta").
// Admite barras de Windows (C:\…\main.tex).
const FILE_RE = new RegExp(
  `\\(("[^"]+?\\.(?:${EXTS})"|(?:\\.{0,2}[\\/\\\\]|[A-Za-z]:|[\\/\\\\])?[^\\s()"{}]+?\\.(?:${EXTS}))(?=[\\s)]|$)`,
  "g",
);

/** Ruta del registro → forma comparable: sin comillas ni \r y con barras normales. */
const normPath = (raw: string) => raw.replace(/^"|"$/g, "").replace(/\r$/, "").replace(/\\/g, "/").replace(/\/\.\//g, "/").replace(/^\.\//, "");

export function parseLog(log: string, knownFiles: string[], mainFile = "main.tex"): Problem[] {
  const lines = unwrap(log);
  const problems: Problem[] = [];
  const seen = new Set<string>();
  const stack: string[] = [];

  const resolve = (raw: string | undefined): string | null => {
    if (!raw) return null;
    const clean = normPath(raw);
    const hit = knownFiles.find(
      (k) => clean === k || clean.endsWith("/" + k) || k.endsWith("/" + clean),
    );
    return hit ?? null;
  };
  const currentFile = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const f = resolve(stack[i]);
      if (f) return f;
    }
    return null;
  };
  const push = (p: Problem) => {
    const key = `${p.level}|${p.file}|${p.line}|${p.message}`;
    if (seen.has(key)) return; // el mismo error se repite en cada pasada
    seen.add(key);
    problems.push(p);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Errores: "! Mensaje" ... "l.123 contexto"
    if (line.startsWith("! ")) {
      let message = line.slice(2).trim();
      // mensajes de cierre que solo repiten que hubo un error
      if (/^(==> Fatal error|Emergency stop)/.test(message)) continue;
      let ln: number | null = null;
      let context: string | undefined;
      let prev = "";
      for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
        const m = /^l\.(\d+)\s?(.*)$/.exec(lines[j]);
        if (m) {
          ln = +m[1];
          context = m[2] || undefined;
          if (/^Undefined control sequence/.test(message)) {
            // el comando culpable es el último de la línea de contexto anterior a l.N
            const cs = [...(prev || m[2]).matchAll(/\\[A-Za-z@]+|\\./g)].pop()?.[0];
            if (cs) message = `Undefined control sequence ${cs}`;
          }
          break;
        }
        if (lines[j].trim()) prev = lines[j];
        if (j === i + 1 && lines[j] && !lines[j].startsWith("<") && !lines[j].startsWith("See ")) {
          // algunos mensajes siguen en la línea siguiente
          if (message.endsWith(".") === false && lines[j].length < 120) message += " " + lines[j].trim();
        }
      }
      push({ level: "error", message: translate(message), file: currentFile() ?? (knownFiles.includes(mainFile) ? mainFile : null), line: ln, context });
      continue;
    }

    // Errores estilo file:line:error
    const fle = /^(.*?\.tex):(\d+): (.*)$/.exec(line);
    if (fle) {
      push({ level: "error", message: fle[3], file: resolve(fle[1]), line: +fle[2] });
      continue;
    }

    // Avisos de LaTeX y de paquetes (pueden ocupar varias líneas)
    const w = /^(LaTeX|Package [\w-]+|Class [\w-]+|LaTeX Font|pdfTeX) Warning: (.*)$/.exec(line);
    // avisos que el usuario no puede resolver dentro del navegador
    if (/^Package epstopdf Warning: Shell escape/.test(line)) continue;
    if (w) {
      let message = w[2];
      let j = i + 1;
      const indent = /^\([\w-]+\)\s+/;
      while (j < lines.length && indent.test(lines[j])) {
        message += " " + lines[j].replace(indent, "");
        j++;
      }
      const lm = /on input line (\d+)/.exec(message);
      const level: Level = /Font/.test(w[1]) ? "info" : "warning";
      push({
        level,
        message: (w[1].startsWith("Package") ? `[${w[1].slice(8)}] ` : "") + message.replace(/\s+/g, " ").trim(),
        file: currentFile(),
        line: lm ? +lm[1] : null,
      });
      i = j - 1;
      continue;
    }

    // Cajas mal ajustadas
    const bb = /^(Overfull|Underfull) \\[hv]box (.*?)(?:in paragraph |in alignment |detected )?at lines? (\d+)/.exec(line);
    if (bb) {
      push({ level: "info", message: `${bb[1]} box ${bb[2].trim()}`, file: currentFile(), line: +bb[3] });
    }

    // Seguimiento de qué archivo está abierto según los paréntesis
    FILE_RE.lastIndex = 0;
    const opens: { idx: number; file: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = FILE_RE.exec(line))) opens.push({ idx: m.index, file: m[1] });
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (ch === "(") {
        const o = opens.find((x) => x.idx === k);
        stack.push(o ? o.file : "");
        // salta la ruta completa: sus paréntesis internos («Mecánica (prueba)») no cuentan
        if (o) k = o.idx + o.file.length;
      } else if (ch === ")") {
        stack.pop();
      }
    }
  }

  const order: Record<Level, number> = { error: 0, warning: 1, info: 2 };
  return problems.sort((a, b) => order[a.level] - order[b.level]);
}
