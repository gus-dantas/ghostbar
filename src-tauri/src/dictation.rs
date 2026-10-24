//! The live dictation editor. While Gus talks, a floating panel shows the live
//! text and takes the keyboard, so a word can be fixed or typed without
//! stopping. At each pause the stream is cut into a chunk and the accurate
//! model re-hears it (refine.rs); an edited chunk is never overwritten. When he
//! stops, Enter pastes the text, Cmd+Enter proofreads it first (proofread.rs).
//! Talking again before pasting keeps adding to the same text.

use crate::managers::history::HistoryManager;
use crate::settings::get_settings;
use crate::transcription_coordinator::TranscriptionCoordinator;
use log::{error, info, warn};
use serde::Serialize;
use specta::Type;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};

#[cfg(target_os = "macos")]
use tauri_nspanel::{tauri_panel, CollectionBehavior, ManagerExt, PanelBuilder, PanelLevel, StyleMask};

pub const LABEL: &str = "dictation";
/// Starting size; the page grows the panel upward with the text.
const SIZE: (f64, f64) = (360.0, 92.0);

/// A recording is feeding the editor.
static ACTIVE: AtomicBool = AtomicBool::new(false);
/// The panel holds text that hasn't been pasted or closed yet.
static OPEN: AtomicBool = AtomicBool::new(false);
static NEXT_ID: AtomicU64 = AtomicU64::new(0);
/// The app that was in front when dictation began, to hand the keyboard back to.
static TARGET_PID: AtomicI32 = AtomicI32::new(0);
static PHASE: Mutex<&str> = Mutex::new("idle");
static BINDING: Mutex<String> = Mutex::new(String::new());
static RECORDINGS: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// Every chunk's text, the accurate pass's once it came. The panel can lose
/// what it was sent (a missed event, a reloaded page); this copy can't, so the
/// panel fills itself from here when it ends up empty.
static SESSION: Mutex<Vec<(u64, String)>> = Mutex::new(Vec::new());

/// All the text heard since the panel opened.
pub fn session_text() -> String {
    SESSION
        .lock()
        .map(|s| s.iter().map(|(_, t)| t.trim()).filter(|t| !t.is_empty()).collect::<Vec<_>>().join(" "))
        .unwrap_or_default()
}

/// Chunks the accurate pass hasn't answered yet.
static REFINING: AtomicI32 = AtomicI32::new(0);

/// The accurate pass answered a chunk, with better text or none.
pub fn refined(id: u64, text: Option<&str>) {
    let _ = REFINING.try_update(Ordering::AcqRel, Ordering::Acquire, |n| Some((n - 1).max(0)));
    let Some(text) = text.filter(|t| !t.trim().is_empty()) else { return };
    if let Ok(mut s) = SESSION.lock() {
        if let Some(entry) = s.iter_mut().find(|(i, _)| *i == id) {
            entry.1 = text.to_string();
        }
    }
}

/// Waits (up to `limit`) for the accurate pass to answer every chunk.
pub fn wait_for_refines(limit: Duration) {
    let started = Instant::now();
    while REFINING.load(Ordering::Acquire) > 0 && started.elapsed() < limit {
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Something went wrong where Gus is looking: the panel shows it.
pub fn error(app: &AppHandle, message: &str) {
    warn!("dictation: {message}");
    let _ = app.emit_to(LABEL, "dictation-error", message.to_string());
}

#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(DictationPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })
}

pub fn enabled(app: &AppHandle) -> bool {
    get_settings(app).live_editor
}

pub fn is_active() -> bool {
    ACTIVE.load(Ordering::Acquire)
}

#[derive(Clone, Serialize, Type)]
pub struct DictationState {
    pub phase: String,
    /// "Claude Haiku", "Apple Intelligence" or "none".
    pub proofreader: String,
    /// The accurate model re-hearing each chunk, if one is downloaded.
    pub refiner: Option<String>,
    /// Everything heard so far, for the panel to fall back on.
    pub text: String,
}

#[derive(Clone, Serialize)]
struct Chunk {
    id: u64,
    text: String,
    /// A second pass is coming for this chunk.
    refining: bool,
    last: bool,
}

fn set_phase(app: &AppHandle, phase: &'static str) {
    *PHASE.lock().unwrap() = phase;
    let _ = app.emit_to(LABEL, "dictation-phase", phase);
}

/// Recording starts: open the panel (or keep adding to the open one).
pub fn begin(app: &AppHandle, binding_id: &str) {
    ACTIVE.store(true, Ordering::Release);
    *BINDING.lock().unwrap() = binding_id.to_string();
    if !OPEN.swap(true, Ordering::AcqRel) {
        RECORDINGS.lock().unwrap().clear();
        SESSION.lock().unwrap().clear();
        remember_target();
    }
    if crate::refine::model_id(app).is_some() {
        crate::refine::warm(app);
    }
    set_phase(app, "listening");
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || show_panel(&handle));
}

