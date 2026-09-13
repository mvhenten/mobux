//! The Piper voice, running in this process.
//!
//! Three steps: words to phonemes, phonemes to the ids the checkpoint was
//! trained on, ids through the VITS graph to samples. The first step is the
//! one that usually drags a C++ dependency in — Piper's own tooling shells out
//! to espeak-ng for it. This uses a CMU-dictionary phonemizer instead, which
//! is pure Rust and ships as one of the vendored files, so nothing here needs
//! a toolchain beyond cargo.
//!
//! Synthesis runs a sentence at a time. A VITS decode is quadratic in sequence
//! length and the reader hands over whole blocks, so one utterance per sentence
//! keeps a long block from stalling and lets the prosody restart where a person
//! would breathe.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use ort::session::Session;
use ort::value::Tensor;
use piper_plus_g2p::english::EnglishPhonemizer;
use piper_plus_g2p::{Phonemizer, PiperEncoder, UnknownTokenMode};

use super::wav;
use super::Phase;
use crate::release_asset::{self, Manifest, Progress};
use crate::speech_text::Speech;

/// Silence between sentences, so a block does not run together into one
/// breathless stretch.
const SENTENCE_GAP_SECS: f32 = 0.14;

/// Words the dictionary has never heard of but this terminal says constantly.
/// Without them "tmux" comes out as nothing at all.
const GLOSSARY: &[(&str, &str)] = &[
    ("mobux", "M OW1 B AH0 K S"),
    ("tmux", "T IY1 M AH0 K S"),
    ("npm", "EH1 N P IY1 EH1 M"),
    ("cli", "S IY1 EH1 L AY1"),
    ("ssh", "EH1 S EH1 S EY1 CH"),
    ("repo", "R IY1 P OW0"),
    ("sudo", "S UW1 D OW0"),
    ("json", "JH EY1 S AH0 N"),
    ("yaml", "Y AE1 M AH0 L"),
    ("stdout", "S T IY1 D AW1 T"),
    ("stderr", "S T IY1 D EH1 R"),
    ("localhost", "L OW1 K AH0 L HH OW2 S T"),
    ("systemd", "S IH1 S T AH0 M D IY1"),
    ("onnx", "OW1 N IH0 K S"),
    ("tts", "T IY1 T IY1 EH1 S"),
    ("stt", "EH1 S T IY1 T IY1"),
];

/// Letter names, so a word the dictionary does not carry is spelled instead of
/// dropped. Silence in the middle of a sentence is worse than a spelled name.
const LETTERS: &[(char, &str)] = &[
    ('a', "ay"),
    ('b', "bee"),
    ('c', "see"),
    ('d', "dee"),
    ('e', "ee"),
    ('f', "ef"),
    ('g', "gee"),
    ('h', "aitch"),
    ('i', "eye"),
    ('j', "jay"),
    ('k', "kay"),
    ('l', "el"),
    ('m', "em"),
    ('n', "en"),
    ('o', "oh"),
    ('p', "pee"),
    ('q', "cue"),
    ('r', "ar"),
    ('s', "ess"),
    ('t', "tee"),
    ('u', "you"),
    ('v', "vee"),
    ('w', "double you"),
    ('x', "ex"),
    ('y', "why"),
    ('z', "zee"),
];

/// Suffixes the phonemizer strips itself before giving up on a word. Checking
/// the same ones keeps the spell-out from firing on every plural.
const SUFFIXES: &[&str] = &["ing", "edly", "ed", "es", "s", "er", "est", "ly", "'s"];

struct Engine {
    /// The voice the reported phase belongs to, and the phase itself.
    phase: Mutex<(String, Phase)>,
    loaded: tokio::sync::Mutex<Option<Loaded>>,
    /// Held for the whole fetch-and-load, so a second caller joins the first
    /// rather than starting a second download of the same weights.
    preparing: tokio::sync::Mutex<()>,
}

