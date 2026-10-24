//! Screenshots and screen recordings, through macOS's own `screencapture`.
//!
//! Everything lands in ~/Downloads/Ghostbar, the folder the Chrome
//! extension saves to as well, so the library shows both. Pictures are also
//! put on the clipboard, ready to paste.

use log::{info, warn};
use serde::Serialize;
use specta::Type;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const SCREENCAPTURE: &str = "/usr/sbin/screencapture";
const FOLDER: &str = "Ghostbar";
/// The folders used before the renames. Their files move into FOLDER at
/// launch; anything that couldn't move is still listed, never written to.
const LEGACY_FOLDERS: [&str; 2] = ["Gus Assistant", "Gus Screenshot"];

struct Recording {
    child: Child,
    path: PathBuf,
    started_ms: f64,
}

static RECORDING: Mutex<Option<Recording>> = Mutex::new(None);

#[derive(Clone, Copy, Debug)]
pub enum ShotMode {
    Area,
    Window,
    Screen,
}

impl ShotMode {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "area" => Some(Self::Area),
            "window" => Some(Self::Window),
            "screen" => Some(Self::Screen),
            _ => None,
        }
    }
}

#[derive(Serialize, Type, Clone)]
pub struct CaptureFile {
    pub path: String,
    pub name: String,
    /// "image", "gif" or "video"
    pub kind: String,
    pub size: f64,
    /// milliseconds since 1970
    pub modified: f64,
}

#[derive(Serialize, Type, Clone)]
pub struct RecordingState {
    pub recording: bool,
    pub started_ms: Option<f64>,
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"))
}

pub fn capture_dir() -> PathBuf {
    home().join("Downloads").join(FOLDER)
}

fn folders() -> Vec<PathBuf> {
    let downloads = home().join("Downloads");
    std::iter::once(capture_dir()).chain(LEGACY_FOLDERS.iter().map(|f| downloads.join(f))).collect()
}

