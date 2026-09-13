//! The candle-backed whisper engine.
//!
//! Adapted from `candle-examples/examples/whisper` (huggingface/candle 0.11):
//! greedy decode with the temperature fallback ladder, timestamps off, one
//! English-only checkpoint held in memory between requests.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use candle_core::{Device, IndexOp, Tensor};
use candle_nn::ops::softmax;
use candle_nn::VarBuilder;
use candle_transformers::models::whisper::{self as m, audio, Config};
use futures_util::StreamExt;
use rand::distr::weighted::WeightedIndex;
use rand::distr::Distribution;
use rand::rngs::StdRng;
use rand::SeedableRng;
use sha2::{Digest, Sha256};
use tokenizers::Tokenizer;
use tokio::io::AsyncWriteExt;

use super::wav;
use super::Phase;

/// Mel filterbank for the 80-bin whisper checkpoints, as shipped by candle's
/// own example. The engine refuses a checkpoint that wants a different bank
/// rather than transcribing noise.
const MEL_FILTERS_80: &[u8] = include_bytes!("melfilters.bytes");

const DOWNLOAD_PROGRESS_STEP: u64 = 4 * 1024 * 1024;

/// How long a download may go without delivering a chunk. A host that stalls
/// mid-stream used to hang the transcription that started it, with the mutex
/// below held, until the process was restarted.
const READ_TIMEOUT: Duration = Duration::from_secs(60);

/// The sidecar is a single line, so it gets a short budget of its own.
const SIDECAR_TIMEOUT: Duration = Duration::from_secs(30);

/// Room the asset may take beyond the weights it carries: the binary, the tar
/// headers, and whatever a future release adds. A download past this is not a
/// slow mirror, it is the wrong URL — stop rather than fill the disk.
const DOWNLOAD_SLACK: u64 = 256 * 1024 * 1024;

/// The most we will write for one asset, from the sizes the lock pins.
fn download_budget(model: &str) -> u64 {
    let weights: u64 = super::locked_model(model)
        .map(|m| m.files.values().map(|f| f.bytes).sum())
        .unwrap_or(0);
    weights + DOWNLOAD_SLACK
}

