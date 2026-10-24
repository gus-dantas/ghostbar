//! The link between Ghostbar and its Chrome extension.
//!
//! Chrome starts this same executable as a native-messaging host (it passes the
//! extension's origin as the first argument). The host relays Chrome's framed
//! messages to the running app over a local socket, starting the app if needed,
//! and relays the app's messages back. The app keeps one socket client per
//! connected Chrome profile.

use log::{info, warn};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub const HOST_NAME: &str = "com.gusdantas.assistant";

struct Client {
    id: u64,
    stream: UnixStream,
    last_active: Instant,
}

static CLIENTS: Mutex<Vec<Client>> = Mutex::new(Vec::new());

fn socket_path() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join("Library/Application Support/com.gusdantas.assistant/bridge.sock")
}

/// The extension, unpacked from ~/Projects/gus-screenshot in both Chrome profiles.
const EXTENSION_ORIGINS: &[&str] = &["chrome-extension://mkkidappaoedioimaikhdkjfnfbllpcm/"];

/// Tells Chrome where the host is: one manifest per installed Chrome flavour,
/// pointing at this executable, so a rebuilt or moved app re-registers itself.
fn register_host() {
    let Ok(exe) = std::env::current_exe() else { return };
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let manifest = json!({
        "name": HOST_NAME,
        "description": "Ghostbar",
        "path": exe,
        "type": "stdio",
        "allowed_origins": EXTENSION_ORIGINS,
    });
    let body = serde_json::to_string_pretty(&manifest).unwrap_or_default();
    for browser in ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary", "Chromium"] {
        let base = home.join("Library/Application Support").join(browser);
        if !base.is_dir() {
            continue;
        }
        let dir = base.join("NativeMessagingHosts");
        let file = dir.join(format!("{HOST_NAME}.json"));
        if std::fs::read_to_string(&file).ok().as_deref() == Some(body.as_str()) {
            continue;
        }
        match std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&file, &body)) {
            Ok(_) => info!("registered the Chrome host at {}", file.display()),
            Err(e) => warn!("couldn't register the Chrome host at {}: {e}", file.display()),
        }
    }
}

/// True when Chrome launched this executable as the native-messaging host.
pub fn is_host_invocation() -> bool {
    std::env::args().skip(1).any(|a| a.starts_with("chrome-extension://"))
}

// ---------- host side (inside Chrome's process tree) ----------

fn connect_or_launch() -> Option<UnixStream> {
    if let Ok(s) = UnixStream::connect(socket_path()) {
        return Some(s);
    }
    // The app isn't running: start it in the background and wait for its socket.
    let _ = std::process::Command::new("/usr/bin/open").args(["-g", "-b", "com.gusdantas.assistant"]).status();
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
        if let Ok(s) = UnixStream::connect(socket_path()) {
            return Some(s);
        }
    }
    None
}

fn write_frame(out: &mut impl Write, value: &Value) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(value)?;
    out.write_all(&(bytes.len() as u32).to_le_bytes())?;
    out.write_all(&bytes)?;
    out.flush()
}

/// Runs the native-messaging host until Chrome closes the port. Nothing may be
/// printed to stdout here except framed messages.
pub fn run_host() {
    let mut stdout = std::io::stdout();
    let Some(socket) = connect_or_launch() else {
        let _ = write_frame(&mut stdout, &json!({ "type": "error", "message": "Ghostbar isn't running and couldn't be started." }));
        return;
    };
    let mut to_app = match socket.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    // App → Chrome.
    std::thread::spawn(move || {
        let mut stdout = std::io::stdout();
        for line in BufReader::new(socket).lines() {
            let Ok(line) = line else { break };
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if write_frame(&mut stdout, &value).is_err() {
                    break;
                }
            }
        }
        std::process::exit(0);
    });
    // Chrome → app.
    let mut stdin = std::io::stdin();
    loop {
        let mut len = [0u8; 4];
        if stdin.read_exact(&mut len).is_err() {
            break;
        }
        let n = u32::from_le_bytes(len) as usize;
        if n > 1 << 20 {
            break;
        }
        let mut body = vec![0u8; n];
        if stdin.read_exact(&mut body).is_err() {
            break;
        }
        body.push(b'\n');
        if to_app.write_all(&body).is_err() {
            break;
        }
    }
}

// ---------- app side ----------