/// Moves captures from the old folders into Downloads › Ghostbar, carrying
/// their titles and text along, and drops each old folder once it is empty.
/// A name already taken in the new folder stays where it is.
pub fn move_legacy_captures(app: &AppHandle) {
    let dir = capture_dir();
    let mut moved = Vec::new();
    for old in folders().into_iter().skip(1) {
        let Ok(entries) = fs::read_dir(&old) else { continue };
        if fs::create_dir_all(&dir).is_err() {
            return;
        }
        for entry in entries.flatten() {
            let from = entry.path();
            let to = dir.join(entry.file_name());
            if !from.is_file() || to.exists() {
                continue;
            }
            match fs::rename(&from, &to) {
                Ok(()) => moved.push((from.display().to_string(), to.display().to_string())),
                Err(e) => warn!("couldn't move {}: {e}", from.display()),
            }
        }
        // Finder's .DS_Store is the only thing allowed to be left behind.
        let _ = fs::remove_file(old.join(".DS_Store"));
        let _ = fs::remove_dir(&old);
    }
    if !moved.is_empty() {
        info!("moved {} captures into {}", moved.len(), dir.display());
        crate::capture_meta::rename_paths(app, &moved);
    }
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// "Screenshot 2026-10-19 at 14.05.33.png", made unique if it already exists.
fn new_path(stem: &str, ext: &str) -> Result<PathBuf, String> {
    let dir = capture_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
    let stamp = chrono::Local::now().format("%Y-%m-%d at %H.%M.%S");
    let mut path = dir.join(format!("{stem} {stamp}.{ext}"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem} {stamp} ({n}).{ext}"));
        n += 1;
    }
    Ok(path)
}

fn copy_png_to_clipboard(path: &Path) {
    let script = format!(
        "set the clipboard to (read (POSIX file \"{}\") as «class PNGf»)",
        path.display().to_string().replace('\\', "\\\\").replace('"', "\\\"")
    );
    if let Err(e) = Command::new("/usr/bin/osascript").args(["-e", &script]).status() {
        warn!("couldn't copy the screenshot to the clipboard: {e}");
    }
}

/// Copies a picture into the capture folder as a new screenshot.
pub fn save_screenshot(src: &Path) -> Result<PathBuf, String> {
    let dest = new_path("Screenshot", "png")?;
    fs::copy(src, &dest).map_err(|e| format!("couldn't save the screenshot: {e}"))?;
    Ok(dest)
}

/// Takes a screenshot on a background thread. Pressing Escape during an
/// interactive capture cancels it, which leaves no file and does nothing.
pub fn screenshot(app: &AppHandle, mode: ShotMode) {
    let app = app.clone();
    std::thread::spawn(move || {
        crate::capture_card::hide_before_capture(&app);
        let tmp = std::env::temp_dir().join(format!("ghostbar-{}.png", now_ms() as u64));
        let mut cmd = Command::new(SCREENCAPTURE);
        match mode {
            ShotMode::Area => cmd.arg("-i"),
            ShotMode::Window => cmd.args(["-i", "-W"]),
            ShotMode::Screen => cmd.arg("-m"),
        };
        cmd.arg(&tmp);
        if let Err(e) = cmd.status() {
            warn!("screencapture failed to start: {e}");
            return;
        }
        if !tmp.exists() {
            info!("screenshot cancelled");
            return;
        }
        // The pointer is still over what an area or window shot captured.
        let origin = crate::capture_meta::window_now(!matches!(mode, ShotMode::Screen));
        copy_png_to_clipboard(&tmp);
        let dest = match new_path("Screenshot", "png") {
            Ok(p) => p,
            Err(e) => return warn!("{e}"),
        };
        if fs::rename(&tmp, &dest).or_else(|_| fs::copy(&tmp, &dest).map(|_| ())).is_err() {
            return warn!("couldn't save the screenshot to {}", dest.display());
        }
        let _ = fs::remove_file(&tmp);
        info!("screenshot saved to {}", dest.display());
        crate::capture_meta::set_origin(&app, &dest.display().to_string(), origin);
        crate::capture_meta::read_text_later(&app, &dest);
        let _ = app.emit("capture-saved", dest.display().to_string());
        crate::capture_card::show(&app, &dest.display().to_string());
    });
}

/// Starts a screen recording, or stops the one running. Returns whether a
/// recording is running afterwards.
pub fn toggle_recording(app: &AppHandle) -> Result<bool, String> {
    let mut slot = RECORDING.lock().map_err(|_| "recording state poisoned".to_string())?;
    if let Some(mut rec) = slot.take() {
        // screencapture finishes and writes the movie on SIGINT, like Ctrl-C.
        let _ = Command::new("/bin/kill").args(["-INT", &rec.child.id().to_string()]).status();
        let app = app.clone();
        std::thread::spawn(move || {
            let _ = rec.child.wait();
            info!("screen recording saved to {}", rec.path.display());
            let _ = app.emit("screen-recording", false);
            crate::tray::update_tray_menu(&app);
            if rec.path.exists() {
                let _ = app.emit("capture-saved", rec.path.display().to_string());
                crate::capture_card::show(&app, &rec.path.display().to_string());
            }
        });
        return Ok(false);
    }
    let path = new_path("Screen recording", "mov")?;
    // -v video of the main screen, -k shows clicks, -g records the default microphone.
    let child = Command::new(SCREENCAPTURE)
        .args(["-v", "-k", "-g"])
        .arg(&path)
        .spawn()
        .map_err(|e| format!("couldn't start the recording: {e}"))?;
    *slot = Some(Recording { child, path, started_ms: now_ms() });
    drop(slot);
    let _ = app.emit("screen-recording", true);
    crate::tray::update_tray_menu(app);
    Ok(true)
}

pub fn recording_state() -> RecordingState {
    let mut slot = match RECORDING.lock() {
        Ok(s) => s,
        Err(_) => return RecordingState { recording: false, started_ms: None },
    };
    // The recording may have ended on its own (macOS stopped it, or it failed).
    if let Some(rec) = slot.as_mut() {
        if let Ok(Some(_)) = rec.child.try_wait() {
            *slot = None;
        }
    }
    RecordingState {
        recording: slot.is_some(),
        started_ms: slot.as_ref().map(|r| r.started_ms),
    }
}

fn kind_of(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" | "jpg" | "jpeg" | "heic" => Some("image"),
        "gif" => Some("gif"),
        "mov" | "mp4" | "webm" | "m4v" => Some("video"),
        _ => None,
    }
}

