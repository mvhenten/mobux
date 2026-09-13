//! In-process speech-to-text.
//!
//! The local provider runs whisper inside the mobux process through candle —
//! pure Rust, so `cargo install mobux --features local-stt` needs no cmake, no
//! C++ toolchain and no container runtime.
//!
//! The weights come from mobux's own releases, never from a model host. The
//! default checkpoint rides in the release tarball `install.sh` already
//! downloads and sha256-verifies, so a prebuilt install transcribes offline out
//! of the box. The other checkpoints are their own release assets, fetched on
//! demand when someone picks one. Every file, on every path, is checked against
//! `model.lock.json` — the hashes this source tree was built against.
//! `scripts/stt-model.mjs` is the only thing that talks to Hugging Face, and
//! only when a maintainer refreshes a checkpoint.
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

/// The checkpoint the release tarball carries and the settings card starts on.
/// The whole catalog is English-only: the decoder here does not detect
/// language, so a multilingual checkpoint would silently transcribe into the
/// wrong one.
pub const DEFAULT_MODEL: &str = "base.en";

/// Point this at a directory holding `config.json`, `tokenizer.json` and
/// `model.safetensors` to run weights this host already has — an airgapped
/// install, or a checkpoint mobux does not publish. A directory named here is
/// used for whichever model is selected, as given, and never checked against
/// the lock.
pub const MODEL_DIR_ENV: &str = "MOBUX_STT_MODEL_DIR";

/// Where the release assets are fetched from. Mirrors `MOBUX_INSTALL_BASE_URL`
/// in install.sh, and exists for the same reasons: tests and mirrors.
pub const ASSET_BASE_URL_ENV: &str = "MOBUX_STT_ASSET_BASE_URL";
pub const DEFAULT_ASSET_BASE_URL: &str =
    "https://github.com/mvhenten/mobux/releases/latest/download";

/// Path inside a release asset that a checkpoint is packed at. The same
/// layout in the platform tarball and in a per-model asset, so one unpacker
/// serves both.
pub fn asset_model_prefix(model: &str) -> String {
    format!("stt-models/{model}/")
}

/// The catalog this source tree was built against, every file pinned by
/// content hash. Rewritten only by `scripts/stt-model.mjs`.
const MODEL_LOCK_JSON: &str = include_str!("local_stt/model.lock.json");

#[derive(Debug, Clone, serde::Deserialize)]
pub struct LockedFile {
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct LockedModel {
    pub id: String,
    pub files: std::collections::BTreeMap<String, LockedFile>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ModelLock {
    #[serde(rename = "default")]
    pub default_model: String,
    /// The checkpoint packed into the per-platform release tarball.
    pub vendored: String,
    /// Every checkpoint mobux publishes, in the order the settings card
    /// offers them.
    pub models: Vec<LockedModel>,
}

pub fn model_lock() -> &'static ModelLock {
    static LOCK: std::sync::OnceLock<ModelLock> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| {
        serde_json::from_str(MODEL_LOCK_JSON).expect("model.lock.json is built into the binary")
    })
}

pub fn locked_model(model: &str) -> Option<&'static LockedModel> {
    let model = model.trim();
    model_lock().models.iter().find(|m| m.id == model)
}

/// The files a checkpoint is made of, in the order they are unpacked.
pub fn model_files(model: &str) -> Vec<&'static str> {
    locked_model(model)
        .map(|m| m.files.keys().map(String::as_str).collect())
        .unwrap_or_default()
}

pub fn model_ids() -> Vec<String> {
    model_lock().models.iter().map(|m| m.id.clone()).collect()
}

pub fn is_known_model(model: &str) -> bool {
    locked_model(model).is_some()
}

/// Resolve a configured model name to one the engine can run. A value left
/// over from another provider (a `Systran/faster-whisper-*` id, say) falls back
/// to the default rather than failing the transcription.
pub fn resolve_model(configured: &str) -> &'static str {
    locked_model(configured)
        .map(|m| m.id.as_str())
        .unwrap_or(model_lock().default_model.as_str())
}

pub fn cache_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("stt-models")
}

pub fn model_dir(data_dir: &Path, model: &str) -> PathBuf {
    cache_dir(data_dir).join(model)
}

/// True once every file a checkpoint is made of is in `dir`.
pub fn files_present(dir: &Path, model: &str) -> bool {
    let files = model_files(model);
    !files.is_empty() && files.iter().all(|f| dir.join(f).is_file())
}

pub fn model_files_present(data_dir: &Path, model: &str) -> bool {
    files_present(&model_dir(data_dir, model), model)
}

/// The per-platform release tarball for this host, or None on an architecture
/// mobux publishes no prebuilt binary for.
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

