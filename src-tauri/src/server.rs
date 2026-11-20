//! Servidor HTTP local: archivos estáticos (interfaz + motor TeX) y la API /api.

use std::fs::File;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

use crate::store::Store;

pub struct ServerHandle(#[allow(dead_code)] Arc<Server>);

struct Ctx {
    root: PathBuf,
    store: Arc<Store>,
    token: String,
    host: String,
    app: AppHandle,
}

pub fn start(
    port: u16,
    root: PathBuf,
    store: Arc<Store>,
    token: String,
    app: AppHandle,
) -> Result<(u16, ServerHandle), Box<dyn std::error::Error>> {
    let server = Server::http(("127.0.0.1", port))
        .or_else(|_| Server::http(("127.0.0.1", 0)))
        .map_err(|err| err.to_string())?;
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("sin puerto")?;
    let server = Arc::new(server);
    let ctx = Arc::new(Ctx { root, store, token, host: format!("127.0.0.1:{port}"), app });
    for _ in 0..8 {
        let server = server.clone();
        let ctx = ctx.clone();
        std::thread::spawn(move || {
            while let Ok(req) = server.recv() {
                handle(&ctx, req);
            }
        });
    }
    Ok((port, ServerHandle(server)))
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("cabecera válida")
}

fn get_header<'a>(req: &'a Request, name: &str) -> Option<&'a str> {
    req.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str())
}

fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                match u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16) {
                    Ok(b) => {
                        out.push(b);
                        i += 3;
                        continue;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            b'+' => out.push(b' '),
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        (k == key).then(|| decode(v))
    })
}

fn json_resp(req: Request, code: u16, v: &Value) {
    let body = serde_json::to_vec(v).unwrap_or_default();
    let _ = req.respond(
        Response::from_data(body)
            .with_status_code(StatusCode(code))
            .with_header(header("Content-Type", "application/json; charset=utf-8"))
            .with_header(header("Cache-Control", "no-store")),
    );
}

fn bytes_resp(req: Request, data: Vec<u8>, mime: &str) {
    let _ = req.respond(
        Response::from_data(data)
            .with_header(header("Content-Type", mime))
            .with_header(header("Cache-Control", "no-store")),
    );
}

fn ok(req: Request) {
    json_resp(req, 200, &json!({ "ok": true }));
}

fn fail(req: Request, code: u16, msg: &str) {
    json_resp(req, code, &json!({ "error": msg }));
}

fn body(req: &mut Request) -> Vec<u8> {
    let mut buf = Vec::new();
    let _ = req.as_reader().read_to_end(&mut buf);
    buf
}

fn handle(ctx: &Ctx, req: Request) {
    // Protección contra DNS rebinding: solo se atiende al host exacto.
    if get_header(&req, "Host") != Some(ctx.host.as_str()) {
        return fail(req, 403, "host no permitido");
    }
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("/").to_string();
    if path.starts_with("/api/") {
        if get_header(&req, "X-Folio-Token") != Some(ctx.token.as_str()) {
            return fail(req, 403, "token no válido");
        }
        return api(ctx, req, &path, &url);
    }
    serve_static(ctx, req, &path);
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "txt" | "profile" | "cnf" => "text/plain; charset=utf-8",
        "pfb" | "data" | "bcmap" => "application/octet-stream",
        _ => "application/octet-stream",
    }
}

fn serve_static(ctx: &Ctx, req: Request, path: &str) {
    let rel = decode(path.trim_start_matches('/'));
    let rel = if rel.is_empty() { "index.html".to_string() } else { rel };
    let p = Path::new(&rel);
    if p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return fail(req, 400, "ruta no válida");
    }
    let full = ctx.root.join(p);
    // Solo depuración: con FOLIO_TOKEN se puede probar la interfaz desde un navegador normal.
    if cfg!(debug_assertions) && rel == "index.html" && std::env::var("FOLIO_TOKEN").is_ok() {
        if let Ok(html) = std::fs::read_to_string(&full) {
            let init = format!(
                "<head><script>window.__FOLIO={{token:{},api:\"/api\"}};</script>",
                serde_json::to_string(&ctx.token).unwrap_or_default()
            );
            let _ = req.respond(
                Response::from_string(html.replacen("<head>", &init, 1))
                    .with_header(header("Content-Type", "text/html; charset=utf-8")),
            );
            return;
        }
    }
    let Ok(file) = File::open(&full) else {
        return fail(req, 404, "no encontrado");
    };
    let meta = file.metadata().ok();
    let len = meta.as_ref().map(|m| m.len() as usize);
    // ETag = tamaño + fecha: el visor revalida cada archivo y, si no cambió, recibe un
    // 304 sin cuerpo. Así una actualización de la app nunca deja archivos viejos en caché.
    let mtime = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let etag = format!("\"{:x}-{:x}\"", len.unwrap_or(0), mtime);
    let headers = vec![
        header("Content-Type", mime_for(&full)),
        header("Cache-Control", "no-cache"),
        header("ETag", &etag),
    ];
    if get_header(&req, "If-None-Match") == Some(etag.as_str()) {
        let mut resp = Response::empty(StatusCode(304));
        for h in headers {
            resp.add_header(h);
        }
        let _ = req.respond(resp);
        return;
    }
    let _ = req.respond(Response::new(StatusCode(200), headers, file, len, None));
}

