//! VPN: the whole Mac exits in a country Gus picks from the tray.
//!
//! Picking a country starts a throwaway Google Cloud server there (a spot
//! e2-micro that deletes itself after 10 hours at most), points
//! the VPN hostname (vpn/config.json) at it and starts the WireGuard app's `GusVPN` tunnel.
//! Turning it off stops the tunnel and deletes the server, so it costs nothing
//! while off.
//!
//! Every server gets the same WireGuard keys through instance metadata, so the
//! one tunnel imported into WireGuard once works with any country: only the
//! address behind the hostname changes. Private ranges stay off the tunnel, so
//! the LAN (Hue, Apple TV, the aircon) keeps working while it is on.
//!
//! A tunnel up with nothing behind it takes the whole Mac offline, so: "off"
//! always wins, even mid-start; every command has a deadline; and while it is
//! on a watchdog turns it off if the internet stops coming through.

use base64::Engine as _;
use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::net::ToSocketAddrs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;

const TUNNEL: &str = "GusVPN";
const LABEL: &str = "gus-vpn";
const STARTUP_SCRIPT: &str = include_str!("vpn_startup.sh");
/// Apps launched from Finder get a bare PATH; gcloud needs Homebrew's python.
const PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
/// 0.0.0.0/0 minus 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16 and 224/3,
/// plus all of IPv6 so it can't leak around the tunnel.
const ALLOWED_IPS: &str = "0.0.0.0/5, 8.0.0.0/7, 11.0.0.0/8, 12.0.0.0/6, 16.0.0.0/4, 32.0.0.0/3, 64.0.0.0/3, 96.0.0.0/4, 112.0.0.0/5, 120.0.0.0/6, 124.0.0.0/7, 126.0.0.0/8, 128.0.0.0/3, 160.0.0.0/5, 168.0.0.0/8, 169.0.0.0/9, 169.128.0.0/10, 169.192.0.0/11, 169.224.0.0/12, 169.240.0.0/13, 169.248.0.0/14, 169.252.0.0/15, 169.255.0.0/16, 170.0.0.0/7, 172.0.0.0/12, 172.32.0.0/11, 172.64.0.0/10, 172.128.0.0/9, 173.0.0.0/8, 174.0.0.0/7, 176.0.0.0/4, 192.0.0.0/9, 192.128.0.0/11, 192.160.0.0/13, 192.169.0.0/16, 192.170.0.0/15, 192.172.0.0/14, 192.176.0.0/12, 192.192.0.0/10, 193.0.0.0/8, 194.0.0.0/7, 196.0.0.0/6, 200.0.0.0/5, 208.0.0.0/4, ::/0";

pub struct Country {
    /// ISO code, also what Cloudflare's trace answers once the tunnel is up.
    pub code: &'static str,
    pub name: &'static str,
    pub flag: &'static str,
    /// Google Cloud region; zones a, b and c are tried in turn.
    pub region: &'static str,
}

pub const COUNTRIES: &[Country] = &[
    Country { code: "BR", name: "Brazil", flag: "🇧🇷", region: "southamerica-east1" },
    Country { code: "US", name: "United States", flag: "🇺🇸", region: "us-east4" },
    Country { code: "CA", name: "Canada", flag: "🇨🇦", region: "northamerica-northeast1" },
    Country { code: "CL", name: "Chile", flag: "🇨🇱", region: "southamerica-west1" },
    Country { code: "GB", name: "United Kingdom", flag: "🇬🇧", region: "europe-west2" },
    Country { code: "ES", name: "Spain", flag: "🇪🇸", region: "europe-southwest1" },
    Country { code: "FR", name: "France", flag: "🇫🇷", region: "europe-west9" },
    Country { code: "DE", name: "Germany", flag: "🇩🇪", region: "europe-west3" },
    Country { code: "IT", name: "Italy", flag: "🇮🇹", region: "europe-west8" },
    Country { code: "NL", name: "Netherlands", flag: "🇳🇱", region: "europe-west4" },
    Country { code: "CH", name: "Switzerland", flag: "🇨🇭", region: "europe-west6" },
    Country { code: "JP", name: "Japan", flag: "🇯🇵", region: "asia-northeast1" },
    Country { code: "KR", name: "South Korea", flag: "🇰🇷", region: "asia-northeast3" },
    Country { code: "SG", name: "Singapore", flag: "🇸🇬", region: "asia-southeast1" },
    Country { code: "IN", name: "India", flag: "🇮🇳", region: "asia-south1" },
    Country { code: "ZA", name: "South Africa", flag: "🇿🇦", region: "africa-south1" },
];

