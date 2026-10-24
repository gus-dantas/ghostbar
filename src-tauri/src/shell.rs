//! Gus Assistant's own windows: the main window's pages, and the editor and
//! video pages shared with the Chrome extension (src/ext, synced from it).

use log::warn;
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

static NEXT: AtomicU32 = AtomicU32::new(1);

/// Shows the main window on a page: home, library, dictation or settings.
pub fn show(app: &AppHandle, page: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        #[cfg(target_os = "macos")]
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    }
    let _ = app.emit_to("main", "navigate", page.to_string());
}

fn encode(path: &str) -> String {
    path.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn open_page(app: &AppHandle, page: &str, path: &str, title: &str, size: (f64, f64)) {
    let label = format!("viewer-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let url = format!("src/ext/{page}?id={}", encode(path));
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(size.0, size.1)
        .min_inner_size(720.0, 480.0)
        .resizable(true)
        .build();
    match built {
        Ok(w) => {
            let _ = w.set_focus();
            #[cfg(target_os = "macos")]
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
        }
        Err(e) => warn!("couldn't open {page}: {e}"),
    }
}

pub fn open_video(app: &AppHandle, path: &str) {
    let app2 = app.clone();
    let path = path.to_string();
    let _ = app.run_on_main_thread(move || open_page(&app2, "video.html", &path, "Recording · Gus Assistant", (1180.0, 760.0)));
}

pub fn open_editor(app: &AppHandle, path: &str) {
    let app2 = app.clone();
    let path = path.to_string();
    let _ = app.run_on_main_thread(move || open_page(&app2, "editor.html", &path, "Screenshot · Gus Assistant", (1200.0, 800.0)));
}

/// Opens a capture where it is worked on: a video in the video page, a
/// screenshot in the editor, a GIF in Preview.
pub fn open_any(app: &AppHandle, path: &str) {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".gif") {
        let _ = crate::capture::open(path);
    } else if lower.ends_with(".mp4") || lower.ends_with(".mov") || lower.ends_with(".webm") || lower.ends_with(".m4v") {
        open_video(app, path);
    } else {
        open_editor(app, path);
    }
}

/// Settings in a window of its own, as Mac apps do (⌘,). `page` picks the
/// tab: general, dictation, models, postprocessing, debug or about.
pub fn open_settings(app: &AppHandle, page: Option<&str>) {
    let page = page.unwrap_or("").to_string();
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        let _ = app2.set_activation_policy(tauri::ActivationPolicy::Regular);
        if let Some(w) = app2.get_webview_window("settings") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
            if !page.is_empty() {
                let _ = app2.emit_to("settings", "settings-page", page);
            }
            return;
        }
        let url = if page.is_empty() { "src/settings/index.html".to_string() } else { format!("src/settings/index.html?page={page}") };
        let mut builder = WebviewWindowBuilder::new(&app2, "settings", WebviewUrl::App(url.into()))
            .title("Settings")
            .inner_size(760.0, 640.0)
            .min_inner_size(620.0, 460.0)
            .resizable(true);
        #[cfg(target_os = "macos")]
        {
            builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
        }
        match builder.build() {
            Ok(w) => {
                let _ = w.set_focus();
            }
            Err(e) => warn!("couldn't open Settings: {e}"),
        }
    });
}

/// The Mac's accent colour as #rrggbb, so the app's highlight follows it.
#[cfg(target_os = "macos")]
fn accent_hex() -> Option<String> {
    use objc2_app_kit::{NSColor, NSColorSpace};
    #[allow(unused_unsafe)]
    unsafe {
        let srgb = NSColor::controlAccentColor().colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())?;
        let c = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
        Some(format!("#{:02x}{:02x}{:02x}", c(srgb.redComponent()), c(srgb.greenComponent()), c(srgb.blueComponent())))
    }
}

// ---------- commands ----------

#[tauri::command]
#[specta::specta]
pub fn open_settings_window(app: AppHandle, page: Option<String>) {
    open_settings(&app, page.as_deref());
}

#[tauri::command]
#[specta::specta]
pub fn system_accent() -> Option<String> {
    #[cfg(target_os = "macos")]
    return accent_hex();
    #[cfg(not(target_os = "macos"))]
    None
}

#[tauri::command]
#[specta::specta]
pub fn open_capture_page(app: AppHandle, path: String) -> Result<(), String> {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".mp4") || lower.ends_with(".mov") || lower.ends_with(".webm") || lower.ends_with(".m4v") {
        open_video(&app, &path);
    } else {
        open_editor(&app, &path);
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn show_page(app: AppHandle, page: String) {
    show(&app, &page);
}

/// The editor and video pages write files themselves (plugin-fs); this tells
/// the app's library and the extension that a new one landed.
#[tauri::command]
#[specta::specta]
pub fn notify_capture_saved(app: AppHandle, path: String) {
    let _ = app.emit("capture-saved", path.clone());
    crate::bridge::notify(&app, serde_json::json!({ "type": "capture-saved", "path": path }));
}

#[tauri::command]
#[specta::specta]
pub fn open_external_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only web links".into());
    }
    std::process::Command::new("/usr/bin/open").arg(&url).status().map(|_| ()).map_err(|e| e.to_string())
}
