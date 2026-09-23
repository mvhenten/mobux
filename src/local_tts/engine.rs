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
use std::sync::{Arc, Mutex, OnceLock};

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

/// The most phoneme ids one decode is given.
///
/// `speech_text::MAX_SENTENCE_CHARS` already bounds the text, but a sentence
/// of that length in a dense script still encodes to more ids than a quadratic
/// decode should be handed. This is the backstop: the run is cut short rather
/// than allowed to pin a blocking thread and exhaust memory.
const MAX_PHONEME_IDS: usize = 1024;

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

/// Character names, so a word the dictionary does not carry is spelled
/// instead of dropped. Silence in the middle of a sentence is worse than a
/// spelled name — and a half-spelled one, `sha256` read as "ess aitch ay", is
/// worse than either.
const LETTERS: &[(char, &str)] = &[
    ('0', "zero"),
    ('1', "one"),
    ('2', "two"),
    ('3', "three"),
    ('4', "four"),
    ('5', "five"),
    ('6', "six"),
    ('7', "seven"),
    ('8', "eight"),
    ('9', "nine"),
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

/// A loaded model in the engine's slot. The name sits outside the lock so
/// "which voice is loaded" can be answered without waiting on a synthesis.
struct Held<T> {
    name: String,
    value: Arc<Mutex<T>>,
}

/// Run `work` against the model in `slot`, on a blocking thread.
///
/// The model is lent by cloning the `Arc`; it is never taken out of the slot.
/// Taking it meant a request future dropped mid-synthesis — a page navigation,
/// a client that hung up — carried the 63 MB checkpoint away with it, leaving
/// the phase reporting Ready over an empty slot and the next speak silently
/// reloading from disk.
async fn with_held<T, R>(
    slot: &tokio::sync::Mutex<Option<Held<T>>>,
    name: &str,
    work: impl FnOnce(&mut T) -> R + Send + 'static,
) -> Result<R, String>
where
    T: Send + 'static,
    R: Send + 'static,
{
    let model = {
        let guard = slot.lock().await;
        match guard.as_ref() {
            Some(held) if held.name == name => held.value.clone(),
            _ => return Err("the voice is not loaded".to_string()),
        }
    };
    tokio::task::spawn_blocking(move || {
        let mut guard = model
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        work(&mut guard)
    })
    .await
    .map_err(|e| format!("synthesis panicked: {e}"))
}

struct Engine {
    /// The voice the reported phase belongs to, and the phase itself.
    phase: Mutex<(String, Phase)>,
    loaded: tokio::sync::Mutex<Option<Held<Loaded>>>,
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

pub fn phase(data_dir: &Path) -> Phase {
    let voice = super::voice();
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

pub async fn ensure_ready(data_dir: PathBuf) -> Result<(), String> {
    let voice = super::voice();
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
    let loaded = tokio::task::spawn_blocking(move || Loaded::load(&dir))
        .await
        .map_err(|e| format!("loading the voice panicked: {e}"));
    let loaded = match loaded.and_then(|inner| inner) {
        Ok(loaded) => loaded,
        Err(err) => {
            set_phase(voice, Phase::Failed(err.clone()));
            return Err(err);
        }
    };

    *engine().loaded.lock().await = Some(Held {
        name: voice.to_string(),
        value: Arc::new(Mutex::new(loaded)),
    });
    set_phase(voice, Phase::Ready);
    Ok(())
}

pub async fn synthesize(data_dir: PathBuf, speech: Speech) -> Result<Vec<u8>, String> {
    let voice = super::voice();
    ensure_ready(data_dir).await?;

    speak_with(&engine().loaded, voice, move |loaded: &mut Loaded| {
        loaded.run(&speech)
    })
    .await
}

/// One utterance against the loaded voice. A sentence the voice cannot say is
/// that utterance's failure, reported to its caller; the engine that failed
/// on it is still loaded and still answers the next one, so the phase stays
/// where it was.
async fn speak_with<T>(
    slot: &tokio::sync::Mutex<Option<Held<T>>>,
    voice: &str,
    work: impl FnOnce(&mut T) -> Result<Vec<u8>, String> + Send + 'static,
) -> Result<Vec<u8>, String>
where
    T: Send + 'static,
{
    with_held(slot, voice, work).await?
}

async fn is_loaded(voice: &str) -> bool {
    matches!(&*engine().loaded.lock().await, Some(held) if held.name == voice)
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
    let asset = release_asset::platform_asset().map_err(|err| {
        format!(
            "{err}, so the voice cannot be fetched — point {} at a directory holding it",
            super::MODEL_DIR_ENV
        )
    })?;
    let source = release_asset::Source {
        base,
        asset,
        budget: release_asset::DOWNLOAD_BUDGET,
        read_timeout: release_asset::READ_TIMEOUT,
    };
    release_asset::fetch_into(&source, &dir, &manifest(voice), &report).await?;
    Ok(dir)
}

// ── synthesis ─────────────────────────────────────────────────────────

struct Loaded {
    session: Session,
    encoder: PiperEncoder,
    phonemizer: EnglishPhonemizer,
    known: HashMap<String, ()>,
    sample_rate: u32,
    scales: Vec<f32>,
}

impl Loaded {
    fn load(dir: &Path) -> Result<Self, String> {
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

        let ids = cap_ids(ids, MAX_PHONEME_IDS);
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

/// Trim a phoneme run to `max`, keeping the last id — the end-of-sentence
/// marker the checkpoint needs to stop cleanly rather than trail off.
fn cap_ids(mut ids: Vec<i64>, max: usize) -> Vec<i64> {
    if ids.len() <= max || max == 0 {
        return ids;
    }
    let eos = ids[ids.len() - 1];
    ids.truncate(max);
    let last = ids.len() - 1;
    ids[last] = eos;
    ids
}

fn open_session(path: &Path, threads: usize) -> ort::Result<Session> {
    Session::builder()?
        .with_intra_threads(threads)?
        .commit_from_file(path)
}

/// A word as its characters, the way a person reads out an unfamiliar name.
///
/// A character with no name — an accent, a symbol — takes the whole word back
/// to its written form rather than being skipped: dropping it spelled `café`
/// as "see ay ef", which is a different word.
fn spell(word: &str) -> String {
    let mut names = Vec::with_capacity(word.chars().count());
    for ch in word.chars() {
        match LETTERS.iter().find(|(named, _)| *named == ch) {
            Some((_, name)) => names.push(*name),
            None => return word.to_string(),
        }
    }
    if names.is_empty() {
        return word.to_string();
    }
    names.join(" ")
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
    }

    // Digits used to be filtered out of the spelling entirely, so `sha256`
    // came out as "ess aitch ay" and `x86` as "ex" — a different word from the
    // one on the screen, said with confidence.
    #[test]
    fn a_spelled_word_keeps_its_digits() {
        assert_eq!(spell("sha256"), "ess aitch ay two five six");
        assert_eq!(spell("x86"), "ex eight six");
        assert_eq!(spell("v0"), "vee zero");
        assert_eq!(spell("42"), "four two");
    }

    // A character with no name takes the whole word back to its written form:
    // skipping it spelled `café` as "see ay ef".
    #[test]
    fn a_word_with_an_unnameable_character_is_left_as_written() {
        assert_eq!(spell("café"), "café");
        assert_eq!(spell("naïve"), "naïve");
        assert_eq!(spell(""), "");
    }

    #[test]
    fn a_phoneme_run_is_cut_to_the_cap_and_keeps_its_end_marker() {
        let ids: Vec<i64> = (0..3000).collect();
        let capped = cap_ids(ids.clone(), MAX_PHONEME_IDS);
        assert_eq!(capped.len(), MAX_PHONEME_IDS);
        assert_eq!(capped[capped.len() - 1], 2999);
        assert_eq!(capped[0], 0);

        let short = vec![1i64, 2, 3];
        assert_eq!(cap_ids(short.clone(), MAX_PHONEME_IDS), short);
    }

    // A request future dropped mid-synthesis — a page navigation, a client
    // that hung up — must not carry the loaded checkpoint away with it.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_dropped_request_leaves_the_model_in_its_slot() {
        let slot: tokio::sync::Mutex<Option<Held<u32>>> = tokio::sync::Mutex::new(Some(Held {
            name: "voice".to_string(),
            value: Arc::new(Mutex::new(1)),
        }));

        let abandoned = tokio::time::timeout(
            std::time::Duration::from_millis(20),
            with_held(&slot, "voice", |n: &mut u32| {
                std::thread::sleep(std::time::Duration::from_millis(200));
                *n += 1;
                *n
            }),
        )
        .await;
        assert!(abandoned.is_err(), "the request was meant to be dropped");

        assert!(
            slot.lock().await.is_some(),
            "the model was taken out of the slot and lost"
        );
        let again = with_held(&slot, "voice", |n: &mut u32| *n)
            .await
            .expect("the model is still usable");
        assert_eq!(again, 2, "the abandoned work still ran to completion");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_slot_holding_another_voice_is_not_lent_out() {
        let slot: tokio::sync::Mutex<Option<Held<u32>>> = tokio::sync::Mutex::new(Some(Held {
            name: "other".to_string(),
            value: Arc::new(Mutex::new(1)),
        }));
        let err = with_held(&slot, "voice", |n: &mut u32| *n)
            .await
            .expect_err("a different voice is not this one");
        assert!(err.contains("not loaded"), "{err}");
    }

    // One sentence the voice could not say used to mark the whole voice
    // Failed, so every later speak fell back to the browser voice until a
    // restart although the engine itself was fine.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_utterance_leaves_the_voice_ready() {
        let voice = "a-failed-utterance-voice";
        let slot: tokio::sync::Mutex<Option<Held<u32>>> = tokio::sync::Mutex::new(Some(Held {
            name: voice.to_string(),
            value: Arc::new(Mutex::new(0)),
        }));
        set_phase(voice, Phase::Ready);

        let err = speak_with(&slot, voice, |_: &mut u32| {
            Err("running the voice: bad input".to_string())
        })
        .await
        .expect_err("the utterance failed");
        assert!(err.contains("bad input"), "{err}");

        let phase = engine().phase.lock().unwrap().clone();
        assert!(
            !matches!(&phase, (named, Phase::Failed(_)) if named == voice),
            "{phase:?}"
        );
        let clip = speak_with(&slot, voice, |_: &mut u32| Ok(b"RIFF".to_vec()))
            .await
            .expect("the next utterance is spoken");
        assert_eq!(clip, b"RIFF");
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
        ensure_ready(cache.clone()).await.expect("the voice loads");

        let started = std::time::Instant::now();
        let clip = synthesize(cache, speech)
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
