//! STT provider abstraction — forwards audio to an OpenAI-compatible endpoint.
//!
//! No model is loaded in-process. The active provider is read from db config
//! on each request (no restart needed after config change).

use std::time::Duration;

use anyhow::Result;
use reqwest::multipart;

/// Which provider kind is configured.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Local,
    Network,
    Openai,
}

impl Default for ProviderKind {
    fn default() -> Self {
        Self::Local
    }
}

/// Provider configuration stored in db (mirrors db::SttConfig).
#[derive(Debug, Clone)]
pub struct ProviderConfig {
    pub kind: ProviderKind,
    pub url: String,
    pub model: String,
    pub api_key: Option<String>,
    pub install_cmd: Option<String>,
    pub start_cmd: Option<String>,
}

impl ProviderConfig {
    /// Default local config — points at a faster-whisper server on port 5200.
    pub fn default_local() -> Self {
        Self {
            kind: ProviderKind::Local,
            url: "http://127.0.0.1:5200/v1/audio/transcriptions".to_string(),
            model: "Systran/faster-whisper-base.en".to_string(),
            api_key: None,
            install_cmd: Some("bin/stt-install".to_string()),
            start_cmd: Some("bin/stt-serve".to_string()),
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
        .timeout(Duration::from_secs(60))
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

/// Check if the provider URL is reachable (HEAD or GET with short timeout).
pub async fn probe_provider(url: &str) -> bool {
    // Extract base URL for the health probe (strip path back to /health or just /)
    let base = url
        .trim_end_matches('/')
        .rsplitn(2, '/')
        .last()
        .unwrap_or(url);
    // Try a GET on /health; many whisper-compatible servers expose it
    let health_url = format!("{base}/health");
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    // Try /health first; fall back to checking the transcribe URL with HEAD
    if client
        .get(&health_url)
        .send()
        .await
        .map(|r| r.status().as_u16() < 500)
        .unwrap_or(false)
    {
        return true;
    }
    client
        .head(url)
        .send()
        .await
        .map(|r| r.status().as_u16() < 500)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_local_config_has_expected_url() {
        let cfg = ProviderConfig::default_local();
        assert!(cfg.url.contains("5200"));
        assert_eq!(cfg.kind, ProviderKind::Local);
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
}
