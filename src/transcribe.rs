//! STT provider selection.
//!
//! Two providers, one seam. The "local" kind runs whisper inside this process
//! (`crate::local_stt`); every other kind forwards the clip to an
//! OpenAI-compatible `/v1/audio/transcriptions` endpoint the user configured.
//! The active provider is read from db config on each request, so a config
//! change needs no restart.

use std::time::Duration;

use anyhow::Result;
use reqwest::multipart;

/// Endpoint configuration for a remote provider (mirrors db::SttProviderRow).
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderConfig {
    pub url: String,
    pub model: String,
    pub api_key: Option<String>,
}

/// The provider kind that runs in-process instead of over HTTP.
pub const LOCAL_KIND: &str = "local";

/// Where a transcription runs.
#[derive(Debug, Clone, PartialEq)]
pub enum Provider {
    /// Whisper loaded into this process.
    InProcess { model: String },
    /// An OpenAI-compatible endpoint the user configured.
    Remote(ProviderConfig),
}

/// Pick the provider for a configured kind.
///
/// Only the local kind runs in-process; every other kind — including one this
/// build has never heard of — is a user-configured endpoint, so an unknown
/// kind keeps forwarding rather than silently switching to local inference.
pub fn select_provider(kind: &str, url: &str, model: &str, api_key: Option<&str>) -> Provider {
    if kind == LOCAL_KIND {
        return Provider::InProcess {
            model: crate::local_stt::resolve_model(model).to_string(),
        };
    }
    Provider::Remote(ProviderConfig {
        url: url.to_string(),
        model: model.to_string(),
        api_key: api_key.filter(|k| !k.is_empty()).map(str::to_string),
    })
}

#[derive(Debug)]
pub enum TranscribeError {
    /// No provider configured or provider unreachable (503).
    ProviderUnavailable(String),
    /// The provider returned an error (500).
    ProviderError(String),
    /// Network error reaching the provider.
    NetworkError(String),
}

impl std::fmt::Display for TranscribeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ProviderUnavailable(s) => write!(f, "provider unavailable: {s}"),
            Self::ProviderError(s) => write!(f, "provider error: {s}"),
            Self::NetworkError(s) => write!(f, "network error: {s}"),
        }
    }
}

// Outbound timeout for the forwarded transcription request. Must stay below
// the client's own /transcribe timeout (see TRANSCRIBE_TIMEOUT_MS in
// input-actions.js) so a hung backend surfaces as a clean error response
// instead of the client having to abort the connection itself.
const FORWARD_TIMEOUT: Duration = Duration::from_secs(20);

/// Forward `audio_bytes` to the configured provider and return the transcript.
///
/// `filename` is sent as the multipart filename (e.g. "speech.wav").
/// The provider must speak POST /v1/audio/transcriptions (OpenAI-compatible).
pub async fn transcribe_with_provider(
    config: &ProviderConfig,
    audio_bytes: Vec<u8>,
    filename: &str,
) -> Result<String, TranscribeError> {
    if audio_bytes.is_empty() {
        return Ok(String::new());
    }

    let client = reqwest::Client::builder()
        .timeout(FORWARD_TIMEOUT)
        .build()
        .map_err(|e| TranscribeError::NetworkError(e.to_string()))?;

    let file_part = multipart::Part::bytes(audio_bytes)
        .file_name(filename.to_string())
        .mime_str("audio/wav")
        .map_err(|e| TranscribeError::NetworkError(e.to_string()))?;

    let form = multipart::Form::new()
        .part("file", file_part)
        .text("model", config.model.clone());

    let mut req = client.post(&config.url).multipart(form);

    if let Some(key) = &config.api_key {
        req = req.bearer_auth(key);
    }

    let resp = req.send().await.map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            TranscribeError::ProviderUnavailable(e.to_string())
        } else {
            TranscribeError::NetworkError(e.to_string())
        }
    })?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        if status.as_u16() == 503 || status.as_u16() == 502 || status.as_u16() == 504 {
            return Err(TranscribeError::ProviderUnavailable(format!(
                "{} {body}",
                status.as_u16()
            )));
        }
        return Err(TranscribeError::ProviderError(format!(
            "{} {body}",
            status.as_u16()
        )));
    }

    #[derive(serde::Deserialize)]
    struct TranscribeResponse {
        text: String,
    }

    let body: TranscribeResponse = resp
        .json()
        .await
        .map_err(|e| TranscribeError::ProviderError(format!("invalid json: {e}")))?;

    Ok(body.text.trim().to_string())
}

