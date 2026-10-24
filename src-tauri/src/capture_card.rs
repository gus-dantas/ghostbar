//! The card that comes up in the corner after a screenshot or a Cast, like
//! CleanShot's: the next step is one click (copy, edit, show in Finder, bin)
//! or one drag into another app, without opening a window. It never takes the
//! keyboard, so pasting straight after a screenshot still goes to the app in
//! front. The page closes it by itself after a few seconds.

use crate::settings::get_settings;
use log::error;
use serde::Serialize;
use specta::Type;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};

#[cfg(target_os = "macos")]
use tauri_nspanel::{tauri_panel, CollectionBehavior, ManagerExt, PanelBuilder, PanelLevel, StyleMask};

pub const LABEL: &str = "capture-card";
/// The window, with room around the card for its shadow.
const SIZE: (f64, f64) = (300.0, 236.0);
/// From the corner of the screen to the window's edge.
const INSET: f64 = 8.0;

static CURRENT: Mutex<Option<CardItem>> = Mutex::new(None);

#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(CapturePanel {
        config: {
            can_become_key_window: false,
            is_floating_panel: true
        }
    })
}

#[derive(Clone, Serialize, Type, Debug)]
pub struct CardItem {
    pub path: String,
    /// "image", "gif" or "video"
    pub kind: String,
    pub title: String,
    pub size: f64,
    /// A new id each time, so the page restarts its countdown.
    pub shown_at: f64,
    /// Text from the screen: what was read, and the table when there was one.
    pub text: Option<String>,
    pub rows: Option<Vec<Vec<String>>>,
}

pub fn enabled(app: &AppHandle) -> bool {
    get_settings(app).capture_card
}

fn item(path: &str) -> CardItem {
    let p = std::path::Path::new(path);
    let name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let ext = p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    let kind = match ext.as_str() {
        "gif" => "gif",
        "mov" | "mp4" | "webm" | "m4v" => "video",
        _ => "image",
    };
    let title = if name.starts_with("cast") {
        "Cast"
    } else if kind == "video" {
        "Screen recording"
    } else if kind == "gif" {
        "GIF"
    } else {
        "Screenshot"
    };
    CardItem {
        path: path.to_string(),
        kind: kind.to_string(),
        title: title.to_string(),
        size: std::fs::metadata(p).map(|m| m.len() as f64).unwrap_or(0.0),
        shown_at: chrono::Local::now().timestamp_millis() as f64,
        text: None,
        rows: None,
    }
}

