//! The accurate second pass: each chunk the live stream cuts at a pause is
//! re-heard by a slower, more accurate model (Cohere Transcribe by default) on
//! its own thread and its own loaded model, so it never waits on the live one.
//! Cohere can't detect the language, so each chunk's live text decides between
//! Portuguese and English.

use crate::managers::model::ModelManager;
use crate::managers::transcription::clean_editor_text;
use crate::settings::get_settings;
use log::{info, warn};
use serde::Serialize;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};
use transcribe_cpp::{Model, ModelOptions, RunOptions, Session, Task};

enum Job {
    Warm,
    Chunk { id: u64, pcm: Vec<f32>, live: String },
}

static TX: Mutex<Option<mpsc::Sender<Job>>> = Mutex::new(None);

#[derive(Clone, Serialize)]
struct Refined {
    id: u64,
    /// None when there was nothing better to offer: the live text stands.
    text: Option<String>,
    /// The pause before this chunk fell mid-sentence: the full stop the chunk
    /// before ends with gives way to this (a comma, or nothing).
    joins: Option<String>,
}

/// How much of the chunk before is heard again with each chunk, so the
/// model can tell whether the pause between them ended a sentence.
const CONTEXT_SAMPLES: usize = 16_000 * 6;

fn sender(app: &AppHandle) -> mpsc::Sender<Job> {
    let mut slot = TX.lock().unwrap();
    if let Some(tx) = slot.as_ref() {
        return tx.clone();
    }
    let (tx, rx) = mpsc::channel();
    let app = app.clone();
    std::thread::Builder::new()
        .name("refine".into())
        .spawn(move || run(app, rx))
        .expect("refine thread");
    *slot = Some(tx.clone());
    tx
}

/// Load the model ahead of the first pause, so the first chunk isn't late.
pub fn warm(app: &AppHandle) {
    let _ = sender(app).send(Job::Warm);
}

/// Queue a chunk; `dictation-refined` answers it, with or without new text.
pub fn queue(app: &AppHandle, id: u64, pcm: Vec<f32>, live: String) {
    let _ = sender(app).send(Job::Chunk { id, pcm, live });
}

/// The model the second pass uses: the setting, else the most precise
/// downloaded Cohere Transcribe file.
pub fn model_id(app: &AppHandle) -> Option<String> {
    let manager = app.try_state::<Arc<ModelManager>>()?;
    let models = manager.get_available_models();
    if let Some(id) = get_settings(app).refine_model {
        return models.iter().any(|m| m.id == id && m.is_downloaded).then_some(id);
    }
    let rank = |id: &str| ["Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M"].iter().position(|q| id.contains(q)).unwrap_or(9);
    models
        .iter()
        .filter(|m| m.is_downloaded && m.id.contains("cohere-transcribe") && m.id.ends_with(".gguf"))
        .min_by_key(|m| rank(&m.id))
        .map(|m| m.id.clone())
}

struct Loaded {
    id: String,
    session: Session,
    languages: Vec<String>,
}

fn load(app: &AppHandle) -> Option<Loaded> {
    let id = model_id(app)?;
    let path = app.state::<Arc<ModelManager>>().get_model_path(&id).ok()?;
    let started = Instant::now();
    let model = match Model::load_with(&path, &ModelOptions::default()) {
        Ok(m) => m,
        Err(e) => {
            warn!("refine: couldn't load {id}: {e}");
            return None;
        }
    };
    let languages = model.capabilities().languages;
    let session = match model.session() {
        Ok(s) => s,
        Err(e) => {
            warn!("refine: no session for {id}: {e}");
            return None;
        }
    };
    info!("refine: {id} loaded in {:?} on {}", started.elapsed(), session.model().backend());
    Some(Loaded { id, session, languages })
}