// Probe timeout — short so a hung backend fails the pre-record check fast
// instead of leaving the "reachable" poll itself looking dead.
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

/// 10 ms of 16 kHz mono silence, WAV-encoded — just enough audio for a real
/// provider to round-trip through its actual transcription pipeline.
fn probe_audio_bytes() -> Vec<u8> {
    let sample_rate: u32 = 16000;
    let samples: u32 = sample_rate / 100;
    let data_len = samples * 2;
    let mut buf = Vec::with_capacity(44 + data_len as usize);
    buf.extend_from_slice(b"RIFF");
    buf.extend_from_slice(&(36 + data_len).to_le_bytes());
    buf.extend_from_slice(b"WAVE");
    buf.extend_from_slice(b"fmt ");
    buf.extend_from_slice(&16u32.to_le_bytes());
    buf.extend_from_slice(&1u16.to_le_bytes());
    buf.extend_from_slice(&1u16.to_le_bytes());
    buf.extend_from_slice(&sample_rate.to_le_bytes());
    buf.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    buf.extend_from_slice(&2u16.to_le_bytes());
    buf.extend_from_slice(&16u16.to_le_bytes());
    buf.extend_from_slice(b"data");
    buf.extend_from_slice(&data_len.to_le_bytes());
    buf.resize(buf.len() + data_len as usize, 0u8);
    buf
}

/// Probe actual transcribe capability, not just backend liveness. A `/health`
/// ping can return 200 while the real transcription pipeline is stuck (the
/// motivating case: the backend accepts connections but
/// POST /v1/audio/transcriptions never returns) — so this sends a tiny silent
/// clip through the real endpoint with a short timeout. Any response, even an
/// error status, means the backend round-tripped and is reachable; a timeout
/// or connection failure means it is not.
pub async fn probe_transcribe(config: &ProviderConfig) -> bool {
    transcribe_round_trip(config, PROBE_TIMEOUT).await
}

