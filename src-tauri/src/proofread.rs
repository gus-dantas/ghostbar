//! Proofreading a finished dictation: the instructions run on Claude Haiku 5.5
//! through the Messages API with the Anthropic key from the post-processing
//! settings. With no key, Apple Intelligence on the Mac does it instead.
//!
//! The instructions are proofread_prompt.txt (general), unless the user keeps
//! their own in the app's data folder (proofread_prompt.txt there), written
//! from their own proofreading habits. The Custom Words list is added as the
//! names to spell exactly.

use crate::settings::get_settings;
use log::{info, warn};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::AppHandle;

const DEFAULT_INSTRUCTIONS: &str = include_str!("proofread_prompt.txt");

/// The user's own instructions if they keep some, else the general ones, plus
/// their Custom Words as names to spell exactly.
fn instructions(app: &AppHandle) -> String {
    use tauri::Manager;
    let own = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("proofread_prompt.txt")).ok())
        .filter(|t| !t.trim().is_empty());
    let mut text = own.unwrap_or_else(|| DEFAULT_INSTRUCTIONS.to_string());
    let words = get_settings(app).custom_words;
    if !words.is_empty() {
        text.push_str(&format!("\n\nNames and words to spell exactly as written here: {}.", words.join(", ")));
    }
    text
}
const MODEL: &str = "claude-haiku-5-5";
const ENDPOINT: &str = "https://api.anthropic.com/v1/messages";

/// Which engine a proofread will use, for the panel's label.
pub fn engine(app: &AppHandle) -> &'static str {
    if anthropic_key(app).is_some() {
        "Claude Haiku"
    } else if apple_available() {
        "Apple Intelligence"
    } else {
        "none"
    }
}

fn anthropic_key(app: &AppHandle) -> Option<String> {
    let settings = get_settings(app);
    settings
        .post_process_api_keys
        .get("anthropic")
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
}

fn apple_available() -> bool {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        crate::apple_intelligence::check_apple_intelligence_availability()
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        false
    }
}

pub async fn proofread(app: &AppHandle, text: &str) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(String::new());
    }
    let started = Instant::now();
    let user = format!("<transcript>\n{text}\n</transcript>");
    let system = instructions(app);
    let result = match anthropic_key(app) {
        Some(key) => claude(&key, &system, &user).await,
        None => apple(&system, &user),
    };
    match &result {
        Ok(out) => info!("proofread {} → {} chars in {:?}", text.len(), out.len(), started.elapsed()),
        Err(e) => warn!("proofread failed: {e}"),
    }
    result
}

async fn claude(key: &str, system: &str, user: &str) -> Result<String, String> {
    let body = json!({
        "model": MODEL,
        "max_tokens": 4096,
        // A quick edit, not a problem to think about.
        "thinking": { "type": "disabled" },
        "output_config": { "effort": "low" },
        "system": system,
        "messages": [{ "role": "user", "content": user }],
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .post(ENDPOINT)
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Claude: {e}"))?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let message = value["error"]["message"].as_str().unwrap_or("unknown error");
        return Err(format!("Claude answered {status}: {message}"));
    }
    if value["stop_reason"] == "refusal" {
        return Err("Claude declined to proofread this text".into());
    }
    let out: String = value["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect()
        })
        .unwrap_or_default();
    Ok(out.trim().to_string())
}

fn apple(system: &str, user: &str) -> Result<String, String> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        if !apple_available() {
            return Err("Add an Anthropic key in Post-processing to proofread (Apple Intelligence is off)".into());
        }
        crate::apple_intelligence::process_text_with_system_prompt(system, user, 0)
            .map(|s| s.trim().to_string())
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        let _ = (system, user);
        Err("Add an Anthropic key in Post-processing to proofread".into())
    }
}

/// `cargo test --release --lib proofread_apple -- --ignored --nocapture`
#[cfg(all(test, target_os = "macos", target_arch = "aarch64"))]
mod tests {
    #[test]
    #[ignore]
    fn proofread_apple() {
        let dictated = "Can we explore ways of having the better model that one of the highest accuracy rate for Portuguese and English, but ideally seeing it real time and being able to interact with the text. So when I were this mispronounced, or it's something that needs to be typed without interrupting anything and just type it and it gets added also a lot of the times after I dictate here I copy the test and I paste on a proofread chat that I have in the chat session of cloud and that pretty much simplifies, correct any issue, increase clarity, break down correctly it doesn't change my prompt massively, but it improves it quite a bit so it'll be great as well that every time I finish dictating I have the option for both but done with the lightest model so it happens like real quick does that make sense";
        println!("available: {}", crate::apple_intelligence::check_apple_intelligence_availability());
        let t = std::time::Instant::now();
        let out = crate::apple_intelligence::process_text_with_system_prompt(
            super::DEFAULT_INSTRUCTIONS,
            &format!("<transcript>\n{dictated}\n</transcript>"),
            0,
        );
        println!("{:?}\n{}", t.elapsed(), out.unwrap_or_else(|e| format!("ERROR {e}")));
    }
}
