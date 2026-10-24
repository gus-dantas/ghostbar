//! Cast: screen-and-face videos. Pick a screen or a window, landscape or a
//! 9:16 phone frame you steer, a round face bubble placed where you want it,
//! a prompter with cue cards, countdown, pause, restart and stop. The video is
//! composited natively (swift/cast_engine.swift), so what the preview shows is
//! what the file gets, and none of Cast's own windows are ever in it.
//!
//! In landscape the face bubble also floats on the screen like Loom: drag it
//! and the face moves in the video. In the phone frame it's placed in the
//! preview instead.

use base64::Engine as _;
use log::{info, warn};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_double, c_int};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WindowEvent};

#[cfg(target_os = "macos")]
use tauri_nspanel::{tauri_panel, CollectionBehavior, ManagerExt, PanelBuilder, PanelLevel, StyleMask};

const PANEL: &str = "cast";
const BUBBLE: &str = "bubble";
const PROMPTER: &str = "prompter";
/// Room around the on-screen bubble for its shadow, so the window's edge never shows.
const BUBBLE_MARGIN: f64 = 24.0;

extern "C" {
    fn gcast_free(p: *mut c_char);
    fn gcast_free_bytes(p: *mut u8, len: usize);
    fn gcast_last_error() -> *const c_char;
    fn gcast_has_permission() -> c_int;
    fn gcast_request_permission() -> c_int;
    fn gcast_sources() -> *mut c_char;
    fn gcast_thumbnail(kind: *const c_char, id: u32, max_width: c_double, out: *mut *mut u8, len: *mut usize) -> c_int;
    fn gcast_prepare(kind: *const c_char, id: u32, camera: c_int, system_audio: c_int) -> c_int;
    fn gcast_set_view(vertical: c_int, cx: c_double, cy: c_double, zoom: c_double);
    fn gcast_set_bubble(x: c_double, y: c_double, size: c_double, face_zoom: c_double, show: c_int);
    fn gcast_preview(which: c_int, max_width: c_double, out: *mut *mut u8, len: *mut usize) -> c_int;
    fn gcast_record(microphone: c_int) -> c_int;
    fn gcast_pause();
    fn gcast_resume();
    fn gcast_elapsed_ms() -> c_double;
    fn gcast_failure() -> *mut c_char;
    fn gcast_stop(path: *const c_char) -> c_int;
    fn gcast_discard();
    fn gcast_close();
    #[allow(dead_code)]
    fn gcast_selftest(path: *const c_char, vertical: c_int) -> c_int;
}

#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(CastBubblePanel {
        config: {
            can_become_key_window: false,
            is_floating_panel: true
        }
    })
    panel!(CastPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Type, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Idle,
    Setup,
    Recording,
    Paused,
    Saving,
}

/// A screen or a window, in global points from the top left.
#[derive(Clone, Serialize, Deserialize, Type, Debug, Default)]
pub struct Source {
    pub kind: String,
    pub id: u32,
    pub name: String,
    pub app: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Serialize, Deserialize, Type, Debug)]
pub struct Mark {
    /// ms into the recording (pauses excluded)
    pub t: f64,
    pub beat: u32,
    /// start | redo | end
    pub kind: String,
}

#[derive(Clone, Serialize, Type)]
pub struct CastState {
    pub phase: Phase,
    pub elapsed_ms: f64,
    pub permission: bool,
    /// Capture stopped on its own (e.g. the window closed).
    pub failure: Option<String>,
}

#[derive(Clone, Deserialize, Type, Debug)]
pub struct StartOptions {
    pub microphone: bool,
    /// Prompter block titles, empty when the prompter is off.
    pub blocks: Vec<String>,
}

#[derive(Clone, Copy, Deserialize, Serialize, Type, Debug)]
pub struct BubbleLook {
    /// centre, as a share of the video from the top left
    pub x: f64,
    pub y: f64,
    /// diameter, as a share of the video's shorter side
    pub size: f64,
    pub face_zoom: f64,
    pub show: bool,
}

struct Session {
    phase: Phase,
    marks: Vec<Mark>,
    blocks: Vec<String>,
    source: Option<Source>,
    vertical: bool,
    bubble: BubbleLook,
    camera: bool,
}

static SESSION: Mutex<Session> = Mutex::new(Session {
    phase: Phase::Idle,
    marks: Vec::new(),
    blocks: Vec::new(),
    source: None,
    vertical: false,
    bubble: BubbleLook { x: 0.1, y: 0.82, size: 0.22, face_zoom: 1.0, show: true },
    camera: true,
});