struct Engine {
    /// The model the reported phase belongs to, and the phase itself.
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

fn set_phase(model: &str, phase: Phase) {
    if let Ok(mut slot) = engine().phase.lock() {
        *slot = (model.to_string(), phase);
    }
}

pub fn phase(data_dir: &Path, model: &str) -> Phase {
    let model = super::resolve_model(model);
    if let Ok(slot) = engine().phase.lock() {
        if slot.0 == model {
            return slot.1.clone();
        }
    }
    if super::model_files_present(data_dir, model) {
        return Phase::Loading;
    }
    Phase::NotDownloaded
}

pub async fn ensure_ready(data_dir: PathBuf, model: String) -> Result<(), String> {
    let model = super::resolve_model(&model);
    if is_loaded(model).await {
        return Ok(());
    }

    let _one_at_a_time = engine().preparing.lock().await;
    if is_loaded(model).await {
        return Ok(());
    }

    set_phase(model, Phase::Verifying);
    let existing = {
        let data_dir = data_dir.clone();
        let model = model.to_string();
        tokio::task::spawn_blocking(move || existing_model_dir(&data_dir, &model))
            .await
            .map_err(|e| format!("checking the speech model panicked: {e}"))?
    };
    let dir = match existing {
        Some(dir) => dir,
        None => match unpack_release_asset(&data_dir, model).await {
            Ok(dir) => dir,
            Err(err) => {
                set_phase(model, Phase::Failed(err.clone()));
                return Err(err);
            }
        },
    };

    set_phase(model, Phase::Loading);
    let id = model.to_string();
    let loaded = tokio::task::spawn_blocking(move || Loaded::load(&dir, &id))
        .await
        .map_err(|e| format!("loading the speech model panicked: {e}"));
    let loaded = match loaded.and_then(|inner| inner) {
        Ok(loaded) => loaded,
        Err(err) => {
            set_phase(model, Phase::Failed(err.clone()));
            return Err(err);
        }
    };

    *engine().loaded.lock().await = Some(loaded);
    set_phase(model, Phase::Ready);
    Ok(())
}

pub async fn transcribe(data_dir: PathBuf, model: String, clip: Vec<u8>) -> Result<String, String> {
    let model = super::resolve_model(&model);
    let pcm = wav::decode_to_mono_16k(&clip)?;
    if pcm.is_empty() {
        return Ok(String::new());
    }

    ensure_ready(data_dir, model.to_string()).await?;

    let mut guard = engine().loaded.lock().await;
    // A model switch racing this request can have swapped the slot between
    // ensure_ready and here; transcribing with the other checkpoint would
    // silently answer from weights nobody asked for.
    if !matches!(&*guard, Some(l) if l.model == model) {
        return Err(format!("{model} is no longer the loaded speech model"));
    }
    let mut loaded = guard
        .take()
        .ok_or_else(|| "the speech model is not loaded".to_string())?;
    let handed_back = tokio::task::spawn_blocking(move || {
        let text = loaded.run(&pcm);
        (loaded, text)
    })
    .await;

    match handed_back {
        Ok((loaded, text)) => {
            *guard = Some(loaded);
            text
        }
        Err(e) => {
            // The model went down with the panicking task. Leaving the phase
            // Failed wedged the card until someone pressed a button; the
            // weights are still on disk, so say "loading" and let the next
            // status poll rebuild it.
            set_phase(model, Phase::Loading);
            Err(format!("transcription panicked: {e}"))
        }
    }
}

async fn is_loaded(model: &str) -> bool {
    matches!(&*engine().loaded.lock().await, Some(l) if l.model == model)
}

// ── weights ───────────────────────────────────────────────────────────
//
// A prebuilt install already has the weights: they ride in the release tarball
// install.sh downloads and sha256-verifies, unpacked into the data dir. Only a
// `cargo install` build arrives without them, and it pulls that same published
// asset rather than a model host, checking every file it unpacks against
// model.lock.json — the hashes this source tree was built against.

/// The weights this host already has, or None if they must be fetched.
///
/// The unpacked cache is re-checked against the lock: a self-update can leave
/// a binary whose pinned weights differ from what an earlier version wrote
/// there, and loading those silently would be worse than fetching again. A
/// directory the operator named is used exactly as given — that is the point
/// of naming it.
fn existing_model_dir(data_dir: &Path, model: &str) -> Option<PathBuf> {
    let named = std::env::var_os(super::MODEL_DIR_ENV).map(PathBuf::from);
    resolve_existing(named.as_deref(), data_dir, model)
}

fn resolve_existing(named: Option<&Path>, data_dir: &Path, model: &str) -> Option<PathBuf> {
    if let Some(named) = named {
        if super::files_present(named, model) {
            return Some(named.to_path_buf());
        }
    }
    let cached = super::model_dir(data_dir, model);
    if super::files_present(&cached, model) && verify_against_lock(&cached, model).is_ok() {
        return Some(cached);
    }
    None
}

/// Fetch the release tarball for this host and unpack the weights out of it
/// into the cache dir. Returns the directory the engine should load from.
async fn unpack_release_asset(data_dir: &Path, model: &str) -> Result<PathBuf, String> {
    unpack_from(&super::asset_base_url(), data_dir, model).await
}

async fn unpack_from(base: &str, data_dir: &Path, model: &str) -> Result<PathBuf, String> {
    unpack_with(base, data_dir, model, download_budget(model), READ_TIMEOUT).await
}

async fn unpack_with(
    base: &str,
    data_dir: &Path,
    model: &str,
    budget: u64,
    read_timeout: Duration,
) -> Result<PathBuf, String> {
    let asset = super::asset_for(model).ok_or_else(|| {
        format!(
            "no prebuilt mobux release for {}/{}, so {model} cannot be fetched — point {} at a directory holding the weights",
            std::env::consts::OS,
            std::env::consts::ARCH,
            super::MODEL_DIR_ENV
        )
    })?;
    let dir = super::model_dir(data_dir, model);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("creating {}: {e}", dir.display()))?;

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    // Everything from here on runs inside one block whose result the cleanup
    // follows: a download that fails partway used to return early and leave
    // its .part file — up to half a gigabyte — in the data dir forever.
    let tarball = dir.join(format!("{asset}.part"));
    let result = fetch_and_unpack(
        &client,
        base,
        &asset,
        &tarball,
        &dir,
        model,
        budget,
        read_timeout,
    )
    .await;
    let _ = tokio::fs::remove_file(&tarball).await;
    result.map(|()| dir)
}

#[allow(clippy::too_many_arguments)]
async fn fetch_and_unpack(
    client: &reqwest::Client,
    base: &str,
    asset: &str,
    tarball: &Path,
    dir: &Path,
    model: &str,
    budget: u64,
    read_timeout: Duration,
) -> Result<(), String> {
    set_phase(
        model,
        Phase::Downloading {
            file: asset.to_string(),
            downloaded: 0,
            total: 0,
        },
    );
    let digest = download(
        client,
        &format!("{base}/{asset}"),
        tarball,
        model,
        asset,
        budget,
        read_timeout,
    )
    .await?;

    set_phase(model, Phase::Verifying);
    verify_and_unpack(client, base, asset, &digest, tarball, dir, model).await
}

