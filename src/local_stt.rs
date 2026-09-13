//! In-process speech-to-text.
//!
//! The local provider runs whisper inside the mobux process through candle —
//! pure Rust, so `cargo install mobux --features local-stt` needs no cmake, no
//! C++ toolchain and no container runtime.
//!
//! The weights are vendored, not fetched from a model host. They ride in the
//! release tarball `install.sh` already downloads and sha256-verifies, so that
//! path never reaches the network for a model at all. A `cargo install` build
//! has no weights beside it, so it pulls that same release asset and checks
//! every file against `model.lock.json` — the hashes this source tree was
//! built against. `scripts/stt-model.mjs` is the only thing that talks to
//! Hugging Face, and only when a maintainer refreshes the vendored model.
//!
//! The engine itself is behind the `local-stt` feature so the default build
//! stays small. Without it every entry point here still exists and reports
//! `Phase::Disabled`, so the remote providers keep working and the settings UI
//! gets a real state to render instead of a missing endpoint.

#![cfg_attr(not(feature = "local-stt"), allow(dead_code))]

use std::path::{Path, PathBuf};

#[cfg(feature = "local-stt")]
mod engine;
#[cfg(feature = "local-stt")]
mod wav;

/// Whether this binary was built with the in-process engine.
pub const ENABLED: bool = cfg!(feature = "local-stt");

/// The vendored checkpoint. Small enough that a phone-length clip finishes in
/// a second or two on a CPU, and small enough to ride in the release tarball.
/// English-only: the decoder here does not detect language, so a multilingual
/// checkpoint would silently transcribe into the wrong one.
pub const DEFAULT_MODEL: &str = "tiny.en";

/// Point this at a directory holding `config.json`, `tokenizer.json` and
/// `model.safetensors` to run weights this host already has — an airgapped
/// install, or a checkpoint other than the vendored one. A directory named
/// here is used as given and never checked against the lock.
pub const MODEL_DIR_ENV: &str = "MOBUX_STT_MODEL_DIR";

/// Where the release assets are fetched from. Mirrors `MOBUX_INSTALL_BASE_URL`
/// in install.sh, and exists for the same reasons: tests and mirrors.
pub const ASSET_BASE_URL_ENV: &str = "MOBUX_STT_ASSET_BASE_URL";
pub const DEFAULT_ASSET_BASE_URL: &str =
    "https://github.com/mvhenten/mobux/releases/latest/download";

/// Path inside the release tarball that the weights are packed at.
pub fn asset_model_prefix(model: &str) -> String {
    format!("stt-models/{model}/")
}

/// The model this source tree was built against, pinned by content hash.
/// Rewritten only by `scripts/stt-model.mjs`.
const MODEL_LOCK_JSON: &str = include_str!("local_stt/model.lock.json");

#[derive(Debug, Clone, serde::Deserialize)]
pub struct LockedFile {
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ModelLock {
    pub model: String,
    pub files: std::collections::BTreeMap<String, LockedFile>,
}

pub fn model_lock() -> &'static ModelLock {
    static LOCK: std::sync::OnceLock<ModelLock> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| {
        serde_json::from_str(MODEL_LOCK_JSON).expect("model.lock.json is built into the binary")
    })
}

/// The files the engine loads, in the order they are unpacked.
pub fn model_files() -> Vec<&'static str> {
    model_lock().files.keys().map(String::as_str).collect()
}

pub fn model_ids() -> Vec<String> {
    vec![model_lock().model.clone()]
}

pub fn is_known_model(model: &str) -> bool {
    model_lock().model == model.trim()
}

/// Resolve a configured model name to the one the engine can run. A value left
/// over from another provider (a `Systran/faster-whisper-*` id, say) falls back
/// to the vendored model rather than failing the transcription.
pub fn resolve_model(_configured: &str) -> &'static str {
    DEFAULT_MODEL
}

pub fn cache_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("stt-models")
}

pub fn model_dir(data_dir: &Path, model: &str) -> PathBuf {
    cache_dir(data_dir).join(model)
}