fn last_error() -> String {
    unsafe {
        let p = gcast_last_error();
        if p.is_null() { "unknown error".into() } else { CStr::from_ptr(p).to_string_lossy().into_owned() }
    }
}

fn set_phase(app: &AppHandle, phase: Phase) {
    if let Ok(mut s) = SESSION.lock() {
        s.phase = phase;
    }
    let _ = app.emit("cast-state", state());
    crate::tray::update_tray_menu(app);
}

pub fn phase() -> Phase {
    SESSION.lock().map(|s| s.phase).unwrap_or(Phase::Idle)
}

pub fn is_recording() -> bool {
    matches!(phase(), Phase::Recording | Phase::Paused)
}

pub fn state() -> CastState {
    let phase = phase();
    let elapsed_ms = if matches!(phase, Phase::Recording | Phase::Paused) { unsafe { gcast_elapsed_ms() } } else { 0.0 };
    let failure = unsafe {
        let p = gcast_failure();
        if p.is_null() {
            None
        } else {
            let s = CStr::from_ptr(p).to_string_lossy().into_owned();
            gcast_free(p);
            Some(s)
        }
    };
    CastState { phase, elapsed_ms, permission: unsafe { gcast_has_permission() } == 1, failure }
}

fn jpeg_url(call: impl FnOnce(*mut *mut u8, *mut usize) -> c_int) -> Option<String> {
    let mut ptr: *mut u8 = std::ptr::null_mut();
    let mut len: usize = 0;
    if call(&mut ptr, &mut len) != 0 || ptr.is_null() {
        return None;
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
    unsafe { gcast_free_bytes(ptr, len) };
    Some(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

// ---------- windows ----------

fn screen_area(app: &AppHandle) -> (f64, f64, f64, f64) {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    match monitor {
        Some(m) => {
            let scale = m.scale_factor();
            let pos = m.position().to_logical::<f64>(scale);
            let size = m.size().to_logical::<f64>(scale);
            (pos.x, pos.y, size.width, size.height)
        }
        None => (0.0, 0.0, 1440.0, 900.0),
    }
}

/// AppKit builds windows only on the main thread; shortcuts and the recorder
/// call in from their own threads, so the panel is built there.
#[cfg(target_os = "macos")]
fn floating_panel<P: tauri_nspanel::FromWindow<tauri::Wry> + 'static>(
    app: &AppHandle,
    label: &str,
    page: &str,
    title: &str,
    rect: (f64, f64, f64, f64),
    focusable: bool,
    on_ready: Option<fn(&AppHandle)>,
) {
    let handle = app.clone();
    let (label, page, title) = (label.to_string(), page.to_string(), title.to_string());
    let _ = app.run_on_main_thread(move || {
        if let Some(win) = handle.get_webview_window(&label) {
            let _ = win.show();
            return;
        }
        let (x, y, w, h) = rect;
        let mut mask = StyleMask::empty().borderless();
        if !focusable {
            mask = mask.nonactivating_panel();
        }
        let built = PanelBuilder::<_, P>::new(&handle, &label)
            .url(WebviewUrl::App(page.into()))
            .title(&title)
            .position(tauri::Position::Logical(tauri::LogicalPosition { x, y }))
            .size(tauri::Size::Logical(tauri::LogicalSize { width: w, height: h }))
            .level(PanelLevel::Floating)
            .has_shadow(false)
            .transparent(true)
            .no_activate(!focusable)
            .corner_radius(0.0)
            .style_mask(mask)
            .with_window({
                let title = title.clone();
                move |win| win.decorations(false).transparent(true).focusable(focusable).title(&title)
            })
            .collection_behavior(CollectionBehavior::new().can_join_all_spaces().full_screen_auxiliary())
            .build();
        match built {
            Ok(panel) => {
                panel.show();
                if let Some(f) = on_ready {
                    f(&handle);
                }
            }
            Err(e) => warn!("couldn't open {label}: {e}"),
        }
    });
}

/// Closes one of Cast's windows for good. A panel's close only hid it, so the
/// bubble kept its page alive and the camera on after a Cast had ended: the
/// camera is told to stop first, then the panel is forgotten and destroyed.
fn close_window(app: &AppHandle, label: &str) {
    let _ = app.emit_to(label, "cast-camera-off", ());
    let app2 = app.clone();
    let label = label.to_string();
    let _ = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        if let Some(panel) = app2.remove_webview_panel(&label) {
            panel.hide();
        }
        if let Some(w) = app2.get_webview_window(&label) {
            if let Err(e) = w.destroy() {
                warn!("cast: couldn't close {label}: {e}");
            }
        }
    });
}