pub fn list() -> Vec<CaptureFile> {
    let mut out = Vec::new();
    for dir in folders() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(kind) = kind_of(&path) else { continue };
            let Ok(meta) = entry.metadata() else { continue };
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as f64)
                .unwrap_or(0.0);
            out.push(CaptureFile {
                name: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                path: path.display().to_string(),
                kind: kind.to_string(),
                size: meta.len() as f64,
                modified,
            });
        }
    }
    out.sort_by(|a, b| b.modified.partial_cmp(&a.modified).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// Only files inside the capture folders can be opened, revealed or binned.
fn checked(path: &str) -> Result<PathBuf, String> {
    let p = fs::canonicalize(path).map_err(|_| "that file no longer exists".to_string())?;
    let inside = folders()
        .iter()
        .filter_map(|d| fs::canonicalize(d).ok())
        .any(|d| p.starts_with(&d));
    if inside { Ok(p) } else { Err("not a Ghostbar capture".to_string()) }
}

pub fn open(path: &str) -> Result<(), String> {
    let p = checked(path)?;
    Command::new("/usr/bin/open").arg(&p).status().map(|_| ()).map_err(|e| e.to_string())
}

pub fn reveal(path: &str) -> Result<(), String> {
    let p = checked(path)?;
    Command::new("/usr/bin/open").arg("-R").arg(&p).status().map(|_| ()).map_err(|e| e.to_string())
}

pub fn open_folder() -> Result<(), String> {
    let dir = capture_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Command::new("/usr/bin/open").arg(&dir).status().map(|_| ()).map_err(|e| e.to_string())
}

/// Moves a capture to the Bin (recoverable), never deletes outright.
pub fn trash(path: &str) -> Result<(), String> {
    let p = checked(path)?;
    let script = format!(
        "tell application \"Finder\" to delete (POSIX file \"{}\" as alias)",
        p.display().to_string().replace('\\', "\\\\").replace('"', "\\\"")
    );
    let status = Command::new("/usr/bin/osascript").args(["-e", &script]).status().map_err(|e| e.to_string())?;
    if status.success() {
        info!("moved to the Bin: {}", p.display());
        Ok(())
    } else {
        Err("Finder couldn't move it to the Bin".to_string())
    }
}

/// A still of a video for the library, made once by Quick Look and kept in the
/// cache (keyed by path, size and date), so cards never decode video to draw.
pub fn thumbnail(path: &str, size: u32) -> Result<PathBuf, String> {
    use std::hash::{Hash, Hasher};
    let p = checked(path)?;
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    p.hash(&mut h);
    meta.len().hash(&mut h);
    meta.modified().ok().hash(&mut h);
    size.hash(&mut h);
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let dir = home.join("Library/Caches/com.gusdantas.assistant/thumbs");
    let out = dir.join(format!("{:016x}.png", h.finish()));
    if out.exists() {
        return Ok(out);
    }
    let work = dir.join(format!("work-{:016x}", h.finish()));
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let status = Command::new("/usr/bin/qlmanage")
        .args(["-t", "-s", &size.to_string(), "-o"])
        .arg(&work)
        .arg(&p)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| e.to_string())?;
    let made = fs::read_dir(&work).ok().and_then(|mut d| d.find_map(|e| e.ok().map(|e| e.path())));
    let result = match made {
        Some(file) if status.success() => fs::rename(&file, &out).map(|_| out.clone()).map_err(|e| e.to_string()),
        _ => Err("Quick Look made no thumbnail".to_string()),
    };
    let _ = fs::remove_dir_all(&work);
    result
}