fn engine() -> &'static Engine {
    static ENGINE: OnceLock<Engine> = OnceLock::new();
    ENGINE.get_or_init(|| Engine {
        phase: Mutex::new((String::new(), Phase::NotDownloaded)),
        loaded: tokio::sync::Mutex::new(None),
        preparing: tokio::sync::Mutex::new(()),
    })
}

fn set_phase(voice: &str, phase: Phase) {
    if let Ok(mut slot) = engine().phase.lock() {
        *slot = (voice.to_string(), phase);
    }
}

pub fn phase(data_dir: &Path, voice: &str) -> Phase {
    let voice = super::resolve_voice(voice);
    if let Ok(slot) = engine().phase.lock() {
        if slot.0 == voice {
            return slot.1.clone();
        }
    }
    if super::voice_files_present(data_dir, voice) {
        return Phase::Loading;
    }
    Phase::NotDownloaded
}

fn manifest(voice: &str) -> Manifest<'static> {
    Manifest {
        prefix: super::asset_voice_prefix(voice),
        files: &super::voice_lock().files,
    }
}

pub async fn ensure_ready(data_dir: PathBuf, voice: String) -> Result<(), String> {
    let voice = super::resolve_voice(&voice);
    if is_loaded(voice).await {
        return Ok(());
    }

    let _one_at_a_time = engine().preparing.lock().await;
    if is_loaded(voice).await {
        return Ok(());
    }

    set_phase(voice, Phase::Verifying);
    let existing = {
        let data_dir = data_dir.clone();
        let voice = voice.to_string();
        tokio::task::spawn_blocking(move || existing_voice_dir(&data_dir, &voice))
            .await
            .map_err(|e| format!("checking the voice panicked: {e}"))?
    };
    let dir = match existing {
        Some(dir) => dir,
        None => match fetch(&data_dir, voice).await {
            Ok(dir) => dir,
            Err(err) => {
                set_phase(voice, Phase::Failed(err.clone()));
                return Err(err);
            }
        },
    };

    set_phase(voice, Phase::Loading);
    let name = voice.to_string();
    let loaded = tokio::task::spawn_blocking(move || Loaded::load(&name, &dir))
        .await
        .map_err(|e| format!("loading the voice panicked: {e}"));
    let loaded = match loaded.and_then(|inner| inner) {
        Ok(loaded) => loaded,
        Err(err) => {
            set_phase(voice, Phase::Failed(err.clone()));
            return Err(err);
        }
    };

    *engine().loaded.lock().await = Some(loaded);
    set_phase(voice, Phase::Ready);
    Ok(())
}

pub async fn synthesize(
    data_dir: PathBuf,
    voice: String,
    speech: Speech,
) -> Result<Vec<u8>, String> {
    let voice = super::resolve_voice(&voice);
    ensure_ready(data_dir, voice.to_string()).await?;

    let mut guard = engine().loaded.lock().await;
    let mut loaded = guard
        .take()
        .ok_or_else(|| "the voice is not loaded".to_string())?;
    let handed_back = tokio::task::spawn_blocking(move || {
        let clip = loaded.run(&speech);
        (loaded, clip)
    })
    .await;

    match handed_back {
        Ok((loaded, clip)) => {
            *guard = Some(loaded);
            clip
        }
        Err(e) => {
            let err = format!("synthesis panicked: {e}");
            set_phase(voice, Phase::Failed(err.clone()));
            Err(err)
        }
    }
}

async fn is_loaded(voice: &str) -> bool {
    matches!(&*engine().loaded.lock().await, Some(l) if l.voice == voice)
}

// ── weights ───────────────────────────────────────────────────────────

fn existing_voice_dir(data_dir: &Path, voice: &str) -> Option<PathBuf> {
    let named = std::env::var_os(super::MODEL_DIR_ENV).map(PathBuf::from);
    release_asset::resolve_existing(
        named.as_deref(),
        &super::voice_dir(data_dir, voice),
        &manifest(voice),
    )
}

