//! Control de versiones con Git para cada proyecto (usa el `git` instalado en el sistema).

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

use crate::store::Res;

fn git_exe() -> Option<PathBuf> {
    // PATH primero; si no, la ruta habitual de Git for Windows
    let candidates = [
        PathBuf::from("git"),
        PathBuf::from(r"C:\Program Files\Git\cmd\git.exe"),
        PathBuf::from(r"C:\Program Files (x86)\Git\cmd\git.exe"),
    ];
    candidates.into_iter().find(|c| {
        let mut cmd = Command::new(c);
        cmd.arg("--version");
        no_window(&mut cmd);
        cmd.output().map(|o| o.status.success()).unwrap_or(false)
    })
}

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}
#[cfg(not(windows))]
fn no_window(_: &mut Command) {}

struct Out {
    ok: bool,
    stdout: String,
    stderr: String,
}

/// Opciones que anulan configuración local peligrosa: un `.git/config` de una carpeta
/// o ZIP ajeno podría, si no, ejecutar programas (fsmonitor, hooks, ssh, ext::).
const SAFE: &[&str] = &[
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=.folio-sin-hooks",
    "-c", "core.sshCommand=ssh",
    "-c", "protocol.ext.allow=never",
    "-c", "protocol.file.allow=user",
    "-c", "core.pager=",
    "-c", "credential.helper=",
    "-c", "credential.helper=manager",
];

fn run(dir: &Path, args: &[&str]) -> Res<Out> {
    let exe = git_exe().ok_or("Git no está instalado. Instálalo desde https://git-scm.com")?;
    let mut cmd = Command::new(exe);
    cmd.current_dir(dir)
        .args(SAFE)
        .args(args)
        // nunca esperar una contraseña en una consola invisible; el gestor de
        // credenciales de Git for Windows abre su propia ventana si hace falta
        .env("GIT_TERMINAL_PROMPT", "0");
    no_window(&mut cmd);
    let o = cmd.output().map_err(|e| e.to_string())?;
    Ok(Out {
        ok: o.status.success(),
        stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
    })
}

fn check(o: Out) -> Res<String> {
    if o.ok {
        Ok(o.stdout)
    } else {
        Err(if o.stderr.trim().is_empty() { o.stdout } else { o.stderr }.trim().to_string())
    }
}

const GITIGNORE: &str = "# Generado por Overfree\n.folio/\n*.aux\n*.log\n*.out\n*.toc\n*.lof\n*.lot\n*.synctex.gz\n*.fls\n*.fdb_latexmk\n*.bbl\n*.blg\n*.bcf\n*.run.xml\n*.nav\n*.snm\n*.vrb\n";

pub fn status(dir: &Path) -> Res<Value> {
    if git_exe().is_none() {
        return Ok(json!({ "available": false }));
    }
    if !dir.join(".git").exists() {
        return Ok(json!({ "available": true, "repo": false }));
    }
    // symbolic-ref funciona también antes del primer commit (rev-parse falla ahí)
    let branch = check(run(dir, &["symbolic-ref", "--short", "HEAD"])?).unwrap_or_default().trim().to_string();
    let porcelain = check(run(dir, &["status", "--porcelain=v1", "-uall"])?)?;
    let changes: Vec<Value> = porcelain
        .lines()
        .filter(|l| l.len() > 3)
        .map(|l| {
            let code = l[..2].trim().to_string();
            let path = l[3..].trim_matches('"').to_string();
            json!({ "status": code, "path": path })
        })
        .collect();
    let remote = check(run(dir, &["remote", "get-url", "origin"])?).ok().map(|s| s.trim().to_string());
    let (mut ahead, mut behind) = (0, 0);
    if let Ok(s) = check(run(dir, &["rev-list", "--left-right", "--count", "HEAD...@{u}"])?) {
        let mut it = s.split_whitespace().map(|n| n.parse::<u32>().unwrap_or(0));
        ahead = it.next().unwrap_or(0);
        behind = it.next().unwrap_or(0);
    }
    let name = check(run(dir, &["config", "user.name"])?).unwrap_or_default().trim().to_string();
    let email = check(run(dir, &["config", "user.email"])?).unwrap_or_default().trim().to_string();
    Ok(json!({
        "available": true,
        "repo": true,
        "branch": branch,
        "changes": changes,
        "remote": remote,
        "ahead": ahead,
        "behind": behind,
        "identity": !name.is_empty() && !email.is_empty(),
    }))
}