/// Opens Cast's setup panel (or brings back the controls while recording).
pub fn open(app: &AppHandle) {
    if is_recording() {
        if let Some(w) = app.get_webview_window(PANEL) {
            let _ = w.show();
        }
        return;
    }
    let (sx, sy, sw, sh) = screen_area(app);
    let (w, h) = (420.0, 720.0_f64.min(sh - 80.0));
    #[cfg(target_os = "macos")]
    floating_panel::<CastPanel>(app, PANEL, "src/capture/cast.html", "Gus Assistant Cast", (sx + sw - w - 24.0, sy + (sh - h) / 2.0, w, h), true, None);
    set_phase(app, Phase::Setup);
}

/// Where the on-screen bubble sits, as the video's bubble position (landscape).
fn follow_bubble(app: &AppHandle) {
    let Some(win) = app.get_webview_window(BUBBLE) else { return };
    let (Ok(pos), Ok(size), Ok(scale)) = (win.outer_position(), win.outer_size(), win.scale_factor()) else { return };
    let (pos, size) = (pos.to_logical::<f64>(scale), size.to_logical::<f64>(scale));
    let mut s = SESSION.lock().unwrap();
    let Some(src) = s.source.clone() else { return };
    if s.vertical || src.w <= 0.0 || src.h <= 0.0 {
        return;
    }
    s.bubble.x = ((pos.x + size.width / 2.0 - src.x) / src.w).clamp(0.0, 1.0);
    s.bubble.y = ((pos.y + size.height / 2.0 - src.y) / src.h).clamp(0.0, 1.0);
    s.bubble.size = (size.width - 2.0 * BUBBLE_MARGIN) / src.w.min(src.h);
    let b = s.bubble;
    drop(s);
    apply_bubble(b);
    let _ = app.emit_to(PANEL, "cast-bubble-moved", b);
}

fn watch_bubble(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(BUBBLE) {
        let handle = app.clone();
        win.on_window_event(move |e| {
            if matches!(e, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
                follow_bubble(&handle);
            }
        });
    }
}

/// The face floating on screen, in landscape: placed and sized to match the video.
fn place_screen_bubble(app: &AppHandle) {
    let s = SESSION.lock().unwrap();
    let show = s.camera && s.bubble.show && !s.vertical && s.source.is_some() && s.phase != Phase::Idle;
    let (src, b) = (s.source.clone().unwrap_or_default(), s.bubble);
    drop(s);
    if !show {
        close_window(app, BUBBLE);
        return;
    }
    let d = (b.size * src.w.min(src.h)).clamp(60.0, 600.0) + 2.0 * BUBBLE_MARGIN;
    let (x, y) = (src.x + b.x * src.w - d / 2.0, src.y + b.y * src.h - d / 2.0);
    if let Some(w) = app.get_webview_window(BUBBLE) {
        let _ = w.set_size(tauri::LogicalSize::new(d, d));
        let _ = w.set_position(tauri::LogicalPosition::new(x, y));
        let _ = w.show();
        return;
    }
    #[cfg(target_os = "macos")]
    floating_panel::<CastBubblePanel>(app, BUBBLE, "src/capture/bubble.html", "Gus Assistant Camera", (x, y, d, d), false, Some(watch_bubble));
}

fn open_prompter(app: &AppHandle) {
    let (sx, sy, sw, _sh) = screen_area(app);
    let (w, h) = (560.0, 250.0);
    #[cfg(target_os = "macos")]
    floating_panel::<CastPanel>(app, PROMPTER, "src/capture/prompter.html", "Gus Assistant Prompter", (sx + (sw - w) / 2.0, sy + 40.0, w, h), true, None);
}

fn close_all(app: &AppHandle) {
    for label in [PANEL, BUBBLE, PROMPTER] {
        close_window(app, label);
    }
}

fn apply_bubble(b: BubbleLook) {
    unsafe { gcast_set_bubble(b.x, b.y, b.size, b.face_zoom, b.show as c_int) };
}

// ---------- recording ----------

fn recording_path() -> Result<PathBuf, String> {
    let dir = crate::capture::capture_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = chrono::Local::now().format("%Y-%m-%d at %H.%M.%S");
    Ok(dir.join(format!("Cast {stamp}.mp4")))
}

