//! The candle-backed whisper engine.
//!
//! Adapted from `candle-examples/examples/whisper` (huggingface/candle 0.11):
//! greedy decode with the temperature fallback ladder, timestamps off, one
//! English-only checkpoint held in memory between requests.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use candle_core::{Device, IndexOp, Tensor};
use candle_nn::ops::softmax;
use candle_nn::VarBuilder;
use candle_transformers::models::whisper::{self as m, audio, Config};
use futures_util::StreamExt;
use rand::distr::weighted::WeightedIndex;
use rand::distr::Distribution;
use rand::rngs::StdRng;
use rand::SeedableRng;
use tokenizers::Tokenizer;
use tokio::io::AsyncWriteExt;

use super::wav;
use super::{Phase, MODEL_FILES};

/// Mel filterbank for the 80-bin whisper checkpoints, as shipped by candle's
/// own example. The engine refuses a checkpoint that wants a different bank
/// rather than transcribing noise.
const MEL_FILTERS_80: &[u8] = include_bytes!("melfilters.bytes");

const DOWNLOAD_PROGRESS_STEP: u64 = 4 * 1024 * 1024;

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

    if let Err(err) = fetch_missing_files(&data_dir, model).await {
        set_phase(model, Phase::Failed(err.clone()));
        return Err(err);
    }

    set_phase(model, Phase::Loading);
    let dir = super::model_dir(&data_dir, model);
    let loaded = tokio::task::spawn_blocking(move || Loaded::load(&dir))
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
            let err = format!("transcription panicked: {e}");
            set_phase(model, Phase::Failed(err.clone()));
            Err(err)
        }
    }
}

async fn is_loaded(model: &str) -> bool {
    matches!(&*engine().loaded.lock().await, Some(l) if l.model == model)
}

// ── weights ───────────────────────────────────────────────────────────

async fn fetch_missing_files(data_dir: &Path, model: &str) -> Result<(), String> {
    let repo = super::repo_for(model).ok_or_else(|| format!("unknown speech model: {model}"))?;
    let dir = super::model_dir(data_dir, model);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("creating {}: {e}", dir.display()))?;

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    for file in MODEL_FILES {
        let target = dir.join(file);
        if target.is_file() {
            continue;
        }
        set_phase(
            model,
            Phase::Downloading {
                file: file.to_string(),
                downloaded: 0,
                total: 0,
            },
        );
        download(
            &client,
            &format!("https://huggingface.co/{repo}/resolve/main/{file}"),
            &target,
            model,
            file,
        )
        .await?;
    }
    Ok(())
}

async fn download(
    client: &reqwest::Client,
    url: &str,
    target: &Path,
    model: &str,
    file: &str,
) -> Result<(), String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("fetching {file}: {e}"))?;
    let response = response
        .error_for_status()
        .map_err(|e| format!("fetching {file}: {e}"))?;
    let total = response.content_length().unwrap_or(0);

    // Write beside the target and rename, so an interrupted download is never
    // mistaken for a complete one on the next start.
    let partial = target.with_extension("part");
    let mut out = tokio::fs::File::create(&partial)
        .await
        .map_err(|e| format!("creating {}: {e}", partial.display()))?;

    let mut stream = response.bytes_stream();
    let mut downloaded = 0u64;
    let mut reported = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("downloading {file}: {e}"))?;
        downloaded += chunk.len() as u64;
        out.write_all(&chunk)
            .await
            .map_err(|e| format!("writing {}: {e}", partial.display()))?;
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
        .map_err(|e| format!("writing {}: {e}", partial.display()))?;
    drop(out);
    tokio::fs::rename(&partial, target)
        .await
        .map_err(|e| format!("finalising {}: {e}", target.display()))
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
    fn load(dir: &Path) -> Result<Self, String> {
        let model = dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
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

    // The real thing: downloads ~150 MB from Hugging Face and runs whisper on
    // a bundled clip, so it never belongs in a normal `cargo test`. Run it by
    // hand with:
    //
    //   MOBUX_STT_MODEL_TEST=1 cargo test --features local-stt \
    //     --  --ignored transcribes_the_bundled_sample
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "downloads whisper weights and runs real inference"]
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
