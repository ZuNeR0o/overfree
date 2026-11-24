//! Proyectos como carpetas reales en disco.
//!
//! Documentos\Folio\<Proyecto>\
//!   main.tex, capitulos\..., figuras\...   ← archivos del usuario, tal cual
//!   .folio\project.json                     ← nombre, archivo principal, motor
//!   .folio\history\<id>.json                ← versiones guardadas
//!   .folio\output.pdf / output.synctex.gz   ← última compilación
//!
//! Un registro en la carpeta de datos de la app recuerda dónde está cada proyecto,
//! así también se pueden abrir carpetas que estén en cualquier otro sitio.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const META_DIR: &str = ".folio";
const MAX_FILE: u64 = 64 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone)]
struct Entry {
    id: String,
    dir: PathBuf,
}

pub struct Store {
    docs: PathBuf,
    registry: PathBuf,
    lock: Mutex<()>,
}

pub type Res<T> = Result<T, String>;

fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

fn new_id() -> String {
    let t = now_ms();
    let r = {
        use std::collections::hash_map::RandomState;
        use std::hash::{BuildHasher, Hasher};
        let mut h = RandomState::new().build_hasher();
        h.write_u64(t);
        h.finish()
    };
    format!("{:x}{:06x}", t, r & 0xff_ffff)
}

/// Une una ruta relativa del proyecto a su carpeta sin permitir salir de ella.
fn safe_join(root: &Path, rel: &str) -> Res<PathBuf> {
    let rel = rel.replace('\\', "/");
    let p = Path::new(&rel);
    if rel.is_empty() || p.is_absolute() {
        return Err("ruta no válida".into());
    }
    for c in p.components() {
        match c {
            // .folio y .git son internos (Windows no distingue mayúsculas: .GIT = .git)
            Component::Normal(s) => {
                let low = s.to_string_lossy().to_lowercase();
                let low = low.trim_end_matches(['.', ' ']);
                if low == META_DIR || low == ".git" {
                    return Err("ruta no válida".into());
                }
            }
            _ => return Err("ruta no válida".into()),
        }
    }
    Ok(root.join(p))
}

fn is_text(path: &str) -> bool {
    const EXT: &[&str] = &[
        "tex", "bib", "sty", "cls", "bst", "bbx", "cbx", "lbx", "def", "cfg", "clo", "dtx", "ins", "ltx", "txt",
        "md", "csv", "dat", "tsv", "json", "xml", "lua", "py", "r", "m", "tikz", "pgf", "gp", "asy", "mp", "bbl",
        "ist",
    ];
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rsplit_once('.') {
        Some((_, ext)) => EXT.contains(&ext.to_ascii_lowercase().as_str()),
        None => true,
    }
}

/// Archivos auxiliares de LaTeX que no tiene sentido cargar en el editor.
fn is_artifact(name: &str) -> bool {
    const SKIP: &[&str] = &[
        ".aux", ".log", ".out", ".toc", ".lof", ".lot", ".fls", ".fdb_latexmk", ".synctex.gz", ".synctex",
        ".bcf", ".run.xml", ".blg", ".nav", ".snm", ".vrb", ".ilg", ".glg", ".acr", ".alg", ".xdv", ".dvi",
    ];
    let lower = name.to_ascii_lowercase();
    SKIP.iter().any(|s| lower.ends_with(s)) || lower == "thumbs.db" || lower == ".ds_store"
}

fn sanitize(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let s = s.trim().trim_end_matches('.').to_string();
    if s.is_empty() {
        "Proyecto".into()
    } else {
        s
    }
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn write_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|s| s.to_str()).unwrap_or("")
    ));
    fs::write(&tmp, data)?;
    fs::rename(&tmp, path)
}

impl Store {
    pub fn new(docs: PathBuf, data: PathBuf) -> io::Result<Self> {
        fs::create_dir_all(&docs)?;
        fs::create_dir_all(&data)?;
        Ok(Self { docs, registry: data.join("projects.json"), lock: Mutex::new(()) })
    }