fn valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() < 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn api(ctx: &Ctx, mut req: Request, path: &str, url: &str) {
    let parts: Vec<&str> = path.trim_start_matches("/api/").split('/').collect();
    let method = req.method().clone();
    let st = &ctx.store;

    macro_rules! reply {
        ($r:expr) => {
            match $r {
                Ok(v) => json_resp(req, 200, &v),
                Err(err) => fail(req, 500, &err),
            }
        };
    }
    macro_rules! done {
        ($r:expr) => {
            match $r {
                Ok(()) => ok(req),
                Err(err) => fail(req, 500, &err),
            }
        };
    }

    match (method, parts.as_slice()) {
        (Method::Get, ["projects"]) => reply!(st.list_projects()),

        (Method::Post, ["open-folder"]) => {
            let picked = ctx.app.dialog().file().set_title("Abrir carpeta de proyecto LaTeX").blocking_pick_folder();
            match picked.and_then(|p| p.into_path().ok()) {
                Some(dir) => reply!(st.adopt_folder(&dir)),
                None => json_resp(req, 200, &Value::Null),
            }
        }

        (Method::Get, ["native"]) => json_resp(req, 200, &crate::native::detect()),

        (Method::Post, ["open-url"]) => {
            // solo enlaces web o de correo; nunca rutas ni otros protocolos
            let u = query(url, "url").unwrap_or_default();
            let low = u.to_lowercase();
            let ok_scheme = low.starts_with("https://") || low.starts_with("http://") || low.starts_with("mailto:");
            if !ok_scheme || u.chars().any(|c| c.is_control() || c == '"') {
                return fail(req, 400, "enlace no admitido");
            }
            let _ = std::process::Command::new("explorer").arg(&u).spawn();
            ok(req)
        }

        (Method::Post, ["open-window"]) => {
            // solo páginas propias conocidas
            let page = query(url, "page").unwrap_or_default();
            if page != "pdf.html" {
                return fail(req, 400, "página no permitida");
            }
            let app = ctx.app.clone();
            let target = format!("http://{}/{}", ctx.host, page);
            let res = ctx.app.run_on_main_thread(move || {
                use tauri::Manager;
                if let Some(w) = app.get_webview_window("pdf") {
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                    return;
                }
                if let Ok(u) = target.parse() {
                    let _ = tauri::WebviewWindowBuilder::new(&app, "pdf", tauri::WebviewUrl::External(u))
                        .title("Folio · PDF")
                        .inner_size(900.0, 1100.0)
                        .build();
                }
            });
            match res {
                Ok(()) => ok(req),
                Err(err) => fail(req, 500, &err.to_string()),
            }
        }

        (Method::Post, ["save-as"]) => {
            let name = query(url, "name").unwrap_or_else(|| "documento".into());
            let data = body(&mut req);
            let ext = name.rsplit_once('.').map(|(_, e)| e.to_string()).unwrap_or_default();
            let mut dlg = ctx.app.dialog().file().set_title("Guardar como").set_file_name(&name);
            if !ext.is_empty() {
                dlg = dlg.add_filter(ext.to_uppercase(), &[ext.as_str()]);
            }
            match dlg.blocking_save_file().and_then(|p| p.into_path().ok()) {
                Some(dest) => match std::fs::write(&dest, data) {
                    Ok(()) => json_resp(req, 200, &json!({ "saved": dest.to_string_lossy() })),
                    Err(err) => fail(req, 500, &err.to_string()),
                },
                None => json_resp(req, 200, &json!({ "saved": null })),
            }
        }

        (m, ["projects", id, rest @ ..]) if valid_id(id) => match (m, rest) {
            (Method::Put, ["meta"]) => {
                let b = body(&mut req);
                match serde_json::from_slice::<Value>(&b) {
                    Ok(v) if v["id"].as_str() == Some(id) => done!(st.save_meta(v)),
                    _ => fail(req, 400, "metadatos no válidos"),
                }
            }
            (Method::Delete, []) => done!(st.delete_project(id)),
            (Method::Get, ["files"]) => reply!(st.load_files(id)),
            (Method::Get, ["manifest"]) => reply!(st.manifest(id)),
            (Method::Get, ["file"]) => match query(url, "path") {
                Some(p) => reply!(st.read_file(id, &p)),
                None => fail(req, 400, "falta path"),
            },
            (Method::Put, ["file"]) => match query(url, "path") {
                Some(p) => {
                    let b = body(&mut req);
                    done!(st.write_file(id, &p, &b))
                }
                None => fail(req, 400, "falta path"),
            },
            (Method::Delete, ["file"]) => match query(url, "path") {
                Some(p) => done!(st.delete_file(id, &p)),
                None => fail(req, 400, "falta path"),
            },
            (Method::Get, ["snapshots"]) => reply!(st.list_snapshots(id)),
            (Method::Put, ["snapshots"]) => {
                let b = body(&mut req);
                done!(st.add_snapshot(id, &b))
            }
            (Method::Delete, ["snapshots", sid]) => done!(st.delete_snapshot(id, sid)),
            (Method::Get, ["output", which]) => match st.load_output(id, which) {
                Ok(Some(b)) => bytes_resp(req, b, "application/octet-stream"),
                Ok(None) => fail(req, 404, "sin salida"),
                Err(err) => fail(req, 500, &err),
            },
            (Method::Put, ["output", which]) => {
                let b = body(&mut req);
                done!(st.save_output(id, which, &b))
            }
            (Method::Post, ["native", action]) => {
                let dir = match st.project_dir(id) {
                    Ok(d) => d,
                    Err(err) => return fail(req, 404, &err),
                };
                let b = body(&mut req);
                let v: Value = serde_json::from_slice(&b).unwrap_or(Value::Null);
                match *action {
                    "compile" => reply!(crate::native::compile(
                        &dir,
                        v["main"].as_str().unwrap_or("main.tex"),
                        v["engine"].as_str().unwrap_or("pdflatex"),
                        v["shellEscape"].as_bool().unwrap_or(false),
                        v["draft"].as_bool().unwrap_or(false),
                    )),
                    "clean" => done!(crate::native::clean(&dir)),
                    _ => fail(req, 404, "acción desconocida"),
                }
            }
            (m, ["git", action]) => {
                let dir = match st.project_dir(id) {
                    Ok(d) => d,
                    Err(err) => return fail(req, 404, &err),
                };
                let b = body(&mut req);
                let v: Value = serde_json::from_slice(&b).unwrap_or(Value::Null);
                let s = |k: &str| v[k].as_str().map(str::to_string);
                match (m, *action) {
                    (Method::Get, "status") => reply!(crate::git::status(&dir)),
                    (Method::Get, "log") => reply!(crate::git::log(&dir)),
                    (Method::Post, "init") => done!(crate::git::init(&dir)),
                    (Method::Post, "commit") => {
                        let (name, email) = (s("name"), s("email"));
                        reply!(crate::git::commit(&dir, &s("message").unwrap_or_default(), name.as_deref(), email.as_deref())
                            .map(|out| json!({ "output": out })))
                    }
                    (Method::Post, "remote") => done!(crate::git::set_remote(&dir, &s("url").unwrap_or_default())),
                    (Method::Post, "sync") => reply!(crate::git::sync(&dir).map(|out| json!({ "output": out }))),
                    _ => fail(req, 404, "acción de git desconocida"),
                }
            }
            (Method::Post, ["reveal"]) => match st.project_dir(id) {
                Ok(dir) => {
                    let _ = std::process::Command::new("explorer").arg(dir).spawn();
                    ok(req)
                }
                Err(err) => fail(req, 404, &err),
            },
            _ => fail(req, 404, "ruta desconocida"),
        },

        _ => fail(req, 404, "ruta desconocida"),
    }
}
