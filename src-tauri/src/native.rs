//! Compilación con el TeX instalado en el equipo (MiKTeX o TeX Live), como alternativa
//! al motor integrado. No usa latexmk (necesita Perl): orquesta las pasadas aquí.
//! Los auxiliares van a <proyecto>/.folio/build para no ensuciar la carpeta.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};

use crate::store::Res;

/// Separador de listas de rutas de kpathsea; el vacío final añade las rutas por defecto.
const PATH_SEP: char = if cfg!(windows) { ';' } else { ':' };

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000);
}
#[cfg(not(windows))]
fn no_window(_: &mut Command) {}

/// Carpeta con los binarios de TeX (pdflatex.exe…), buscando en PATH y rutas habituales.
fn tex_bin() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "pdflatex.exe" } else { "pdflatex" };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local).join(r"Programs\MiKTeX\miktex\bin\x64"));
    }
    dirs.push(PathBuf::from(r"C:\Program Files\MiKTeX\miktex\bin\x64"));
    // TeX Live: C:\texlive\<año>\bin\windows (el más reciente primero)
    if let Ok(rd) = fs::read_dir(r"C:\texlive") {
        let mut years: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
        years.sort();
        for y in years.into_iter().rev() {
            dirs.push(y.join(r"bin\windows"));
            dirs.push(y.join(r"bin\win64"));
        }
    }
    dirs.into_iter().find(|d| d.join(exe).is_file())
}

fn is_miktex(bin: &Path) -> bool {
    bin.to_string_lossy().to_lowercase().contains("miktex")
}

fn version(bin: &Path) -> String {
    let mut cmd = Command::new(bin.join("pdflatex"));
    cmd.arg("--version").stdin(Stdio::null());
    no_window(&mut cmd);
    cmd.output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).lines().next().map(str::to_string))
        .unwrap_or_default()
}

pub fn detect() -> Value {
    match tex_bin() {
        Some(bin) => json!({ "available": true, "path": bin.to_string_lossy(), "version": version(&bin), "miktex": is_miktex(&bin) }),
        None => json!({ "available": false }),
    }
}

struct Run {
    log: String,
}

// ---------- Cancelación ----------

const CANCEL_MSG: &str = "Compilación cancelada";
/// Se activa al pedir cancelar; cada paso lo comprueba antes y después de ejecutarse.
static CANCELLED: AtomicBool = AtomicBool::new(false);
/// Trabajo en curso y cancelación recibida para un trabajo que aún no empezó. Cada
/// compilación lleva un identificador único: una cancelación tardía o adelantada solo
/// afecta a la compilación que la pidió, nunca a la siguiente.
static JOBS: Mutex<(Option<String>, Option<String>)> = Mutex::new((None, None));
/// PID del programa de TeX que se está ejecutando ahora (para poder terminarlo).
static RUNNING_PID: Mutex<Option<u32>> = Mutex::new(None);

fn set_running(pid: Option<u32>) {
    if let Ok(mut g) = RUNNING_PID.lock() {
        *g = pid;
    }
}

/// Detiene la compilación en curso: marca la cancelación y termina el proceso activo
/// con sus hijos (MiKTeX puede lanzar otros, p. ej. al instalar paquetes).
pub fn cancel(job: &str) {
    let Ok(mut jobs) = JOBS.lock() else { return };
    if jobs.0.as_deref() == Some(job) {
        CANCELLED.store(true, Ordering::SeqCst);
        drop(jobs);
        if let Some(pid) = RUNNING_PID.lock().ok().and_then(|g| *g) {
            kill_tree(pid);
        }
    } else {
        jobs.1 = Some(job.to_string()); // aún no empezó: se cancelará al llegar
    }
}

fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut k = Command::new("taskkill");
        k.args(["/PID", &pid.to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        no_window(&mut k);
        let _ = k.status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
    }
}