async fn fetch(data_dir: &Path, voice: &str) -> Result<PathBuf, String> {
    fetch_from(&super::asset_base_url(), data_dir, voice).await
}

async fn fetch_from(base: &str, data_dir: &Path, voice: &str) -> Result<PathBuf, String> {
    let dir = super::voice_dir(data_dir, voice);
    let name = voice.to_string();
    let report = move |progress: Progress| {
        set_phase(
            &name,
            match progress {
                Progress::Verifying => Phase::Verifying,
                Progress::Downloading {
                    file,
                    downloaded,
                    total,
                } => Phase::Downloading {
                    file,
                    downloaded,
                    total,
                },
            },
        );
    };
    release_asset::fetch_into(base, &dir, &manifest(voice), &report)
        .await
        .map_err(|err| match release_asset::release_asset_name() {
            Some(_) => err,
            None => format!(
                "{err}, so the voice cannot be fetched — point {} at a directory holding it",
                super::MODEL_DIR_ENV
            ),
        })?;
    Ok(dir)
}

// ── synthesis ─────────────────────────────────────────────────────────

struct Loaded {
    voice: String,
    session: Session,
    encoder: PiperEncoder,
    phonemizer: EnglishPhonemizer,
    known: HashMap<String, ()>,
    sample_rate: u32,
    scales: Vec<f32>,
}

impl Loaded {
    fn load(voice: &str, dir: &Path) -> Result<Self, String> {
        let config: serde_json::Value = serde_json::from_slice(
            &std::fs::read(dir.join("voice.onnx.json"))
                .map_err(|e| format!("reading voice.onnx.json: {e}"))?,
        )
        .map_err(|e| format!("parsing voice.onnx.json: {e}"))?;

        let mut id_map: HashMap<String, Vec<i64>> = HashMap::new();
        let raw = config["phoneme_id_map"]
            .as_object()
            .ok_or_else(|| "voice.onnx.json has no phoneme_id_map".to_string())?;
        for (symbol, ids) in raw {
            let ids = ids
                .as_array()
                .ok_or_else(|| format!("phoneme_id_map[{symbol}] is not a list"))?
                .iter()
                .filter_map(serde_json::Value::as_i64)
                .collect();
            id_map.insert(symbol.clone(), ids);
        }
        let encoder = PiperEncoder::new(id_map, UnknownTokenMode::Skip)
            .map_err(|e| format!("building the phoneme encoder: {e}"))?;

        let dictionary = load_dictionary(&dir.join("cmudict.json"))?;
        let known = dictionary.keys().map(|w| (w.clone(), ())).collect();
        let phonemizer = EnglishPhonemizer::new_with_hashmap(dictionary);

        let sample_rate = config["audio"]["sample_rate"].as_u64().unwrap_or(22050) as u32;
        let inference = &config["inference"];
        let scales = vec![
            inference["noise_scale"].as_f64().unwrap_or(0.667) as f32,
            inference["length_scale"].as_f64().unwrap_or(1.0) as f32,
            inference["noise_w"].as_f64().unwrap_or(0.8) as f32,
        ];

        let threads = std::thread::available_parallelism()
            .map(|n| n.get().min(4))
            .unwrap_or(2);
        let session = open_session(&dir.join("voice.onnx"), threads)
            .map_err(|e| format!("loading the voice checkpoint: {e}"))?;

        Ok(Self {
            voice: voice.to_string(),
            session,
            encoder,
            phonemizer,
            known,
            sample_rate,
            scales,
        })
    }

    fn run(&mut self, speech: &Speech) -> Result<Vec<u8>, String> {
        let gap = vec![0.0f32; (SENTENCE_GAP_SECS * self.sample_rate as f32) as usize];
        let mut samples: Vec<f32> = Vec::new();
        for sentence in &speech.sentences {
            let spoken = self.spell_unknown(sentence);
            let clip = self.say(&spoken)?;
            if clip.is_empty() {
                continue;
            }
            if !samples.is_empty() {
                samples.extend_from_slice(&gap);
            }
            samples.extend_from_slice(&clip);
        }
        if samples.is_empty() {
            return Err("the voice produced no audio for this text".to_string());
        }
        Ok(wav::encode(&samples, self.sample_rate))
    }

