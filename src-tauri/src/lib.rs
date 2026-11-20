//! Folio de escritorio.
//!
//! La interfaz y el motor LaTeX (BusyTeX, ~700 MB) se sirven desde disco con un
//! servidor HTTP local en 127.0.0.1. Así todo comparte origen (el worker de
//! BusyTeX lo necesita) y nada pesado se incrusta en el ejecutable.
//! El mismo servidor expone /api, protegido con un token aleatorio, para guardar
//! los proyectos como carpetas reales en Documentos\Folio.

mod git;
mod native;
mod server;
mod store;
mod updater;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Puerto fijo para que el origen no cambie entre ejecuciones (ajustes y caché del
/// navegador dependen de él). Si está ocupado se usa uno libre cualquiera.
const PORT: u16 = 47321;

fn random_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for i in 0..4u64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(i);
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default(),
        );
        h.write_u32(std::process::id());
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

fn web_root(app: &tauri::AppHandle) -> PathBuf {
    // En desarrollo se usa dist/ directamente; en la versión instalada, los recursos.
    if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("dist")
    } else {
        app.path()
            .resource_dir()
            .expect("sin carpeta de recursos")
            .join("web")
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            let docs = app
                .path()
                .document_dir()
                .unwrap_or_else(|_| app.path().home_dir().expect("sin carpeta de usuario"))
                .join("Folio");
            let data = app.path().app_data_dir()?;
            let store = Arc::new(store::Store::new(docs, data.clone())?);
            // FOLIO_TOKEN solo se respeta en depuración (pruebas automáticas de la API)
            let token = match std::env::var("FOLIO_TOKEN") {
                Ok(t) if cfg!(debug_assertions) && t.len() >= 16 => t,
                _ => random_token(),
            };

            let (port, srv) = server::start(PORT, web_root(&handle), store, token.clone(), handle.clone())?;
            // el servidor vive mientras dure la aplicación
            app.manage(srv);

            let origin = format!("http://127.0.0.1:{port}");
            let init = format!(
                "window.__FOLIO = {{ token: {}, api: {} }};",
                serde_json::to_string(&token)?,
                serde_json::to_string(&format!("{origin}/api"))?
            );
            // Al cambiar de versión se vacía la caché del visor una vez, para que no use
            // archivos de la versión anterior (las primeras versiones los marcaban inmutables).
            let version = app.package_info().version.to_string();
            let marker = data.join("webview-version.txt");
            let stale = std::fs::read_to_string(&marker).map(|v| v.trim() != version).unwrap_or(true);

            let url: tauri::Url = origin.parse()?;
            let start = if stale { "about:blank".parse()? } else { url.clone() };
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(start))
                .title("Folio")
                .inner_size(1440.0, 900.0)
                .min_inner_size(800.0, 500.0)
                .initialization_script(&init)
                .build()?;
            if stale {
                let _ = win.clear_all_browsing_data();
                let _ = std::fs::write(&marker, &version);
                // el borrado es asíncrono en WebView2: se navega un instante después
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(800));
                    let _ = win.navigate(url);
                });
            }
            // solo en la versión instalada (en desarrollo no hay paquetes firmados)
            if !cfg!(debug_assertions) {
                updater::check_in_background(handle.clone());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error al iniciar Folio");
}