pub fn country(code: &str) -> Option<&'static Country> {
    COUNTRIES.iter().find(|c| c.code == code)
}

fn country_for_region(region: &str) -> Option<&'static Country> {
    COUNTRIES.iter().find(|c| c.region == region)
}

/// What the tray shows. Countries are ISO codes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Phase {
    Off,
    Starting(String),
    On(String),
    Stopping,
    Failed(String),
}

static PHASE: Mutex<Phase> = Mutex::new(Phase::Off);
/// Set by "off"; a start in progress checks it between steps and gives up.
static CANCEL: AtomicBool = AtomicBool::new(false);
/// Held for the whole of a start, so "off" can wait for it before deleting.
static START: Mutex<()> = Mutex::new(());
/// Bumped each time the VPN comes on; a watchdog with an older number exits.
static WATCH: AtomicU64 = AtomicU64::new(0);

pub fn phase() -> Phase {
    PHASE.lock().map(|p| p.clone()).unwrap_or(Phase::Off)
}

/// "on BR", "starting BR", "off", "stopping", "failed: …", for the bridge.
pub fn describe() -> String {
    match phase() {
        Phase::Off => "off".into(),
        Phase::Starting(c) => format!("starting {c}"),
        Phase::On(c) => format!("on {c}"),
        Phase::Stopping => "stopping".into(),
        Phase::Failed(reason) => format!("failed: {reason}"),
    }
}

fn set_phase(app: &AppHandle, phase: Phase) {
    claim(phase);
    redraw(app);
}

fn claim(phase: Phase) {
    if let Ok(mut p) = PHASE.lock() {
        *p = phase;
    }
}

/// The tray menu and the window's VPN control show the current phase.
fn redraw(app: &AppHandle) {
    crate::tray::update_tray_menu(app);
    let _ = tauri::Emitter::emit(app, "vpn-state", state());
}

fn cancelled() -> bool {
    CANCEL.load(Ordering::SeqCst)
}

/// Between the steps of a start: stop here if "off" came in meanwhile.
fn go_on() -> Result<(), String> {
    if cancelled() {
        Err("turned off while starting".into())
    } else {
        Ok(())
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Action {
    Ignore,
    Off,
    On(String),
}

/// What a choice does from where the VPN is. "off" is never ignored while
/// anything could be up: mid-start, failed, or a tunnel left connected.
fn plan(now: &Phase, choice: &str, tunnel_up: bool) -> Action {
    if choice == "off" {
        return match now {
            Phase::Stopping => Action::Ignore,
            Phase::Off if !tunnel_up => Action::Ignore,
            _ => Action::Off,
        };
    }
    if country(choice).is_none() || matches!(now, Phase::Starting(_) | Phase::Stopping) {
        return Action::Ignore;
    }
    // Picking the country it's already in only reconnects a dropped tunnel.
    if *now == Phase::On(choice.to_string()) && tunnel_up {
        return Action::Ignore;
    }
    Action::On(choice.to_string())
}

/// Tray entry point: "off" or a country code. The phase is claimed here, so a
/// second click can't start a second run; the work, and the menu redraw, run on
/// their own thread.
pub fn select(app: &AppHandle, choice: &str) {
    let app = app.clone();
    match plan(&phase(), choice, tunnel_status() == "Connected") {
        Action::Ignore => {}
        Action::Off => {
            CANCEL.store(true, Ordering::SeqCst);
            claim(Phase::Stopping);
            std::thread::spawn(move || {
                redraw(&app);
                turn_off(&app);
            });
        }
        Action::On(code) => {
            let Some(c) = country(&code) else { return };
            CANCEL.store(false, Ordering::SeqCst);
            claim(Phase::Starting(code));
            std::thread::spawn(move || {
                redraw(&app);
                turn_on(&app, c);
            });
        }
    }
}

/// What launch finds: the phase to show (None leaves it off) and whether the
/// tunnel has to come down. A tunnel only stays up if the internet comes
/// through it from the server's country.
fn after_launch(server: Option<&Server>, tunnel_up: bool, exit: Option<&str>) -> (Option<Phase>, bool) {
    let expected = server.and_then(|s| country_for_region(&s.region()));
    if tunnel_up {
        if let Some(e) = exit.filter(|e| country(e).is_some()) {
            if expected.map_or(true, |c| c.code == e) {
                return (Some(Phase::On(e.to_string())), false);
            }
        }
    }
    let phase = server.map(|s| match expected {
        Some(c) => Phase::Failed(format!("{} server running, tunnel off", c.name)),
        None => Phase::Failed(format!("{} is running", s.name)),
    });
    (phase, tunnel_up)
}

/// At launch: a server still running from before (the app quit with the VPN
/// on) shows in the menu, so it can't keep billing unnoticed; a tunnel left up
/// with no internet behind it comes down.
pub fn recover(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let tunnel_up = tunnel_status() == "Connected";
        let list = servers().unwrap_or_else(|e| {
            warn!("VPN: couldn't list servers at launch: {e}");
            Vec::new()
        });
        let exit = if tunnel_up { exit_country() } else { None };
        let (phase, stop) = after_launch(list.first(), tunnel_up, exit.as_deref());
        if let Some(s) = list.first() {
            info!("VPN: found {} running from before", s.name);
        }
        if stop {
            warn!("VPN: tunnel was up at launch with no internet through it, stopping it");
            let _ = tunnel_stop();
        }
        if let Some(phase) = phase {
            set_phase(&app, phase.clone());
            if let Phase::On(code) = phase {
                watch(app, code);
            }
        }
    });
}

