//! Turning terminal text into something worth listening to.
//!
//! The reader hands whole blocks to the synthesizer, and a terminal block is
//! mostly things nobody wants spoken: escape sequences, box drawing, commit
//! hashes, prompt decoration, a path with nine segments. Read literally they
//! come out as a minute of punctuation. This module rewrites a block into the
//! sentence a person would have said, and it runs in front of both the local
//! voice and the browser's, so the two say the same thing.
//!
//! The rewriting lives in the tables below rather than in the speak path, so
//! the rules can be read as a list and tested as a list. Each entry names what
//! it is for, the pattern it recognises, and what the listener hears instead:
//! [`Say`] for a phrase, [`Drop`] to delete it, and the three shaping actions
//! for matches that need their own capture rewritten.
//!
//! [`Kind`] is the reader's own classification, not a guess made here. With
//! shell integration on, a prompt row and the output of the command it started
//! are marked deterministically (OSC 133 A and C..D), and the reader passes
//! that through — so command output gets the aggressive scrub and a paragraph
//! of prose does not.

use std::sync::LazyLock;

use regex::{Captures, Regex};

/// What the reader says this text is. The reader's block classifier is the
/// source: OSC 133 markers where shell integration is on, its own heuristics
/// where it is not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Freeform text — a chat reply, a paragraph, a log line meant for people.
    Prose,
    /// The command line itself, the thing typed at a prompt.
    Command,
    /// What a command printed. The noisiest input there is.
    Output,
    /// A fenced code block. Announced, not read, unless the UI asks.
    Code,
}

impl Kind {
    /// Parse the `kind` field the reader sends. An unknown value reads as
    /// prose: speaking a paragraph plainly is the safe wrong answer.
    pub fn parse(value: &str) -> Self {
        match value.trim() {
            "command" | "prompt" => Self::Command,
            "output" => Self::Output,
            "code" => Self::Code,
            _ => Self::Prose,
        }
    }
}

/// What the listener hears where a rule matched.
#[derive(Debug, Clone, Copy)]
pub enum Action {
    /// Delete the match. For things that carry no meaning out loud.
    Drop,
    /// Replace the match with these words.
    Say(&'static str),
    /// Keep one copy of a run that repeats (`!!!!` → `!`).
    Squeeze,
    /// Rewrite a filesystem path the way a person reads one aloud.
    Path,
    /// Say the units of a byte count (`1.4G` → `1.4 gigabytes`).
    Size,
}

/// One rewriting rule. `what` is the reason it exists and doubles as the test
/// name; `pattern` and `action` are the rule itself.
#[derive(Debug)]
pub struct Rule {
    pub what: &'static str,
    pub pattern: &'static str,
    pub action: Action,
}

// ── The rules ─────────────────────────────────────────────────────────

/// Terminal control bytes. These reach the reader whenever a program writes
/// colour or moves the cursor, and every one of them is silence.
pub static ESCAPES: &[Rule] = &[
    Rule {
        what: "CSI sequences — colour, cursor moves, erase",
        pattern: r"\x1b\[[0-9;:?]*[ -/]*[@-~]",
        action: Action::Drop,
    },
    Rule {
        what: "OSC sequences — window titles, hyperlinks, shell integration",
        pattern: r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)",
        action: Action::Drop,
    },
    Rule {
        what: "single-character escapes left over from a partial sequence",
        pattern: r"\x1b[@-Z\\-_]",
        action: Action::Drop,
    },
    Rule {
        what: "carriage returns from progress lines that rewrote themselves",
        pattern: r"\r",
        action: Action::Drop,
    },
    Rule {
        what: "remaining control bytes",
        pattern: r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]",
        action: Action::Drop,
    },
    Rule {
        what: "zero-width and bidi marks",
        pattern: "[\u{200b}-\u{200f}\u{2060}\u{feff}]",
        action: Action::Drop,
    },
];

