// ── Speech-to-text: local CPU Parakeet via sherpa-rs ──────────────────
//
// `POST /transcribe` accepts a 16 kHz mono 16-bit PCM WAV (multipart, same
// pattern as `/api/upload`), runs it through an NVIDIA Parakeet TDT 0.6b-v2
// (int8) offline transducer entirely on CPU, and returns `{ "text": "..." }`.
//
// The recognizer is expensive to construct (~4 s to load three ONNX graphs),
// so it is built ONCE on first use and reused for every request behind a
// mutex. The model is large (~620 MB encoder) and is NOT bundled — if the
// model files are absent the endpoint reports `503` and mobux still boots
// normally (so CI / model-less dev environments are unaffected).
//
// Engine: `sherpa-rs` (sherpa-onnx bindings), in-process — no subprocess, no
// temp files. Samples are fed straight from the parsed WAV to the recognizer.

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use sherpa_rs::transducer::{TransducerConfig, TransducerRecognizer};

/// Subdirectory (under the resolved model dir) name as published by the
/// k2-fsa sherpa-onnx model zoo. The Makefile `stt-model` target extracts the
/// release tarball to exactly this layout.
pub const MODEL_SUBDIR: &str = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8";

/// Reject anything longer than this many seconds of 16 kHz audio. Defence in
/// depth behind the client-side 60 s cap; a little headroom above 60 s.
const MAX_AUDIO_SECONDS: f32 = 70.0;
const TARGET_SAMPLE_RATE: u32 = 16_000;
const MAX_SAMPLES: usize = (MAX_AUDIO_SECONDS as usize) * (TARGET_SAMPLE_RATE as usize);

/// Errors a transcription request can fail with, mapped to HTTP status by the
/// caller in main.rs.
#[derive(Debug)]
pub enum TranscribeError {
    /// Model files are not installed; the endpoint is unavailable (503).
    ModelUnavailable(String),
    /// The uploaded bytes are not a WAV we can decode, or violate the audio
    /// constraints (400).
    BadAudio(String),
    /// The recognizer failed to initialise or run (500).
    Engine(String),
}

impl std::fmt::Display for TranscribeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TranscribeError::ModelUnavailable(m) => {
                write!(f, "speech-to-text model unavailable: {m}")
            }
            TranscribeError::BadAudio(m) => write!(f, "invalid audio: {m}"),
            TranscribeError::Engine(m) => write!(f, "transcription engine error: {m}"),
        }
    }
}

/// Resolve where the Parakeet model lives. `MOBUX_STT_MODEL_DIR` overrides;
/// otherwise it defaults to `<data_dir>/models/<MODEL_SUBDIR>`.
pub fn resolve_model_dir(data_dir: &Path) -> PathBuf {
    if let Some(override_dir) = std::env::var_os("MOBUX_STT_MODEL_DIR") {
        if !override_dir.is_empty() {
            return PathBuf::from(override_dir);
        }
    }
    data_dir.join("models").join(MODEL_SUBDIR)
}

/// Holds the lazily-constructed recognizer plus the directory it loads from.
/// Construction is deferred to the first request so startup stays fast and a
/// missing model never blocks boot.
pub struct SpeechToText {
    model_dir: PathBuf,
    recognizer: Mutex<Option<TransducerRecognizer>>,
}

impl SpeechToText {
    pub fn new(model_dir: PathBuf) -> Self {
        Self {
            model_dir,
            recognizer: Mutex::new(None),
        }
    }

    /// True if all four model files are present on disk.
    pub fn model_present(&self) -> bool {
        [
            "encoder.int8.onnx",
            "decoder.int8.onnx",
            "joiner.int8.onnx",
            "tokens.txt",
        ]
        .iter()
        .all(|f| self.model_dir.join(f).is_file())
    }

    pub fn model_dir(&self) -> &Path {
        &self.model_dir
    }

    fn build_recognizer(&self) -> Result<TransducerRecognizer, TranscribeError> {
        if !self.model_present() {
            return Err(TranscribeError::ModelUnavailable(format!(
                "model files not found in {}; run `make stt-model` or set MOBUX_STT_MODEL_DIR",
                self.model_dir.display()
            )));
        }

        let dir = &self.model_dir;
        let path = |f: &str| dir.join(f).to_string_lossy().into_owned();

        // Exact config validated in the spike: Parakeet TDT is a NeMo
        // transducer, greedy decoding, 80-dim features at 16 kHz. Thread count
        // is bounded so a single transcription cannot monopolise a small
        // phone-tethered box.
        let num_threads = std::thread::available_parallelism()
            .map(|n| (n.get() as i32).clamp(1, 4))
            .unwrap_or(2);

        let config = TransducerConfig {
            encoder: path("encoder.int8.onnx"),
            decoder: path("decoder.int8.onnx"),
            joiner: path("joiner.int8.onnx"),
            tokens: path("tokens.txt"),
            model_type: "nemo_transducer".into(),
            num_threads,
            sample_rate: TARGET_SAMPLE_RATE as i32,
            feature_dim: 80,
            decoding_method: "greedy_search".into(),
            ..Default::default()
        };

        TransducerRecognizer::new(config).map_err(|e| TranscribeError::Engine(e.to_string()))
    }