fn turn_on(app: &AppHandle, c: &'static Country) {
    let _start = START.lock().unwrap_or_else(|e| e.into_inner());
    let result = connect(c);
    if cancelled() {
        // "off" owns the phase and the cleanup now; only make sure this start
        // didn't leave a tunnel up behind it.
        let _ = tunnel_stop();
        return;
    }
    match result {
        Ok(seen) => {
            info!("VPN: on in {} (exit seen as {seen})", c.name);
            set_phase(app, Phase::On(c.code.to_string()));
            notify(&format!("VPN on · {} {}", c.flag, c.name));
            watch(app.clone(), c.code.to_string());
        }
        Err(e) => {
            warn!("VPN: {} failed: {e}", c.name);
            // Nothing half-built is left billing.
            give_up(app, e.clone());
            notify(&format!("VPN failed: {e}"));
        }
    }
}

fn turn_off(app: &AppHandle) {
    // The tunnel first: with it down the Mac is back on its own internet,
    // whatever happens to the server.
    let _ = tunnel_stop();
    // A start in progress sees CANCEL and returns within a step; wait for it
    // so a server it was still creating is deleted too.
    let _start = START.lock().unwrap_or_else(|e| e.into_inner());
    let _ = tunnel_stop();
    match delete_servers() {
        Ok(()) => {
            set_phase(app, Phase::Off);
            notify("VPN off");
        }
        Err(e) => {
            set_phase(app, Phase::Failed(format!("server not deleted: {e}")));
            notify(&format!("VPN: the server wasn't deleted ({e})"));
        }
    }
}

/// Tunnel down, servers deleted, the reason shown in the menu.
fn give_up(app: &AppHandle, reason: String) {
    let _ = tunnel_stop();
    if let Err(e) = delete_servers() {
        warn!("VPN: couldn't delete the server: {e}");
    }
    set_phase(app, Phase::Failed(reason));
}

#[derive(Debug, PartialEq, Eq)]
enum Check {
    Fine,
    Miss,
    TunnelDown,
}

fn check(tunnel_up: bool, exit: Option<&str>) -> Check {
    match (tunnel_up, exit) {
        (false, _) => Check::TunnelDown,
        (true, Some(_)) => Check::Fine,
        (true, None) => Check::Miss,
    }
}

/// Misses in a row, 20 s apart, before the watchdog turns the VPN off.
const MISSES: u32 = 2;