pub fn prepare(app: &AppHandle, source: Source, camera: bool, system_audio: bool) -> Result<(), String> {
    if is_recording() {
        return Err("already recording".into());
    }
    if unsafe { gcast_has_permission() } != 1 {
        unsafe { gcast_request_permission() };
        return Err("Gus Assistant needs permission to record the screen: turn it on in System Settings › Privacy & Security › Screen & System Audio Recording, then reopen Gus Assistant.".into());
    }
    let kind = CString::new(source.kind.clone()).map_err(|e| e.to_string())?;
    if unsafe { gcast_prepare(kind.as_ptr(), source.id, camera as c_int, system_audio as c_int) } != 0 {
        return Err(last_error());
    }
    let (vertical, b) = {
        let mut s = SESSION.lock().unwrap();
        s.source = Some(source);
        s.camera = camera;
        (s.vertical, s.bubble)
    };
    apply_bubble(b);
    let _ = vertical;
    place_screen_bubble(app);
    Ok(())
}

pub fn start(app: &AppHandle, options: StartOptions) -> Result<(), String> {
    if !matches!(phase(), Phase::Setup | Phase::Idle) {
        return Err("already recording".into());
    }
    if unsafe { gcast_record(options.microphone as c_int) } != 0 {
        return Err(last_error());
    }
    if let Ok(mut s) = SESSION.lock() {
        s.blocks = options.blocks.clone();
        s.marks = if options.blocks.is_empty() { vec![] } else { vec![Mark { t: 0.0, beat: 0, kind: "start".into() }] };
    }
    if !options.blocks.is_empty() {
        open_prompter(app);
    }
    info!("cast recording started");
    set_phase(app, Phase::Recording);
    Ok(())
}

pub fn pause(app: &AppHandle) {
    match phase() {
        Phase::Recording => {
            unsafe { gcast_pause() };
            set_phase(app, Phase::Paused);
        }
        Phase::Paused => {
            unsafe { gcast_resume() };
            set_phase(app, Phase::Recording);
        }
        _ => {}
    }
}

/// Stops, saves to Downloads › Gus Assistant and opens the result.
pub fn stop(app: &AppHandle) -> Result<String, String> {
    if !is_recording() {
        return Err("not recording".into());
    }
    set_phase(app, Phase::Saving);
    let path = recording_path()?;
    let c = CString::new(path.display().to_string()).map_err(|e| e.to_string())?;
    let rc = unsafe { gcast_stop(c.as_ptr()) };
    let (marks, blocks) = SESSION.lock().map(|s| (s.marks.clone(), s.blocks.clone())).unwrap_or_default();
    unsafe { gcast_close() };
    close_all(app);
    set_phase(app, Phase::Idle);
    if rc != 0 {
        return Err(last_error());
    }
    if !marks.is_empty() {
        // The prompter's time marks, beside the movie, for reelkit.
        let sidecar = path.with_extension("marks.json");
        let _ = std::fs::write(&sidecar, serde_json::json!({ "marks": marks, "blocks": blocks }).to_string());
    }
    let shown = path.display().to_string();
    info!("cast saved to {shown}");
    let origin = SESSION
        .lock()
        .ok()
        .and_then(|s| s.source.clone())
        .filter(|src| src.kind == "window")
        .map(|src| (src.app, src.name));
    crate::capture_meta::set_origin(app, &shown, origin);
    let _ = app.emit("capture-saved", shown.clone());
    crate::bridge::notify(app, serde_json::json!({ "type": "capture-saved", "path": shown }));
    if !crate::capture_card::show(app, &shown) {
        crate::shell::open_video(app, &shown);
    }
    Ok(shown)
}

pub fn discard(app: &AppHandle) {
    unsafe { gcast_close() };
    close_all(app);
    set_phase(app, Phase::Idle);
}

/// Throws the take away and goes back to setup, capture still running.
pub fn restart(app: &AppHandle) {
    if is_recording() {
        unsafe { gcast_discard() };
    }
    close_window(app, PROMPTER);
    set_phase(app, Phase::Setup);
}

/// The shortcut, the tray and the extension: open Cast, or stop if recording.
pub fn toggle(app: &AppHandle) {
    match phase() {
        Phase::Recording | Phase::Paused => {
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(e) = stop(&app) {
                    warn!("stopping the recording: {e}");
                }
            });
        }
        Phase::Saving => {}
        _ => open(app),
    }
}

pub fn mark(kind: &str, beat: u32) {
    if let Ok(mut s) = SESSION.lock() {
        let t = unsafe { gcast_elapsed_ms() }.round();
        s.marks.push(Mark { t, beat, kind: kind.to_string() });
    }
}