    fn entries(&self) -> Vec<Entry> {
        fs::read(&self.registry)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn save_entries(&self, list: &[Entry]) -> Res<()> {
        write_atomic(&self.registry, &serde_json::to_vec_pretty(list).map_err(e)?).map_err(e)
    }

    fn dir_of(&self, id: &str) -> Res<PathBuf> {
        self.entries()
            .into_iter()
            .find(|x| x.id == id)
            .map(|x| x.dir)
            .ok_or_else(|| "proyecto no encontrado".into())
    }

    fn meta_path(dir: &Path) -> PathBuf {
        dir.join(META_DIR).join("project.json")
    }

    fn with_dir(mut meta: Value, dir: &Path) -> Value {
        meta["dir"] = json!(dir.to_string_lossy());
        meta
    }

    pub fn list_projects(&self) -> Res<Value> {
        let _g = self.lock.lock().map_err(e)?;
        let mut out = vec![];
        let mut keep = vec![];
        let entries = self.entries();
        let total = entries.len();
        for en in entries {
            if let Some(meta) = read_json(&Self::meta_path(&en.dir)) {
                out.push(Self::with_dir(meta, &en.dir));
                keep.push(en);
            }
        }
        // olvida proyectos cuya carpeta ya no existe (solo escribe si hubo alguno)
        if keep.len() != total {
            self.save_entries(&keep)?;
        }
        out.sort_by_key(|m| std::cmp::Reverse(m["updated"].as_u64().unwrap_or(0)));
        Ok(Value::Array(out))
    }

    pub fn save_meta(&self, mut meta: Value) -> Res<()> {
        let _g = self.lock.lock().map_err(e)?;
        let id = meta["id"].as_str().ok_or("falta id")?.to_string();
        if let Some(o) = meta.as_object_mut() {
            o.remove("dir");
        }
        let mut list = self.entries();
        let dir = match list.iter().find(|x| x.id == id) {
            Some(en) => en.dir.clone(),
            None => {
                // proyecto nuevo: carpeta con su nombre dentro de Documentos\Folio
                let base = sanitize(meta["name"].as_str().unwrap_or("Proyecto"));
                let mut dir = self.docs.join(&base);
                let mut n = 2;
                while dir.exists() {
                    dir = self.docs.join(format!("{base} ({n})"));
                    n += 1;
                }
                fs::create_dir_all(&dir).map_err(e)?;
                list.push(Entry { id: id.clone(), dir: dir.clone() });
                self.save_entries(&list)?;
                dir
            }
        };
        write_atomic(&Self::meta_path(&dir), &serde_json::to_vec_pretty(&meta).map_err(e)?).map_err(e)
    }

    pub fn delete_project(&self, id: &str) -> Res<()> {
        let _g = self.lock.lock().map_err(e)?;
        let mut list = self.entries();
        if let Some(en) = list.iter().find(|x| x.id == id) {
            if en.dir.exists() {
                // a la papelera, no borrado definitivo
                trash::delete(&en.dir).map_err(e)?;
            }
        }
        list.retain(|x| x.id != id);
        self.save_entries(&list)
    }

    /// Recorre los archivos del proyecto (sin .folio, .git ni auxiliares de LaTeX).
    fn walk(&self, root: &Path) -> Vec<(String, PathBuf, fs::Metadata)> {
        let mut out = vec![];
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = fs::read_dir(&dir) else { continue };
            for ent in rd.flatten() {
                let name = ent.file_name().to_string_lossy().to_string();
                let path = ent.path();
                let Ok(ft) = ent.file_type() else { continue };
                if ft.is_dir() {
                    if name != META_DIR && name != ".git" && name != "node_modules" && !name.ends_with(".folio-renombrando") {
                        stack.push(path);
                    }
                    continue;
                }
                // los archivos temporales de Drive/Office y los nuestros (.tmp) se ignoran
                if !ft.is_file() || is_artifact(&name) || name.ends_with(".tmp") || name.ends_with(".folio-renombrando") || name.starts_with("~$") || name == "desktop.ini" {
                    continue;
                }
                let Ok(meta) = ent.metadata() else { continue };
                if meta.len() > MAX_FILE {
                    continue;
                }
                let Ok(rel) = path.strip_prefix(root) else { continue };
                out.push((rel.to_string_lossy().replace('\\', "/"), path, meta));
            }
        }
        out
    }