/// While on: every 20 s, check the internet still comes through the tunnel.
/// After MISSES misses in a row (a dead or deleted server) the VPN goes off,
/// so it can't hold the Mac offline. A tunnel stopped in the WireGuard app
/// shows as failed, since the server is still billing.
fn watch(app: AppHandle, code: String) {
    let me = WATCH.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        let mut misses = 0;
        loop {
            std::thread::sleep(Duration::from_secs(20));
            if WATCH.load(Ordering::SeqCst) != me || phase() != Phase::On(code.clone()) {
                return;
            }
            let up = tunnel_status() == "Connected";
            let exit = if up { exit_country() } else { None };
            match check(up, exit.as_deref()) {
                Check::Fine => misses = 0,
                Check::Miss => misses += 1,
                Check::TunnelDown => {
                    let name = country(&code).map_or(code.as_str(), |c| c.name);
                    set_phase(&app, Phase::Failed(format!("{name} server running, tunnel off")));
                    return;
                }
            }
            if misses >= MISSES {
                warn!("VPN: no internet through the tunnel for {}s, turning it off", MISSES * 20);
                give_up(&app, "no internet was coming through, so it was turned off".into());
                notify("VPN off: no internet was coming through it");
                return;
            }
        }
    });
}

/// Brings the tunnel up in `c` and returns the country the internet sees.
fn connect(c: &Country) -> Result<String, String> {
    let keys = keys()?;
    ensure_tunnel(&keys)?;
    tunnel_stop()?;

    // One server at a time: switching countries replaces it. A running one
    // already in this country is reused.
    let name = format!("{LABEL}-{}", c.region);
    let mut reuse = None;
    for s in servers()? {
        if s.name == name && s.status == "RUNNING" {
            reuse = s.ip;
        } else {
            // Same name must be gone before it is created again.
            delete_server(&s, s.name != name)?;
        }
    }
    go_on()?;
    ensure_firewall()?;
    let ip = match reuse {
        Some(ip) => ip,
        None => create_server(c, &name, &keys)?,
    };
    go_on()?;
    wait_ready(&name, &c.region)?;

    point_dns(&ip)?;
    wait_resolves(&ip)?;
    go_on()?;
    tunnel_start()?;

    // The exit is only proven by what the internet sees.
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut seen = String::new();
    while Instant::now() < deadline {
        go_on()?;
        if let Some(exit) = exit_country() {
            seen = exit;
            if seen == c.code {
                return Ok(seen);
            }
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    if seen.len() == 2 {
        Err(format!("the exit shows as {seen}, not {}", c.code))
    } else {
        Err("no internet through the tunnel".into())
    }
}

// ---- keys and the WireGuard app ----

#[derive(Serialize, Deserialize, Clone)]
struct Keys {
    server_private: String,
    server_public: String,
    client_private: String,
    client_public: String,
}

/// Where this Mac's VPN lives: the Google Cloud project the servers start in,
/// the hostname the tunnel dials, and the Cloudflare zone holding that name.
/// Kept in vpn/config.json beside the keys rather than in the code, so the
/// code can be shared; docs/vpn.md says how to set it up.
#[derive(Deserialize, Clone)]
struct Config {
    gcp_project: String,
    host: String,
    cloudflare_zone: String,
}

fn config() -> Result<Config, String> {
    let path = dir()?.join("config.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|_| format!("the VPN isn't set up yet: add {} (see docs/vpn.md)", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

fn dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "no HOME")?;
    let d = PathBuf::from(home).join("Library/Application Support/com.gusdantas.assistant/vpn");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

/// The fixed keypairs, made once. Changing them means re-importing the tunnel.
fn keys() -> Result<Keys, String> {
    let path = dir()?.join("keys.json");
    if let Ok(text) = std::fs::read_to_string(&path) {
        return serde_json::from_str(&text).map_err(|e| format!("keys.json: {e}"));
    }
    let (server_private, server_public) = keypair()?;
    let (client_private, client_public) = keypair()?;
    let keys = Keys { server_private, server_public, client_private, client_public };
    write_private(&path, &serde_json::to_string_pretty(&keys).map_err(|e| e.to_string())?)?;
    Ok(keys)
}

/// A WireGuard keypair, base64, clamped like `wg genkey`.
fn keypair() -> Result<(String, String), String> {
    let mut k = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut k))
        .map_err(|e| e.to_string())?;
    k[0] &= 248;
    k[31] &= 127;
    k[31] |= 64;
    let secret = x25519_dalek::StaticSecret::from(k);
    let public = x25519_dalek::PublicKey::from(&secret);
    let b64 = base64::engine::general_purpose::STANDARD;
    Ok((b64.encode(secret.to_bytes()), b64.encode(public.as_bytes())))
}

fn write_private(path: &PathBuf, text: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, text).map_err(|e| e.to_string())?;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    Ok(())
}