/// The release asset a checkpoint comes out of.
///
/// The vendored one is inside the platform tarball, because that is what makes
/// a prebuilt install transcribe with nothing downloaded. The others are their
/// own assets: weights are platform-independent, so one upload serves every
/// target, and nobody pays for a checkpoint they did not pick.
pub fn asset_for(model: &str) -> Option<String> {
    let model = resolve_model(model);
    if model == model_lock().vendored {
        return release_asset_name().map(str::to_string);
    }
    Some(format!("mobux-stt-{model}.tar.gz"))
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
    fn the_default_is_the_vendored_model_and_the_card_offers_it_first() {
        let lock = model_lock();
        assert_eq!(lock.default_model, DEFAULT_MODEL);
        assert_eq!(lock.vendored, DEFAULT_MODEL);
        assert!(is_known_model(DEFAULT_MODEL));
        assert_eq!(model_ids().first().map(String::as_str), Some(DEFAULT_MODEL));
    }

    #[test]
    fn the_catalog_is_the_three_english_checkpoints() {
        assert_eq!(model_ids(), vec!["base.en", "tiny.en", "small.en"]);
    }

    // The weights are stored half-precision and converted on load; a lock that
    // drifted back to f32 would double every published asset without anyone
    // noticing until it shipped.
    #[test]
    fn every_locked_checkpoint_pins_three_f16_files_with_real_hashes() {
        // Half-precision whisper: base.en is ~145 MB and small.en ~484 MB, so
        // anything past this is a checkpoint that was never converted.
        const F32_WOULD_EXCEED: u64 = 600 * 1024 * 1024;
        for model in model_lock().models.iter() {
            assert_eq!(
                model_files(&model.id),
                vec!["config.json", "model.safetensors", "tokenizer.json"],
                "{}",
                model.id
            );
            for (name, file) in &model.files {
                assert_eq!(file.sha256.len(), 64, "{}/{name}", model.id);
                assert!(
                    file.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                    "{}/{name}",
                    model.id
                );
                assert!(file.bytes > 0, "{}/{name}", model.id);
            }
            assert!(
                model.files["model.safetensors"].bytes < F32_WOULD_EXCEED,
                "{} is {} bytes — not converted to f16?",
                model.id,
                model.files["model.safetensors"].bytes
            );
        }
    }

    // The vendored checkpoint comes out of the platform tarball, which is what
    // lets install.sh land a host that dictates with nothing downloaded. Every
    // other checkpoint is its own asset, so picking one pulls only that one.
    #[test]
    fn the_vendored_model_comes_from_the_platform_tarball_and_the_rest_from_their_own() {
        assert_eq!(
            asset_for(DEFAULT_MODEL),
            release_asset_name().map(str::to_string)
        );
        assert_eq!(
            asset_for("tiny.en").as_deref(),
            Some("mobux-stt-tiny.en.tar.gz")
        );
        assert_eq!(
            asset_for("small.en").as_deref(),
            Some("mobux-stt-small.en.tar.gz")
        );
    }

    #[test]
    fn every_catalog_model_has_an_asset_and_a_path_inside_it() {
        assert!(asset_base_url().starts_with("http"));
        for id in model_ids() {
            assert!(
                asset_for(&id).is_some_and(|a| a.ends_with(".tar.gz")),
                "{id}"
            );
            assert_eq!(asset_model_prefix(&id), format!("stt-models/{id}/"));
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
    fn a_model_in_the_catalog_is_kept() {
        assert_eq!(resolve_model(DEFAULT_MODEL), DEFAULT_MODEL);
        assert_eq!(resolve_model(" small.en "), "small.en");
        assert_eq!(resolve_model("tiny.en"), "tiny.en");
    }

    fn write_model_files(dir: &Path, model: &str) {
        std::fs::create_dir_all(dir).unwrap();
        for name in model_files(model) {
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
        assert!(!files_present(dir.path(), DEFAULT_MODEL));
        write_model_files(dir.path(), DEFAULT_MODEL);
        assert!(files_present(dir.path(), DEFAULT_MODEL));
    }

    // Each checkpoint caches under its own name, so downloading one never
    // makes another look present.
    #[test]
    fn each_model_caches_in_its_own_directory() {
        let dir = tempfile::tempdir().unwrap();
        write_model_files(&model_dir(dir.path(), "small.en"), "small.en");
        assert!(model_files_present(dir.path(), "small.en"));
        assert!(!model_files_present(dir.path(), DEFAULT_MODEL));
        assert!(!model_files_present(dir.path(), "tiny.en"));
    }

    #[test]
    fn a_model_outside_the_catalog_has_no_files_to_look_for() {
        let dir = tempfile::tempdir().unwrap();
        assert!(model_files("medium.en").is_empty());
        assert!(!files_present(dir.path(), "medium.en"));
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
