//! The dictation's check, done a sentence at a time while Gus is still talking,
//! so the key that ends the recording only waits for the last sentence.
//!
//! As the editor's text grows, every finished sentence (it ends in . ? or !)
//! that hasn't been sent yet goes to a single background worker, in order, with
//! the language the dictation started in. Answers are kept against the exact
//! sentences they came from. At the end the final text is split the same way:
//! runs of sentences that were checked word for word take the checked text, and
//! whatever is left (the last sentence, anything Gus edited) is checked then.
//! The cache is keyed by the exact text, so a sentence that changed is simply
//! checked again; it can cost time, never correctness.

use log::{info, warn};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;

struct Group {
    raw: Vec<String>,
    checked: String,
}

struct Job {
    app: AppHandle,
    sentences: Vec<String>,
    language: Option<&'static str>,
    session: u64,
}

static GROUPS: Mutex<Vec<Group>> = Mutex::new(Vec::new());
/// Sentences already sent to the worker this session (answered or not).
static SENT: Mutex<Vec<String>> = Mutex::new(Vec::new());
static IN_FLIGHT: Mutex<usize> = Mutex::new(0);
static LANGUAGE: Mutex<Option<&'static str>> = Mutex::new(None);
static SESSION: Mutex<u64> = Mutex::new(0);
static WORKER: OnceLock<Mutex<Sender<Job>>> = OnceLock::new();

/// Splits after . ? ! (and …) followed by a space. The last piece may be an
/// unfinished sentence; `finished` says whether it ended.
pub fn split(text: &str) -> (Vec<String>, bool) {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        current.push(c);
        if matches!(c, '.' | '?' | '!' | '…') && chars.peek().is_none_or(|n| n.is_whitespace()) {
            // Keep "?!" and "..." together.
            while let Some(&n) = chars.peek() {
                if matches!(n, '.' | '?' | '!') {
                    current.push(n);
                    chars.next();
                } else {
                    break;
                }
            }
            let s = current.trim().to_string();
            if !s.is_empty() {
                out.push(s);
            }
            current.clear();
        }
    }
    let tail = current.trim().to_string();
    let finished = tail.is_empty();
    if !finished {
        out.push(tail);
    }
    (out, finished)
}

fn worker() -> Sender<Job> {
    WORKER
        .get_or_init(|| {
            let (tx, rx) = mpsc::channel::<Job>();
            std::thread::Builder::new()
                .name("precheck".into())
                .spawn(move || {
                    for job in rx {
                        let text = job.sentences.join(" ");
                        let started = Instant::now();
                        let result = tauri::async_runtime::block_on(crate::proofread::proofread_in(&job.app, &text, job.language));
                        if *SESSION.lock().unwrap() == job.session {
                            match result {
                                Ok(checked) if !checked.trim().is_empty() => {
                                    info!("precheck: {} sentences in {:?}", job.sentences.len(), started.elapsed());
                                    GROUPS.lock().unwrap().push(Group { raw: job.sentences, checked });
                                }
                                Ok(_) => {}
                                Err(e) => warn!("precheck: {e}"),
                            }
                        }
                        let mut n = IN_FLIGHT.lock().unwrap();
                        *n = n.saturating_sub(1);
                    }
                })
                .ok();
            Mutex::new(tx)
        })
        .lock()
        .unwrap()
        .clone()
}

/// A new dictation: forget the last one's sentences.
pub fn reset() {
    *SESSION.lock().unwrap() += 1;
    GROUPS.lock().unwrap().clear();
    SENT.lock().unwrap().clear();
    *LANGUAGE.lock().unwrap() = None;
}

fn language_of(text: &str) -> Option<&'static str> {
    let mut lang = LANGUAGE.lock().unwrap();
    if lang.is_none() && text.split_whitespace().count() >= 4 {
        *lang = crate::proofread::starting_language(text);
    }
    *lang
}

