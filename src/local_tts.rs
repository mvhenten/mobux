//! In-process text-to-speech.
//!
//! The browser's own `speechSynthesis` reads the terminal in whatever voice
//! the phone happens to ship, which on Android is a robot. This runs a neural
//! voice inside the mobux process instead — Piper's VITS checkpoint through
//! onnxruntime, with a pure-Rust grapheme-to-phoneme step, so
//! `cargo install mobux --features local-tts` needs no cmake, no C++ toolchain
//! and no espeak-ng.
//!
//! The weights are vendored, not fetched from a model host. They ride in the
//! release tarball `install.sh` already downloads and sha256-verifies, so that
//! path never reaches the network for a model at all. A `cargo install` build
//! has no weights beside it, so it pulls that same release asset and checks
//! every file against `voice.lock.json` — the hashes this source tree was
//! built against. `scripts/tts-voice.mjs` is the only thing that talks to
//! Hugging Face, and only when a maintainer refreshes the vendored voice.
//!
//! The engine is behind the `local-tts` feature so the default build stays
//! small. Without it every entry point here still exists and reports
//! [`Phase::Disabled`], so the reader falls back to the browser voice and the
//! settings card gets a real state to render instead of a missing endpoint.

#![cfg_attr(not(feature = "local-tts"), allow(dead_code))]

use std::path::{Path, PathBuf};

#[cfg(feature = "local-tts")]
mod engine;
#[cfg(feature = "local-tts")]
mod wav;

/// Whether this binary was built with the in-process engine.
pub const ENABLED: bool = cfg!(feature = "local-tts");

/// The vendored voice, as the lock had better still name it. A
/// medium-quality Piper checkpoint: 60 MB, and an order of magnitude faster
/// than realtime on the kind of CPU that runs a terminal for a phone, which is
/// what makes a tap-to-listen feel immediate.
#[cfg(test)]
pub const DEFAULT_VOICE: &str = "en_US-lessac-medium";

/// Point this at a directory holding the voice files to run weights this host
/// already has — an airgapped install, or a voice other than the vendored one.
/// A directory named here is used as given and never checked against the lock.
pub const MODEL_DIR_ENV: &str = "MOBUX_TTS_MODEL_DIR";

/// Where the release assets are fetched from. Mirrors `MOBUX_INSTALL_BASE_URL`
/// in install.sh, and exists for the same reasons: tests and mirrors.
pub const ASSET_BASE_URL_ENV: &str = "MOBUX_TTS_ASSET_BASE_URL";
pub const DEFAULT_ASSET_BASE_URL: &str =
    "https://github.com/mvhenten/mobux/releases/latest/download";

/// Path inside the release tarball that the voice is packed at.
pub fn asset_voice_prefix(voice: &str) -> String {
    format!("tts-voices/{voice}/")
}

/// The voice this source tree was built against, pinned by content hash.
/// Rewritten only by `scripts/tts-voice.mjs`.
const VOICE_LOCK_JSON: &str = include_str!("local_tts/voice.lock.json");

#[derive(Debug, Clone, serde::Deserialize)]
pub struct VoiceLock {
    pub voice: String,
    pub files: std::collections::BTreeMap<String, crate::release_asset::LockedFile>,
}

pub fn voice_lock() -> &'static VoiceLock {
    static LOCK: std::sync::OnceLock<VoiceLock> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| {
        serde_json::from_str(VOICE_LOCK_JSON).expect("voice.lock.json is built into the binary")
    })
}

/// The files the engine loads, in the order they are unpacked.
pub fn voice_files() -> Vec<&'static str> {
    voice_lock().files.keys().map(String::as_str).collect()
}

/// The voice this build speaks with. One binary carries one checkpoint, and
/// the lock is what names it.
pub fn voice() -> &'static str {
    &voice_lock().voice
}

pub fn cache_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("tts-voices")
}

pub fn voice_dir(data_dir: &Path, voice: &str) -> PathBuf {
    cache_dir(data_dir).join(voice)
}

pub fn voice_files_present(data_dir: &Path, voice: &str) -> bool {
    crate::release_asset::files_present(&voice_dir(data_dir, voice), &voice_files())
}

pub fn asset_base_url() -> String {
    std::env::var(ASSET_BASE_URL_ENV)
        .ok()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| DEFAULT_ASSET_BASE_URL.to_string())
}

/// What the local engine is doing, as the status endpoint reports it.
#[derive(Debug, Clone, PartialEq)]
pub enum Phase {
    /// Built without the `local-tts` feature.
    Disabled,
    /// Weights are not on disk yet and nothing is fetching them.
    NotDownloaded,
    /// Checking unpacked weights against the hashes in the lock.
    Verifying,
    Downloading {
        file: String,
        downloaded: u64,
        total: u64,
    },
    /// Weights are on disk; building the model in memory.
    Loading,
    Ready,
    Failed(String),
}

impl Phase {
    /// The one word the settings card and the reader render.
    pub fn state(&self) -> &'static str {
        match self {
            Self::Disabled => "unsupported",
            Self::NotDownloaded => "not_installed",
            Self::Downloading { .. } | Self::Verifying | Self::Loading => "warming",
            Self::Ready => "ready",
            Self::Failed(_) => "failed",
        }
    }

    /// A sentence that says what is happening and, where there is one, what
    /// closes the gap.
    pub fn message(&self) -> String {
        match self {
            Self::Disabled => UNSUPPORTED_MESSAGE.to_string(),
            Self::NotDownloaded => "The voice is not on this host yet.".to_string(),
            Self::Downloading {
                file,
                downloaded,
                total,
            } => match percent(*downloaded, *total) {
                Some(pct) => format!("Downloading the voice ({file}) — {pct}%."),
                None => format!("Downloading the voice ({file})."),
            },
            Self::Verifying => "Checking the voice against its recorded hashes.".to_string(),
            Self::Loading => "Loading the voice into memory.".to_string(),
            Self::Ready => "The voice is loaded.".to_string(),
            Self::Failed(err) => format!("The voice could not be prepared: {err}"),
        }
    }
}

