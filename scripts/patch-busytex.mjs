// Ajusta el pipeline de BusyTeX para que se comporte como Overleaf: ante errores
// normales (un comando mal escrito, etc.) TeX sigue y genera el PDF igualmente.
// Es idempotente: se puede ejecutar cada vez sin dañar nada.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const file = "public/core/busytex/busytex_pipeline.js";
if (!existsSync(file)) process.exit(0);

let src = readFileSync(file, "utf8");
const before = src;

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