fn run(bin: &Path, tool: &str, args: &[&str], cwd: &Path, envs: &[(&str, &str)]) -> Res<Run> {
    if CANCELLED.load(Ordering::SeqCst) {
        return Err(CANCEL_MSG.into());
    }
    let mut cmd = Command::new(bin.join(tool));
    cmd.args(args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in envs {
        cmd.env(k, v);
    }
    no_window(&mut cmd);
    let child = cmd.spawn().map_err(|e| format!("No se pudo ejecutar {tool}: {e}"))?;
    let pid = child.id();
    set_running(Some(pid));
    // la cancelación pudo llegar justo entre spawn y set_running (cuando aún no había PID)
    if CANCELLED.load(Ordering::SeqCst) {
        kill_tree(child.id());
    }
    // Se espera en otro hilo: si se cancela, se responde al instante aunque algún proceso
    // hijo siga con la salida abierta (wait_with_output esperaría a que la cierre).
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    let out = loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(out) => break out,
            Err(mpsc::RecvTimeoutError::Timeout) if CANCELLED.load(Ordering::SeqCst) => {
                kill_tree(pid); // por si cancel() no llegó a verlo (lo leyó ya sin PID)
                set_running(None);
                return Err(CANCEL_MSG.into());
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                set_running(None);
                return Err(format!("No se pudo esperar a {tool}"));
            }
        }
    };
    set_running(None);
    if CANCELLED.load(Ordering::SeqCst) {
        return Err(CANCEL_MSG.into());
    }
    let o = out.map_err(|e| format!("No se pudo ejecutar {tool}: {e}"))?;
    let mut log = format!("$ {tool} {}\n", args.join(" "));
    log += &String::from_utf8_lossy(&o.stdout);
    log += &String::from_utf8_lossy(&o.stderr);
    Ok(Run { log })
}

fn read(p: &Path) -> String {
    fs::read(p).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default()
}

/// Crea en build/ las mismas subcarpetas que el proyecto (las necesita \include con rutas).
fn mirror_dirs(src: &Path, dst: &Path) {
    let Ok(rd) = fs::read_dir(src) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name();
        if p.is_dir() && name != ".folio" && name != ".git" && name != "node_modules" {
            let d = dst.join(&name);
            let _ = fs::create_dir_all(&d);
            mirror_dirs(&p, &d);
        }
    }
}