    fn file_json(rel: &str, bytes: Vec<u8>) -> Value {
        let b64 = base64::engine::general_purpose::STANDARD;
        if is_text(rel) {
            match String::from_utf8(bytes) {
                Ok(text) => json!({ "path": rel, "text": text }),
                Err(err) => json!({ "path": rel, "b64": b64.encode(err.into_bytes()) }),
            }
        } else {
            json!({ "path": rel, "b64": b64.encode(bytes) })
        }
    }

    pub fn load_files(&self, id: &str) -> Res<Value> {
        let root = self.dir_of(id)?;
        let out = self
            .walk(&root)
            .into_iter()
            .filter_map(|(rel, path, _)| fs::read(&path).ok().map(|b| Self::file_json(&rel, b)))
            .collect();
        Ok(Value::Array(out))
    }

    /// Lista ligera (ruta, tamaño, fecha) para detectar cambios hechos fuera de Overfree.
    pub fn manifest(&self, id: &str) -> Res<Value> {
        let root = self.dir_of(id)?;
        let out = self
            .walk(&root)
            .into_iter()
            .map(|(rel, _, meta)| {
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or_default();
                json!({ "path": rel, "size": meta.len(), "mtime": mtime })
            })
            .collect();
        Ok(Value::Array(out))
    }

    pub fn read_file(&self, id: &str, rel: &str) -> Res<Value> {
        let root = self.dir_of(id)?;
        let bytes = fs::read(safe_join(&root, rel)?).map_err(e)?;
        Ok(Self::file_json(rel, bytes))
    }

    pub fn write_file(&self, id: &str, rel: &str, data: &[u8]) -> Res<()> {
        let root = self.dir_of(id)?;
        write_atomic(&safe_join(&root, rel)?, data).map_err(e)
    }