/// True once every file the engine loads is in `dir`.
pub fn files_present(dir: &Path) -> bool {
    model_files().iter().all(|f| dir.join(f).is_file())
}

pub fn model_files_present(data_dir: &Path, model: &str) -> bool {
    files_present(&model_dir(data_dir, model))
}

/// The release tarball carrying the weights for this host, or None on an
/// architecture mobux publishes no prebuilt asset for.
pub fn release_asset_name() -> Option<&'static str> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    match std::env::consts::ARCH {
        "x86_64" => Some("mobux-x86_64-unknown-linux-gnu.tar.gz"),
        "aarch64" => Some("mobux-aarch64-unknown-linux-gnu.tar.gz"),
        _ => None,
    }
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
    /// Built without the `local-stt` feature.
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
    /// The one word the settings card and the mic overlay render.
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
            Self::NotDownloaded => "The speech model is not on this host yet.".to_string(),
            Self::Downloading {
                file,
                downloaded,
                total,
            } => match percent(*downloaded, *total) {
                Some(pct) => format!("Downloading the speech model ({file}) — {pct}%."),
                None => format!("Downloading the speech model ({file})."),
            },
            Self::Verifying => "Checking the speech model against its recorded hashes.".to_string(),
            Self::Loading => "Loading the speech model into memory.".to_string(),
            Self::Ready => "The speech model is loaded.".to_string(),
            Self::Failed(err) => format!("The speech model could not be prepared: {err}"),
        }
    }
}

pub const UNSUPPORTED_MESSAGE: &str =
    "This build has no in-process speech engine. Reinstall with `cargo install mobux --locked --features local-stt`, or point the provider at an OpenAI-compatible endpoint.";

fn percent(downloaded: u64, total: u64) -> Option<u64> {
    if total == 0 {
        return None;
    }
    Some((downloaded.saturating_mul(100) / total).min(100))
}

#[cfg(feature = "local-stt")]
pub fn phase(data_dir: &Path, model: &str) -> Phase {
    engine::phase(data_dir, model)
}

#[cfg(not(feature = "local-stt"))]
pub fn phase(_data_dir: &Path, _model: &str) -> Phase {
    Phase::Disabled
}

/// Fetch and load the model if it is not ready, and return once it is. Callers
/// that only want the work started (the status poll, the settings button) can
/// drop the future's result — a second call while one is running joins it
/// rather than starting a second download.
#[cfg(feature = "local-stt")]
pub async fn ensure_ready(data_dir: PathBuf, model: String) -> Result<(), String> {
    engine::ensure_ready(data_dir, model).await
}

#[cfg(not(feature = "local-stt"))]
pub async fn ensure_ready(_data_dir: PathBuf, _model: String) -> Result<(), String> {
    Err(UNSUPPORTED_MESSAGE.to_string())
}

/// Transcribe a 16-bit PCM WAV clip. Waits out a first-run download.
#[cfg(feature = "local-stt")]
pub async fn transcribe(data_dir: PathBuf, model: String, wav: Vec<u8>) -> Result<String, String> {
    engine::transcribe(data_dir, model, wav).await
}