fn client_config(keys: &Keys, host: &str) -> String {
    format!(
        "[Interface]\nPrivateKey = {}\nAddress = 10.66.0.2/32\nDNS = 1.1.1.1, 8.8.8.8\nMTU = 1380\n\n[Peer]\nPublicKey = {}\nEndpoint = {host}:51820\nAllowedIPs = {ALLOWED_IPS}\nPersistentKeepalive = 25\n",
        keys.client_private, keys.server_public
    )
}

/// The WireGuard app has no import command, so the first time the config is
/// left selected in Finder for Gus to import by hand.
fn ensure_tunnel(keys: &Keys) -> Result<(), String> {
    let list = run("/usr/sbin/scutil", &["--nc", "list"])?;
    if list.contains(&format!("\"{TUNNEL}\"")) {
        return Ok(());
    }
    let conf = dir()?.join(format!("{TUNNEL}.conf"));
    write_private(&conf, &client_config(keys, &config()?.host))?;
    let _ = Command::new("/usr/bin/open").args(["-a", "WireGuard"]).status();
    let _ = Command::new("/usr/bin/open").arg("-R").arg(&conf).status();
    Err(format!("import {TUNNEL}.conf into WireGuard once, then pick the country again"))
}

fn tunnel_status() -> String {
    run("/usr/sbin/scutil", &["--nc", "status", TUNNEL])
        .map(|s| s.lines().next().unwrap_or_default().trim().to_string())
        .unwrap_or_default()
}

fn tunnel_start() -> Result<(), String> {
    run("/usr/sbin/scutil", &["--nc", "start", TUNNEL])?;
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if tunnel_status() == "Connected" {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Err(format!("the tunnel didn't connect ({})", tunnel_status()))
}

fn tunnel_stop() -> Result<(), String> {
    if tunnel_status() == "Disconnected" {
        return Ok(());
    }
    run("/usr/sbin/scutil", &["--nc", "stop", TUNNEL])?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && tunnel_status() != "Disconnected" {
        std::thread::sleep(Duration::from_millis(300));
    }
    Ok(())
}

// ---- Google Cloud ----

struct Server {
    name: String,
    zone: String,
    status: String,
    ip: Option<String>,
}

impl Server {
    /// "southamerica-east1-a" -> "southamerica-east1".
    fn region(&self) -> String {
        self.zone.rsplit_once('-').map(|(r, _)| r.to_string()).unwrap_or_default()
    }
}

fn gcloud(args: &[&str]) -> Result<String, String> {
    gcloud_for(args, 60)
}

/// Creating and deleting take a minute or two; everything else gets 60 s.
fn gcloud_for(args: &[&str], secs: u64) -> Result<String, String> {
    let bin = ["/opt/homebrew/bin/gcloud", "/usr/local/bin/gcloud"]
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())
        .ok_or("gcloud isn't installed")?;
    let mut cmd = Command::new(bin);
    let project = config()?.gcp_project;
    cmd.args(args).args(["--project", &project, "--quiet"]).env("PATH", PATH);
    run_for(&mut cmd, Duration::from_secs(secs))
        .map_err(|e| e.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("gcloud failed").trim().to_string())
}

fn servers() -> Result<Vec<Server>, String> {
    let out = gcloud(&[
        "compute",
        "instances",
        "list",
        &format!("--filter=labels.{LABEL}=1"),
        "--format=value(name,zone.basename(),status,networkInterfaces[0].accessConfigs[0].natIP)",
    ])?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            (f.len() >= 3).then(|| Server {
                name: f[0].to_string(),
                zone: f[1].to_string(),
                status: f[2].to_string(),
                ip: f.get(3).filter(|s| !s.is_empty()).map(|s| s.to_string()),
            })
        })
        .collect())
}

/// Deletes every VPN server and waits until Google confirms it.
fn delete_servers() -> Result<(), String> {
    for s in servers()? {
        delete_server(&s, false)?;
    }
    Ok(())
}