    pub fn delete_file(&self, id: &str, rel: &str) -> Res<()> {
        let root = self.dir_of(id)?;
        let path = safe_join(&root, rel)?;
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(e(err)),
        }
        // quita carpetas que hayan quedado vacías
        let mut dir = path.parent().map(Path::to_path_buf);
        while let Some(d) = dir {
            if d == root || fs::remove_dir(&d).is_err() {
                break;
            }
            dir = d.parent().map(Path::to_path_buf);
        }
        Ok(())
    }

    // ---------- Historial ----------

    fn history_dir(&self, id: &str) -> Res<PathBuf> {
        Ok(self.dir_of(id)?.join(META_DIR).join("history"))
    }

    pub fn list_snapshots(&self, id: &str) -> Res<Value> {
        let dir = self.history_dir(id)?;
        let mut out: Vec<Value> = fs::read_dir(&dir)
            .map(|rd| rd.flatten().filter_map(|f| read_json(&f.path())).collect())
            .unwrap_or_default();
        out.sort_by_key(|s| std::cmp::Reverse(s["time"].as_u64().unwrap_or(0)));
        Ok(Value::Array(out))
    }

    fn snap_file(&self, id: &str, sid: &str) -> Res<PathBuf> {
        if sid.is_empty() || !sid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err("id de versión no válido".into());
        }
        Ok(self.history_dir(id)?.join(format!("{sid}.json")))
    }

    pub fn add_snapshot(&self, id: &str, snap: &[u8]) -> Res<()> {
        let v: Value = serde_json::from_slice(snap).map_err(e)?;
        let sid = v["id"].as_str().ok_or("falta id")?;
        write_atomic(&self.snap_file(id, sid)?, snap).map_err(e)
    }

    pub fn delete_snapshot(&self, id: &str, sid: &str) -> Res<()> {
        match fs::remove_file(self.snap_file(id, sid)?) {
            Err(err) if err.kind() != io::ErrorKind::NotFound => Err(e(err)),
            _ => Ok(()),
        }
    }

    // ---------- Última compilación ----------

    fn output_path(&self, id: &str, which: &str) -> Res<PathBuf> {
        let name = match which {
            "pdf" => "output.pdf",
            "synctex" => "output.synctex.gz",
            "info" => "output.json",
            _ => return Err("salida no válida".into()),
        };
        Ok(self.dir_of(id)?.join(META_DIR).join(name))
    }

    pub fn save_output(&self, id: &str, which: &str, data: &[u8]) -> Res<()> {
        write_atomic(&self.output_path(id, which)?, data).map_err(e)
    }

    pub fn load_output(&self, id: &str, which: &str) -> Res<Option<Vec<u8>>> {
        match fs::read(self.output_path(id, which)?) {
            Ok(b) => Ok(Some(b)),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(e(err)),
        }
    }

    // ---------- Carpetas existentes ----------

    /// Registra una carpeta cualquiera como proyecto (o recupera el que ya tenía).
    pub fn adopt_folder(&self, dir: &Path) -> Res<Value> {
        let _g = self.lock.lock().map_err(e)?;
        let dir = plain(dir.canonicalize().map_err(e)?);
        let mut list = self.entries();
        if let Some(en) = list.iter().find(|x| x.dir.canonicalize().ok().map(plain).as_deref() == Some(dir.as_path())) {
            if let Some(meta) = read_json(&Self::meta_path(&en.dir)) {
                return Ok(Self::with_dir(meta, &en.dir));
            }
        }
        let mut meta = read_json(&Self::meta_path(&dir)).unwrap_or_else(|| {
            json!({
                "name": dir.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Proyecto".into()),
                "main": guess_main(&dir),
                "engine": "pdflatex",
                "folders": [],
                "created": now_ms(),
            })
        });
        // una carpeta copiada trae el id de otra: se le da uno nuevo
        let id = match meta["id"].as_str() {
            Some(id) if !list.iter().any(|x| x.id == id) => id.to_string(),
            _ => new_id(),
        };
        meta["id"] = json!(id);
        meta["updated"] = json!(now_ms());
        write_atomic(&Self::meta_path(&dir), &serde_json::to_vec_pretty(&meta).map_err(e)?).map_err(e)?;
        list.push(Entry { id, dir: dir.clone() });
        self.save_entries(&list)?;
        Ok(Self::with_dir(meta, &dir))
    }

    pub fn project_dir(&self, id: &str) -> Res<PathBuf> {
        self.dir_of(id)
    }
}

/// Quita el prefijo \\?\ que añade canonicalize() en Windows (salvo rutas de red).
fn plain(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => p,
    }
}

/// Busca el .tex con \documentclass, prefiriendo main.tex y los menos anidados.
fn guess_main(root: &Path) -> String {
    let mut best: Option<(usize, bool, String)> = None;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for ent in rd.flatten() {
            let p = ent.path();
            if p.is_dir() {
                if ent.file_name() != META_DIR && ent.file_name() != ".git" {
                    stack.push(p);
                }
                continue;
            }
            if p.extension().and_then(|s| s.to_str()) != Some("tex") {
                continue;
            }
            let Ok(text) = fs::read_to_string(&p) else { continue };
            let has_class = text.lines().any(|l| l.trim_start().starts_with("\\documentclass"));
            if !has_class {
                continue;
            }
            let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().replace('\\', "/");
            let depth = rel.matches('/').count();
            let is_main = rel.ends_with("main.tex");
            let cand = (depth, !is_main, rel);
            if best.as_ref().map(|b| (cand.0, cand.1) < (b.0, b.1)).unwrap_or(true) {
                best = Some(cand);
            }
        }
    }
    best.map(|b| b.2).unwrap_or_else(|| "main.tex".into())
}