/// The shortcut ended the recording; the last chunk is on its way.
pub fn stopping(app: &AppHandle) {
    set_phase(app, "finishing");
}

/// A stretch of speech the live stream finished: show it, and have the
/// accurate model re-hear it.
pub fn chunk(app: &AppHandle, pcm: Vec<f32>, text: String, last: bool) {
    let id = NEXT_ID.fetch_add(1, Ordering::AcqRel) + 1;
    let text = text.trim().to_string();
    let seconds = pcm.len() as f32 / 16000.0;
    let refining = (seconds >= 1.0 || (!text.is_empty() && seconds >= 0.5)) && crate::refine::model_id(app).is_some();
    info!(
        "dictation: chunk {id}, {seconds:.1}s, {} chars{}{}",
        text.chars().count(),
        if refining { ", second pass queued" } else { "" },
        if last { ", last" } else { "" }
    );
    SESSION.lock().unwrap().push((id, text.clone()));
    if refining {
        REFINING.fetch_add(1, Ordering::AcqRel);
    }
    let _ = app.emit_to(LABEL, "dictation-chunk", Chunk { id, text: text.clone(), refining, last });
    if refining {
        crate::refine::queue(app, id, pcm, text);
    }
}

/// The recording is saved; the text waits for Enter, Cmd+Enter or Escape.
pub fn recorded(app: &AppHandle, recording: Option<String>) {
    ACTIVE.store(false, Ordering::Release);
    if let Some(name) = recording {
        RECORDINGS.lock().unwrap().push(name);
    }
    info!(
        "dictation: recorded, {} chunks, {} chars so far",
        SESSION.lock().map(|s| s.len()).unwrap_or(0),
        session_text().chars().count()
    );
    set_phase(app, "review");
}

/// Cancelled (Escape while recording, or the recording failed).
pub fn abort(app: &AppHandle) {
    if !ACTIVE.swap(false, Ordering::AcqRel) && !OPEN.load(Ordering::Acquire) {
        return;
    }
    OPEN.store(false, Ordering::Release);
    SESSION.lock().unwrap().clear();
    set_phase(app, "idle");
    hide(app);
}

fn hide(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        if let Ok(panel) = handle.get_webview_panel(LABEL) {
            panel.resign_key_window();
            panel.hide();
            return;
        }
        if let Some(w) = handle.get_webview_window(LABEL) {
            let _ = w.hide();
        }
    });
}