/// `background` deletes on its own thread (instances delete has no --async)
/// so switching countries doesn't wait for the old server to go.
fn delete_server(s: &Server, background: bool) -> Result<(), String> {
    info!("VPN: deleting {}", s.name);
    let (name, zone) = (s.name.clone(), s.zone.clone());
    let delete = move || gcloud_for(&["compute", "instances", "delete", &name, "--zone", &zone], 180).map(|_| ());
    if background {
        std::thread::spawn(move || {
            if let Err(e) = delete() {
                warn!("VPN: background delete failed: {e}");
            }
        });
        Ok(())
    } else {
        delete()
    }
}

fn ensure_firewall() -> Result<(), String> {
    if gcloud(&["compute", "firewall-rules", "describe", "gus-vpn-wg", "--format=value(name)"]).is_ok() {
        return Ok(());
    }
    gcloud(&[
        "compute",
        "firewall-rules",
        "create",
        "gus-vpn-wg",
        "--network",
        "default",
        "--allow",
        "udp:51820",
        "--target-tags",
        LABEL,
        "--source-ranges",
        "0.0.0.0/0",
    ])
    .map(|_| ())
}

/// Spot first (a fraction of the price), on-demand if no zone has spot room.
fn create_server(c: &Country, name: &str, keys: &Keys) -> Result<String, String> {
    let script = dir()?.join("startup.sh");
    std::fs::write(&script, STARTUP_SCRIPT).map_err(|e| e.to_string())?;
    let metadata = format!("wg-server-key={},wg-client-pub={}", keys.server_private, keys.client_public);
    let script_arg = format!("startup-script={}", script.display());
    let attempts = [("a", true), ("b", true), ("c", true), ("a", false), ("b", false)];
    let mut last = String::new();
    for (zone, spot) in attempts {
        let zone = format!("{}-{zone}", c.region);
        let mut args = vec![
            "compute", "instances", "create", name, "--zone", &zone, "--machine-type", "e2-micro",
            "--image-family", "debian-12", "--image-project", "debian-cloud", "--boot-disk-size", "10GB",
            "--tags", LABEL, "--labels", "gus-vpn=1", "--metadata", &metadata,
            "--metadata-from-file", &script_arg,
            "--instance-termination-action", "DELETE", "--max-run-duration", "10h",
            "--format=value(networkInterfaces[0].accessConfigs[0].natIP)",
        ];
        if spot {
            args.extend(["--provisioning-model", "SPOT"]);
        }
        match gcloud_for(&args, 180) {
            Ok(ip) if !ip.trim().is_empty() => {
                info!("VPN: {name} up in {zone} (spot={spot}) at {}", ip.trim());
                return Ok(ip.trim().to_string());
            }
            Ok(_) => last = "the server came up without an address".into(),
            Err(e) => {
                warn!("VPN: create in {zone} (spot={spot}) failed: {e}");
                last = e;
            }
        }
    }
    Err(last)
}