#[cfg(not(feature = "local-stt"))]
pub async fn transcribe(
    _data_dir: PathBuf,
    _model: String,
    _wav: Vec<u8>,
) -> Result<String, String> {
    Err(UNSUPPORTED_MESSAGE.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_model_is_the_one_the_lock_pins() {
        assert_eq!(model_lock().model, DEFAULT_MODEL);
        assert!(is_known_model(DEFAULT_MODEL));
        assert_eq!(model_ids(), vec![DEFAULT_MODEL.to_string()]);
    }

    // The weights are stored half-precision and converted on load; a lock that
    // drifted back to f32 would double the release tarball without anyone
    // noticing until it was published.
    #[test]
    fn the_lock_pins_three_f16_files_with_real_hashes() {
        let lock = model_lock();
        assert_eq!(
            model_files(),
            vec!["config.json", "model.safetensors", "tokenizer.json"]
        );
        for (name, file) in &lock.files {
            assert_eq!(file.sha256.len(), 64, "{name}");
            assert!(file.sha256.chars().all(|c| c.is_ascii_hexdigit()), "{name}");
            assert!(file.bytes > 0, "{name}");
        }
        assert!(
            lock.files["model.safetensors"].bytes < 100 * 1024 * 1024,
            "f16 tiny.en is ~75 MB; anything near 150 MB is f32"
        );
    }

    #[test]
    fn both_published_architectures_have_an_asset_to_pull_the_model_from() {
        assert!(release_asset_name().is_some_and(|a| a.ends_with(".tar.gz")));
        assert!(asset_base_url().starts_with("http"));
        assert_eq!(asset_model_prefix("tiny.en"), "stt-models/tiny.en/");
    }

    // A DB written by the container-backed provider still carries its
    // faster-whisper model id. Falling back keeps that install dictating
    // instead of failing on an id the engine has never heard of.
    #[test]
    fn a_model_the_engine_cannot_run_falls_back_to_the_default() {
        assert_eq!(resolve_model("Systran/faster-whisper-small"), DEFAULT_MODEL);
        assert_eq!(resolve_model(""), DEFAULT_MODEL);
        assert_eq!(resolve_model("whisper-1"), DEFAULT_MODEL);
    }

    #[test]
    fn the_vendored_model_is_kept() {
        assert_eq!(resolve_model(DEFAULT_MODEL), DEFAULT_MODEL);
        assert_eq!(resolve_model(" tiny.en "), DEFAULT_MODEL);
    }

    fn write_model_files(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        for name in model_files() {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
    }

    #[test]
    fn model_files_are_reported_missing_until_all_three_exist() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!model_files_present(dir.path(), DEFAULT_MODEL));
        let model = model_dir(dir.path(), DEFAULT_MODEL);
        std::fs::create_dir_all(&model).unwrap();
        std::fs::write(model.join("config.json"), b"{}").unwrap();
        std::fs::write(model.join("tokenizer.json"), b"{}").unwrap();
        assert!(!model_files_present(dir.path(), DEFAULT_MODEL));
        std::fs::write(model.join("model.safetensors"), b"x").unwrap();
        assert!(model_files_present(dir.path(), DEFAULT_MODEL));
    }

    // The unpacked cache is what install.sh leaves behind, and finding it is
    // what keeps that path from ever reaching the network.
    #[test]
    fn a_directory_counts_as_present_only_once_it_holds_every_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!files_present(dir.path()));
        write_model_files(dir.path());
        assert!(files_present(dir.path()));
    }

    #[test]
    fn phases_render_a_state_word_and_a_sentence() {
        assert_eq!(Phase::Ready.state(), "ready");
        assert_eq!(Phase::NotDownloaded.state(), "not_installed");
        assert_eq!(Phase::Loading.state(), "warming");
        assert_eq!(Phase::Verifying.state(), "warming");
        assert_eq!(
            Phase::Downloading {
                file: "model.safetensors".to_string(),
                downloaded: 50,
                total: 200,
            }
            .state(),
            "warming"
        );
        assert_eq!(Phase::Failed("boom".to_string()).state(), "failed");
        assert_eq!(Phase::Disabled.state(), "unsupported");

        let msg = Phase::Downloading {
            file: "model.safetensors".to_string(),
            downloaded: 50,
            total: 200,
        }
        .message();
        assert!(msg.contains("25%"), "{msg}");
        assert!(Phase::Disabled.message().contains("--features local-stt"));
    }

    // A server that answers the range request without a Content-Length leaves
    // the total at zero; the sentence must still read as progress, not as 0%.
    #[test]
    fn an_unknown_download_total_reports_no_percentage() {
        let msg = Phase::Downloading {
            file: "model.safetensors".to_string(),
            downloaded: 4096,
            total: 0,
        }
        .message();
        assert!(!msg.contains('%'), "{msg}");
    }
}