/// Drawing, not writing. Frames, spinners, progress bars and bullets are how a
/// TUI shows structure on a screen; out loud they are noise.
pub static DECORATION: &[Rule] = &[
    Rule {
        what: "box drawing, blocks and geometric shapes",
        pattern: "[\u{2500}-\u{259f}\u{25a0}-\u{25ff}\u{2b00}-\u{2bff}]+",
        action: Action::Drop,
    },
    Rule {
        what: "braille spinners",
        pattern: "[\u{2800}-\u{28ff}]+",
        action: Action::Drop,
    },
    Rule {
        what: "ASCII rules and separator lines",
        pattern: r"(?m)^[ \t]*[-=_*~+#.]{3,}[ \t]*$",
        action: Action::Drop,
    },
    Rule {
        what: "list bullets",
        pattern: r"(?m)^[ \t]*[•▪◦‣·*+][ \t]+",
        action: Action::Drop,
    },
    Rule {
        what: "markdown heading marks",
        pattern: r"(?m)^[ \t]*#{1,6}[ \t]+",
        action: Action::Drop,
    },
    Rule {
        what: "checkbox and status glyphs",
        pattern: "[✓✔✗✘×⚠⚡★☆»«\u{fe0f}]",
        action: Action::Drop,
    },
];

/// Long opaque strings. A commit hash read digit by digit is forty seconds of
/// nothing; naming it is the whole of what a listener wanted.
pub static NOISE: &[Rule] = &[
    Rule {
        what: "UUIDs",
        pattern: r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b",
        action: Action::Say(" an identifier "),
    },
    Rule {
        what: "long runs of digits",
        pattern: r"\b\d{7,}\b",
        action: Action::Say(" a long number "),
    },
    Rule {
        what: "sha256 and git object hashes",
        pattern: r"\b[0-9a-f]{8,}\b",
        action: Action::Say(" a hash "),
    },
    Rule {
        what: "base64 blobs and bearer tokens",
        pattern: r"\b[A-Za-z0-9+_-]{32,}={0,2}\b",
        action: Action::Say(" a long token "),
    },
    Rule {
        what: "byte counts",
        pattern: r"\b(\d+(?:\.\d+)?)\s?([KMGT])(?:i?B)?\b",
        action: Action::Size,
    },
    Rule {
        what: "runs of repeated punctuation",
        pattern: r"!{3,}|\?{3,}|\.{4,}|,{3,}|;{3,}|:{3,}|\*{3,}|#{3,}|={3,}|~{3,}|_{3,}|\+{3,}|-{3,}",
        action: Action::Squeeze,
    },
];

/// Symbols that do carry meaning. A pipeline is a sentence about what feeds
/// what, and saying so is the difference between following it and not.
pub static SYMBOLS: &[Rule] = &[
    Rule {
        what: "stderr redirected onto stdout",
        pattern: r"2>&1",
        action: Action::Drop,
    },
    Rule {
        what: "shell and",
        pattern: r"&&",
        action: Action::Say(" and then "),
    },
    Rule {
        what: "shell or",
        pattern: r"\|\|",
        action: Action::Say(" or else "),
    },
    Rule {
        what: "arrows",
        pattern: r"(?:->|=>|→|⇒)",
        action: Action::Say(" to "),
    },
    Rule {
        what: "pipes",
        pattern: r"\s\|\s",
        action: Action::Say(" piped to "),
    },
    Rule {
        what: "append and truncate redirects",
        pattern: r"\s>>?\s",
        action: Action::Say(" into "),
    },
    Rule {
        what: "the exit status variable",
        pattern: r"\$\?",
        action: Action::Say(" the exit code "),
    },
    Rule {
        what: "the home directory on its own",
        pattern: r"(?m)(?:^|\s)~(?:$|\s)",
        action: Action::Say(" home "),
    },
    Rule {
        what: "at signs in addresses and hosts",
        pattern: r"@",
        action: Action::Say(" at "),
    },
];

/// Prompt decoration, stripped from the command line only. The sigil a shell
/// ends its prompt with is the last one on the row, so the strip runs to the
/// last one there is. Redirects are deliberately not sigils: `echo a > b` is a
/// command, not a prompt.
pub static PROMPTS: &[Rule] = &[Rule {
    what: "everything up to and including the prompt sigil",
    pattern: r"(?m)^.*[$#%❯➜›»⟩][ \t]+",
    action: Action::Drop,
}];