/// The startup script prints a marker to the serial console once WireGuard
/// is listening.
fn wait_ready(name: &str, region: &str) -> Result<(), String> {
    let zone = servers()?
        .into_iter()
        .find(|s| s.name == name)
        .map(|s| s.zone)
        .unwrap_or_else(|| format!("{region}-a"));
    let deadline = Instant::now() + Duration::from_secs(180);
    while Instant::now() < deadline {
        go_on()?;
        if let Ok(out) = gcloud(&["compute", "instances", "get-serial-port-output", name, "--zone", &zone]) {
            if out.contains("GUSVPN READY") {
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_secs(3));
    }
    Err("the server didn't finish setting up in 3 minutes".into())
}

// ---- DNS ----

fn cloudflare(method: &str, path: &str, body: Option<&str>) -> Result<serde_json::Value, String> {
    let home = std::env::var("HOME").map_err(|_| "no HOME")?;
    let token = std::fs::read_to_string(format!("{home}/.config/cloudflare/api-token"))
        .map_err(|_| "no Cloudflare token at ~/.config/cloudflare/api-token")?;
    let zone = config()?.cloudflare_zone;
    let url = format!("https://api.cloudflare.com/client/v4/zones/{zone}/{path}");
    let auth = format!("Authorization: Bearer {}", token.trim());
    let mut args = vec!["-s", "--max-time", "15", "-X", method, "-H", &auth, "-H", "Content-Type: application/json"];
    if let Some(b) = body {
        args.extend(["--data", b]);
    }
    args.push(&url);
    let out = run("/usr/bin/curl", &args)?;
    let v: serde_json::Value = serde_json::from_str(&out).map_err(|e| format!("Cloudflare: {e}"))?;
    if v["success"].as_bool() != Some(true) {
        return Err(format!("Cloudflare: {}", v["errors"]));
    }
    Ok(v)
}

fn point_dns(ip: &str) -> Result<(), String> {
    let host = config()?.host;
    let found = cloudflare("GET", &format!("dns_records?type=A&name={host}"), None)?;
    let body = serde_json::json!({ "type": "A", "name": host, "content": ip, "ttl": 60, "proxied": false }).to_string();
    match found["result"].as_array().and_then(|r| r.first()).and_then(|r| r["id"].as_str()) {
        Some(id) => cloudflare("PUT", &format!("dns_records/{id}"), Some(&body))?,
        None => cloudflare("POST", "dns_records", Some(&body))?,
    };
    Ok(())
}

/// WireGuard resolves the endpoint when the tunnel starts, through the same
/// system cache as this, so wait until the cache has the new address.
fn wait_resolves(ip: &str) -> Result<(), String> {
    let host = config()?.host;
    let deadline = Instant::now() + Duration::from_secs(90);
    while Instant::now() < deadline {
        go_on()?;
        if let Ok(addrs) = (host.as_str(), 51820).to_socket_addrs() {
            if addrs.into_iter().any(|a| a.ip().to_string() == ip) {
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    Err(format!("{host} still doesn't point at the new server"))
}

// ---- helpers ----

fn run(bin: &str, args: &[&str]) -> Result<String, String> {
    run_for(Command::new(bin).args(args), Duration::from_secs(20))
}

/// Runs a command, killing it past `limit`. Its output is read while it runs,
/// so a long serial log can't fill the pipe and stall it.
fn run_for(cmd: &mut Command, limit: Duration) -> Result<String, String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    fn drain<R: std::io::Read + Send + 'static>(pipe: Option<R>) -> std::sync::mpsc::Receiver<Vec<u8>> {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            let _ = tx.send(buf);
        });
        rx
    }
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    // A grandchild can keep a pipe open after the kill; don't wait on it.
    let text = |rx: std::sync::mpsc::Receiver<Vec<u8>>| {
        String::from_utf8_lossy(&rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default()).into_owned()
    };
    let (out, err) = (text(out), text(err));
    match status {
        Some(s) if s.success() => Ok(out),
        Some(_) => Err(err.trim().to_string()),
        None => Err(format!("{} took over {}s", cmd.get_program().to_string_lossy(), limit.as_secs())),
    }
}

/// The country the internet sees this Mac in, from Cloudflare's trace. It is
/// fetched by IP, so it still answers when DNS is what broke.
fn exit_country() -> Option<String> {
    run("/usr/bin/curl", &["-s", "--max-time", "6", "https://1.1.1.1/cdn-cgi/trace"])
        .ok()
        .and_then(|t| trace_loc(&t))
}

fn trace_loc(trace: &str) -> Option<String> {
    trace
        .lines()
        .find_map(|l| l.strip_prefix("loc="))
        .map(|c| c.trim().to_string())
        .filter(|c| c.len() == 2)
}

