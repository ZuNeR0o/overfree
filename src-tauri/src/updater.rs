//! Actualizaciones automáticas desde las Releases de GitHub.
//! Cada versión va firmada con la clave privada del autor; la app solo instala
//! paquetes cuya firma coincide con la clave pública de tauri.conf.json.

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

/// Comprueba en segundo plano si hay una versión nueva y pregunta antes de instalarla.
pub fn check_in_background(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // deja que la ventana cargue antes de usar la red
        tokio_sleep(8).await;
        if let Err(e) = check(&app).await {
            eprintln!("actualización: {e}");
        }
    });
}

async fn tokio_sleep(secs: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_secs(secs))).await;
}

async fn check(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let Some(update) = app.updater()?.check().await? else {
        return Ok(()); // ya está al día (o sin conexión)
    };
    let notes = update.body.clone().unwrap_or_default();
    let question = format!(
        "Hay una versión nueva de Folio: {} (tienes la {}).\n\n{}\n\n¿Descargarla e instalarla ahora? Tus proyectos no se tocan.",
        update.version,
        update.current_version,
        notes.chars().take(600).collect::<String>()
    );
    let app2 = app.clone();
    let accepted = tauri::async_runtime::spawn_blocking(move || {
        app2.dialog()
            .message(question)
            .title("Actualización disponible")
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom("Actualizar".into(), "Más tarde".into()))
            .blocking_show()
    })
    .await?;
    if !accepted {
        return Ok(());
    }

    // progreso en el título de la ventana principal
    let win = app.get_webview_window("main");
    let mut downloaded: u64 = 0;
    let mut last_pct = u64::MAX;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                if let (Some(w), Some(t)) = (&win, total) {
                    let pct = downloaded * 100 / t.max(1);
                    if pct != last_pct {
                        last_pct = pct;
                        let _ = w.set_title(&format!("Folio — descargando actualización {pct} %"));
                    }
                }
            },
            || {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_title("Folio — instalando actualización…");
                }
            },
        )
        .await?;
    // en Windows el instalador cierra y vuelve a abrir la app; por si acaso:
    app.restart();
}
