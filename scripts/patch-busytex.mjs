// Ajusta el pipeline de BusyTeX para que se comporte como Overleaf: ante errores
// normales (un comando mal escrito, etc.) TeX sigue y genera el PDF igualmente.
// Es idempotente: se puede ejecutar cada vez sin dañar nada.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const file = "public/core/busytex/busytex_pipeline.js";
if (!existsSync(file)) process.exit(0);

// los parches buscan texto con saltos LF: se normaliza por si el archivo trae CRLF
const before = readFileSync(file, "utf8");
let src = before.replace(/\r\n/g, "\n");

// 1. No detenerse en el primer error.
src = src.replaceAll("'--halt-on-error', ", "");
// 2. Un comando no definido no es un error fatal: TeX lo salta y continúa.
src = src.replace("'! Undefined control sequence.', ", "");

// 3. Pasadas extra solo si hacen falta. El original siempre hace al menos tres
//    (inicial + intermedia + final). Con los .aux de la compilación anterior
//    (Folio los conserva), lo normal es que la pasada inicial ya sea la definitiva.
const RERUN_ORIG = "const rerun_enabled = rerun === null ? true : rerun;";
const RERUN_NEW =
  "const rerun_enabled = (rerun === null ? true : rerun) && (bibtex || makeindex_active || (this._needs_rerun(last_log) && !this._folio_same_as_input(files, main_tex_path, logs, last_log))); /* folio:skip-passes */";
// actualiza la primera versión de este parche, si estaba aplicada
src = src.replace(
  "const rerun_enabled = (rerun === null ? true : rerun) && (bibtex || makeindex_active || this._needs_rerun(last_log)); /* folio:skip-passes */",
  RERUN_ORIG,
);
if (!src.includes("folio:skip-passes")) {
  src = src.replace(RERUN_ORIG, RERUN_NEW);
  // Como latexmk: "There were undefined references" no justifica otra pasada si el
  // .aux no cambió (la referencia sigue sin definir por mucho que se repita).
  src = src.replace(
    "if (!this._needs_rerun(last_log)) {",
    "if (!this._needs_rerun(last_log) || this._folio_aux_stable(logs, last_log)) {",
  );
  src = src.replace(
    "    _needs_rerun(log_text) {",
    `    _folio_strong_rerun(log_text) {
        return /Rerun to get|Rerun LaTeX|run LaTeX again/.test(log_text || '');
    }

    _folio_tex_logs(logs) {
        return logs.filter(e => !e.cmd.startsWith('bibtex') && !e.cmd.startsWith('makeindex') && !e.cmd.startsWith('xdvipdfmx') && !e.cmd.startsWith('biber'));
    }

    _folio_aux_stable(logs, log_text) {
        const tex = this._folio_tex_logs(logs);
        if (tex.length < 2 || this._folio_strong_rerun(log_text)) return false;
        return tex[tex.length - 1].aux === tex[tex.length - 2].aux;
    }

    _folio_same_as_input(files, main_tex_path, logs, log_text) {
        if (this._folio_strong_rerun(log_text)) return false;
        const aux_name = main_tex_path.replace(/\\.tex$/, '.aux');
        const input = files.find(f => f.path === aux_name);
        const tex = this._folio_tex_logs(logs);
        if (!input || input.contents == null || !tex.length) return false;
        const text = typeof input.contents === 'string' ? input.contents : new TextDecoder().decode(input.contents);
        return text.trim() === tex[tex.length - 1].aux;
    }

    _needs_rerun(log_text) {`,
  );
}
// 4. Glosarios y acrónimos (paquetes glossaries / glossaries-extra / nomencl): hace lo
//    mismo que makeglossaries, con el makeindex que ya trae BusyTeX y el .ist que escribe
//    \makeglossaries. Solo fuerza otra pasada si el glosario generado cambió.
const GLOSS_ANCHOR = "            this.print('$ # makeindex disabled by caller');\n        }\n";
if (!src.includes("folio:glossaries") && src.includes(GLOSS_ANCHOR)) {
  src = src.replace(
    GLOSS_ANCHOR,
    GLOSS_ANCHOR +
      `
        /* folio:glossaries */
        let glossaries_active = false;
        if (exit_code == 0 && rerun !== false) {
            const base = tex_path.replace(/\\.tex$/, '');
            const ist = base + '.ist';
            const decode = c => c == null ? '' : (typeof c === 'string' ? c : new TextDecoder().decode(c));
            for (const [i, o, l] of [['.glo', '.gls', '.glg'], ['.acn', '.acr', '.alg'], ['.slo', '.sls', '.slg'], ['.nlo', '.nls', '.nlg']]) {
                const inp = base + i;
                if (!FS.analyzePath(inp).exists || this.read_all_text(FS, inp).trim() == '') continue;
                const style = i == '.nlo' ? 'nomencl.ist' : (FS.analyzePath(ist).exists ? ist : null);
                if (!style) continue;
                const before = FS.analyzePath(base + o).exists ? this.read_all_text(FS, base + o) : decode((files.find(f => f.path.endsWith(base.split('/').pop() + o)) || {}).contents);
                run(['makeindex', '-s', style, '-t', base + l, '-o', base + o, inp], this.error_messages_fatal);
                const after = FS.analyzePath(base + o).exists ? this.read_all_text(FS, base + o) : '';
                if (after.trim() !== before.trim()) glossaries_active = true;
            }
        }
`,
  );
}
// actualiza la primera versión del bloque (no respetaba el modo rápido)
src = src.replace(
  "let glossaries_active = false;\n        if (exit_code == 0) {",
  "let glossaries_active = false;\n        if (exit_code == 0 && rerun !== false) {",
);
// solo si el bloque de glosarios existe (si no, glossaries_active no estaría declarada)
if (src.includes("folio:glossaries")) {
  src = src.replace("(bibtex || makeindex_active || (this._needs_rerun", "(bibtex || makeindex_active || glossaries_active || (this._needs_rerun");
} else {
  console.warn("BusyTeX: no se pudo aplicar el parche de glosarios (cambió el pipeline).");
}

// 'rerunfilecheck' aparece en el registro de cualquier documento con hyperref (solo por
// cargar el paquete) y forzaba pasadas extra siempre. Su aviso real dice "Rerun to get…",
// que ya está en la lista.
src = src.replace(/\n\s*'rerunfilecheck',/, "");
// la pasada inicial produce el PDF final directamente (mismo resultado, sin batchmode)
// Todas las pasadas usan el comando "final": genera el mismo PDF y evita que el bucle
// añada una pasada extra solo para cambiar de comando.
src = src.replace(
  /pdftex_bibtex8: \{ initial: pdftex_(non)?final, nonfinal: pdftex_nonfinal,/,
  "pdftex_bibtex8: { initial: pdftex_final, nonfinal: pdftex_final,",
);
src = src.replace(
  /luahbtex_bibtex8: \{ initial: luahbtex_(non)?final, nonfinal: luahbtex_nonfinal,/,
  "luahbtex_bibtex8: { initial: luahbtex_final, nonfinal: luahbtex_final,",
);

if (src !== before) {
  writeFileSync(file, src);
  console.log("BusyTeX: pipeline ajustado para generar el PDF aunque haya errores.");
}