/// Listens for extension connections (one per Chrome profile).
pub fn start(app: &AppHandle) {
    register_host();
    let path = socket_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => return warn!("extension bridge: couldn't listen on {}: {e}", path.display()),
    };
    info!("extension bridge listening on {}", path.display());
    let app = app.clone();
    std::thread::spawn(move || {
        let mut next_id = 1u64;
        for stream in listener.incoming().flatten() {
            let id = next_id;
            next_id += 1;
            if let Ok(writer) = stream.try_clone() {
                if let Ok(mut clients) = CLIENTS.lock() {
                    clients.push(Client { id, stream: writer, last_active: Instant::now() });
                }
            }
            let reader_app = app.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stream).lines() {
                    let Ok(line) = line else { break };
                    if let Ok(msg) = serde_json::from_str::<Value>(&line) {
                        handle(&reader_app, id, msg);
                    }
                }
                if let Ok(mut clients) = CLIENTS.lock() {
                    clients.retain(|c| c.id != id);
                }
                let _ = reader_app.emit("extension-connections", count());
            });
            let _ = app.emit("extension-connections", count());
        }
    });
}

pub fn count() -> usize {
    CLIENTS.lock().map(|c| c.len()).unwrap_or(0)
}

fn send(id: u64, value: &Value) {
    let line = format!("{}\n", value);
    if let Ok(mut clients) = CLIENTS.lock() {
        if let Some(c) = clients.iter_mut().find(|c| c.id == id) {
            let _ = c.stream.write_all(line.as_bytes());
        }
    }
}

/// Tells every connected Chrome profile (e.g. a new capture was saved).
pub fn notify(_app: &AppHandle, value: Value) {
    let line = format!("{}\n", value);
    if let Ok(mut clients) = CLIENTS.lock() {
        clients.retain_mut(|c| c.stream.write_all(line.as_bytes()).is_ok());
    }
}

/// Asks the Chrome profile the user touched last to do something (e.g. record a tab).
pub fn ask_active_chrome(value: Value) -> bool {
    let line = format!("{}\n", value);
    if let Ok(mut clients) = CLIENTS.lock() {
        if let Some(c) = clients.iter_mut().max_by_key(|c| c.last_active) {
            return c.stream.write_all(line.as_bytes()).is_ok();
        }
    }
    false
}

fn touch(id: u64) {
    if let Ok(mut clients) = CLIENTS.lock() {
        if let Some(c) = clients.iter_mut().find(|c| c.id == id) {
            c.last_active = Instant::now();
        }
    }
}

fn handle(app: &AppHandle, id: u64, msg: Value) {
    let kind = msg.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "hello" | "focus" => {
            touch(id);
            if kind == "hello" {
                send(id, &json!({ "type": "hello", "app": "Ghostbar", "version": app.package_info().version.to_string(), "recording": format!("{:?}", crate::cast::phase()).to_lowercase() }));
            }
        }
        "record" => {
            touch(id);
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || crate::cast::toggle(&app2));
        }
        "screenshot" => {
            touch(id);
            let mode = match msg.get("mode").and_then(Value::as_str) {
                Some("window") => crate::capture::ShotMode::Window,
                Some("screen") => crate::capture::ShotMode::Screen,
                _ => crate::capture::ShotMode::Area,
            };
            crate::capture::screenshot(app, mode);
        }
        "open" => {
            touch(id);
            let page = msg.get("page").and_then(Value::as_str).unwrap_or("home").to_string();
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || crate::shell::show(&app2, &page));
        }
        "capture-saved" => {
            let path = msg.get("path").and_then(Value::as_str).unwrap_or("").to_string();
            if [".png", ".jpg", ".jpeg"].iter().any(|e| path.to_ascii_lowercase().ends_with(e)) {
                crate::capture_meta::read_text_later(app, std::path::Path::new(&path));
            }
            let _ = app.emit("capture-saved", path);
        }
        "vpn" => {
            // {"type":"vpn","country":"BR"} or "off"; without a country it only reports.
            if let Some(choice) = msg.get("country").and_then(Value::as_str) {
                crate::vpn::select(app, choice);
            }
            send(id, &json!({ "type": "vpn", "phase": crate::vpn::describe() }));
        }
        "busy" => {
            // The install script asks before it quits the app, so an update
            // never cuts a dictation or a Cast short.
            send(id, &json!({ "type": "busy", "dictating": crate::dictation::is_busy(), "casting": crate::cast::is_recording() }));
        }
        "ext-recording" => {
            // The extension reports its own tab recording starting or stopping.
            let _ = app.emit("extension-recording", msg.get("on").and_then(Value::as_bool).unwrap_or(false));
        }
        _ => {}
    }
}

// ---------- commands ----------

#[tauri::command]
#[specta::specta]
pub fn extension_connections() -> usize {
    count()
}

/// The app's "Record a Chrome tab" button: hands over to the extension.
#[tauri::command]
#[specta::specta]
pub fn extension_record_tab() -> Result<(), String> {
    if ask_active_chrome(json!({ "type": "record-tab" })) {
        Ok(())
    } else {
        Err("Chrome isn't connected: open Chrome with the Ghostbar extension.".into())
    }
}