/// Copies captures to the clipboard, the way Finder's Copy does, so they paste
/// as files in Finder and Slack. A single screenshot also goes as an image, so
/// it pastes straight into Teams, Outlook or a deck.
#[cfg(target_os = "macos")]
pub fn copy_files(paths: &[String]) -> Result<(), String> {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardItem, NSPasteboardTypeFileURL, NSPasteboardTypePNG, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSData, NSString, NSURL};

    let files: Vec<PathBuf> = paths.iter().map(|p| checked(p)).collect::<Result<_, _>>()?;
    if files.is_empty() {
        return Ok(());
    }
    let mut items: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = Vec::new();
    for file in &files {
        let url = NSURL::fileURLWithPath(&NSString::from_str(&file.display().to_string()));
        let item = NSPasteboardItem::new();
        #[allow(unused_unsafe)]
        unsafe {
            if let Some(s) = url.absoluteString() {
                item.setString_forType(&s, NSPasteboardTypeFileURL);
            }
            let is_png = file.extension().is_some_and(|e| e.eq_ignore_ascii_case("png"));
            if files.len() == 1 && is_png {
                if let Ok(bytes) = fs::read(file) {
                    item.setData_forType(&NSData::with_bytes(&bytes), NSPasteboardTypePNG);
                }
            }
        }
        items.push(ProtocolObject::from_retained(item));
    }
    #[allow(unused_unsafe)]
    let ok = unsafe {
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        pb.writeObjects(&NSArray::from_retained_slice(&items))
    };
    if ok { Ok(()) } else { Err("the clipboard refused the files".into()) }
}

/// Opens the system's Quick Look on the captures (Space in the library).
pub fn quick_look(paths: &[String]) -> Result<(), String> {
    let files: Vec<PathBuf> = paths.iter().map(|p| checked(p)).collect::<Result<_, _>>()?;
    Command::new("/usr/bin/qlmanage")
        .arg("-p")
        .args(&files)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// ---------- commands for the window ----------

#[tauri::command]
#[specta::specta]
pub fn copy_captures(paths: Vec<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return copy_files(&paths);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = paths;
        Err("copying files is only on macOS".into())
    }
}

#[tauri::command]
#[specta::specta]
pub fn quick_look_captures(paths: Vec<String>) -> Result<(), String> {
    quick_look(&paths)
}

#[tauri::command]
#[specta::specta]
pub fn trash_captures(app: AppHandle, paths: Vec<String>) -> Result<usize, String> {
    let mut done = 0;
    for p in &paths {
        if trash(p).is_ok() {
            done += 1;
        }
    }
    crate::tray::update_tray_menu(&app);
    Ok(done)
}

#[tauri::command]
#[specta::specta]
pub async fn capture_thumbnail(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || thumbnail(&path, 480).ok().map(|p| p.display().to_string()))
        .await
        .ok()
        .flatten()
}

/// The small picture that follows the pointer when a capture is dragged out.
#[tauri::command]
#[specta::specta]
pub async fn capture_drag_icon(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || thumbnail(&path, 128).ok().map(|p| p.display().to_string()))
        .await
        .ok()
        .flatten()
}

#[tauri::command]
#[specta::specta]
pub fn take_screenshot(app: AppHandle, mode: String) -> Result<(), String> {
    if mode == "text" {
        crate::text_grab::grab(&app);
        return Ok(());
    }
    let mode = ShotMode::parse(&mode).ok_or_else(|| format!("unknown screenshot mode {mode}"))?;
    screenshot(&app, mode);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn toggle_screen_recording(app: AppHandle) -> Result<bool, String> {
    toggle_recording(&app)
}

#[tauri::command]
#[specta::specta]
pub fn get_screen_recording_state() -> RecordingState {
    recording_state()
}

#[tauri::command]
#[specta::specta]
pub fn list_captures() -> Vec<CaptureFile> {
    list()
}

#[tauri::command]
#[specta::specta]
pub fn open_capture(path: String) -> Result<(), String> {
    open(&path)
}

#[tauri::command]
#[specta::specta]
pub fn reveal_capture(path: String) -> Result<(), String> {
    reveal(&path)
}

#[tauri::command]
#[specta::specta]
pub fn trash_capture(app: AppHandle, path: String) -> Result<(), String> {
    trash(&path)?;
    crate::tray::update_tray_menu(&app);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn open_capture_folder() -> Result<(), String> {
    open_folder()
}
