//! What each capture shows, beyond its file: the app and window it came from
//! and the text in it (read by Vision), so the library can title a capture by
//! what it shows and search inside it. One small JSON file next to the
//! settings holds it, keyed by the capture's path.

use log::{info, warn};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::ffi::{c_char, CStr};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

extern "C" {
    fn gmeta_window(under_pointer: bool) -> *mut c_char;
    fn gtext_free(p: *mut c_char);
}

#[derive(Serialize, Deserialize, Clone, Default, Debug, Type)]
pub struct CaptureMeta {
    /// "Google Chrome", "Microsoft PowerPoint"…
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    /// The window's title, e.g. "Weekly report - Google Chrome".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
    /// The text Vision read in a screenshot ("" once read and none found).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

static STORE: Lazy<Mutex<Option<HashMap<String, CaptureMeta>>>> = Lazy::new(|| Mutex::new(None));
/// Only so much text is kept per capture; enough to search and to quote.
const TEXT_LIMIT: usize = 4000;

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("captures.json"))
}

fn with_store<T>(app: &AppHandle, f: impl FnOnce(&mut HashMap<String, CaptureMeta>) -> T) -> T {
    let mut guard = STORE.lock().unwrap_or_else(|p| p.into_inner());
    if guard.is_none() {
        let loaded = file(app)
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        *guard = Some(loaded);
    }
    f(guard.as_mut().expect("loaded above"))
}

fn save(app: &AppHandle) {
    let json = with_store(app, |s| serde_json::to_string(s).unwrap_or_default());
    if let Some(path) = file(app) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).and_then(|_| std::fs::rename(&tmp, &path)).is_err() {
            warn!("capture meta: couldn't save {}", path.display());
        }
    }
}

fn update(app: &AppHandle, path: &str, f: impl FnOnce(&mut CaptureMeta)) {
    with_store(app, |s| f(s.entry(path.to_string()).or_default()));
    save(app);
    let _ = app.emit("capture-meta", path.to_string());
}

/// The app and window under the pointer, or the front one.
pub fn window_now(under_pointer: bool) -> Option<(String, String)> {
    #[derive(Deserialize)]
    struct Origin {
        app: String,
        window: String,
    }
    let raw = unsafe { gmeta_window(under_pointer) };
    if raw.is_null() {
        return None;
    }
    let json = unsafe { CStr::from_ptr(raw) }.to_string_lossy().to_string();
    unsafe { gtext_free(raw) };
    let o: Origin = serde_json::from_str(&json).ok()?;
    Some((o.app, o.window))
}

/// Records where a capture came from.
pub fn set_origin(app: &AppHandle, path: &str, origin: Option<(String, String)>) {
    let Some((app_name, window)) = origin else { return };
    update(app, path, |m| {
        m.app = Some(app_name).filter(|s| !s.is_empty());
        m.window = Some(window).filter(|s| !s.is_empty());
    });
}

/// The text is already known (text from the screen, saved as a screenshot).
pub fn set_text(app: &AppHandle, path: &str, text: &str) {
    let text: String = text.trim().chars().take(TEXT_LIMIT).collect();
    update(app, path, |m| m.text = Some(text));
}

/// Reads the text in a screenshot, off the caller's thread.
pub fn read_text_later(app: &AppHandle, path: &Path) {
    let app = app.clone();
    let path = path.to_path_buf();
    std::thread::spawn(move || read_text(&app, &path));
}

fn read_text(app: &AppHandle, path: &Path) {
    let grab = crate::text_grab::recognize(path);
    let mut text = grab.text.trim().to_string();
    if text.chars().count() > TEXT_LIMIT {
        text = text.chars().take(TEXT_LIMIT).collect();
    }
    update(app, &path.display().to_string(), |m| m.text = Some(text));
}

/// Screenshots taken before the library read text get read once, in the
/// background, newest first.
pub fn backfill(app: &AppHandle) {
    let app = app.clone();
    std::thread::Builder::new()
        .name("capture-meta".into())
        .spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(20));
            let unread: Vec<String> = crate::capture::list()
                .into_iter()
                .filter(|f| f.kind == "image")
                .map(|f| f.path)
                .filter(|p| with_store(&app, |s| s.get(p).and_then(|m| m.text.as_ref()).is_none()))
                .take(300)
                .collect();
            if unread.is_empty() {
                return;
            }
            info!("capture meta: reading the text in {} screenshots", unread.len());
            for p in unread {
                read_text(&app, Path::new(&p));
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
        })
        .ok();
}

#[tauri::command]
#[specta::specta]
pub fn capture_meta(app: AppHandle) -> HashMap<String, CaptureMeta> {
    with_store(&app, |s| s.clone())
}