/// Bottom left of the screen the pointer is on (dictation has bottom right).
fn position(app: &AppHandle) -> (f64, f64) {
    let Some(monitor) = crate::overlay::get_monitor_with_cursor(app) else {
        return (40.0, 500.0);
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let x = area.position.x as f64 / scale + INSET;
    let y = (area.position.y as f64 + area.size.height as f64) / scale - SIZE.1 - INSET;
    (x, y)
}

/// Shows the card for a capture that just landed. False when Gus turned the
/// card off, so the caller can open the capture the old way instead.
pub fn show(app: &AppHandle, path: &str) -> bool {
    if !enabled(app) {
        return false;
    }
    present(app, item(path));
    true
}

/// Text from the screen always shows the card: it is the only sign the text
/// was read and copied.
pub fn show_text(app: &AppHandle, shot: &std::path::Path, grab: &crate::text_grab::Grab) {
    let mut card = item(&shot.display().to_string());
    card.kind = "text".into();
    card.title = if grab.rows.is_some() { "Table".into() } else { "Text".into() };
    card.text = Some(grab.text.clone());
    card.rows = grab.rows.clone();
    present(app, card);
}

fn present(app: &AppHandle, card: CardItem) {
    if let Ok(mut current) = CURRENT.lock() {
        *current = Some(card.clone());
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let (x, y) = position(&handle);
        #[cfg(target_os = "macos")]
        {
            if let Ok(panel) = handle.get_webview_panel(LABEL) {
                if let Some(win) = handle.get_webview_window(LABEL) {
                    let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
                }
                panel.show();
            } else {
                match build_panel(&handle, x, y) {
                    Ok(panel) => {
                        panel.set_hides_on_deactivate(false);
                        panel.set_accepts_mouse_moved_events(true);
                        panel.show();
                    }
                    Err(e) => error!("capture card: {e}"),
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            if let Some(w) = handle.get_webview_window(LABEL) {
                let _ = w.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
                let _ = w.show();
            } else {
                let _ = tauri::WebviewWindowBuilder::new(&handle, LABEL, WebviewUrl::App("src/card/index.html".into()))
                    .title("Gus Assistant Capture")
                    .position(x, y)
                    .inner_size(SIZE.0, SIZE.1)
                    .decorations(false)
                    .transparent(true)
                    .always_on_top(true)
                    .focused(false)
                    .build();
            }
        }
        let _ = handle.emit_to(LABEL, "card-show", card);
    });
}

#[cfg(target_os = "macos")]
fn build_panel(app: &AppHandle, x: f64, y: f64) -> Result<tauri_nspanel::PanelHandle<tauri::Wry>, String> {
    PanelBuilder::<_, CapturePanel>::new(app, LABEL)
        .url(WebviewUrl::App("src/card/index.html".into()))
        .title("Gus Assistant Capture")
        .position(tauri::Position::Logical(tauri::LogicalPosition { x, y }))
        .size(tauri::Size::Logical(tauri::LogicalSize { width: SIZE.0, height: SIZE.1 }))
        .level(PanelLevel::Floating)
        .has_shadow(false)
        .transparent(true)
        .no_activate(true)
        .corner_radius(0.0)
        .style_mask(StyleMask::empty().borderless().nonactivating_panel())
        .with_window(|w| w.decorations(false).transparent(true).focusable(false).visible(false))
        .collection_behavior(CollectionBehavior::new().can_join_all_spaces().full_screen_auxiliary())
        .build()
        .map_err(|e| e.to_string())
}

/// Puts the card away, e.g. before the next screenshot so it isn't in it.
pub fn hide(app: &AppHandle) {
    if let Ok(mut current) = CURRENT.lock() {
        *current = None;
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        if let Ok(panel) = handle.get_webview_panel(LABEL) {
            panel.hide();
            return;
        }
        if let Some(w) = handle.get_webview_window(LABEL) {
            let _ = w.hide();
        }
    });
}

/// Hides the card and waits a moment for it to leave the screen.
pub fn hide_before_capture(app: &AppHandle) {
    let shown = CURRENT.lock().map(|c| c.is_some()).unwrap_or(false);
    if shown {
        hide(app);
        std::thread::sleep(std::time::Duration::from_millis(120));
    }
}

// ---------- commands for the card page ----------

#[tauri::command]
#[specta::specta]
pub fn capture_card_current() -> Option<CardItem> {
    CURRENT.lock().ok().and_then(|c| c.clone())
}

#[tauri::command]
#[specta::specta]
pub fn capture_card_close(app: AppHandle) {
    hide(&app);
}

/// The card's Edit (a screenshot) or Open (a video): the page it's worked on.
#[tauri::command]
#[specta::specta]
pub fn capture_card_open(app: AppHandle, path: String) {
    hide(&app);
    crate::shell::open_any(&app, &path);
}

#[tauri::command]
#[specta::specta]
pub fn capture_card_settings(app: AppHandle) -> bool {
    enabled(&app)
}

#[tauri::command]
#[specta::specta]
pub fn capture_card_set_enabled(app: AppHandle, enabled: bool) {
    let mut settings = get_settings(&app);
    settings.capture_card = enabled;
    crate::settings::write_settings(&app, settings);
    if !enabled {
        hide(&app);
    }
}
