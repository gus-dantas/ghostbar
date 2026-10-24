//! Words a speech model reliably mishears, fixed before the dictation's check.
//!
//! The list is the user's own: sound_alikes.txt in the app's data folder, one
//! rule per line, `heard => written`, optionally `| near: a, b, c` so the rule
//! only fires when one of those words is close by. That is how a name and a
//! brand that sound alike stay apart: "Gustavo => Ghostavo | near: logo, site"
//! rewrites the brand and leaves the person alone. Matching ignores case and
//! respects word edges. Lines starting with # are notes.

use regex::Regex;
use tauri::{AppHandle, Manager};

/// How far either side of a match "near" looks, in characters.
const NEAR: usize = 48;

pub struct Rule {
    pattern: Regex,
    written: String,
    near: Vec<String>,
}

pub fn parse(text: &str) -> Vec<Rule> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (rule, near) = match line.split_once('|') {
                Some((rule, near)) => (rule, near.trim().strip_prefix("near:").unwrap_or(near.trim())),
                None => (line, ""),
            };
            let (heard, written) = rule.split_once("=>")?;
            let (heard, written) = (heard.trim(), written.trim());
            if heard.is_empty() || written.is_empty() {
                return None;
            }
            // Words joined by any run of spaces; edges that aren't letters or digits.
            let words: Vec<String> = heard.split_whitespace().map(regex::escape).collect();
            let pattern = Regex::new(&format!(r"(?i)(?:^|\b){}(?:\b|$)", words.join(r"\s+"))).ok()?;
            let near = near.split(',').map(|w| w.trim().to_lowercase()).filter(|w| !w.is_empty()).collect();
            Some(Rule { pattern, written: written.to_string(), near })
        })
        .collect()
}

fn floor_char(text: &str, mut i: usize) -> usize {
    while !text.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_char(text: &str, mut i: usize) -> usize {
    while i < text.len() && !text.is_char_boundary(i) {
        i += 1;
    }
    i
}

pub fn apply(text: &str, rules: &[Rule]) -> String {
    let mut out = text.to_string();
    for rule in rules {
        let mut next = String::with_capacity(out.len());
        let mut last = 0;
        for m in rule.pattern.find_iter(&out) {
            let fits = rule.near.is_empty() || {
                let from = floor_char(&out, m.start().saturating_sub(NEAR));
                let to = ceil_char(&out, (m.end() + NEAR).min(out.len()));
                let around = out[from..to].to_lowercase();
                rule.near.iter().any(|w| around.contains(w.as_str()))
            };
            if fits {
                next.push_str(&out[last..m.start()]);
                next.push_str(&rule.written);
                last = m.end();
            }
        }
        next.push_str(&out[last..]);
        out = next;
    }
    out
}

/// The user's rules, read fresh each time so an edit applies to the next dictation.
pub fn load(app: &AppHandle) -> Vec<Rule> {
    app.path()
        .app_data_dir()
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("sound_alikes.txt")).ok())
        .map(|t| parse(&t))
        .unwrap_or_default()
}

pub fn fix(app: &AppHandle, text: &str) -> String {
    let rules = load(app);
    if rules.is_empty() {
        text.to_string()
    } else {
        apply(text, &rules)
    }
}

#[cfg(test)]
mod tests {
    use super::{apply, parse};

    #[test]
    fn fixes_whole_words_in_any_case() {
        let rules = parse("# notes are skipped\nChat GPT => ChatGPT\nghost bar => Ghostbar\n");
        assert_eq!(apply("I asked chat  gpt about the Ghost Bar menu", &rules), "I asked ChatGPT about the Ghostbar menu");
        assert_eq!(apply("a ghost barn", &rules), "a ghost barn");
    }

    #[test]
    fn a_near_rule_keeps_the_name_and_fixes_the_brand() {
        let rules = parse("Gustavo => Ghostavo | near: logo, site, ponto com, .com\n");
        assert_eq!(apply("my name is Gustavo Dantas", &rules), "my name is Gustavo Dantas");
        assert_eq!(apply("o logo do Gustavo ficou bonito", &rules), "o logo do Ghostavo ficou bonito");
        assert_eq!(apply("o site gustavo ponto com", &rules), "o site Ghostavo ponto com");
    }

    #[test]
    fn accents_and_short_text_are_safe() {
        let rules = parse("Advenio => ADvendio | near: relatório\n");
        assert_eq!(apply("o relatório do Advenio", &rules), "o relatório do ADvendio");
        assert_eq!(apply("Advenio", &rules), "Advenio");
        assert_eq!(apply("", &rules), "");
    }
}