    fn say(&mut self, sentence: &str) -> Result<Vec<f32>, String> {
        let (tokens, _prosody) = self
            .phonemizer
            .phonemize_with_prosody(sentence)
            .map_err(|e| format!("phonemizing: {e}"))?;
        let ids = self
            .encoder
            .encode(&tokens)
            .map_err(|e| format!("encoding phonemes: {e}"))?;
        if ids.len() <= 3 {
            return Ok(Vec::new());
        }

        let length = ids.len();
        let phonemes = Tensor::from_array((vec![1usize, length], ids))
            .map_err(|e| format!("building the phoneme tensor: {e}"))?;
        let lengths = Tensor::from_array((vec![1usize], vec![length as i64]))
            .map_err(|e| format!("building the length tensor: {e}"))?;
        let scales = Tensor::from_array((vec![3usize], self.scales.clone()))
            .map_err(|e| format!("building the scale tensor: {e}"))?;

        let outputs = self
            .session
            .run(ort::inputs![phonemes, lengths, scales])
            .map_err(|e| format!("running the voice: {e}"))?;
        let (_shape, audio) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("reading the voice output: {e}"))?;
        Ok(audio.to_vec())
    }

    /// Replace words the dictionary has never seen with their letters. The
    /// phonemizer emits nothing at all for a word it cannot look up, which
    /// would drop a name out of the middle of a sentence without a trace.
    fn spell_unknown(&self, sentence: &str) -> String {
        let mut out = String::with_capacity(sentence.len());
        let mut word = String::new();
        for ch in sentence.chars() {
            if ch.is_alphanumeric() || ch == '\'' {
                word.push(ch);
                continue;
            }
            out.push_str(&self.say_word(&word));
            word.clear();
            out.push(ch);
        }
        out.push_str(&self.say_word(&word));
        out
    }

    fn say_word(&self, word: &str) -> String {
        if word.is_empty() || word.chars().all(|c| c.is_numeric()) {
            return word.to_string();
        }
        let lowered = word.to_lowercase();
        if self.knows(&lowered) {
            return word.to_string();
        }
        spell(&lowered)
    }

    fn knows(&self, word: &str) -> bool {
        if self.known.contains_key(word) {
            return true;
        }
        SUFFIXES.iter().any(|suffix| {
            word.strip_suffix(suffix)
                .is_some_and(|stem| stem.len() > 2 && self.known.contains_key(stem))
        })
    }
}

fn open_session(path: &Path, threads: usize) -> ort::Result<Session> {
    Session::builder()?
        .with_intra_threads(threads)?
        .commit_from_file(path)
}

/// A word as its letters, the way a person reads out an unfamiliar name.
fn spell(word: &str) -> String {
    let letters: Vec<&str> = word
        .chars()
        .filter_map(|c| {
            LETTERS
                .iter()
                .find(|(letter, _)| *letter == c)
                .map(|(_, name)| *name)
        })
        .collect();
    if letters.is_empty() {
        return word.to_string();
    }
    letters.join(" ")
}