async fn transcribe_round_trip(config: &ProviderConfig, timeout: Duration) -> bool {
    let client = match reqwest::Client::builder().timeout(timeout).build() {
        Ok(c) => c,
        Err(_) => return false,
    };

    let file_part = match multipart::Part::bytes(probe_audio_bytes())
        .file_name("probe.wav")
        .mime_str("audio/wav")
    {
        Ok(p) => p,
        Err(_) => return false,
    };
    let form = multipart::Form::new()
        .part("file", file_part)
        .text("model", config.model.clone());

    let mut req = client.post(&config.url).multipart(form);
    if let Some(key) = &config.api_key {
        req = req.bearer_auth(key);
    }
    req.send().await.is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote_config() -> ProviderConfig {
        ProviderConfig {
            url: "http://127.0.0.1:5200/v1/audio/transcriptions".to_string(),
            model: "Systran/faster-whisper-small".to_string(),
            api_key: None,
        }
    }

    #[test]
    fn the_local_kind_runs_in_process() {
        assert_eq!(
            select_provider("local", "http://127.0.0.1:5200", "tiny.en", None),
            Provider::InProcess {
                model: "tiny.en".to_string()
            }
        );
    }

    // An install carried over from the container provider still has that
    // provider stt model id stored against the local kind.
    #[test]
    fn a_stale_local_model_resolves_to_one_the_engine_can_run() {
        let Provider::InProcess { model } = select_provider(
            "local",
            "http://127.0.0.1:5200/v1/audio/transcriptions",
            "Systran/faster-whisper-small",
            None,
        ) else {
            panic!("the local kind must run in-process");
        };
        assert_eq!(model, crate::local_stt::DEFAULT_MODEL);
    }

    #[test]
    fn a_configured_endpoint_is_forwarded_to_unchanged() {
        let provider = select_provider(
            "openai",
            "https://api.openai.com:443/v1/audio/transcriptions",
            "whisper-1",
            Some("sk-test"),
        );
        assert_eq!(
            provider,
            Provider::Remote(ProviderConfig {
                url: "https://api.openai.com:443/v1/audio/transcriptions".to_string(),
                model: "whisper-1".to_string(),
                api_key: Some("sk-test".to_string()),
            })
        );
    }

    #[test]
    fn a_self_hosted_endpoint_keeps_its_own_model_id() {
        let provider = select_provider(
            "network",
            "http://lab:8081/v1/audio/transcriptions",
            "Systran/faster-whisper-medium.en",
            Some(""),
        );
        assert_eq!(
            provider,
            Provider::Remote(ProviderConfig {
                url: "http://lab:8081/v1/audio/transcriptions".to_string(),
                model: "Systran/faster-whisper-medium.en".to_string(),
                api_key: None,
            })
        );
    }

    // A kind this build does not know is still a configured endpoint, never a
    // silent switch to in-process inference.
    #[test]
    fn an_unknown_kind_stays_a_remote_endpoint() {
        assert!(matches!(
            select_provider(
                "groq",
                "https://api.groq.com/openai/v1/audio/transcriptions",
                "whisper-large-v3",
                None
            ),
            Provider::Remote(_)
        ));
    }

    #[tokio::test]
    async fn transcribe_with_empty_bytes_returns_empty_string() {
        // Should short-circuit without making any network call
        let cfg = remote_config();
        let result = transcribe_with_provider(&cfg, vec![], "speech.wav").await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "");
    }

    #[tokio::test]
    async fn transcribe_unreachable_provider_returns_unavailable() {
        let mut cfg = remote_config();
        cfg.url = "http://127.0.0.1:19999/v1/audio/transcriptions".to_string();
        // tiny audio bytes just to get past the empty check
        let result = transcribe_with_provider(&cfg, vec![0u8; 100], "speech.wav").await;
        assert!(matches!(
            result,
            Err(TranscribeError::ProviderUnavailable(_) | TranscribeError::NetworkError(_))
        ));
    }

    #[tokio::test]
    async fn transcribe_mock_server() {
        // Spin up a tiny mock HTTP server with axum
        use axum::{routing::post, Json as AxumJson, Router};
        use std::net::SocketAddr;

        async fn mock_handler() -> AxumJson<serde_json::Value> {
            AxumJson(serde_json::json!({ "text": "hello world" }))
        }

        let app = Router::new().route("/v1/audio/transcriptions", post(mock_handler));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let mut cfg = remote_config();
        cfg.url = format!("http://{addr}/v1/audio/transcriptions");
        // Provide minimal WAV header bytes (44 bytes)
        let audio = vec![0u8; 100];
        let result = transcribe_with_provider(&cfg, audio, "speech.wav").await;
        assert!(result.is_ok(), "mock server should return ok: {result:?}");
        assert_eq!(result.unwrap(), "hello world");
    }

    #[tokio::test]
    async fn probe_transcribe_true_when_backend_responds() {
        use axum::{routing::post, Json as AxumJson, Router};
        use std::net::SocketAddr;

        async fn mock_handler() -> AxumJson<serde_json::Value> {
            AxumJson(serde_json::json!({ "text": "" }))
        }

        let app = Router::new().route("/v1/audio/transcriptions", post(mock_handler));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let mut cfg = remote_config();
        cfg.url = format!("http://{addr}/v1/audio/transcriptions");
        assert!(
            probe_transcribe(&cfg).await,
            "responsive backend must probe reachable"
        );
    }

    #[tokio::test]
    async fn probe_transcribe_false_when_unreachable() {
        let mut cfg = remote_config();
        cfg.url = "http://127.0.0.1:19999/v1/audio/transcriptions".to_string();
        assert!(
            !probe_transcribe(&cfg).await,
            "connection refused must probe unreachable"
        );
    }

    // Reproduces the real-world bug: the backend accepts the connection but
    // the transcribe path never returns (a /health-only probe would have
    // reported this backend as reachable). probe_transcribe must give up
    // after PROBE_TIMEOUT rather than hang, and report unreachable.
    #[tokio::test]
    async fn probe_transcribe_false_when_backend_hangs() {
        use axum::{routing::post, Json as AxumJson, Router};
        use std::net::SocketAddr;

        async fn hang_handler() -> AxumJson<serde_json::Value> {
            tokio::time::sleep(PROBE_TIMEOUT + Duration::from_secs(2)).await;
            AxumJson(serde_json::json!({ "text": "should never get here in time" }))
        }

        let app = Router::new().route("/v1/audio/transcriptions", post(hang_handler));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let mut cfg = remote_config();
        cfg.url = format!("http://{addr}/v1/audio/transcriptions");

        let started = std::time::Instant::now();
        let reachable = probe_transcribe(&cfg).await;
        let elapsed = started.elapsed();

        assert!(
            !reachable,
            "hung transcribe path must probe unreachable, not a false green"
        );
        assert!(
            elapsed < PROBE_TIMEOUT + Duration::from_secs(2),
            "probe must give up around PROBE_TIMEOUT instead of waiting for the hang: took {elapsed:?}"
        );
    }
}
