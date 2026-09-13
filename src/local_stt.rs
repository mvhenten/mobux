//! In-process speech-to-text.
//!
//! The local provider runs whisper inside the mobux process through candle —
//! pure Rust, so `cargo install mobux --features local-stt` needs no cmake, no
//! C++ toolchain and no container runtime. Weights are fetched from Hugging
//! Face once into `<data_dir>/stt-models/<model>/` and kept there.
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

/// Smallest model that transcribes dictation usefully on a CPU. A phone-length
/// clip finishes in a second or two and the download is ~150 MB, which is what
/// makes "record, wait, get text" hold on a first run.
pub const DEFAULT_MODEL: &str = "tiny.en";

/// The whisper checkpoints the engine can run, smallest first. English-only:
/// the decoder here does not do language detection, so a multilingual
/// checkpoint would silently transcribe into the wrong language.
const MODELS: [(&str, &str); 3] = [
    ("tiny.en", "openai/whisper-tiny.en"),
    ("base.en", "openai/whisper-base.en"),
    ("small.en", "openai/whisper-small.en"),
];

/// Files pulled from the model repo, in download order.
const MODEL_FILES: [&str; 3] = ["config.json", "tokenizer.json", "model.safetensors"];

pub fn model_ids() -> Vec<String> {
    MODELS.iter().map(|(id, _)| (*id).to_string()).collect()
}

/// The Hugging Face repo backing a model id, or None for an unknown id.
pub fn repo_for(model: &str) -> Option<&'static str> {
    MODELS
        .iter()
        .find(|(id, _)| *id == model)
        .map(|(_, repo)| *repo)
}

/// Resolve a configured model name to one the engine can run. A value left
/// over from another provider (a `Systran/faster-whisper-*` id, say) falls back
/// to the default rather than failing the transcription.
pub fn resolve_model(configured: &str) -> &'static str {
    MODELS
        .iter()
        .find(|(id, _)| *id == configured.trim())
        .map(|(id, _)| *id)
        .unwrap_or(DEFAULT_MODEL)
}

pub fn cache_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("stt-models")
}

pub fn model_dir(data_dir: &Path, model: &str) -> PathBuf {
    cache_dir(data_dir).join(model)
}

/// True once every file the engine loads is on disk.
pub fn model_files_present(data_dir: &Path, model: &str) -> bool {
    let dir = model_dir(data_dir, model);
    MODEL_FILES.iter().all(|f| dir.join(f).is_file())
}

/// What the local engine is doing, as the status endpoint reports it.
#[derive(Debug, Clone, PartialEq)]
pub enum Phase {
    /// Built without the `local-stt` feature.
    Disabled,
    /// Weights are not on disk yet and nothing is fetching them.
    NotDownloaded,
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
            Self::Downloading { .. } | Self::Loading => "warming",
            Self::Ready => "ready",
            Self::Failed(_) => "failed",
        }
    }

    /// A sentence that says what is happening and, where there is one, what
    /// closes the gap.
    pub fn message(&self) -> String {
        match self {
            Self::Disabled => UNSUPPORTED_MESSAGE.to_string(),
            Self::NotDownloaded => "The speech model has not been downloaded yet.".to_string(),
            Self::Downloading {
                file,
                downloaded,
                total,
            } => match percent(*downloaded, *total) {
                Some(pct) => format!("Downloading the speech model ({file}) — {pct}%."),
                None => format!("Downloading the speech model ({file})."),
            },
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
    fn default_model_is_in_the_catalog() {
        assert!(repo_for(DEFAULT_MODEL).is_some());
        assert!(model_ids().contains(&DEFAULT_MODEL.to_string()));
    }

    #[test]
    fn every_catalog_model_maps_to_an_openai_whisper_repo() {
        for id in model_ids() {
            let repo = repo_for(&id).expect("catalog entry has a repo");
            assert!(repo.starts_with("openai/whisper-"), "{id} -> {repo}");
        }
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
    fn a_known_model_is_kept() {
        assert_eq!(resolve_model("small.en"), "small.en");
        assert_eq!(resolve_model(" base.en "), "base.en");
    }

    #[test]
    fn model_files_are_reported_missing_until_all_three_exist() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!model_files_present(dir.path(), "tiny.en"));
        let model = model_dir(dir.path(), "tiny.en");
        std::fs::create_dir_all(&model).unwrap();
        std::fs::write(model.join("config.json"), b"{}").unwrap();
        std::fs::write(model.join("tokenizer.json"), b"{}").unwrap();
        assert!(!model_files_present(dir.path(), "tiny.en"));
        std::fs::write(model.join("model.safetensors"), b"x").unwrap();
        assert!(model_files_present(dir.path(), "tiny.en"));
    }

    #[test]
    fn phases_render_a_state_word_and_a_sentence() {
        assert_eq!(Phase::Ready.state(), "ready");
        assert_eq!(Phase::NotDownloaded.state(), "not_installed");
        assert_eq!(Phase::Loading.state(), "warming");
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