async fn verify_and_unpack(
    client: &reqwest::Client,
    base: &str,
    asset: &str,
    digest: &str,
    tarball: &Path,
    dir: &Path,
    model: &str,
) -> Result<(), String> {
    let published = fetch_published_digest(client, base, asset).await?;
    if published != digest {
        return Err(format!(
            "sha256 mismatch for {asset}: the release publishes {published}, the download is {digest}"
        ));
    }

    let tarball = tarball.to_path_buf();
    let dir = dir.to_path_buf();
    let model = model.to_string();
    tokio::task::spawn_blocking(move || extract_model(&tarball, &dir, &model))
        .await
        .map_err(|e| format!("unpacking the speech model panicked: {e}"))?
}

/// Read the `<asset>.sha256` sidecar the release publishes beside the tarball —
/// the same file install.sh checks, in `sha256sum` format.
async fn fetch_published_digest(
    client: &reqwest::Client,
    base: &str,
    asset: &str,
) -> Result<String, String> {
    let body = client
        .get(format!("{base}/{asset}.sha256"))
        .timeout(SIDECAR_TIMEOUT)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("fetching {asset}.sha256: {e}"))?
        .text()
        .await
        .map_err(|e| format!("reading {asset}.sha256: {e}"))?;
    parse_sha256sum(&body).ok_or_else(|| format!("{asset}.sha256 is not a sha256sum line"))
}

fn parse_sha256sum(body: &str) -> Option<String> {
    let digest = body.split_whitespace().next()?;
    if digest.len() != 64 || !digest.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(digest.to_ascii_lowercase())
}

/// Unpack just the model files out of the tarball, then check each one against
/// the lock. A file that does not match is removed rather than left behind for
/// the next start to load.
fn extract_model(tarball: &Path, dir: &Path, model: &str) -> Result<(), String> {
    let prefix = super::asset_model_prefix(model);
    let file =
        std::fs::File::open(tarball).map_err(|e| format!("opening {}: {e}", tarball.display()))?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let entries = archive
        .entries()
        .map_err(|e| format!("reading {}: {e}", tarball.display()))?;

    let wanted = super::model_files(model);
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("reading {}: {e}", tarball.display()))?;
        let path = entry
            .path()
            .map_err(|e| format!("reading {}: {e}", tarball.display()))?
            .to_string_lossy()
            .into_owned();
        let Some(name) = path.strip_prefix(&prefix) else {
            continue;
        };
        if !wanted.contains(&name) {
            continue;
        }
        // Regular files only. A symlink or hardlink entry named like a model
        // file extracts cleanly and verification then reads straight through
        // it, reporting the size and digest of whatever it points at. Skipping
        // it means an archive carrying no regular file yields no model.
        if !entry.header().entry_type().is_file() {
            continue;
        }
        entry
            .unpack(dir.join(name))
            .map_err(|e| format!("unpacking {name}: {e}"))?;
    }

    if let Err(err) = verify_against_lock(dir, model) {
        for name in &wanted {
            let _ = std::fs::remove_file(dir.join(name));
        }
        return Err(err);
    }
    Ok(())
}

fn verify_against_lock(dir: &Path, model: &str) -> Result<(), String> {
    let locked_model = super::locked_model(model)
        .ok_or_else(|| format!("{model} is not a checkpoint this build publishes"))?;
    for (name, locked) in &locked_model.files {
        let bytes = std::fs::read(dir.join(name))
            .map_err(|e| format!("the release asset carries no usable {name}: {e}"))?;
        if bytes.len() as u64 != locked.bytes {
            return Err(format!(
                "{name} is {} bytes, this build expects {}",
                bytes.len(),
                locked.bytes
            ));
        }
        let digest = hex(Sha256::digest(&bytes));
        if digest != locked.sha256 {
            return Err(format!(
                "sha256 mismatch for {name}: this build expects {}, the release carries {digest}",
                locked.sha256
            ));
        }
    }
    Ok(())
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
}

/// Stream `url` to `target`, reporting progress, and return the sha256 of what
/// landed — computed while writing, so nothing is read back to check it.
async fn download(
    client: &reqwest::Client,
    url: &str,
    target: &Path,
    model: &str,
    file: &str,
    budget: u64,
    read_timeout: Duration,
) -> Result<String, String> {
    let response = tokio::time::timeout(read_timeout, client.get(url).send())
        .await
        .map_err(|_| format!("fetching {file}: no response within {read_timeout:?}"))?
        .map_err(|e| format!("fetching {file}: {e}"))?;
    let response = response
        .error_for_status()
        .map_err(|e| format!("fetching {file}: {e}"))?;
    let total = response.content_length().unwrap_or(0);
    if total > budget {
        return Err(format!(
            "{file} is {total} bytes, more than the {budget} this build expects to download"
        ));
    }

    let mut out = tokio::fs::File::create(target)
        .await
        .map_err(|e| format!("creating {}: {e}", target.display()))?;

    let mut hasher = Sha256::new();
    let mut stream = response.bytes_stream();
    let mut downloaded = 0u64;
    let mut reported = 0u64;
    // A host that answers and then stops sending is the case that hung the
    // whole engine: every chunk gets a clock of its own, and the total gets a
    // ceiling, so a stall or a wrong URL fails instead of running forever.
    while let Some(chunk) = tokio::time::timeout(read_timeout, stream.next())
        .await
        .map_err(|_| format!("downloading {file}: stalled for {read_timeout:?}"))?
    {
        let chunk = chunk.map_err(|e| format!("downloading {file}: {e}"))?;
        downloaded += chunk.len() as u64;
        if downloaded > budget {
            return Err(format!(
                "{file} passed {budget} bytes without ending — refusing to fill the disk"
            ));
        }
        hasher.update(&chunk);
        out.write_all(&chunk)
            .await
            .map_err(|e| format!("writing {}: {e}", target.display()))?;
        if downloaded - reported >= DOWNLOAD_PROGRESS_STEP {
            reported = downloaded;
            set_phase(
                model,
                Phase::Downloading {
                    file: file.to_string(),
                    downloaded,
                    total,
                },
            );
        }
    }
    out.flush()
        .await
        .map_err(|e| format!("writing {}: {e}", target.display()))?;
    Ok(hex(hasher.finalize()))
}