/// Filesystem paths, rewritten by [`humanize_path`].
pub static PATHS: &[Rule] = &[Rule {
    what: "paths of two segments or more",
    pattern: r"(?:~|\.{1,2})?(?:/[\w.@%+-]+){2,}/?",
    action: Action::Path,
}];

/// Counts small enough to be worth a word. Past this the digits read fine.
static COUNT_WORDS: &[&str] = &[
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
    "twenty",
];

/// Abbreviations that end in a full stop without ending a sentence.
static ABBREVIATIONS: &[&str] = &[
    "e.g", "i.e", "etc", "vs", "cf", "approx", "dr", "mr", "mrs", "ms", "st", "no", "fig", "al",
];

static SIZE_UNITS: &[(&str, &str)] = &[
    ("K", "kilobytes"),
    ("M", "megabytes"),
    ("G", "gigabytes"),
    ("T", "terabytes"),
];

// ── Applying them ─────────────────────────────────────────────────────

struct Compiled {
    regex: Regex,
    action: Action,
}

fn compile(rules: &'static [Rule]) -> Vec<Compiled> {
    rules
        .iter()
        .map(|rule| Compiled {
            regex: Regex::new(rule.pattern)
                .unwrap_or_else(|e| panic!("speech rule {:?} does not compile: {e}", rule.what)),
            action: rule.action,
        })
        .collect()
}

static ESCAPE_RULES: LazyLock<Vec<Compiled>> = LazyLock::new(|| compile(ESCAPES));
static DECORATION_RULES: LazyLock<Vec<Compiled>> = LazyLock::new(|| compile(DECORATION));
static NOISE_RULES: LazyLock<Vec<Compiled>> = LazyLock::new(|| compile(NOISE));
static SYMBOL_RULES: LazyLock<Vec<Compiled>> = LazyLock::new(|| compile(SYMBOLS));
static PATH_RULES: LazyLock<Vec<Compiled>> = LazyLock::new(|| compile(PATHS));
static PROMPT_RULES: LazyLock<Vec<Compiled>> = LazyLock::new(|| compile(PROMPTS));
static WHITESPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t]+").unwrap());
static BLANK_LINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{2,}").unwrap());

fn apply(rules: &[Compiled], text: &str) -> String {
    let mut out = text.to_string();
    for rule in rules {
        out = rule
            .regex
            .replace_all(&out, |caps: &Captures| match rule.action {
                Action::Drop => " ".to_string(),
                Action::Say(words) => words.to_string(),
                Action::Squeeze => caps[0].chars().take(1).collect(),
                Action::Path => humanize_path(&caps[0]),
                Action::Size => say_size(caps.get(1), caps.get(2)),
            })
            .into_owned();
    }
    out
}

fn say_size(amount: Option<regex::Match<'_>>, unit: Option<regex::Match<'_>>) -> String {
    let amount = amount.map(|m| m.as_str()).unwrap_or_default();
    let unit = unit.map(|m| m.as_str()).unwrap_or_default();
    let spoken = SIZE_UNITS
        .iter()
        .find(|(key, _)| *key == unit)
        .map(|(_, words)| *words)
        .unwrap_or("bytes");
    format!("{amount} {spoken}")
}

/// How a person says a path out loud: the file, and the one directory that
/// tells you where it is. `/home/control/mobux/src/main.rs` is "main dot rs in
/// src" — nobody recites the whole chain, and nobody spells the slashes.
pub fn humanize_path(path: &str) -> String {
    let trailing_slash = path.ends_with('/');
    let home = path.starts_with('~');
    let segments: Vec<&str> = path
        .trim_end_matches('/')
        .split('/')
        .filter(|s| !s.is_empty() && *s != "~" && *s != "." && *s != "..")
        .collect();

    let spoken = match segments.as_slice() {
        [] if home => "home".to_string(),
        [] => "the root directory".to_string(),
        [only] => say_segment(only),
        [.., parent, last] => format!("{} in {}", say_segment(last), say_segment(parent)),
    };

    if trailing_slash && !segments.is_empty() {
        return format!(" the {spoken} directory ");
    }
    format!(" {spoken} ")
}

