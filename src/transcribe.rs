//! STT provider abstraction — forwards audio to an OpenAI-compatible endpoint.
//!
//! No model is loaded in-process. The active provider is read from db config
//! on each request (no restart needed after config change).

use std::time::Duration;

use anyhow::Result;
use reqwest::multipart;

/// Provider configuration stored in db (mirrors db::SttConfig).
#[derive(Debug, Clone)]
pub struct ProviderConfig {
    pub url: String,
    pub model: String,
    pub api_key: Option<String>,
}

impl ProviderConfig {
    /// Default local config — points at a faster-whisper server on port 5200.
    #[cfg(test)]
    pub fn default_local() -> Self {
        Self {
            url: "http://127.0.0.1:5200/v1/audio/transcriptions".to_string(),
            model: "Systran/faster-whisper-small".to_string(),
            api_key: None,
        }
    }
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
    let client = match reqwest::Client::builder().timeout(PROBE_TIMEOUT).build() {
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

    #[test]
    fn default_local_config_has_expected_url() {
        let cfg = ProviderConfig::default_local();
        assert!(cfg.url.contains("5200"));
        assert!(cfg.api_key.is_none());
    }

    #[tokio::test]
    async fn transcribe_with_empty_bytes_returns_empty_string() {
        // Should short-circuit without making any network call
        let cfg = ProviderConfig::default_local();
        let result = transcribe_with_provider(&cfg, vec![], "speech.wav").await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "");
    }

    #[tokio::test]
    async fn transcribe_unreachable_provider_returns_unavailable() {
        let mut cfg = ProviderConfig::default_local();
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

        let mut cfg = ProviderConfig::default_local();
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

        let mut cfg = ProviderConfig::default_local();
        cfg.url = format!("http://{addr}/v1/audio/transcriptions");
        assert!(
            probe_transcribe(&cfg).await,
            "responsive backend must probe reachable"
        );
    }

    #[tokio::test]
    async fn probe_transcribe_false_when_unreachable() {
        let mut cfg = ProviderConfig::default_local();
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

        let mut cfg = ProviderConfig::default_local();
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