// ── inference ─────────────────────────────────────────────────────────

struct Loaded {
    model: String,
    whisper: m::model::Whisper,
    tokenizer: Tokenizer,
    config: Config,
    mel_filters: Vec<f32>,
    device: Device,
    suppress_tokens: Tensor,
    sot_token: u32,
    transcribe_token: u32,
    eot_token: u32,
    no_speech_token: u32,
    no_timestamps_token: u32,
}

impl Loaded {
    fn load(dir: &Path, model: &str) -> Result<Self, String> {
        let model = model.to_string();
        let config: Config = serde_json::from_str(
            &std::fs::read_to_string(dir.join("config.json"))
                .map_err(|e| format!("reading config.json: {e}"))?,
        )
        .map_err(|e| format!("parsing config.json: {e}"))?;
        if config.num_mel_bins != 80 {
            return Err(format!(
                "checkpoint wants {} mel bins; this build ships the 80-bin filterbank",
                config.num_mel_bins
            ));
        }
        let mel_filters = MEL_FILTERS_80
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| f32::from_le_bytes(*c))
            .collect();

        let tokenizer = Tokenizer::from_file(dir.join("tokenizer.json"))
            .map_err(|e| format!("reading tokenizer.json: {e}"))?;

        let device = Device::Cpu;
        let weights = dir.join("model.safetensors");
        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(&[weights], m::DTYPE, &device)
                .map_err(|e| format!("mapping model.safetensors: {e}"))?
        };
        let whisper = m::model::Whisper::load(&vb, config.clone())
            .map_err(|e| format!("building the model: {e}"))?;

        let no_timestamps_token = token_id(&tokenizer, m::NO_TIMESTAMPS_TOKEN)?;
        let suppressed: Vec<f32> = (0..config.vocab_size as u32)
            .map(|i| {
                if config.suppress_tokens.contains(&i) {
                    f32::NEG_INFINITY
                } else {
                    0f32
                }
            })
            .collect();
        let suppress_tokens = Tensor::new(suppressed.as_slice(), &device)
            .map_err(|e| format!("building the suppression mask: {e}"))?;
        let no_speech_token = m::NO_SPEECH_TOKENS
            .iter()
            .find_map(|t| token_id(&tokenizer, t).ok())
            .ok_or_else(|| "tokenizer has no no-speech token".to_string())?;

        Ok(Self {
            model,
            whisper,
            config,
            mel_filters,
            device,
            suppress_tokens,
            sot_token: token_id(&tokenizer, m::SOT_TOKEN)?,
            transcribe_token: token_id(&tokenizer, m::TRANSCRIBE_TOKEN)?,
            eot_token: token_id(&tokenizer, m::EOT_TOKEN)?,
            no_speech_token,
            no_timestamps_token,
            tokenizer,
        })
    }

    fn run(&mut self, pcm: &[f32]) -> Result<String, String> {
        let mel = audio::pcm_to_mel(&self.config, pcm, &self.mel_filters);
        let frames = mel.len() / self.config.num_mel_bins;
        let mel = Tensor::from_vec(mel, (1, self.config.num_mel_bins, frames), &self.device)
            .map_err(|e| format!("building the mel tensor: {e}"))?;

        let mut rng = StdRng::seed_from_u64(299_792_458);
        let mut text = String::new();
        let mut seek = 0;
        while seek < frames {
            let size = usize::min(frames - seek, m::N_FRAMES);
            let segment = mel
                .narrow(2, seek, size)
                .map_err(|e| format!("slicing the mel tensor: {e}"))?;
            seek += size;
            let decoded = self.decode_with_fallback(&segment, &mut rng)?;
            if decoded.no_speech_prob > m::NO_SPEECH_THRESHOLD
                && decoded.avg_logprob < m::LOGPROB_THRESHOLD
            {
                continue;
            }
            let chunk = decoded.text.trim();
            if chunk.is_empty() {
                continue;
            }
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(chunk);
        }
        Ok(text.trim().to_string())
    }

    fn decode_with_fallback(
        &mut self,
        segment: &Tensor,
        rng: &mut StdRng,
    ) -> Result<Decoded, String> {
        let last = m::TEMPERATURES.len() - 1;
        for (i, &t) in m::TEMPERATURES.iter().enumerate() {
            let decoded = self.decode(segment, t, rng);
            if i == last {
                return decoded;
            }
            if let Ok(decoded) = decoded {
                if decoded.avg_logprob >= m::LOGPROB_THRESHOLD
                    || decoded.no_speech_prob > m::NO_SPEECH_THRESHOLD
                {
                    return Ok(decoded);
                }
            }
        }
        unreachable!("the temperature ladder always returns on its last rung")
    }

    fn decode(&mut self, mel: &Tensor, t: f64, rng: &mut StdRng) -> Result<Decoded, String> {
        let mut inner = || -> candle_core::Result<Decoded> {
            let audio_features = self.whisper.encoder.forward(mel, true)?;
            let sample_len = self.config.max_target_positions / 2;
            let mut sum_logprob = 0f64;
            let mut no_speech_prob = f64::NAN;
            let mut tokens = vec![
                self.sot_token,
                self.transcribe_token,
                self.no_timestamps_token,
            ];

            for i in 0..sample_len {
                let tokens_t = Tensor::new(tokens.as_slice(), mel.device())?.unsqueeze(0)?;
                let ys = self
                    .whisper
                    .decoder
                    .forward(&tokens_t, &audio_features, i == 0)?;

                if i == 0 {
                    let logits = self.whisper.decoder.final_linear(&ys.i(..1)?)?.i(0)?.i(0)?;
                    no_speech_prob = softmax(&logits, 0)?
                        .i(self.no_speech_token as usize)?
                        .to_scalar::<f32>()? as f64;
                }

                let (_, seq_len, _) = ys.dims3()?;
                let logits = self
                    .whisper
                    .decoder
                    .final_linear(&ys.i((..1, seq_len - 1..))?)?
                    .i(0)?
                    .i(0)?;
                let logits = logits.broadcast_add(&self.suppress_tokens)?;

                let next = if t > 0f64 {
                    let probabilities: Vec<f32> = softmax(&(&logits / t)?, 0)?.to_vec1()?;
                    let distribution = WeightedIndex::new(&probabilities)
                        .map_err(|e| candle_core::Error::Msg(e.to_string()))?;
                    distribution.sample(rng) as u32
                } else {
                    let logits: Vec<f32> = logits.to_vec1()?;
                    logits
                        .iter()
                        .enumerate()
                        .max_by(|(_, a), (_, b)| a.total_cmp(b))
                        .map(|(i, _)| i as u32)
                        .unwrap_or(self.eot_token)
                };
                tokens.push(next);
                let probability = softmax(&logits, candle_core::D::Minus1)?
                    .i(next as usize)?
                    .to_scalar::<f32>()? as f64;
                if next == self.eot_token || tokens.len() > self.config.max_target_positions {
                    break;
                }
                sum_logprob += probability.ln();
            }

            let text = self
                .tokenizer
                .decode(&tokens, true)
                .map_err(|e| candle_core::Error::Msg(e.to_string()))?;
            Ok(Decoded {
                avg_logprob: sum_logprob / tokens.len() as f64,
                no_speech_prob,
                text,
            })
        };
        inner().map_err(|e| format!("decoding: {e}"))
    }
}