/// The editor's text grew: send the sentences that just finished.
pub fn feed(app: &AppHandle, text: &str) {
    if text.contains('\n') || crate::proofread::engine(app) == "none" {
        return;
    }
    let fixed = crate::sound_alikes::fix(app, text);
    let (mut sentences, finished) = split(&fixed);
    if !finished {
        sentences.pop();
    }
    let language = language_of(&fixed);
    let new: Vec<String> = {
        let mut sent = SENT.lock().unwrap();
        let fresh: Vec<String> = sentences.into_iter().filter(|s| !sent.contains(s)).collect();
        sent.extend(fresh.iter().cloned());
        fresh
    };
    if new.is_empty() {
        return;
    }
    *IN_FLIGHT.lock().unwrap() += 1;
    let job = Job { app: app.clone(), sentences: new, language, session: *SESSION.lock().unwrap() };
    if worker().send(job).is_err() {
        let mut n = IN_FLIGHT.lock().unwrap();
        *n = n.saturating_sub(1);
    }
}

enum Part {
    Checked(String),
    Run(Vec<String>),
}

/// The final text, checked: earlier sentences from what was done while he
/// talked, the rest now. A failed check leaves that part as heard.
pub async fn check(app: &AppHandle, text: &str) -> String {
    let started = Instant::now();
    // An answer on its way is worth a short wait; it is usually most of the text.
    while *IN_FLIGHT.lock().unwrap() > 0 && started.elapsed() < Duration::from_millis(2500) {
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    let language = language_of(text).or_else(|| crate::proofread::starting_language(text));
    if text.contains('\n') {
        return crate::proofread::proofread_in(app, text, language).await.unwrap_or_else(|_| text.to_string());
    }
    let (sentences, _) = split(text);
    let mut parts: Vec<Part> = Vec::new();
    {
        let groups = GROUPS.lock().unwrap();
        let mut i = 0;
        while i < sentences.len() {
            let hit = groups
                .iter()
                .filter(|g| sentences[i..].starts_with(&g.raw))
                .max_by_key(|g| g.raw.len());
            if let Some(g) = hit {
                parts.push(Part::Checked(g.checked.clone()));
                i += g.raw.len();
            } else {
                match parts.last_mut() {
                    Some(Part::Run(run)) => run.push(sentences[i].clone()),
                    _ => parts.push(Part::Run(vec![sentences[i].clone()])),
                }
                i += 1;
            }
        }
    }
    let reused = parts.iter().filter(|p| matches!(p, Part::Checked(_))).count();
    let mut out = Vec::new();
    for part in parts {
        match part {
            Part::Checked(t) => out.push(t),
            Part::Run(run) => {
                let raw = run.join(" ");
                match crate::proofread::proofread_in(app, &raw, language).await {
                    Ok(t) if !t.trim().is_empty() => out.push(t),
                    Ok(_) => out.push(raw),
                    Err(e) => {
                        warn!("dictation: check failed, this part goes in as heard: {e}");
                        out.push(raw);
                    }
                }
            }
        }
    }
    info!("dictation: checked in {:?} ({reused} parts done while talking)", started.elapsed());
    out.join(" ")
}

#[cfg(test)]
mod tests {
    use super::split;

    #[test]
    fn splits_finished_sentences_and_keeps_the_tail() {
        let (s, done) = split("Ótimo, pode subir. Eu notei isso?! E também");
        assert_eq!(s, vec!["Ótimo, pode subir.", "Eu notei isso?!", "E também"]);
        assert!(!done);
        let (s, done) = split("Uma frase. Duas frases.");
        assert_eq!(s, vec!["Uma frase.", "Duas frases."]);
        assert!(done);
        // A dot inside a word or a number is not an end.
        let (s, _) = split("Veja ghostavo.com e o 1.5 de hoje.");
        assert_eq!(s, vec!["Veja ghostavo.com e o 1.5 de hoje."]);
    }
}