pub const UNSUPPORTED_MESSAGE: &str =
    "This build has no in-process voice. Reinstall with `cargo install mobux --locked --features local-tts` to read in a neural voice instead of the browser's.";

fn percent(downloaded: u64, total: u64) -> Option<u64> {
    if total == 0 {
        return None;
    }
    Some((downloaded.saturating_mul(100) / total).min(100))
}

#[cfg(feature = "local-tts")]
pub fn phase(data_dir: &Path) -> Phase {
    engine::phase(data_dir)
}

#[cfg(not(feature = "local-tts"))]
pub fn phase(_data_dir: &Path) -> Phase {
    Phase::Disabled
}

/// Fetch and load the voice if it is not ready, and return once it is. A
/// second call while one is running joins it rather than starting a second
/// download.
#[cfg(feature = "local-tts")]
pub async fn ensure_ready(data_dir: PathBuf) -> Result<(), String> {
    engine::ensure_ready(data_dir).await
}

#[cfg(not(feature = "local-tts"))]
pub async fn ensure_ready(_data_dir: PathBuf) -> Result<(), String> {
    Err(UNSUPPORTED_MESSAGE.to_string())
}

/// Speak already-normalized text, returning a 16-bit PCM WAV clip. Waits out a
/// first-run download.
#[cfg(feature = "local-tts")]
pub async fn synthesize(
    data_dir: PathBuf,
    speech: crate::speech_text::Speech,
) -> Result<Vec<u8>, String> {
    engine::synthesize(data_dir, speech).await
}

#[cfg(not(feature = "local-tts"))]
pub async fn synthesize(
    _data_dir: PathBuf,
    _speech: crate::speech_text::Speech,
) -> Result<Vec<u8>, String> {
    Err(UNSUPPORTED_MESSAGE.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_voice_is_the_one_the_lock_pins() {
        assert_eq!(voice_lock().voice, DEFAULT_VOICE);
        assert_eq!(voice(), DEFAULT_VOICE);
    }

    // The three files are the checkpoint, the phoneme map it was trained with,
    // and the pronunciation dictionary the g2p reads. Losing any one of them
    // silently turns synthesis into noise rather than into an error.
    #[test]
    fn the_lock_pins_three_files_with_real_hashes() {
        assert_eq!(
            voice_files(),
            vec!["cmudict.json", "voice.onnx", "voice.onnx.json"]
        );
        for (name, file) in &voice_lock().files {
            assert_eq!(file.sha256.len(), 64, "{name}");
            assert!(file.sha256.chars().all(|c| c.is_ascii_hexdigit()), "{name}");
            assert!(file.bytes > 0, "{name}");
        }
        let total: u64 = voice_lock().files.values().map(|f| f.bytes).sum();
        assert!(
            total < 150 * 1024 * 1024,
            "the voice rides in the release tarball; {total} bytes is too much to ship"
        );
    }

    #[test]
    fn the_voice_is_packed_under_its_own_name() {
        assert_eq!(
            asset_voice_prefix(DEFAULT_VOICE),
            "tts-voices/en_US-lessac-medium/"
        );
        assert!(asset_base_url().starts_with("http"));
    }

    #[test]
    fn voice_files_are_reported_missing_until_all_three_exist() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!voice_files_present(dir.path(), DEFAULT_VOICE));
        let voice = voice_dir(dir.path(), DEFAULT_VOICE);
        std::fs::create_dir_all(&voice).unwrap();
        for name in voice_files() {
            assert!(!voice_files_present(dir.path(), DEFAULT_VOICE));
            std::fs::write(voice.join(name), b"x").unwrap();
        }
        assert!(voice_files_present(dir.path(), DEFAULT_VOICE));
    }

    #[test]
    fn phases_render_a_state_word_and_a_sentence() {
        assert_eq!(Phase::Ready.state(), "ready");
        assert_eq!(Phase::NotDownloaded.state(), "not_installed");
        assert_eq!(Phase::Loading.state(), "warming");
        assert_eq!(Phase::Verifying.state(), "warming");
        assert_eq!(Phase::Failed("boom".to_string()).state(), "failed");
        assert_eq!(Phase::Disabled.state(), "unsupported");

        let msg = Phase::Downloading {
            file: "mobux.tar.gz".to_string(),
            downloaded: 50,
            total: 200,
        };
        assert_eq!(msg.state(), "warming");
        assert!(msg.message().contains("25%"), "{}", msg.message());
        assert!(Phase::Disabled.message().contains("--features local-tts"));
    }

    // A server that answers without a Content-Length leaves the total at zero;
    // the sentence must still read as progress, not as 0%.
    #[test]
    fn an_unknown_download_total_reports_no_percentage() {
        let msg = Phase::Downloading {
            file: "mobux.tar.gz".to_string(),
            downloaded: 4096,
            total: 0,
        }
        .message();
        assert!(!msg.contains('%'), "{msg}");
    }
}