/// One path segment as words. Separators inside a name are word breaks, and a
/// file extension is the one dot worth saying.
fn say_segment(segment: &str) -> String {
    let words = segment.replace(['_', '-', '+'], " ").replace('.', " dot ");
    WHITESPACE.replace_all(words.trim(), " ").into_owned()
}

/// A count as a word where a word reads better than digits.
pub fn count_word(n: usize) -> String {
    COUNT_WORDS
        .get(n)
        .map(|w| (*w).to_string())
        .unwrap_or_else(|| n.to_string())
}

/// What the reader says instead of reading a code block: what it is and how
/// much of it there is. The language comes from the fence the reader already
/// parsed; without one it is just "code".
pub fn announce_code(language: &str, lines: usize) -> String {
    let language = language.trim();
    let language = if language.is_empty() {
        "code"
    } else {
        language
    };
    if lines == 1 {
        return format!("{language}, one line");
    }
    format!("{language}, {} lines", count_word(lines))
}

/// The fence language of a code block, where the block still carries its
/// fence. `bash` out of "```bash".
pub fn fence_language(text: &str) -> String {
    static FENCE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?m)^[ \t]*(?:```|~~~)[ \t]*([A-Za-z0-9_+-]*)[ \t]*$").unwrap()
    });
    FENCE
        .captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_ascii_lowercase())
        .unwrap_or_default()
}

/// What the synthesizer is given, and the pieces it is given in. Splitting
/// happens here rather than in the speak path so that both the local voice and
/// the browser's read the same sentences.
#[derive(Debug, Clone, PartialEq)]
pub struct Speech {
    pub text: String,
    pub sentences: Vec<String>,
}

/// Said when a block scrubs down to nothing — a frame, a progress bar, a line
/// of box drawing. A button that plays silence is indistinguishable from one
/// that is broken.
pub const NOTHING_TO_READ: &str = "Nothing to read here.";

/// What the reader knows about the block beyond its text. Both fields only
/// mean something for [`Kind::Code`]: the reader tokenizer reads the fence
/// language off the fence it consumed, and `expand` is the explicit request to
/// read the block rather than announce it.
#[derive(Debug, Clone, Default)]
pub struct Options {
    pub expand: bool,
    pub language: String,
}

/// Rewrite a block of terminal text into what should be spoken.
pub fn normalize(kind: Kind, text: &str, options: &Options) -> Speech {
    let text = apply(&ESCAPE_RULES, text);

    let spoken = match kind {
        Kind::Code => normalize_code(&text, options),
        Kind::Prose => normalize_prose(&text),
        Kind::Command => normalize_command(&text),
        Kind::Output => normalize_output(&text),
    };

    let spoken = tidy(&spoken);
    if spoken.is_empty() {
        return Speech {
            text: NOTHING_TO_READ.to_string(),
            sentences: vec![NOTHING_TO_READ.to_string()],
        };
    }
    let sentences = split_sentences(&spoken);
    Speech {
        text: spoken,
        sentences,
    }
}

fn normalize_prose(text: &str) -> String {
    let text = apply(&NOISE_RULES, text);
    let text = apply(&PATH_RULES, &text);
    apply(&SYMBOL_RULES, &text)
}

fn normalize_command(text: &str) -> String {
    let text = apply(&PROMPT_RULES, text);
    let text = apply(&DECORATION_RULES, &text);
    let text = apply(&NOISE_RULES, &text);
    let text = apply(&PATH_RULES, &text);
    let text = apply(&SYMBOL_RULES, &text);
    let text = tidy(&text);
    if text.is_empty() {
        return String::new();
    }
    format!("Command: {text}")
}

fn normalize_output(text: &str) -> String {
    let text = apply(&DECORATION_RULES, text);
    let text = apply(&NOISE_RULES, &text);
    let text = apply(&PATH_RULES, &text);
    apply(&SYMBOL_RULES, &text)
}

fn normalize_code(text: &str, options: &Options) -> String {
    let language = match options.language.trim() {
        "" => fence_language(text),
        named => named.to_ascii_lowercase(),
    };
    let body: Vec<&str> = text
        .lines()
        .filter(|line| {
            !line.trim_start().starts_with("```") && !line.trim_start().starts_with("~~~")
        })
        .collect();
    let lines = body.iter().filter(|l| !l.trim().is_empty()).count();
    let announcement = announce_code(&language, lines);
    if !options.expand {
        return announcement;
    }
    let read = apply(&PATH_RULES, &body.join("\n"));
    let read = apply(&SYMBOL_RULES, &read);
    format!("{announcement}. {read}")
}