pub fn clean(dir: &Path) -> Res<()> {
    let build = dir.join(".folio").join("build");
    if build.exists() {
        fs::remove_dir_all(&build).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn compile(job: &str, dir: &Path, main: &str, engine: &str, shell_escape: bool, draft: bool) -> Res<Value> {
    {
        let Ok(mut jobs) = JOBS.lock() else { return Err("Estado interno no disponible".into()) };
        if jobs.1.as_deref() == Some(job) {
            jobs.1 = None;
            return Err(CANCEL_MSG.into()); // se canceló antes de empezar
        }
        jobs.0 = Some(job.to_string());
        CANCELLED.store(false, Ordering::SeqCst);
    }
    let result = compile_inner(dir, main, engine, shell_escape, draft);
    if let Ok(mut jobs) = JOBS.lock() {
        jobs.0 = None;
        CANCELLED.store(false, Ordering::SeqCst);
    }
    result
}

fn compile_inner(dir: &Path, main: &str, engine: &str, shell_escape: bool, draft: bool) -> Res<Value> {
    let bin = tex_bin().ok_or("No se encontró TeX en el equipo (MiKTeX o TeX Live).")?;
    let exe = match engine {
        "xelatex" => "xelatex",
        "lualatex" => "lualatex",
        _ => "pdflatex",
    };
    // ruta relativa simple dentro del proyecto: nada de C:, \, .., ni nombres que TeX o el
    // programa interpreten como opción (-…), primitiva (\…), formato (&…) o código ({ } % #);
    // TeX se salta los espacios iniciales, así que tampoco se admiten
    let valid = main.ends_with(".tex")
        && main.len() > ".tex".len()
        && !main.contains([':', '{', '}', '%', '#'])
        && (cfg!(windows) || !main.contains('\\'))
        && !main.starts_with(['/', '\\', '-', '&'])
        && Path::new(main).components().all(|c| matches!(c, std::path::Component::Normal(_)))
        && main.split(['/', '\\']).all(|seg| !seg.is_empty() && !seg.starts_with(['-', '&', '\\']) && !seg.starts_with(char::is_whitespace));
    if !valid || !dir.join(main).is_file() {
        return Err("Archivo principal no válido.".into());
    }
    let build = dir.join(".folio").join("build");
    fs::create_dir_all(&build).map_err(|e| e.to_string())?;
    mirror_dirs(dir, &build);

    let stem = main.strip_suffix(".tex").unwrap_or(main);
    let job = Path::new(stem).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| stem.into());
    let out_arg = format!("-output-directory={}", build.to_string_lossy());
    let mut args: Vec<&str> = vec!["-interaction=nonstopmode", "-synctex=1", &out_arg];
    if is_miktex(&bin) {
        args.push("-enable-installer"); // instala solo los paquetes que falten, sin preguntar
    }
    if shell_escape {
        args.push("-shell-escape");
    }
    args.push(main);

    let aux = build.join(format!("{job}.aux"));
    let log_path = build.join(format!("{job}.log"));
    let pdf_path = build.join(format!("{job}.pdf"));
    let synctex_path = build.join(format!("{job}.synctex.gz"));
    // si esta compilación no genera PDF, no se debe devolver el de la anterior
    let _ = fs::remove_file(&pdf_path);
    let _ = fs::remove_file(&synctex_path);
    let dir_s = dir.to_string_lossy().into_owned();
    let mut tools_log = String::new();
    let mut prev_aux = read(&aux);

    let mut passes = 0;
    let mut log;
    loop {
        passes += 1;
        let r = run(&bin, exe, &args, dir, &[])?;
        tools_log += &r.log;
        log = read(&log_path);
        let now_aux = read(&aux);
        // error fatal (sin PDF): no tiene sentido seguir con bibliografía ni más pasadas
        if draft || !pdf_path.exists() {
            break;
        }

        let mut extra = false;
        if passes == 1 {
            // bibliografía
            if build.join(format!("{job}.bcf")).exists() {
                let r = run(&bin, "biber", &[&format!("--input-directory={dir_s}"), &job], &build, &[])?;
                tools_log += &r.log;
                extra = true;
            } else if now_aux.contains("\\bibdata") {
                let r = run(&bin, "bibtex", &[&job], &build, &[("BIBINPUTS", &format!("{dir_s}{PATH_SEP}")), ("BSTINPUTS", &format!("{dir_s}{PATH_SEP}"))])?;
                tools_log += &r.log;
                extra = true;
            }
            // glosarios / acrónimos (mismo procedimiento que makeglossaries)
            let ist = format!("{job}.ist");
            for (i, o, l) in [("glo", "gls", "glg"), ("acn", "acr", "alg"), ("slo", "sls", "slg")] {
                let inp = build.join(format!("{job}.{i}"));
                if inp.exists() && build.join(&ist).exists() && !read(&inp).trim().is_empty() {
                    let r = run(&bin, "makeindex", &["-s", &ist, "-t", &format!("{job}.{l}"), "-o", &format!("{job}.{o}"), &format!("{job}.{i}")], &build, &[])?;
                    tools_log += &r.log;
                    extra = true;
                }
            }
            // índice
            if build.join(format!("{job}.idx")).exists() {
                let r = run(&bin, "makeindex", &[&format!("{job}.idx")], &build, &[])?;
                tools_log += &r.log;
                extra = true;
            }
        }

        let strong = log.contains("Rerun to get") || log.contains("Label(s) may have changed") || log.contains("Rerun LaTeX");
        let aux_changed = now_aux != prev_aux;
        prev_aux = now_aux;
        if passes >= 5 || !(extra || strong || (aux_changed && log.contains("undefined references"))) {
            break;
        }
    }

    let b64 = base64::engine::general_purpose::STANDARD;
    let pdf = fs::read(&pdf_path).ok();
    let synctex = fs::read(&synctex_path).ok();
    Ok(json!({
        "success": pdf.is_some(),
        "pdf": pdf.map(|b| b64.encode(b)),
        "synctex": synctex.map(|b| b64.encode(b)),
        "log": format!("{log}\n\n==== Herramientas ({passes} pasada(s) de {exe}) ====\n{tools_log}"),
    }))
}
