//! The dictation's check, done a sentence at a time while Gus is still talking,
//! so the key that ends the recording never waits for it: what was checked by
//! then is used, the rest goes in as heard (after the sound-alike fixes).
//!
//! As the editor's text grows, every finished sentence (it ends in . ? or !)
//! that hasn't been sent yet goes to a single background worker, in order, with
//! the language the dictation started in. Answers are kept against the exact
//! sentences they came from. At the end the final text is split the same way:
//! runs of sentences that were checked word for word take the checked text, and
//! whatever is left (the last sentence, anything Gus edited) goes in as it is.
//! Gus asked for the paste to be as instant as possible (25 Oct 2026), and the
//! on-device check rarely changed a word, so it is never waited on.

use log::{info, warn};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
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

/// The final text at once: sentences checked while he talked take their
/// checked text, everything else goes in as it is. Never waits.
pub fn assemble(text: &str) -> String {
    if text.contains('\n') {
        return text.to_string();
    }
    let (sentences, _) = split(text);
    let groups = GROUPS.lock().unwrap();
    let (mut out, mut reused, mut i) = (Vec::new(), 0, 0);
    while i < sentences.len() {
        let hit = groups.iter().filter(|g| sentences[i..].starts_with(&g.raw)).max_by_key(|g| g.raw.len());
        if let Some(g) = hit {
            out.push(g.checked.clone());
            reused += g.raw.len();
            i += g.raw.len();
        } else {
            out.push(sentences[i].clone());
            i += 1;
        }
    }
    info!("dictation: {reused} of {} sentences checked while talking", sentences.len());
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