fn run(app: AppHandle, rx: mpsc::Receiver<Job>) {
    let mut loaded: Option<Loaded> = None;
    let mut last_language = String::from("en");
    let mut previous: Option<(u64, Vec<f32>)> = None;
    for job in rx {
        let wanted = model_id(&app);
        if loaded.as_ref().map(|l| Some(&l.id) != wanted.as_ref()).unwrap_or(true) {
            // Free the old model before loading the next one.
            drop(loaded.take());
            loaded = load(&app);
        }
        let Job::Chunk { id, pcm, live } = job else { continue };
        let context = previous
            .take()
            .filter(|(prev, _)| *prev + 1 == id)
            .map(|(_, audio)| audio[audio.len().saturating_sub(CONTEXT_SAMPLES)..].to_vec());
        let mut joins: Option<String> = None;
        let text = loaded.as_mut().and_then(|l| {
            let language = guess_language(&live, &last_language);
            if !l.languages.is_empty() && !l.languages.iter().any(|x| x == &language) {
                return None;
            }
            last_language = language.clone();
            let options = RunOptions { task: Task::Transcribe, language: Some(language), ..Default::default() };
            let started = Instant::now();
            let text = match l.session.run(&pcm, &options) {
                Ok(t) => clean_editor_text(t.text, &get_settings(&app), &l.languages),
                Err(e) => {
                    warn!("refine: chunk {id} failed: {e}");
                    return None;
                }
            };
            let mut text = strip_stray_dashes(&text);
            if text.is_empty() || dropped_words(&live, &text) {
                return None;
            }
            // Heard together with the end of the chunk before, the pause
            // between them shows as a sentence end or not.
            if let Some(context) = &context {
                let joint: Vec<f32> = context.iter().chain(pcm.iter()).copied().collect();
                if let Ok(t) = l.session.run(&joint, &options) {
                    if let Some((true, first, glue)) = boundary(&t.text, &text) {
                        text = with_first_word(&text, &first);
                        joins = Some(glue);
                    }
                }
            }
            info!(
                "refine: chunk {id}, {:.1}s of audio in {:?}{}",
                pcm.len() as f32 / 16000.0,
                started.elapsed(),
                if joins.is_some() { ", joins the sentence before" } else { "" }
            );
            Some(text)
        });
        previous = Some((id, pcm));
        crate::dictation::refined(id, text.as_deref());
        let _ = app.emit("dictation-refined", Refined { id, text, joins });
    }
}

fn norm(word: &str) -> String {
    word.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// The model sometimes hears a dash in trailing noise ("… nada. —").
fn strip_stray_dashes(text: &str) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    let dash = |w: &&str| w.chars().all(|c| matches!(c, '—' | '–' | '-'));
    let start = words.iter().position(|w| !dash(w)).unwrap_or(words.len());
    let end = words.iter().rposition(|w| !dash(w)).map_or(start, |e| e + 1);
    words[start..end].join(" ")
}

/// Finds the chunk's opening words inside the transcript of the previous
/// chunk's end plus this chunk. Returns whether the word before them carries
/// no sentence end (the pause fell mid-sentence), how the joint transcript
/// spells the chunk's first word, and the comma (or nothing) it puts between.
fn boundary(joint: &str, chunk: &str) -> Option<(bool, String, String)> {
    let joint: Vec<&str> = joint.split_whitespace().collect();
    let chunk: Vec<&str> = chunk.split_whitespace().collect();
    if chunk.is_empty() || joint.len() <= chunk.len() {
        return None;
    }
    let key: Vec<String> = chunk.iter().take(2).map(|w| norm(w)).collect();
    if key.iter().any(String::is_empty) {
        return None;
    }
    let expected = (joint.len() - chunk.len()) as i64;
    let pos = (1..joint.len())
        .filter(|&p| key.iter().enumerate().all(|(k, w)| joint.get(p + k).is_some_and(|x| norm(x) == *w)))
        .min_by_key(|&p| (p as i64 - expected).abs())?;
    if (pos as i64 - expected).abs() > 4 {
        return None;
    }
    let before = joint[pos - 1].trim_end_matches(['"', '\'', '”', ')']);
    let ends_sentence = before.ends_with(['.', '!', '?', '…', ':']);
    let glue = if before.ends_with([',', ';']) { before[before.len() - 1..].to_string() } else { String::new() };
    Some((!ends_sentence, joint[pos].to_string(), glue))
}

/// The chunk's first word, cased the way the joint transcript has it.
fn with_first_word(text: &str, joint_word: &str) -> String {
    let lower = joint_word.chars().next().is_some_and(char::is_lowercase);
    let mut chars = text.chars();
    match chars.next() {
        Some(c) if lower && c.is_uppercase() => c.to_lowercase().chain(chars).collect(),
        _ => text.to_string(),
    }
}

/// The accurate model sometimes skips a sentence on long audio. When its text
/// is much shorter than what the live model heard, the live text stands.
fn dropped_words(live: &str, refined: &str) -> bool {
    let count = |t: &str| t.split_whitespace().count() as f32;
    let (live, refined) = (count(live), count(refined));
    let dropped = live >= 6.0 && refined < live * 0.8;
    if dropped {
        warn!("refine: second pass kept {refined} of {live} words; keeping the live text");
    }
    dropped
}