struct Decoded {
    text: String,
    avg_logprob: f64,
    no_speech_prob: f64,
}

fn token_id(tokenizer: &Tokenizer, token: &str) -> Result<u32, String> {
    tokenizer
        .token_to_id(token)
        .ok_or_else(|| format!("tokenizer has no id for {token}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_filterbank_is_a_whole_80_bin_bank() {
        assert_eq!(MEL_FILTERS_80.len() % 4, 0);
        assert_eq!(MEL_FILTERS_80.len() / 4, 80 * (m::N_FFT / 2 + 1));
    }

    #[tokio::test]
    async fn a_clip_that_is_not_a_wav_fails_before_any_model_work() {
        let dir = tempfile::tempdir().unwrap();
        let err = transcribe(
            dir.path().to_path_buf(),
            "tiny.en".to_string(),
            b"not audio".to_vec(),
        )
        .await
        .expect_err("a non-WAV body cannot be transcribed");
        assert!(err.contains("RIFF"), "{err}");
    }

    #[test]
    fn a_sha256sum_sidecar_yields_the_digest_and_nothing_else_does() {
        let digest = "27e6cbbc03132b9e95bc2ff4fe1a8c4ccb207f77998cc7567a3945b626b733f7";
        assert_eq!(
            parse_sha256sum(&format!(
                "{digest}  mobux-x86_64-unknown-linux-gnu.tar.gz\n"
            )),
            Some(digest.to_string())
        );
        assert_eq!(parse_sha256sum(""), None);
        assert_eq!(parse_sha256sum("not-a-digest  asset.tar.gz"), None);
        assert_eq!(parse_sha256sum(&format!("{}  asset", &digest[..63])), None);
    }

    fn write_files(dir: &Path, model: &str, bytes: &[u8]) {
        std::fs::create_dir_all(dir).unwrap();
        for name in super::super::model_files(model) {
            std::fs::write(dir.join(name), bytes).unwrap();
        }
    }

    // Weights whose bytes are not the ones this build was compiled against are
    // never loaded — extract_model deletes them rather than leave them for the
    // next start to pick up.
    #[test]
    fn unpacked_weights_that_do_not_match_the_lock_are_rejected() {
        for model in super::super::model_ids() {
            let dir = tempfile::tempdir().unwrap();
            write_files(dir.path(), &model, b"not the real weights");
            let err =
                verify_against_lock(dir.path(), &model).expect_err("bad bytes must not verify");
            assert!(
                err.contains("config.json") && err.contains("expects"),
                "{model}: {err}"
            );
        }
    }

    #[test]
    fn a_checkpoint_this_build_does_not_publish_is_named_rather_than_waved_through() {
        let dir = tempfile::tempdir().unwrap();
        let err = verify_against_lock(dir.path(), "medium.en")
            .expect_err("an unpublished checkpoint has no hashes to check");
        assert!(err.contains("medium.en"), "{err}");
    }

    // An operator who names a directory gets that directory, whatever is in
    // it — an airgapped install has no way to match this build's hashes.
    #[test]
    fn a_named_directory_wins_and_is_not_checked_against_the_lock() {
        let dir = tempfile::tempdir().unwrap();
        let named = dir.path().join("airgapped");
        write_files(&named, "small.en", b"someone else's weights");
        assert_eq!(
            resolve_existing(Some(&named), dir.path(), "small.en").as_deref(),
            Some(named.as_path())
        );
    }

    // A cache holding weights this build does not pin is not loaded; the
    // caller fetches instead.
    #[test]
    fn a_cache_that_does_not_match_the_lock_is_not_used() {
        for model in super::super::model_ids() {
            let dir = tempfile::tempdir().unwrap();
            assert!(resolve_existing(None, dir.path(), &model).is_none());
            write_files(
                &super::super::model_dir(dir.path(), &model),
                &model,
                b"weights from an older build",
            );
            assert!(
                resolve_existing(None, dir.path(), &model).is_none(),
                "{model}"
            );
        }
    }

    // An incomplete named directory is ignored rather than half-loaded.
    #[test]
    fn a_named_directory_missing_a_file_falls_through() {
        let dir = tempfile::tempdir().unwrap();
        let named = dir.path().join("partial");
        std::fs::create_dir_all(&named).unwrap();
        std::fs::write(named.join("config.json"), b"{}").unwrap();
        assert!(resolve_existing(Some(&named), dir.path(), "base.en").is_none());
    }

    #[test]
    fn a_missing_file_is_named_rather_than_silently_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let err =
            verify_against_lock(dir.path(), "base.en").expect_err("nothing on disk cannot verify");
        assert!(err.contains("config.json"), "{err}");
    }

    // ── fetching a checkpoint from our own releases ─────────────────────
    //
    // The vendored checkpoint comes out of the platform tarball; every other
    // one out of its own asset. Same download, same sidecar check, same lock
    // check — and nothing anywhere reaches Hugging Face.

    fn tarball(model: &str, model_bytes: &[u8]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        let mut add = |path: &str, bytes: &[u8]| {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, path, bytes).unwrap();
        };
        add("mobux", b"the binary, which the model fetch must skip");
        for name in super::super::model_files(model) {
            add(
                &format!("{}{name}", super::super::asset_model_prefix(model)),
                model_bytes,
            );
        }
        let tar = builder.into_inner().unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut gz, &tar).unwrap();
        gz.finish().unwrap()
    }

    /// Serve one release asset the way GitHub does: the archive, and a
    /// `sha256sum`-format sidecar beside it.
    async fn serve_asset(asset: String, body: Vec<u8>, sidecar: String) -> String {
        use axum::{routing::get, Router};

        let app = Router::new()
            .route(&format!("/{asset}"), get(move || async move { body }))
            .route(
                &format!("/{asset}.sha256"),
                get(move || async move { sidecar }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{addr}")
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        hex(Sha256::digest(bytes))
    }

    // One case per checkpoint: the fetch reaches the asset that checkpoint
    // lives in, unpacks it, finds weights the build does not pin, and leaves
    // nothing behind. The vendored one exercises the platform tarball, the
    // others their own per-model assets.
    #[tokio::test]
    async fn weights_that_do_not_match_the_lock_are_refused_and_removed_for_every_model() {
        for model in super::super::model_ids() {
            let asset = super::super::asset_for(&model).expect("a published asset");
            let body = tarball(&model, b"weights from somewhere else");
            let sidecar = format!("{}  {asset}\n", sha256_hex(&body));
            let base = serve_asset(asset.clone(), body, sidecar).await;

            let dir = tempfile::tempdir().unwrap();
            let err = unpack_from(&base, dir.path(), &model)
                .await
                .expect_err("unpinned weights must not be loaded");
            assert!(err.contains("expects"), "{model}: {err}");

            let cached = super::super::model_dir(dir.path(), &model);
            assert!(
                !super::super::files_present(&cached, &model),
                "{model}: rejected weights must not be left on disk"
            );
            assert!(
                !cached.join(format!("{asset}.part")).exists(),
                "{model}: the download must not be left behind"
            );
        }
    }

    // The per-model assets are the point of this split: picking small.en must
    // not drag down the platform tarball, and vice versa.
    #[tokio::test]
    async fn a_non_vendored_model_is_fetched_from_its_own_asset() {
        let model = "small.en";
        let asset = super::super::asset_for(model).unwrap();
        assert_eq!(asset, "mobux-stt-small.en.tar.gz");

        // Only that asset is served; reaching for any other one 404s.
        let body = tarball(model, b"weights from somewhere else");
        let sidecar = format!("{}  {asset}\n", sha256_hex(&body));
        let base = serve_asset(asset, body, sidecar).await;

        let dir = tempfile::tempdir().unwrap();
        let err = unpack_from(&base, dir.path(), model)
            .await
            .expect_err("unpinned weights must not be loaded");
        assert!(err.contains("expects"), "{err}");
    }

    #[tokio::test]
    async fn a_tarball_that_does_not_match_its_published_sha256_is_refused() {
        let model = super::super::DEFAULT_MODEL;
        let asset = super::super::asset_for(model).unwrap();
        let body = tarball(model, b"anything");
        let sidecar = format!("{}  {asset}\n", "0".repeat(64));
        let base = serve_asset(asset, body, sidecar).await;

        let dir = tempfile::tempdir().unwrap();
        let err = unpack_from(&base, dir.path(), model)
            .await
            .expect_err("a tampered asset must not be unpacked");
        assert!(err.contains("sha256 mismatch"), "{err}");
    }

    // A host that answers and then stops sending used to hang the
    // transcription that started it — with the engine mutex held, so every
    // later dictation queued behind it — until the process was restarted.
    #[tokio::test]
    async fn a_stalled_download_gives_up_instead_of_hanging() {
        use axum::{routing::get, Router};

        let app = Router::new().route(
            "/stalls.tar.gz",
            get(|| async {
                axum::body::Body::from_stream(futures_util::stream::pending::<
                    Result<axum::body::Bytes, std::io::Error>,
                >())
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("stalls.part");
        let started = std::time::Instant::now();
        let err = download(
            &reqwest::Client::new(),
            &format!("http://{addr}/stalls.tar.gz"),
            &target,
            "base.en",
            "stalls.tar.gz",
            u64::MAX,
            Duration::from_millis(300),
        )
        .await
        .expect_err("a stalled host must not be waited on forever");
        assert!(err.contains("stalled"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(10), "gave up late");
    }

    // No budget meant a wrong base URL could write until the disk filled.
    #[tokio::test]
    async fn a_download_past_its_budget_is_refused_and_leaves_nothing_behind() {
        let model = super::super::DEFAULT_MODEL;
        let asset = super::super::asset_for(model).unwrap();
        let body = tarball(model, b"more bytes than the budget allows");
        let sidecar = format!("{}  {asset}\n", sha256_hex(&body));
        let base = serve_asset(asset.clone(), body, sidecar).await;

        let dir = tempfile::tempdir().unwrap();
        let err = unpack_with(&base, dir.path(), model, 8, READ_TIMEOUT)
            .await
            .expect_err("a download past its budget must stop");
        assert!(err.contains("budget") || err.contains("expects"), "{err}");

        // The fix for the leak: the part-file is removed on the download path
        // too, not only after a failed verification.
        let cached = super::super::model_dir(dir.path(), model);
        assert!(
            !cached.join(format!("{asset}.part")).exists(),
            "a failed download must not leave its part-file behind"
        );
    }

    // Only regular files are unpacked. A link entry named like a model file
    // and pointing outside the directory otherwise extracts cleanly, and
    // verification then reads straight through it — reporting the size and
    // digest of whatever it points at. The invariant: an archive carrying no
    // regular file yields no model.
    fn link_only_archive(model: &str, kind: tar::EntryType) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_size(0);
        header.set_mode(0o777);
        header.set_entry_type(kind);
        header.set_cksum();
        builder
            .append_link(
                &mut header,
                format!("{}config.json", super::super::asset_model_prefix(model)),
                "/etc/hostname",
            )
            .unwrap();
        let tar = builder.into_inner().unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut gz, &tar).unwrap();
        gz.finish().unwrap()
    }

    #[tokio::test]
    async fn an_archive_of_links_rather_than_files_yields_no_model() {
        let model = super::super::DEFAULT_MODEL;
        for kind in [tar::EntryType::Symlink, tar::EntryType::Link] {
            let asset = super::super::asset_for(model).unwrap();
            let body = link_only_archive(model, kind);
            let sidecar = format!("{}  {asset}\n", sha256_hex(&body));
            let base = serve_asset(asset, body, sidecar).await;

            let dir = tempfile::tempdir().unwrap();
            let err = unpack_from(&base, dir.path(), model)
                .await
                .expect_err("{kind:?} entries carry no model");
            assert!(err.contains("no usable config.json"), "{kind:?}: {err}");
            assert!(
                !super::super::model_dir(dir.path(), model)
                    .join("config.json")
                    .exists(),
                "{kind:?}: nothing may be created for a link entry"
            );
        }
    }

    // And the guard must not reject the archive we actually publish, which
    // scripts/build-release-asset.sh builds with the system tar.
    #[tokio::test]
    async fn an_archive_built_by_the_system_tar_still_unpacks() {
        let model = super::super::DEFAULT_MODEL;
        let stage = tempfile::tempdir().unwrap();
        let packed = stage.path().join("stt-models").join(model);
        std::fs::create_dir_all(&packed).unwrap();
        for name in super::super::model_files(model) {
            std::fs::write(packed.join(name), b"stand-in weights").unwrap();
        }
        let archive = stage.path().join("asset.tar.gz");
        let status = std::process::Command::new("tar")
            .arg("-C")
            .arg(stage.path())
            .arg("-czf")
            .arg(&archive)
            .arg("stt-models")
            .status()
            .expect("the system tar builds the release assets");
        assert!(status.success());
        let body = std::fs::read(&archive).unwrap();

        let asset = super::super::asset_for(model).unwrap();
        let sidecar = format!("{}  {asset}\n", sha256_hex(&body));
        let base = serve_asset(asset, body, sidecar).await;

        let dir = tempfile::tempdir().unwrap();
        let err = unpack_from(&base, dir.path(), model)
            .await
            .expect_err("stand-in weights cannot match the lock");
        assert!(
            err.contains("expects"),
            "the entries must reach the hash check, not be skipped: {err}"
        );
    }

    #[test]
    fn the_download_budget_covers_the_weights_and_no_more_than_the_slack() {
        for model in super::super::model_ids() {
            let weights: u64 = super::super::locked_model(&model)
                .unwrap()
                .files
                .values()
                .map(|f| f.bytes)
                .sum();
            assert_eq!(download_budget(&model), weights + DOWNLOAD_SLACK);
        }
    }

    #[tokio::test]
    async fn a_release_with_no_asset_says_so_rather_than_hanging() {
        use axum::Router;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, Router::new()).await.unwrap();
        });

        let dir = tempfile::tempdir().unwrap();
        let err = unpack_from(&format!("http://{addr}"), dir.path(), "base.en")
            .await
            .expect_err("a 404 is not a model");
        assert!(err.contains("fetching"), "{err}");
    }

    // The real thing: loads the bundled checkpoint and runs whisper on a
    // bundled clip, so it never belongs in a normal `cargo test`. Run it by
    // hand with:
    //
    //   node scripts/stt-model.mjs ensure .tmp/stt-model "$(node scripts/stt-model.mjs vendored)"
    //   MOBUX_STT_MODEL_TEST=1 MOBUX_STT_MODEL_DIR=.tmp/stt-model \
    //     cargo test --release --features local-stt -- --ignored transcribes_the_bundled_sample
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "loads real whisper weights and runs real inference"]
    async fn transcribes_the_bundled_sample() {
        if std::env::var("MOBUX_STT_MODEL_TEST").is_err() {
            eprintln!("set MOBUX_STT_MODEL_TEST=1 to run the real-model test");
            return;
        }
        let cache = std::env::var("MOBUX_STT_MODEL_CACHE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("mobux-stt-model-test"));
        std::fs::create_dir_all(&cache).unwrap();

        let clip =
            std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("test/assets/jfk-5s.wav"))
                .expect("bundled sample clip");

        let text = transcribe(cache, super::super::DEFAULT_MODEL.to_string(), clip)
            .await
            .expect("the bundled sample transcribes");
        let lowered = text.to_lowercase();
        assert!(lowered.contains("fellow americans"), "got: {text}");
    }
}