fn notify(text: &str) {
    let script = format!("display notification {:?} with title \"Gus Assistant\"", text);
    let _ = Command::new("/usr/bin/osascript").args(["-e", &script]).status();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regions_come_from_zones() {
        let s = Server { name: "x".into(), zone: "southamerica-east1-a".into(), status: "RUNNING".into(), ip: None };
        assert_eq!(s.region(), "southamerica-east1");
        assert_eq!(country_for_region(&s.region()).map(|c| c.code), Some("BR"));
    }

    #[test]
    fn keypairs_are_wireguard_shaped() {
        let (private, public) = keypair().unwrap();
        let b64 = base64::engine::general_purpose::STANDARD;
        assert_eq!(b64.decode(private).unwrap().len(), 32);
        assert_eq!(b64.decode(public).unwrap().len(), 32);
    }

    #[test]
    fn off_wins_mid_start_and_over_a_stray_tunnel() {
        let br = || Phase::Starting("BR".into());
        assert_eq!(plan(&br(), "off", false), Action::Off);
        assert_eq!(plan(&Phase::Failed("x".into()), "off", false), Action::Off);
        assert_eq!(plan(&Phase::Off, "off", true), Action::Off);
        assert_eq!(plan(&Phase::Off, "off", false), Action::Ignore);
        assert_eq!(plan(&Phase::Stopping, "off", true), Action::Ignore);
        assert_eq!(plan(&br(), "US", false), Action::Ignore);
        assert_eq!(plan(&Phase::On("BR".into()), "BR", true), Action::Ignore);
        assert_eq!(plan(&Phase::On("BR".into()), "BR", false), Action::On("BR".into()));
        assert_eq!(plan(&Phase::Off, "XX", false), Action::Ignore);
    }

    fn sp() -> Server {
        Server { name: "gus-vpn-southamerica-east1".into(), zone: "southamerica-east1-a".into(), status: "RUNNING".into(), ip: None }
    }

    #[test]
    fn launch_keeps_a_tunnel_only_with_internet_from_the_right_country() {
        let s = sp();
        assert_eq!(after_launch(Some(&s), true, Some("BR")), (Some(Phase::On("BR".into())), false));
        // The 24 Oct case: tunnel up, server deleted, nothing coming through.
        assert_eq!(after_launch(None, true, None), (None, true));
        assert_eq!(
            after_launch(Some(&s), true, None),
            (Some(Phase::Failed("Brazil server running, tunnel off".into())), true)
        );
        assert_eq!(after_launch(Some(&s), true, Some("AU")).1, true);
        assert_eq!(after_launch(Some(&s), false, None), (Some(Phase::Failed("Brazil server running, tunnel off".into())), false));
        assert_eq!(after_launch(None, false, None), (None, false));
    }

    #[test]
    fn watchdog_counts_only_a_live_tunnel_without_internet() {
        assert_eq!(check(true, Some("BR")), Check::Fine);
        assert_eq!(check(true, None), Check::Miss);
        assert_eq!(check(false, None), Check::TunnelDown);
    }

    #[test]
    fn trace_gives_the_country() {
        assert_eq!(trace_loc("fl=1\nip=34.95.135.178\nloc=BR\ntls=TLSv1.3\n"), Some("BR".into()));
        assert_eq!(trace_loc("<html>blocked</html>"), None);
    }

    #[test]
    fn commands_past_their_deadline_are_killed() {
        let t = Instant::now();
        let r = run_for(Command::new("/bin/sleep").arg("10"), Duration::from_millis(500));
        assert!(r.unwrap_err().contains("took over"));
        assert!(t.elapsed() < Duration::from_secs(4));
    }

    #[test]
    fn long_output_doesnt_stall() {
        let out = run_for(Command::new("/bin/sh").args(["-c", "head -c 500000 /dev/zero"]), Duration::from_secs(10)).unwrap();
        assert_eq!(out.len(), 500000);
    }
}

// ---------- the window's VPN control (sidebar) ----------

#[derive(Clone, Serialize, specta::Type)]
pub struct VpnCountry {
    pub code: String,
    pub name: String,
    pub flag: String,
}

#[derive(Clone, Serialize, specta::Type)]
pub struct VpnState {
    /// "off", "starting", "on", "stopping" or "failed".
    pub phase: String,
    pub country: Option<VpnCountry>,
    pub reason: Option<String>,
    pub countries: Vec<VpnCountry>,
}

fn country_info(code: &str) -> Option<VpnCountry> {
    country(code).map(|c| VpnCountry { code: c.code.into(), name: c.name.into(), flag: c.flag.into() })
}

pub fn state() -> VpnState {
    let (phase, country, reason) = match phase() {
        Phase::Off => ("off", None, None),
        Phase::Starting(c) => ("starting", country_info(&c), None),
        Phase::On(c) => ("on", country_info(&c), None),
        Phase::Stopping => ("stopping", None, None),
        Phase::Failed(r) => ("failed", None, Some(r)),
    };
    VpnState {
        phase: phase.into(),
        country,
        reason,
        countries: COUNTRIES.iter().filter_map(|c| country_info(c.code)).collect(),
    }
}

#[tauri::command]
#[specta::specta]
pub fn vpn_state() -> VpnState {
    state()
}

#[tauri::command]
#[specta::specta]
pub fn vpn_select(app: AppHandle, choice: String) {
    select(&app, &choice);
}