/// The pronunciation dictionary, plus the terminal words it has never heard
/// of. Loaded once per voice load; the phonemizer owns it afterwards.
fn load_dictionary(path: &Path) -> Result<HashMap<String, String>, String> {
    let raw: HashMap<String, String> = serde_json::from_slice(
        &std::fs::read(path).map_err(|e| format!("reading cmudict.json: {e}"))?,
    )
    .map_err(|e| format!("parsing cmudict.json: {e}"))?;
    if raw.len() < 10_000 {
        return Err(format!(
            "cmudict.json holds {} words, which is not a pronunciation dictionary",
            raw.len()
        ));
    }
    let mut dictionary = raw;
    for (word, arpabet) in GLOSSARY {
        dictionary.insert((*word).to_string(), (*arpabet).to_string());
    }
    Ok(dictionary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::speech_text::{normalize, Kind, Options};

    #[test]
    fn an_unknown_word_is_spelled_rather_than_dropped() {
        assert_eq!(spell("rs"), "ar ess");
        assert_eq!(spell("mobux"), "em oh bee you ex");
        assert_eq!(spell("42"), "42");
    }

    #[test]
    fn the_glossary_covers_the_words_this_terminal_says_most() {
        for (word, arpabet) in GLOSSARY {
            assert!(!word.is_empty());
            assert!(
                arpabet.split_whitespace().count() > 1,
                "{word} has no pronunciation"
            );
        }
    }

    #[test]
    fn a_dictionary_too_small_to_be_one_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cmudict.json");
        std::fs::write(&path, br#"{"hello":"HH AH0 L OW1"}"#).unwrap();
        let err = load_dictionary(&path).unwrap_err();
        assert!(err.contains("not a pronunciation dictionary"), "{err}");
    }

    // A base URL that answers nothing is the shape of a mirror that has not
    // published the asset yet; it has to fail loudly rather than leave a
    // half-unpacked directory behind.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_missing_release_asset_is_not_a_voice() {
        use axum::Router;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, Router::new()).await.unwrap();
        });

        let dir = tempfile::tempdir().unwrap();
        let err = fetch_from(
            &format!("http://{addr}"),
            dir.path(),
            super::super::DEFAULT_VOICE,
        )
        .await
        .expect_err("a 404 is not a voice");
        assert!(err.contains("fetching"), "{err}");
    }

    // The real thing: loads the vendored checkpoint and runs it, so it never
    // belongs in a normal `cargo test`. Run it by hand with:
    //
    //   node scripts/tts-voice.mjs ensure .tmp/tts-voice
    //   MOBUX_TTS_MODEL_TEST=1 MOBUX_TTS_MODEL_DIR=.tmp/tts-voice \
    //     cargo test --release --features local-tts -- --ignored speaks_a_normalized_block
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "loads the real voice and runs real synthesis"]
    async fn speaks_a_normalized_block() {
        if std::env::var("MOBUX_TTS_MODEL_TEST").is_err() {
            eprintln!("set MOBUX_TTS_MODEL_TEST=1 to run the real-voice test");
            return;
        }
        let cache = std::env::var("MOBUX_TTS_MODEL_CACHE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("mobux-tts-voice-test"));
        std::fs::create_dir_all(&cache).unwrap();

        let speech = normalize(
            Kind::Output,
            "\x1b[32m✓\x1b[0m twelve tests passed in /home/control/mobux/target/debug",
            &Options::default(),
        );
        assert!(!speech.text.contains('\x1b'));

        // Warm up first: loading the checkpoint and the dictionary is a second
        // of work that happens once, and folding it into the measurement would
        // hide what a tap on a speaker icon actually costs.
        ensure_ready(cache.clone(), super::super::DEFAULT_VOICE.to_string())
            .await
            .expect("the voice loads");

        let started = std::time::Instant::now();
        let clip = synthesize(cache, super::super::DEFAULT_VOICE.to_string(), speech)
            .await
            .expect("the voice speaks the block");
        let elapsed = started.elapsed().as_secs_f64();

        assert_eq!(&clip[0..4], b"RIFF");
        let samples = (clip.len() - 44) / 2;
        let secs = wav::duration_secs(samples, 22050);
        assert!(
            secs > 1.0,
            "a sentence this long is more than a second: {secs}"
        );
        eprintln!(
            "synthesized {secs:.2}s of audio in {elapsed:.2}s ({:.1}x realtime)",
            secs / elapsed
        );
        assert!(
            secs / elapsed > 4.0,
            "synthesis has to beat realtime by a margin: {secs:.2}s of audio took {elapsed:.2}s"
        );
    }
}