fn tidy(text: &str) -> String {
    let text = BLANK_LINES.replace_all(text, "\n").into_owned();
    let lines: Vec<String> = text
        .lines()
        .map(|line| WHITESPACE.replace_all(line, " ").trim().to_string())
        .filter(|line| !line.is_empty())
        .collect();
    lines.join("\n")
}

/// Break text into what the synthesizer should say in one breath.
///
/// A sentence ends at `.`, `!` or `?` followed by space — except after an
/// abbreviation, between the parts of a version number, and after an initial,
/// where the full stop is part of the word. Newlines end a sentence too: in
/// terminal output a line break is the strongest boundary there is.
pub fn split_sentences(text: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        push_sentences(line, &mut sentences);
    }
    if sentences.is_empty() && !text.trim().is_empty() {
        sentences.push(text.trim().to_string());
    }
    sentences
}

fn push_sentences(line: &str, out: &mut Vec<String>) {
    let chars: Vec<char> = line.chars().collect();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < chars.len() {
        if !matches!(chars[i], '.' | '!' | '?' | '…') {
            i += 1;
            continue;
        }
        let mut end = i + 1;
        while end < chars.len() && matches!(chars[end], '.' | '!' | '?' | '…') {
            end += 1;
        }
        let followed_by_space = end >= chars.len() || chars[end].is_whitespace();
        if !followed_by_space || !ends_a_sentence(&chars, start, i) {
            i = end;
            continue;
        }
        let sentence: String = chars[start..end].iter().collect();
        let sentence = sentence.trim();
        if !sentence.is_empty() {
            out.push(sentence.to_string());
        }
        while end < chars.len() && chars[end].is_whitespace() {
            end += 1;
        }
        start = end;
        i = end;
    }
    let tail: String = chars[start.min(chars.len())..].iter().collect();
    let tail = tail.trim();
    if !tail.is_empty() {
        out.push(tail.to_string());
    }
}

