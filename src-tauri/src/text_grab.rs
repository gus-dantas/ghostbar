//! Text from the screen: drag over an area and its text goes to the clipboard.
//! A table goes as a table (tab-separated plus HTML), so it pastes into Excel
//! or Outlook with its rows and columns. Vision does the reading
//! (swift/text_grab.swift); the picture itself stays out of the library unless
//! Gus saves it from the card.

use log::{info, warn};
use serde::Deserialize;
use std::ffi::{c_char, CStr, CString};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::AppHandle;

extern "C" {
    fn gtext_recognize(path: *const c_char) -> *mut c_char;
    fn gtext_free(p: *mut c_char);
}

#[derive(Deserialize, Default, Clone, Debug)]
pub struct Grab {
    #[serde(default)]
    pub text: String,
    /// The biggest real table in the picture, row by row.
    #[serde(default)]
    pub rows: Option<Vec<Vec<String>>>,
}

/// The last grab, for the card's Copy buttons and Save image.
static LAST: Mutex<Option<(PathBuf, Grab)>> = Mutex::new(None);
/// The app and window it was read from.
static ORIGIN: Mutex<Option<(String, String)>> = Mutex::new(None);

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

pub fn recognize(path: &Path) -> Grab {
    let Ok(c) = CString::new(path.display().to_string()) else { return Grab::default() };
    let raw = unsafe { gtext_recognize(c.as_ptr()) };
    if raw.is_null() {
        return Grab::default();
    }
    let json = unsafe { CStr::from_ptr(raw) }.to_string_lossy().to_string();
    unsafe { gtext_free(raw) };
    serde_json::from_str(&json).unwrap_or_default()
}

/// Tab-separated, the plain-text form Excel and Numbers split into cells.
pub fn tsv(rows: &[Vec<String>]) -> String {
    rows.iter()
        .map(|r| r.iter().map(|c| c.replace(['\t', '\n'], " ")).collect::<Vec<_>>().join("\t"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// A plain HTML table, for apps that paste rich text (Outlook, Word, Teams).
pub fn html(rows: &[Vec<String>]) -> String {
    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let mut out = String::from("<table>");
    for (i, row) in rows.iter().enumerate() {
        out.push_str("<tr>");
        let tag = if i == 0 { "th" } else { "td" };
        for cell in row {
            out.push_str(&format!("<{tag}>{}</{tag}>", esc(cell)));
        }
        out.push_str("</tr>");
    }
    out.push_str("</table>");
    out
}

#[cfg(target_os = "macos")]
fn copy_to_clipboard(plain: &str, rich: Option<&str>) -> Result<(), String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeHTML, NSPasteboardTypeString};
    use objc2_foundation::NSString;
    #[allow(unused_unsafe)]
    let ok = unsafe {
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        let mut ok = pb.setString_forType(&NSString::from_str(plain), NSPasteboardTypeString);
        if let Some(h) = rich {
            ok &= pb.setString_forType(&NSString::from_str(h), NSPasteboardTypeHTML);
        }
        ok
    };
    if ok { Ok(()) } else { Err("the clipboard refused the text".into()) }
}

#[cfg(not(target_os = "macos"))]
fn copy_to_clipboard(_plain: &str, _rich: Option<&str>) -> Result<(), String> {
    Err("text from the screen is only on macOS".into())
}

/// Puts a grab on the clipboard: the table when asked and there is one,
/// otherwise all the text.
fn copy(grab: &Grab, as_table: bool) -> Result<(), String> {
    match (&grab.rows, as_table) {
        (Some(rows), true) => copy_to_clipboard(&tsv(rows), Some(&html(rows))),
        _ if grab.text.trim().is_empty() => Err("no text found".into()),
        _ => copy_to_clipboard(&grab.text, None),
    }
}

fn work_dir() -> PathBuf {
    std::env::temp_dir().join("ghostbar-text")
}

/// Drag over an area; its text (or table) lands on the clipboard and the card
/// shows what was read. Escape during the drag cancels it.
pub fn grab(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        crate::capture_card::hide_before_capture(&app);
        let dir = work_dir();
        // Only the newest picture is kept, for Save image.
        let _ = fs::remove_dir_all(&dir);
        if let Err(e) = fs::create_dir_all(&dir) {
            return warn!("text grab: {e}");
        }
        let shot = dir.join(format!("{}.png", now_ms()));
        if let Err(e) = Command::new("/usr/sbin/screencapture").arg("-i").arg(&shot).status() {
            return warn!("screencapture failed to start: {e}");
        }
        if !shot.exists() {
            let _ = tauri::Emitter::emit(&app, "text-grab-done", false);
            return info!("text grab cancelled");
        }
        let origin = crate::capture_meta::window_now(true);
        let found = recognize(&shot);
        let copied = copy(&found, true).is_ok();
        info!(
            "text grab: {} characters, table {:?}, copied {copied}",
            found.text.chars().count(),
            found.rows.as_ref().map(|r| (r.len(), r.first().map_or(0, |c| c.len())))
        );
        if let Ok(mut last) = LAST.lock() {
            *last = Some((shot.clone(), found.clone()));
        }
        if let Ok(mut o) = ORIGIN.lock() {
            *o = origin;
        }
        crate::capture_card::show_text(&app, &shot, &found);
        let _ = tauri::Emitter::emit(&app, "text-grab-done", true);
    });
}

// ---------- commands for the card ----------

#[tauri::command]
#[specta::specta]
pub fn text_grab_copy(as_table: bool) -> Result<(), String> {
    let last = LAST.lock().map_err(|_| "busy".to_string())?;
    let (_, grab) = last.as_ref().ok_or("nothing read yet")?;
    copy(grab, as_table)
}

/// Keeps the picture behind the text as a screenshot in the library.
#[tauri::command]
#[specta::specta]
pub fn text_grab_save(app: AppHandle) -> Result<String, String> {
    let (shot, grab) = LAST.lock().ok().and_then(|l| l.clone()).ok_or("nothing to save")?;
    let dest = crate::capture::save_screenshot(&shot)?;
    let shown = dest.display().to_string();
    crate::capture_meta::set_text(&app, &shown, &grab.text);
    crate::capture_meta::set_origin(&app, &shown, ORIGIN.lock().ok().and_then(|o| o.clone()));
    tauri::Emitter::emit(&app, "capture-saved", shown.clone()).ok();
    Ok(shown)
}

#[cfg(test)]
mod tests {
    use super::{html, recognize, tsv};

    /// TEXT_GRAB_IMAGE=/path/table.png cargo test --release --lib text_grab_real -- --ignored --nocapture
    #[test]
    #[ignore]
    fn text_grab_real() {
        let path = std::env::var("TEXT_GRAB_IMAGE").expect("TEXT_GRAB_IMAGE");
        let grab = recognize(std::path::Path::new(&path));
        println!("{grab:?}");
        assert!(!grab.text.is_empty());
    }

    #[test]
    fn tables_paste_as_cells() {
        let rows = vec![
            vec!["Supplier".to_string(), "Booked".to_string()],
            vec!["Hills & Co".to_string(), "$12,400".to_string()],
        ];
        assert_eq!(tsv(&rows), "Supplier\tBooked\nHills & Co\t$12,400");
        assert_eq!(
            html(&rows),
            "<table><tr><th>Supplier</th><th>Booked</th></tr><tr><td>Hills &amp; Co</td><td>$12,400</td></tr></table>"
        );
    }
}