// ---------- commands ----------

#[tauri::command]
#[specta::specta]
pub fn cast_open(app: AppHandle) {
    open(&app);
}

#[tauri::command]
#[specta::specta]
pub fn cast_state() -> CastState {
    state()
}

#[tauri::command]
#[specta::specta]
pub fn cast_request_permission() -> bool {
    let granted = unsafe { gcast_request_permission() == 1 };
    if !granted {
        // macOS asks only once; after that, go straight to the list.
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .spawn();
    }
    granted
}

/// macOS applies a new screen-recording permission only to a fresh process.
#[tauri::command]
#[specta::specta]
pub fn cast_relaunch(app: AppHandle) {
    info!("relaunching so the screen-recording permission applies");
    app.restart();
}

#[tauri::command]
#[specta::specta]
pub async fn cast_sources() -> Result<Vec<Source>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let p = unsafe { gcast_sources() };
        if p.is_null() {
            return Err(last_error());
        }
        let json = unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
        unsafe { gcast_free(p) };
        serde_json::from_str(&json).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn cast_thumbnail(kind: String, id: u32) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let kind = CString::new(kind).ok()?;
        jpeg_url(|out, len| unsafe { gcast_thumbnail(kind.as_ptr(), id, 220.0, out, len) })
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
#[specta::specta]
pub async fn cast_prepare(app: AppHandle, source: Source, camera: bool, system_audio: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || prepare(&app, source, camera, system_audio)).await.map_err(|e| e.to_string())?
}

/// Landscape or the 9:16 phone frame, and where the frame points (it eases there).
#[tauri::command]
#[specta::specta]
pub fn cast_view(app: AppHandle, vertical: bool, cx: f64, cy: f64, zoom: f64) {
    let changed = {
        let mut s = SESSION.lock().unwrap();
        let changed = s.vertical != vertical;
        s.vertical = vertical;
        changed
    };
    unsafe { gcast_set_view(vertical as c_int, cx, cy, zoom) };
    if changed {
        place_screen_bubble(&app);
    }
}

/// Bubble position, size and face zoom from the panel (and on/off).
#[tauri::command]
#[specta::specta]
pub fn cast_bubble(app: AppHandle, bubble: BubbleLook) {
    SESSION.lock().unwrap().bubble = bubble;
    apply_bubble(bubble);
    place_screen_bubble(&app);
    let _ = app.emit_to(BUBBLE, "bubble-zoom", bubble.face_zoom);
}

/// The latest video frame (0) or the whole source (1), as a JPEG data URL.
#[tauri::command]
#[specta::specta]
pub fn cast_preview(which: u8, width: f64) -> Option<String> {
    jpeg_url(|out, len| unsafe { gcast_preview(which as c_int, width, out, len) })
}

#[tauri::command]
#[specta::specta]
pub async fn cast_start(app: AppHandle, options: StartOptions) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || start(&app, options)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub fn cast_pause(app: AppHandle) {
    pause(&app);
}

#[tauri::command]
#[specta::specta]
pub async fn cast_stop(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || stop(&app)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn cast_discard(app: AppHandle) {
    let _ = tauri::async_runtime::spawn_blocking(move || discard(&app)).await;
}

#[tauri::command]
#[specta::specta]
pub async fn cast_restart(app: AppHandle) {
    let _ = tauri::async_runtime::spawn_blocking(move || restart(&app)).await;
}

#[tauri::command]
#[specta::specta]
pub async fn cast_close(app: AppHandle) {
    if !is_recording() && phase() != Phase::Saving {
        let _ = tauri::async_runtime::spawn_blocking(move || discard(&app)).await;
    }
}

#[tauri::command]
#[specta::specta]
pub fn cast_mark(kind: String, beat: u32) {
    mark(&kind, beat);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The compositor and writer on made-up frames (no screen permission
    /// needed): `cargo test --release --lib cast_selftest -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn cast_selftest() {
        for (vertical, name) in [(0, "landscape"), (1, "vertical")] {
            let path = std::env::temp_dir().join(format!("gus-cast-selftest-{name}.mp4"));
            let c = CString::new(path.display().to_string()).unwrap();
            let rc = unsafe { gcast_selftest(c.as_ptr(), vertical) };
            println!("{name}: rc={rc} {} {}", path.display(), if rc != 0 { last_error() } else { String::new() });
            assert_eq!(rc, 0);
        }
    }
}