pub fn init(dir: &Path) -> Res<()> {
    check(run(dir, &["init", "-b", "main"])?)?;
    let gi = dir.join(".gitignore");
    if !gi.exists() {
        std::fs::write(&gi, GITIGNORE).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Rechaza valores que git interpretaría como opciones (`--algo`).
fn plain_value(v: &str) -> Res<&str> {
    let v = v.trim();
    if v.starts_with('-') || v.contains('\n') {
        Err("Valor no válido.".into())
    } else {
        Ok(v)
    }
}

fn current_branch(dir: &Path) -> Res<String> {
    let b = check(run(dir, &["symbolic-ref", "--short", "HEAD"])?)?.trim().to_string();
    // un .git ajeno podría tener una "rama" que parezca una opción (--upload-pack=...)
    if b.is_empty() || b.starts_with('-') || check(run(dir, &["check-ref-format", "--branch", &b])?).is_err() {
        return Err(format!("Nombre de rama no válido: {b}"));
    }
    Ok(b)
}

pub fn commit(dir: &Path, message: &str, name: Option<&str>, email: Option<&str>) -> Res<String> {
    if let (Some(n), Some(m)) = (name, email) {
        let (n, m) = (plain_value(n)?, plain_value(m)?);
        // identidad solo para este proyecto
        check(run(dir, &["config", "user.name", n])?)?;
        check(run(dir, &["config", "user.email", m])?)?;
    }
    check(run(dir, &["add", "-A"])?)?;
    let msg = if message.trim().is_empty() { "Cambios desde Overfree" } else { message.trim() };
    // -m seguido del valor: git no lo interpreta como opción aunque empiece por '-'
    check(run(dir, &["commit", "-m", msg])?)
}

pub fn log(dir: &Path) -> Res<Value> {
    if !dir.join(".git").exists() {
        return Ok(json!([]));
    }
    let out = match check(run(dir, &["log", "-n", "50", "--date=iso-strict", "--pretty=format:%h%x1f%ad%x1f%an%x1f%s"])?) {
        Ok(s) => s,
        Err(_) => return Ok(json!([])), // repositorio sin commits todavía
    };
    Ok(Value::Array(
        out.lines()
            .filter_map(|l| {
                let p: Vec<&str> = l.split('\u{1f}').collect();
                (p.len() == 4).then(|| json!({ "hash": p[0], "date": p[1], "author": p[2], "message": p[3] }))
            })
            .collect(),
    ))
}

pub fn set_remote(dir: &Path, url: &str) -> Res<()> {
    let url = url.trim();
    if url.is_empty() {
        let _ = run(dir, &["remote", "remove", "origin"]);
        return Ok(());
    }
    // solo remotos de red habituales (nada de opciones, file:// ni ext::)
    let ok_scheme = ["https://", "http://", "ssh://", "git@"].iter().any(|s| url.starts_with(s));
    if !ok_scheme || url.contains(char::is_whitespace) {
        return Err("Usa una URL https://… o git@… (por ejemplo la que muestra GitHub en «Code»).".into());
    }
    if check(run(dir, &["remote", "get-url", "origin"])?).is_ok() {
        check(run(dir, &["remote", "set-url", "origin", url])?).map(|_| ())
    } else {
        check(run(dir, &["remote", "add", "origin", url])?).map(|_| ())
    }
}

/// Trae los cambios del remoto y sube los locales.
pub fn sync(dir: &Path) -> Res<String> {
    let branch = current_branch(dir)?;
    let mut log = String::new();
    // si la rama remota existe, se integra primero
    if check(run(dir, &["ls-remote", "--exit-code", "--heads", "origin", &branch])?).is_ok() {
        log += &check(run(dir, &["pull", "--rebase", "--autostash", "origin", &branch])?)?;
    }
    log += &check(run(dir, &["push", "-u", "origin", &branch])?)?;
    Ok(log)
}
