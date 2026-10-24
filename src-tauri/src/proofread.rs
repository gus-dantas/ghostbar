//! Proofreading a finished dictation: the instructions run on Claude Haiku 5.5
//! through the Messages API with the Anthropic key from the post-processing
//! settings. With no key, Apple Intelligence on the Mac does it instead.
//!
//! The instructions are proofread_prompt.txt (general), unless the user keeps
//! their own in the app's data folder (proofread_prompt.txt there), written
//! from their own proofreading habits. The Custom Words list is added as the
//! names to spell exactly.
//!
//! The check never changes the language: it is told the language the speaker
//! started in, and an answer that comes back in another language (Apple's
//! on-device model translates to English when it feels like it) or that grew
//! or shrank too much is thrown away, and the text goes in as heard.

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

/// The language a stretch of text starts in, between the two Gus speaks:
/// the first sentence or so decides, so a Portuguese dictation with English
/// words in it stays Portuguese. Common little words decide first (they work
/// on a short sentence, where statistics don't); whatlang breaks a tie.
pub fn starting_language(text: &str) -> Option<&'static str> {
    const PT: &[&str] = &[
        "não", "que", "de", "da", "do", "das", "dos", "o", "os", "eu", "você", "pode", "para", "pra", "com", "uma", "um", "é", "está",
        "tá", "isso", "esse", "essa", "mas", "em", "na", "nos", "ele", "ela", "gente", "também", "muito", "mais", "porque", "quando",
        "como", "foi", "tem", "vai", "sim", "aqui", "agora", "então", "ótimo", "acho", "quero", "queria", "seu", "sua", "meu", "minha",
    ];
    const EN: &[&str] = &[
        "the", "and", "you", "can", "is", "are", "to", "of", "it", "that", "this", "i", "we", "have", "with", "for", "be", "was",
        "not", "what", "my", "your", "in", "on", "so", "but", "just", "like", "will", "would", "great", "should", "could", "there",
    ];
    let start: String = text.chars().take(160).collect();
    let lower = start.to_lowercase();
    let (mut pt, mut en) = (0, 0);
    for word in lower.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()) {
        pt += PT.contains(&word) as i32;
        en += EN.contains(&word) as i32;
    }
    pt += 2 * lower.chars().filter(|c| "ãõçâêôà".contains(*c)).count().min(2) as i32;
    if pt != en {
        return Some(if pt > en { "pt" } else { "en" });
    }
    use whatlang::{Detector, Lang};
    let info = Detector::with_allowlist(vec![Lang::Por, Lang::Eng]).detect(&start)?;
    Some(match info.lang() {
        Lang::Por => "pt",
        _ => "en",
    })
}

fn language_name(code: &str) -> &'static str {
    if code == "pt" { "Brazilian Portuguese" } else { "English" }
}

/// Keeps the check only if it stayed in the speaker's language and about as long.
fn keep(heard: &str, checked: &str, language: Option<&str>) -> Result<(), String> {
    let (a, b) = (heard.chars().count() as f32, checked.chars().count() as f32);
    if a >= 20.0 && (b < a * 0.5 || b > a * 1.6) {
        return Err(format!("the check changed the length from {a} to {b} characters"));
    }
    if let (Some(want), Some(got)) = (language, starting_language(checked)) {
        if want != got {
            return Err(format!("the check answered in {} instead of {}", language_name(got), language_name(want)));
        }
    }
    Ok(())
}

pub async fn proofread(app: &AppHandle, text: &str) -> Result<String, String> {
    proofread_in(app, text, starting_language(text)).await
}

/// The check, held to a language decided elsewhere (the dictation's first words).
pub async fn proofread_in(app: &AppHandle, text: &str, language: Option<&'static str>) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(String::new());
    }
    let started = Instant::now();
    let user = format!("<transcript>\n{text}\n</transcript>");
    let mut system = instructions(app);
    if let Some(code) = language {
        let name = language_name(code);
        system.push_str(&format!(
            "\n\nThis transcript starts in {name}. Write the result in {name}. Never translate it into another language."
        ));
    }
    let result = match anthropic_key(app) {
        Some(key) => claude(&key, &system, &user).await,
        None => {
            // The on-device model rewrites too freely ("Ótimo" became "Bom dia"),
            // so it is held to the smallest edit.
            system.push_str(
                "\n\nBe conservative: change only punctuation, capitals, accents and words that were clearly misheard. Keep every other word exactly as he said it, including the first word.",
            );
            apple(&system, &user)
        }
    };
    match result {
        Ok(out) => match keep(text, &out, language) {
            Ok(()) => {
                info!("proofread {} → {} chars in {:?}", text.len(), out.len(), started.elapsed());
                Ok(out)
            }
            Err(why) => {
                warn!("proofread discarded, {why}; the text goes in as heard");
                Ok(text.to_string())
            }
        },
        Err(e) => {
            warn!("proofread failed: {e}");
            Err(e)
        }
    }
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

#[cfg(test)]
mod guard_tests {
    use super::{keep, starting_language};

    #[test]
    fn the_language_he_started_in_wins() {
        assert_eq!(starting_language("Ótimo, pode subir tudo no Github."), Some("pt"));
        assert_eq!(starting_language("Can you upload everything to GitHub?"), Some("en"));
        assert_eq!(starting_language("Eu queria Enable o Option da direita para poder falar no laptop"), Some("pt"));
        assert_eq!(starting_language("Simpado subiu o commit para o Github."), Some("pt"));
        assert_eq!(starting_language("Great, can you upload everything to GitHub?"), Some("en"));
    }

    #[test]
    fn a_translated_check_is_thrown_away() {
        let heard = "Ótimo, pode subir tudo no Github.";
        assert!(keep(heard, "Great, can you upload everything to GitHub?", Some("pt")).is_err());
        assert!(keep(heard, "Ótimo, pode subir tudo no GitHub.", Some("pt")).is_ok());
        assert!(keep("uma frase bem longa que foi ditada aqui agora", "frase", Some("pt")).is_err());
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
        // PROOFREAD_TEXT and PROOFREAD_PROMPT (a file) try other text and instructions.
        let mut dictated = std::env::var("PROOFREAD_TEXT").unwrap_or_else(|_| dictated.to_string());
        // PROOFREAD_ALIKES (a sound_alikes.txt) runs the fixes first, as a dictation does.
        if let Some(rules) = std::env::var("PROOFREAD_ALIKES").ok().and_then(|p| std::fs::read_to_string(p).ok()) {
            dictated = crate::sound_alikes::apply(&dictated, &crate::sound_alikes::parse(&rules));
            println!("after the fixes: {dictated}");
        }
        let prompt = std::env::var("PROOFREAD_PROMPT")
            .ok()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .unwrap_or_else(|| super::DEFAULT_INSTRUCTIONS.to_string());
        let t = std::time::Instant::now();
        let out = crate::apple_intelligence::process_text_with_system_prompt(
            &prompt,
            &format!("<transcript>\n{dictated}\n</transcript>"),
            0,
        );
        println!("{:?}\n{}", t.elapsed(), out.unwrap_or_else(|e| format!("ERROR {e}")));
    }
}