const PORTUGUESE: &[&str] = &[
    "que", "não", "nao", "eu", "você", "voce", "para", "pra", "com", "uma", "um", "é", "isso", "mas", "está", "tá",
    "também", "muito", "mais", "se", "por", "do", "da", "dos", "das", "no", "na", "os", "meu", "minha", "ele", "ela",
    "gente", "tem", "foi", "vai", "ser", "como", "quando", "então", "porque", "aqui", "esse", "essa", "isso", "ou",
    "já", "ainda", "sobre", "fazer", "acho", "vamos", "pode", "seria",
];
const ENGLISH: &[&str] = &[
    "the", "and", "is", "to", "i", "you", "that", "it", "of", "in", "for", "on", "with", "this", "we", "be", "are",
    "have", "my", "so", "but", "what", "can", "just", "it's", "i'm", "don't", "was", "would", "if", "they", "there",
    "about", "like", "will", "your", "our", "think", "want",
];

/// "pt" or "en" by counting each language's common words in the live text;
/// a tie keeps the language of the chunk before.
pub fn guess_language(text: &str, previous: &str) -> String {
    let lower = text.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric() && c != '\'' && c != '’')
        .filter(|w| !w.is_empty())
        .collect();
    let pt = words.iter().filter(|w| PORTUGUESE.contains(w)).count()
        + lower.chars().filter(|c| "ãõçáéíóúâêô".contains(*c)).count().min(3);
    let en = words.iter().filter(|w| ENGLISH.contains(w)).count();
    match pt.cmp(&en) {
        std::cmp::Ordering::Greater => "pt".into(),
        std::cmp::Ordering::Less => "en".into(),
        std::cmp::Ordering::Equal => previous.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::guess_language;

    #[test]
    fn keeps_live_text_when_words_go_missing() {
        let live = "eu fiz uma pesquisa com o GPT sobre mais uma pessoa o Arthur que você também";
        assert!(super::dropped_words(live, "eu fiz uma pesquisa."));
        assert!(!super::dropped_words(live, "Eu fiz uma pesquisa com o GPT sobre mais uma pessoa, o Arthur, que você também."));
        assert!(!super::dropped_words("um dois", "um"));
    }

    #[test]
    fn finds_sentences_cut_by_a_pause() {
        // "Sem eu. Mudar nada." heard as one: no sentence end at the pause
        let (joins, first, glue) = super::boundary("Assim, automaticamente, sem eu mudar nada.", "Mudar nada.").unwrap();
        assert!(joins);
        assert_eq!(glue, "");
        assert_eq!(super::with_first_word("Mudar nada.", &first), "mudar nada.");
        // a real sentence end stays
        let (joins, _, _) = super::boundary("Faz sentido. Então vamos testar.", "Então vamos testar.").unwrap();
        assert!(!joins);
        // a name keeps its capital
        let (joins, first, _) = super::boundary("perguntar no chat para a Maria se pode", "Maria se pode.").unwrap();
        assert!(joins);
        assert_eq!(super::with_first_word("Maria se pode.", &first), "Maria se pode.");
        // the comma the model put at the pause comes along
        let (_, _, glue) = super::boundary("melhorando diretamente, assim, automaticamente", "Assim, automaticamente.").unwrap();
        assert_eq!(glue, ",");
        assert_eq!(super::strip_stray_dashes("sem eu mudar nada. —"), "sem eu mudar nada.");
        assert_eq!(super::strip_stray_dashes("—"), "");
        // nothing to line up
        assert!(super::boundary("Totally different words here.", "Mudar nada.").is_none());
    }

    #[test]
    fn tells_portuguese_from_english() {
        assert_eq!(guess_language("então o lote não foi uma compra inteligente", "en"), "pt");
        assert_eq!(guess_language("Can we explore ways to use a better model", "pt"), "en");
        assert_eq!(guess_language("Acme", "pt"), "pt");
    }
}

/// Runs the downloaded Cohere model over saved dictations, to compare with what
/// the live model wrote: `cargo test --release refine_real -- --ignored --nocapture`.
#[cfg(test)]
mod real {
    use super::guess_language;
    use transcribe_cpp::{Model, ModelOptions, RunOptions, Task};