    /// Decode a WAV blob and return the recognised text. Empty / silent audio
    /// yields `Ok(String::new())` (no error), matching the spike behaviour.
    pub fn transcribe_wav(&self, wav_bytes: &[u8]) -> Result<String, TranscribeError> {
        let samples = decode_wav_to_mono_f32(wav_bytes)?;
        if samples.is_empty() {
            return Ok(String::new());
        }

        let mut guard = self
            .recognizer
            .lock()
            .map_err(|_| TranscribeError::Engine("recognizer mutex poisoned".into()))?;
        if guard.is_none() {
            *guard = Some(self.build_recognizer()?);
        }
        let rec = guard.as_mut().expect("recognizer just constructed");
        let text = rec.transcribe(TARGET_SAMPLE_RATE, &samples);
        Ok(text.trim().to_string())
    }
}

/// Parse a 16-bit PCM WAV into mono f32 samples in [-1, 1] at 16 kHz.
///
/// We only accept what the client sends (16 kHz mono 16-bit PCM). If a
/// stereo file slips through we downmix to mono; non-16 kHz rates are
/// rejected rather than silently resampled (the client guarantees 16 kHz).
fn decode_wav_to_mono_f32(wav_bytes: &[u8]) -> Result<Vec<f32>, TranscribeError> {
    let mut reader = hound::WavReader::new(Cursor::new(wav_bytes))
        .map_err(|e| TranscribeError::BadAudio(format!("not a readable WAV: {e}")))?;
    let spec = reader.spec();

    if spec.sample_rate != TARGET_SAMPLE_RATE {
        return Err(TranscribeError::BadAudio(format!(
            "expected {TARGET_SAMPLE_RATE} Hz, got {} Hz",
            spec.sample_rate
        )));
    }
    let channels = spec.channels.max(1) as usize;

    // Collect interleaved samples normalised to f32 [-1, 1].
    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 / max))
                .collect::<Result<Vec<f32>, _>>()
                .map_err(|e| TranscribeError::BadAudio(format!("corrupt PCM data: {e}")))?
        }
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<Vec<f32>, _>>()
            .map_err(|e| TranscribeError::BadAudio(format!("corrupt float data: {e}")))?,
    };

    // Downmix to mono if needed.
    let mono: Vec<f32> = if channels <= 1 {
        interleaved
    } else {
        interleaved
            .chunks(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32)
            .collect()
    };

    if mono.len() > MAX_SAMPLES {
        return Err(TranscribeError::BadAudio(format!(
            "audio too long: {:.1}s exceeds {MAX_AUDIO_SECONDS:.0}s cap",
            mono.len() as f32 / TARGET_SAMPLE_RATE as f32
        )));
    }

    Ok(mono)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_wav(sample_rate: u32, channels: u16, samples: &[i16]) -> Vec<u8> {
        let spec = hound::WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut buf = Vec::new();
        {
            let mut w = hound::WavWriter::new(Cursor::new(&mut buf), spec).unwrap();
            for &s in samples {
                w.write_sample(s).unwrap();
            }
            w.finalize().unwrap();
        }
        buf
    }

    #[test]
    fn decodes_mono_16k() {
        let wav = make_wav(16_000, 1, &[0, 16384, -16384, 32767, -32768]);
        let out = decode_wav_to_mono_f32(&wav).unwrap();
        assert_eq!(out.len(), 5);
        assert!((out[1] - 0.5).abs() < 0.01);
        assert!(out[3] > 0.99);
        assert!(out[4] < -0.99);
    }

    #[test]
    fn downmixes_stereo() {
        // L=1.0, R=-1.0 averages to 0; L=R=0.5 stays 0.5.
        let wav = make_wav(16_000, 2, &[32767, -32768, 16384, 16384]);
        let out = decode_wav_to_mono_f32(&wav).unwrap();
        assert_eq!(out.len(), 2);
        assert!(out[0].abs() < 0.01);
        assert!((out[1] - 0.5).abs() < 0.01);
    }

    #[test]
    fn rejects_wrong_sample_rate() {
        let wav = make_wav(44_100, 1, &[0, 1, 2]);
        let err = decode_wav_to_mono_f32(&wav).unwrap_err();
        assert!(matches!(err, TranscribeError::BadAudio(_)));
    }

    #[test]
    fn rejects_too_long() {
        // One sample over the cap (mono 16k). Build a header-consistent WAV
        // with MAX_SAMPLES + 1 silent samples.
        let n = MAX_SAMPLES + 1;
        let samples = vec![0i16; n];
        let wav = make_wav(16_000, 1, &samples);
        let err = decode_wav_to_mono_f32(&wav).unwrap_err();
        assert!(matches!(err, TranscribeError::BadAudio(_)));
    }

    #[test]
    fn rejects_non_wav() {
        let err = decode_wav_to_mono_f32(b"not a wav at all").unwrap_err();
        assert!(matches!(err, TranscribeError::BadAudio(_)));
    }

    #[test]
    fn resolve_model_dir_default() {
        // Ensure no env override leaks from another test/process.
        std::env::remove_var("MOBUX_STT_MODEL_DIR");
        let dir = resolve_model_dir(Path::new("/data"));
        assert_eq!(dir, PathBuf::from("/data/models").join(MODEL_SUBDIR));
    }
}