/// Whether the stop at `at` closes a sentence rather than sitting inside a
/// word. `1.5`, `e.g.` and an initial all keep going.
fn ends_a_sentence(chars: &[char], start: usize, at: usize) -> bool {
    if chars[at] != '.' {
        return true;
    }
    if at + 1 < chars.len() && chars[at + 1].is_ascii_digit() {
        return false;
    }
    let mut word: Vec<char> = chars[start..at]
        .iter()
        .rev()
        .take_while(|c| !c.is_whitespace())
        .copied()
        .collect();
    word.reverse();
    let word: String = word.into_iter().collect();
    if word.chars().count() == 1 && word.chars().all(|c| c.is_uppercase()) {
        return false;
    }
    let lowered = word.to_ascii_lowercase();
    let lowered = lowered.trim_matches(|c: char| !c.is_alphanumeric() && c != '.');
    ABBREVIATIONS.iter().all(|abbr| *abbr != lowered)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Every rule table has to compile; a bad pattern would otherwise only
    // surface the first time a listener hit that kind of text.
    #[test]
    fn every_rule_compiles_and_says_why_it_exists() {
        for table in [ESCAPES, DECORATION, NOISE, SYMBOLS, PATHS, PROMPTS] {
            for rule in table {
                assert!(!rule.what.is_empty(), "{}", rule.pattern);
                Regex::new(rule.pattern).unwrap_or_else(|e| panic!("{}: {e}", rule.what));
            }
        }
    }

    fn spoken(kind: Kind, text: &str) -> String {
        normalize(kind, text, &Options::default()).text
    }

    #[test]
    fn ansi_escapes_are_stripped_before_anything_is_spoken() {
        let cases: &[(&str, &str)] = &[
            ("\x1b[31mred\x1b[0m", "red"),
            ("\x1b[1;32mok\x1b[m done", "ok done"),
            ("\x1b[2J\x1b[Hcleared", "cleared"),
            ("\x1b]0;a title\x07shell", "shell"),
            (
                "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\",
                "link",
            ),
            ("one\rtwo", "one two"),
            ("keep \u{200b}this", "keep this"),
            ("\x1b[38;2;255;0;0mtruecolour\x1b[0m", "truecolour"),
        ];
        for (input, want) in cases {
            assert_eq!(&spoken(Kind::Prose, input), want, "{input:?}");
        }
    }

    #[test]
    fn decoration_is_not_read_out() {
        let cases: &[(&str, &str)] = &[
            ("┌────────┐", NOTHING_TO_READ),
            ("│ hello  │", "hello"),
            ("━━━━━━━━", NOTHING_TO_READ),
            ("--------", NOTHING_TO_READ),
            ("========", NOTHING_TO_READ),
            ("⠋ working", "working"),
            ("• first item", "first item"),
            ("## A heading", "A heading"),
            ("████████░░ 80%", "80%"),
            ("✓ passed", "passed"),
        ];
        for (input, want) in cases {
            assert_eq!(&spoken(Kind::Output, input), want, "{input:?}");
        }
    }

    #[test]
    fn prompt_decoration_is_dropped_and_the_command_is_announced() {
        let cases: &[(&str, &str)] = &[
            ("control@rig:~/mobux$ cargo test", "Command: cargo test"),
            ("$ ls", "Command: ls"),
            ("~/mobux ❯ git status", "Command: git status"),
            (
                "(venv) me@box:/srv# systemctl restart mobux",
                "Command: systemctl restart mobux",
            ),
            ("cargo build --release", "Command: cargo build --release"),
            ("echo done > out.txt", "Command: echo done into out.txt"),
        ];
        for (input, want) in cases {
            assert_eq!(&spoken(Kind::Command, input), want, "{input:?}");
        }
    }

    #[test]
    fn opaque_strings_are_named_rather_than_spelled() {
        let cases: &[(&str, &str)] = &[
            (
                "commit 4b5c1d3a9f2e8c7d6b5a4f3e2d1c0b9a8f7e6d5c",
                "commit a hash",
            ),
            (
                "id 550e8400-e29b-41d4-a716-446655440000 done",
                "id an identifier done",
            ),
            ("wow!!!!! really????", "wow! really?"),
            ("freed 1.4G of 512M", "freed 1.4 gigabytes of 512 megabytes"),
        ];
        for (input, want) in cases {
            assert_eq!(&spoken(Kind::Output, input), want, "{input:?}");
        }
    }

    #[test]
    fn shell_symbols_become_the_words_they_mean() {
        let cases: &[(&str, &str)] = &[
            (
                "make build && make test",
                "Command: make build and then make test",
            ),
            (
                "cat log | grep error",
                "Command: cat log piped to grep error",
            ),
            ("a -> b", "Command: a to b"),
            ("cargo test 2>&1", "Command: cargo test"),
        ];
        for (input, want) in cases {
            assert_eq!(&spoken(Kind::Command, input), want, "{input:?}");
        }
    }

    #[test]
    fn paths_read_the_way_a_person_says_them() {
        let cases: &[(&str, &str)] = &[
            ("/home/control/mobux/src/main.rs", "main dot rs in src"),
            (
                "~/.config/systemd/user/mobux.service",
                "mobux dot service in user",
            ),
            ("./web/static/reader.js", "reader dot js in static"),
            ("/usr/local/bin/", "the bin in local directory"),
            ("/", "/"),
        ];
        for (input, want) in cases {
            assert_eq!(&spoken(Kind::Prose, input), want, "{input:?}");
        }
    }

    #[test]
    fn a_path_segment_is_broken_into_words() {
        assert_eq!(
            say_segment("build-release-asset.sh"),
            "build release asset dot sh"
        );
        assert_eq!(say_segment("local_stt"), "local stt");
        assert_eq!(say_segment("main.rs"), "main dot rs");
    }

    #[test]
    fn a_code_block_is_announced_rather_than_read() {
        let block = "```bash\nset -e\nmake build\nmake test\n```";
        assert_eq!(
            normalize(Kind::Code, block, &Options::default()).text,
            "bash, three lines"
        );

        let read = normalize(
            Kind::Code,
            block,
            &Options {
                expand: true,
                ..Options::default()
            },
        )
        .text;
        assert!(read.starts_with("bash, three lines."), "{read}");
        assert!(read.contains("make test"), "{read}");

        // The reader tokenizer eats the fence, so the language it parsed is
        // passed alongside the lines rather than left in the text.
        let fenceless = normalize(
            Kind::Code,
            "npm ci\nnpm test",
            &Options {
                language: "Bash".to_string(),
                ..Options::default()
            },
        );
        assert_eq!(fenceless.text, "bash, two lines");
    }

    #[test]
    fn code_announcements_count_and_name_what_they_found() {
        let cases: &[(&str, usize, &str)] = &[
            ("bash", 12, "bash, twelve lines"),
            ("rust", 1, "rust, one line"),
            ("", 3, "code, three lines"),
            ("python", 40, "python, 40 lines"),
        ];
        for (language, lines, want) in cases {
            assert_eq!(&announce_code(language, *lines), want);
        }
    }

    #[test]
    fn the_fence_language_is_read_off_the_fence() {
        assert_eq!(fence_language("```bash\nls\n```"), "bash");
        assert_eq!(fence_language("~~~JSON\n{}\n~~~"), "json");
        assert_eq!(fence_language("```\nplain\n```"), "");
    }

    #[test]
    fn sentences_break_where_a_reader_would_breathe() {
        let cases: &[(&str, &[&str])] = &[
            ("One. Two! Three?", &["One.", "Two!", "Three?"]),
            (
                "Version 1.2.3 shipped. It works.",
                &["Version 1.2.3 shipped.", "It works."],
            ),
            (
                "Use a flag, e.g. --force, to skip it. Then rerun.",
                &["Use a flag, e.g. --force, to skip it.", "Then rerun."],
            ),
            ("first line\nsecond line", &["first line", "second line"]),
            ("no terminator here", &["no terminator here"]),
            ("Wait... then go.", &["Wait...", "then go."]),
        ];
        for (input, want) in cases {
            assert_eq!(split_sentences(input), *want, "{input:?}");
        }
    }

    #[test]
    fn normalizing_carries_the_sentence_split_with_it() {
        let speech = normalize(Kind::Prose, "All good. Nothing broke.", &Options::default());
        assert_eq!(speech.text, "All good. Nothing broke.");
        assert_eq!(speech.sentences, vec!["All good.", "Nothing broke."]);
    }

    // A block of pure frame would otherwise play as silence, which reads to a
    // listener exactly like a broken button.
    #[test]
    fn a_block_that_scrubs_to_nothing_says_so() {
        for input in ["┏━━━━━━┓", "\x1b[0m", "   ", "▓▓▓▓▓▓▓▓"] {
            let speech = normalize(Kind::Output, input, &Options::default());
            assert_eq!(speech.text, NOTHING_TO_READ, "{input:?}");
            assert_eq!(speech.sentences.len(), 1);
        }
    }

    #[test]
    fn the_reader_classification_picks_the_pipeline() {
        assert_eq!(Kind::parse("prompt"), Kind::Command);
        assert_eq!(Kind::parse("command"), Kind::Command);
        assert_eq!(Kind::parse("output"), Kind::Output);
        assert_eq!(Kind::parse("code"), Kind::Code);
        assert_eq!(Kind::parse("prose"), Kind::Prose);
        assert_eq!(Kind::parse("something else"), Kind::Prose);
    }

    // Prose is the one kind that keeps its punctuation and shape: scrubbing it
    // the way command output is scrubbed would eat the writing.
    #[test]
    fn prose_is_left_alone_apart_from_the_noise() {
        let input = "I rebased onto main and the tests pass — all 42 of them.";
        assert_eq!(spoken(Kind::Prose, input), input);
    }

    #[test]
    fn output_keeps_its_words_while_losing_its_frame() {
        let input = "\x1b[32m✓\x1b[0m 12 passed │ 0 failed in /home/control/mobux/target/debug";
        assert_eq!(
            spoken(Kind::Output, input),
            "12 passed 0 failed in debug in target"
        );
    }
}