fn position(app: &AppHandle) -> (f64, f64) {
    let (w, h) = SIZE;
    let Some(monitor) = crate::overlay::get_monitor_with_cursor(app) else {
        return (200.0, 500.0);
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    // Bottom right, out of the way of what Gus is reading.
    let x = (area.position.x as f64 + area.size.width as f64) / scale - w - 18.0;
    let y = (area.position.y as f64 + area.size.height as f64) / scale - h - 18.0;
    (x, y)
}

/// Builds the panel hidden when the app starts, so the first tap of the key
/// shows it at once with its page already listening (built on the first tap,
/// it came up late and missed the first words).
pub fn prewarm(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        if handle.get_webview_panel(LABEL).is_err() {
            if let Err(e) = build_panel(&handle, false) {
                error!("dictation panel: {e}");
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn build_panel(app: &AppHandle, visible: bool) -> Result<tauri_nspanel::PanelHandle<tauri::Wry>, String> {
    let (x, y) = position(app);
    PanelBuilder::<_, DictationPanel>::new(app, LABEL)
        .url(WebviewUrl::App("src/dictation/index.html".into()))
        .title("Gus Assistant Dictation")
        .position(tauri::Position::Logical(tauri::LogicalPosition { x, y }))
        .size(tauri::Size::Logical(tauri::LogicalSize { width: SIZE.0, height: SIZE.1 }))
        .level(PanelLevel::Floating)
        .has_shadow(false)
        .transparent(true)
            // Takes the keyboard without bringing the app forward, so the app
            // Gus is writing into stays the active one.
        .no_activate(true)
        .corner_radius(0.0)
        .style_mask(StyleMask::empty().borderless().nonactivating_panel())
        .with_window(move |w| w.decorations(false).transparent(true).focusable(true).visible(visible))
        .collection_behavior(CollectionBehavior::new().can_join_all_spaces().full_screen_auxiliary())
        .build()
        .map_err(|e| e.to_string())
}

fn show_panel(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        // Once open, the panel stays where Gus left it (or dragged it).
        if let Ok(panel) = app.get_webview_panel(LABEL) {
            panel.show_and_make_key();
            return;
        }
        match build_panel(app, true) {
            Ok(panel) => panel.show_and_make_key(),
            Err(e) => error!("dictation panel: {e}"),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let (x, y) = position(app);
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = w.show();
            let _ = w.set_focus();
            return;
        }
        let _ = tauri::WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("src/dictation/index.html".into()))
            .title("Gus Assistant Dictation")
            .position(x, y)
            .inner_size(SIZE.0, SIZE.1)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .build();
    }
}

#[cfg(target_os = "macos")]
fn remember_target() {
    use objc2_app_kit::NSWorkspace;
    #[allow(unused_unsafe)]
    let pid = unsafe {
        NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .map(|a| a.processIdentifier())
            .unwrap_or(0)
    };
    if pid != std::process::id() as i32 {
        TARGET_PID.store(pid, Ordering::Release);
    }
}

#[cfg(not(target_os = "macos"))]
fn remember_target() {}

/// If this app somehow became the active one, bring back the app Gus was in.
#[cfg(target_os = "macos")]
fn give_back_focus() {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace};
    let target = TARGET_PID.load(Ordering::Acquire);
    #[allow(unused_unsafe)]
    unsafe {
        let front = NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .map(|a| a.processIdentifier())
            .unwrap_or(0);
        if target == 0 || front == target {
            return;
        }
        if let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(target) {
            #[allow(deprecated)]
            app.activateWithOptions(NSApplicationActivationOptions::empty());
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn give_back_focus() {}

/// Collapse the spaces chunk joins leave behind.
fn tidy(text: &str) -> String {
    text.lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn save_history(app: &AppHandle, raw: &str, proofread: Option<&str>) {
    let Some(file) = RECORDINGS.lock().unwrap().first().cloned() else { return };
    let Some(hm) = app.try_state::<Arc<HistoryManager>>() else { return };
    if let Err(e) = hm.save_entry(
        file,
        raw.to_string(),
        proofread.is_some(),
        proofread.map(str::to_string),
        proofread.map(|_| "Proofread (Gus Assistant)".to_string()),
    ) {
        warn!("dictation: history not saved: {e}");
    }
}

fn close(app: &AppHandle) {
    OPEN.store(false, Ordering::Release);
    SESSION.lock().unwrap().clear();
    set_phase(app, "idle");
    hide(app);
}

#[tauri::command]
#[specta::specta]
pub fn dictation_state(app: AppHandle) -> DictationState {
    DictationState {
        phase: PHASE.lock().unwrap().to_string(),
        proofreader: crate::proofread::engine(&app).to_string(),
        refiner: crate::refine::model_id(&app),
        text: session_text(),
    }
}

#[derive(Clone, Serialize, Type)]
pub struct DictationSettings {
    pub live_editor: bool,
    pub refiner: Option<String>,
    pub proofreader: String,
    pub has_anthropic_key: bool,
}

#[tauri::command]
#[specta::specta]
pub fn dictation_settings(app: AppHandle) -> DictationSettings {
    let settings = get_settings(&app);
    DictationSettings {
        live_editor: settings.live_editor,
        refiner: crate::refine::model_id(&app),
        proofreader: crate::proofread::engine(&app).to_string(),
        has_anthropic_key: settings.post_process_api_keys.get("anthropic").is_some_and(|k| !k.trim().is_empty()),
    }
}

#[tauri::command]
#[specta::specta]
pub fn dictation_set_live_editor(app: AppHandle, enabled: bool) {
    let mut settings = get_settings(&app);
    settings.live_editor = enabled;
    crate::settings::write_settings(&app, settings);
    if enabled {
        crate::refine::warm(&app);
    }
}

/// Enter (proofread false) or Cmd+Enter (true): paste into the app in front.
#[tauri::command]
#[specta::specta]
pub async fn dictation_finish(app: AppHandle, text: String, proofread: bool) -> Result<(), String> {
    let raw = tidy(&text);
    let heard = session_text();
    info!("dictation: {} with {} chars (heard {})", if proofread { "Cmd+Enter" } else { "Enter" }, raw.chars().count(), heard.chars().count());
    if raw.is_empty() {
        if !heard.is_empty() {
            warn!("dictation: the panel was empty but {} chars were heard; kept in History", heard.chars().count());
            save_history(&app, &tidy(&heard), None);
        }
        close(&app);
        return Ok(());
    }
    let output = if proofread {
        set_phase(&app, "proofreading");
        match crate::proofread::proofread(&app, &raw).await {
            Ok(t) if !t.is_empty() => t,
            Ok(_) => raw.clone(),
            Err(e) => {
                set_phase(&app, "review");
                return Err(e);
            }
        }
    } else {
        raw.clone()
    };
    save_history(&app, &raw, proofread.then_some(output.as_str()));
    close(&app);
    // The panel lets go of the keyboard; the app underneath takes it back.
    let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(160))).await;
    let started = Instant::now();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        give_back_focus();
        match crate::utils::paste(output, handle.clone()) {
            Ok(()) => info!("dictation pasted in {:?}", started.elapsed()),
            Err(e) => {
                error!("dictation paste failed: {e}");
                let _ = handle.emit("paste-error", ());
            }
        }
    })
    .map_err(|e| e.to_string())
}

/// Escape after recording: close without pasting (History keeps the text).
#[tauri::command]
#[specta::specta]
pub fn dictation_close(app: AppHandle, text: String) {
    let raw = tidy(&text);
    if !raw.is_empty() {
        save_history(&app, &raw, None);
    }
    if is_active() {
        crate::utils::cancel_current_operation(&app);
    }
    close(&app);
}

/// Enter while still recording: end the recording as the shortcut would.
#[tauri::command]
#[specta::specta]
pub fn dictation_stop(app: AppHandle) {
    if !is_active() {
        return;
    }
    let binding = BINDING.lock().unwrap().clone();
    if let Some(coordinator) = app.try_state::<TranscriptionCoordinator>() {
        coordinator.send_external_input(&binding, "dictation editor");
    }
}

/// Cuts the live stream into chunks at pauses. Fed every frame the stream
/// gets; a chunk is ready once there was enough speech and then a pause.
pub struct Chunker {
    active: bool,
    audio: Vec<f32>,
    speech_ms: f32,
    quiet_ms: f32,
    peak: f32,
    last_feed: Instant,
}

const MIN_SPEECH_MS: f32 = 1200.0;
const PAUSE_MS: f32 = 1000.0;
const LONG_MS: f32 = 20000.0;
const BREATH_MS: f32 = 250.0;

impl Chunker {
    pub fn new() -> Self {
        Self { active: is_active(), audio: Vec::new(), speech_ms: 0.0, quiet_ms: 0.0, peak: 0.0, last_feed: Instant::now() }
    }

    #[cfg(test)]
    pub fn always_on() -> Self {
        Self { active: true, ..Self::new() }
    }

    pub fn is_on(&self) -> bool {
        self.active
    }

    pub fn feed(&mut self, pcm: &[f32]) {
        if !self.active || pcm.is_empty() {
            return;
        }
        self.audio.extend_from_slice(pcm);
        let ms = pcm.len() as f32 / 16.0;
        let rms = (pcm.iter().map(|s| s * s).sum::<f32>() / pcm.len() as f32).sqrt();
        self.peak = self.peak.max(rms);
        if rms > (self.peak * 0.18).max(0.006) {
            self.speech_ms += ms;
            self.quiet_ms = 0.0;
        } else {
            self.quiet_ms += ms;
        }
        self.last_feed = Instant::now();
    }

    /// Enough speech, then a quiet stretch the stream was still fed. A long
    /// stretch is cut at a shorter breath, so the second pass gets audio it
    /// handles well.
    pub fn pause_ready(&self) -> bool {
        let long = self.audio.len() as f32 / 16.0 >= LONG_MS;
        self.active
            && self.speech_ms >= MIN_SPEECH_MS
            && (self.quiet_ms >= PAUSE_MS || (long && self.quiet_ms >= BREATH_MS))
    }

    /// Enough speech, then nothing fed at all (the microphone gate closed).
    pub fn gap_ready(&self) -> bool {
        self.active
            && self.speech_ms >= MIN_SPEECH_MS
            && self.last_feed.elapsed() >= Duration::from_millis(PAUSE_MS as u64)
    }

    pub fn take(&mut self) -> Vec<f32> {
        self.speech_ms = 0.0;
        self.quiet_ms = 0.0;
        std::mem::take(&mut self.audio)
    }
}
