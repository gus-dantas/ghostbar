//! Mac helpers that used to be separate apps.
//!
//! Keep Teams available (was Computer MouseJiggler): while it's on and Gus
//! hasn't touched the keyboard or mouse for a while, the pointer moves one
//! pixel and back, which counts as activity, so Teams never flips to Away.
//! It does nothing while he is using the Mac.
//!
//! Stay awake with the lid closed (was Insone): `pmset -a disablesleep`,
//! written through `sudo -n` and the rule Insone installed in
//! /etc/sudoers.d/pmset-disablesleep, so it never asks for a password. Without
//! the rule it fails at once and says how to install it.

use crate::settings::{get_settings, write_settings};
use log::{info, warn};
use serde::Serialize;
use specta::Type;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicI8, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

extern "C" {
    fn gtools_idle_seconds() -> f64;
    fn gtools_nudge_mouse();
}

/// Idle this long and the pointer gets its nudge; Teams goes Away after 5 min.
const IDLE_BEFORE_NUDGE: f64 = 50.0;
const CHECK_EVERY: Duration = Duration::from_secs(20);
const SUDOERS_RULE: &str = "/etc/sudoers.d/pmset-disablesleep";
const INSTALL_RULE: &str = "scripts/install-lid-rule.sh (in the Gus Assistant source)";

static JIGGLER: AtomicBool = AtomicBool::new(false);
static JIGGLER_THREAD: AtomicBool = AtomicBool::new(false);
/// -1 not read yet, 0 sleeps normally, 1 stays awake.
static LID_AWAKE: AtomicI8 = AtomicI8::new(-1);

#[derive(Clone, Serialize, Type)]
pub struct MacTools {
    pub jiggler: bool,
    /// None when pmset couldn't be read.
    pub lid_awake: Option<bool>,
    /// The sudo rule that lets the lid switch work without a password.
    pub lid_rule: bool,
}

pub fn jiggler_on() -> bool {
    JIGGLER.load(Ordering::Acquire)
}

pub fn lid_awake() -> Option<bool> {
    match LID_AWAKE.load(Ordering::Acquire) {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

pub fn state() -> MacTools {
    MacTools {
        jiggler: jiggler_on(),
        lid_awake: lid_awake(),
        lid_rule: std::path::Path::new(SUDOERS_RULE).exists(),
    }
}

fn changed(app: &AppHandle) {
    let _ = app.emit("mac-tools", state());
    crate::tray::update_tray_menu(app);
}

// ---------- keep Teams available ----------

fn run_jiggler() {
    if JIGGLER_THREAD.swap(true, Ordering::AcqRel) {
        return;
    }
    std::thread::Builder::new()
        .name("jiggler".into())
        .spawn(|| {
            while JIGGLER.load(Ordering::Acquire) {
                if unsafe { gtools_idle_seconds() } >= IDLE_BEFORE_NUDGE {
                    unsafe { gtools_nudge_mouse() };
                }
                std::thread::sleep(CHECK_EVERY);
            }
            JIGGLER_THREAD.store(false, Ordering::Release);
        })
        .ok();
}

pub fn set_jiggler(app: &AppHandle, on: bool) {
    JIGGLER.store(on, Ordering::Release);
    let mut settings = get_settings(app);
    if settings.keep_available != on {
        settings.keep_available = on;
        write_settings(app, settings);
    }
    if on {
        run_jiggler();
    }
    info!("keep Teams available: {}", if on { "on" } else { "off" });
    changed(app);
}

// ---------- stay awake with the lid closed ----------

/// `SleepDisabled 1` in `pmset -g`.
fn read_lid_awake() -> Option<bool> {
    let out = Command::new("/usr/bin/pmset").arg("-g").output().ok()?;
    parse_sleep_disabled(&String::from_utf8_lossy(&out.stdout))
}

fn parse_sleep_disabled(pmset: &str) -> Option<bool> {
    pmset.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        (fields.next()?.eq_ignore_ascii_case("SleepDisabled")).then(|| fields.next())?.map(|v| v == "1")
    })
}

fn refresh_lid(app: &AppHandle) {
    let now = match read_lid_awake() {
        Some(true) => 1,
        Some(false) => 0,
        None => -1,
    };
    if LID_AWAKE.swap(now, Ordering::AcqRel) != now {
        changed(app);
    }
}

pub fn set_lid_awake(app: &AppHandle, on: bool) -> Result<(), String> {
    let out = Command::new("/usr/bin/sudo")
        .args(["-n", "/usr/bin/pmset", "-a", "disablesleep", if on { "1" } else { "0" }])
        .output()
        .map_err(|e| e.to_string())?;
    refresh_lid(app);
    if out.status.success() {
        info!("stay awake with the lid closed: {}", if on { "on" } else { "off" });
        return Ok(());
    }
    let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
    warn!("pmset disablesleep failed: {why}");
    Err(if std::path::Path::new(SUDOERS_RULE).exists() {
        format!("macOS refused the change ({why}).")
    } else {
        format!("This needs a one-time sudo rule. In Terminal run: sudo {INSTALL_RULE}")
    })
}

/// At launch: start the jiggler if it was on, and keep the lid state current
/// (Insone or the Terminal can change it too).
pub fn start(app: &AppHandle) {
    if get_settings(app).keep_available {
        JIGGLER.store(true, Ordering::Release);
        run_jiggler();
    }
    let app = app.clone();
    std::thread::Builder::new()
        .name("lid-watch".into())
        .spawn(move || loop {
            refresh_lid(&app);
            std::thread::sleep(Duration::from_secs(15));
        })
        .ok();
}

// ---------- commands ----------

#[tauri::command]
#[specta::specta]
pub fn mac_tools_state() -> MacTools {
    state()
}

#[tauri::command]
#[specta::specta]
pub fn mac_set_keep_available(app: AppHandle, on: bool) {
    set_jiggler(&app, on);
}

#[tauri::command]
#[specta::specta]
pub async fn mac_set_lid_awake(app: AppHandle, on: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || set_lid_awake(&app, on)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::parse_sleep_disabled;

    #[test]
    fn reads_the_lid_setting() {
        assert_eq!(parse_sleep_disabled("System-wide power settings:\n SleepDisabled\t\t1\nCurrently in use:\n"), Some(true));
        assert_eq!(parse_sleep_disabled(" SleepDisabled\t\t0\n"), Some(false));
        assert_eq!(parse_sleep_disabled(" standby 1\n"), None);
    }
}