    fn wav(path: &str) -> Vec<f32> {
        let mut reader = hound::WavReader::open(path).expect("wav");
        reader.samples::<i16>().map(|s| s.unwrap() as f32 / 32768.0).collect()
    }

    /// The last dictation, cut at pauses like the live editor does, each chunk
    /// re-heard and joined: `cargo test --release refine_chunks -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn refine_chunks() {
        crate::managers::transcription::init_transcribe_backend();
        let home = std::env::var("HOME").unwrap();
        let model = format!("{home}/.cache/huggingface/hub/models--handy-computer--cohere-transcribe-03-2026-gguf/snapshots/dfa4adebb64f3076b7b6b90b721275cc069cb421/cohere-transcribe-03-2026-Q8_0.gguf");
        let mut session = Model::load_with(&model, &ModelOptions::default()).unwrap().session().unwrap();
        let db = rusqlite::Connection::open(format!("{home}/Library/Application Support/com.gusdantas.assistant/history.db")).unwrap();
        let (file, pasted): (String, String) = db
            .query_row("select file_name, transcription_text from transcription_history order by id desc limit 1 offset ?1", [std::env::var("REFINE_OFFSET").unwrap_or("0".into()).parse::<i64>().unwrap()], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        let pcm = wav(&format!("{home}/Library/Application Support/com.gusdantas.assistant/recordings/{file}"));
        let mut chunker = crate::dictation::Chunker::always_on();
        let mut chunks = Vec::new();
        for frame in pcm.chunks(256) {
            chunker.feed(frame);
            if chunker.pause_ready() {
                chunks.push(chunker.take());
            }
        }
        chunks.push(chunker.take());
        let options = RunOptions { task: Task::Transcribe, language: Some("pt".into()), ..Default::default() };
        let mut out = String::new();
        let mut previous: Option<Vec<f32>> = None;
        for chunk in chunks.into_iter().filter(|c| c.len() > 8000) {
            let mut text = super::strip_stray_dashes(&session.run(&chunk, &options).unwrap().text);
            if let Some(prev) = &previous {
                let ctx = &prev[prev.len().saturating_sub(super::CONTEXT_SAMPLES)..];
                let joint: Vec<f32> = ctx.iter().chain(chunk.iter()).copied().collect();
                let t = session.run(&joint, &options).unwrap().text;
                if let Some((true, first, glue)) = super::boundary(&t, &text) {
                    text = super::with_first_word(&text, &first);
                    if out.ends_with('.') && !out.ends_with("..") {
                        out.pop();
                        out.push_str(&glue);
                    }
                }
            }
            print!("[{:.1}s] ", chunk.len() as f32 / 16000.0);
            out = if out.is_empty() { text } else { format!("{out} {text}") };
            previous = Some(chunk);
        }
        println!("\nPASTED BEFORE: {pasted}\nJOINED NOW:    {out}");
    }

    #[test]
    #[ignore]
    fn refine_real() {
        crate::managers::transcription::init_transcribe_backend();
        let home = std::env::var("HOME").unwrap();
        let model = format!("{home}/.cache/huggingface/hub/models--handy-computer--cohere-transcribe-03-2026-gguf/snapshots/dfa4adebb64f3076b7b6b90b721275cc069cb421/cohere-transcribe-03-2026-Q8_0.gguf");
        let t = std::time::Instant::now();
        let model = Model::load_with(&model, &ModelOptions::default()).expect("load");
        let mut session = model.session().expect("session");
        println!("loaded in {:?} on {}", t.elapsed(), session.model().backend());
        let dir = format!("{home}/Library/Application Support/com.gusdantas.assistant/recordings");
        let db = rusqlite::Connection::open(format!("{home}/Library/Application Support/com.gusdantas.assistant/history.db")).unwrap();
        let mut query = db.prepare("select file_name, transcription_text from transcription_history order by id desc limit 5").unwrap();
        let cases: Vec<(String, String)> = query.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().flatten().collect();
        for (file, live) in &cases {
            let live = live.as_str();
            let pcm = wav(&format!("{dir}/{file}"));
            let language = guess_language(live, "en");
            let t = std::time::Instant::now();
            let out = session
                .run(&pcm, &RunOptions { task: Task::Transcribe, language: Some(language.clone()), ..Default::default() })
                .expect("run");
            println!("\n{file} ({:.1}s audio, {language}, {:?})\nLIVE:   {live}\nCOHERE: {}", pcm.len() as f32 / 16000.0, t.elapsed(), out.text);
        }
    }
}
