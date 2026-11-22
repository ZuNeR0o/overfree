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
            // Antes se vaciaba aquí la caché del visor al cambiar de versión, pero eso también
            // borraba localStorage (tus ajustes). Ya no hace falta: desde la 0.1.1 el servidor
            // revalida cada archivo con ETag, así que nunca se usan archivos de otra versión.
            let url: tauri::Url = origin.parse()?;
            let allowed = url.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                // La ventana nunca sale de Folio (p. ej. al soltar un archivo fuera del árbol):
                // así initialization_script, que lleva el token de la API, no llega a otra página.
                .on_navigation(move |u| u.scheme() == allowed.scheme() && u.host_str() == allowed.host_str() && u.port() == allowed.port())
                .title("Folio")
                .inner_size(1440.0, 900.0)
                .min_inner_size(800.0, 500.0)
                .initialization_script(&init)
                // Sin esto, en Windows Tauri captura los archivos soltados sobre la ventana
                // y la página nunca recibe el "drop": arrastrar imágenes al árbol no hacía nada.
                .disable_drag_drop_handler()
                .build()?;
            // solo en la versión instalada (en desarrollo no hay paquetes firmados)
            if !cfg!(debug_assertions) {
                updater::check_in_background(handle.clone());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error al iniciar Folio");
}
