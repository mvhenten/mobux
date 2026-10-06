//! Remote voices behind `/api/tts/speak`. The `local` kind is the in-process
//! Piper voice (`crate::local_tts`) and never reaches this module; every other
//! kind is an HTTP endpoint that answers WAV:
//!
//! - `mistral`: Mistral's hosted Voxtral TTS, `POST /v1/audio/speech` with a
//!   `voice_id`, answering JSON with the clip base64-encoded in `audio_data`.
//! - `network`: an OpenAI-compatible `POST /v1/audio/speech` with a `voice`,
//!   answering the WAV bytes — self-hosted Voxtral on vLLM-Omni speaks this.
//! - `kyutai`: Kyutai Pocket TTS's own server, `POST /tts` with form fields
//!   `text` and `voice_url`, answering the WAV bytes.

use std::time::Duration;

use base64::Engine;
use reqwest::multipart;

use crate::config::{kind_name, TtsKind, TtsProvider};
use crate::speech_settings::base_url;

/// A block is at most `MAX_SPOKEN_CHARS` long, which a remote voice can take
/// a while to render; past this the listener is better served by the browser.
const SPEAK_TIMEOUT: Duration = Duration::from_secs(90);

/// The most of an error body worth quoting back to the listener.
const ERROR_BODY_CHARS: usize = 200;

/// Speak `text` through a remote kind and return the WAV clip. The error is a
/// sentence naming the provider, shown as the browser fallback's reason.
pub async fn speak(kind: TtsKind, provider: &TtsProvider, text: &str) -> Result<Vec<u8>, String> {
    let name = kind_name(&kind);
    if kind == TtsKind::Local {
        return Err("The local voice does not speak over HTTP.".to_string());
    }
    let base = base_url(&provider.host, &provider.port);
    if base.is_empty() {
        return Err(format!("The {name} voice has no host set."));
    }
    let client = reqwest::Client::builder()
        .timeout(SPEAK_TIMEOUT)
        .build()
        .map_err(|e| format!("The {name} voice: {e}"))?;
    let (url, request) = if kind == TtsKind::Kyutai {
        let url = format!("{base}/tts");
        let mut form = multipart::Form::new().text("text", text.to_string());
        if !provider.voice.is_empty() {
            form = form.text("voice_url", provider.voice.clone());
        }
        (url.clone(), client.post(url).multipart(form))
    } else {
        let url = format!("{base}/v1/audio/speech");
        let mut body = serde_json::json!({
            "model": provider.model,
            "input": text,
            "response_format": "wav",
        });
        if !provider.voice.is_empty() {
            let field = if kind == TtsKind::Mistral {
                "voice_id"
            } else {
                "voice"
            };
            body[field] = serde_json::json!(provider.voice);
        }
        (url.clone(), client.post(url).json(&body))
    };
    let request = if provider.api_key.is_empty() {
        request
    } else {
        request.bearer_auth(&provider.api_key)
    };

    let response = request
        .send()
        .await
        .map_err(|e| format!("The {name} voice at {url} did not answer: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let body: String = body.trim().chars().take(ERROR_BODY_CHARS).collect();
        return Err(format!(
            "The {name} voice at {url} answered {}: {body}",
            status.as_u16()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("The {name} voice at {url} broke off: {e}"))?;

    let clip = if kind == TtsKind::Mistral {
        mistral_clip(&bytes).map_err(|e| format!("The {name} voice at {url} {e}"))?
    } else {
        bytes.to_vec()
    };
    if !clip.starts_with(b"RIFF") {
        return Err(format!(
            "The {name} voice at {url} answered something that is not WAV audio."
        ));
    }
    Ok(clip)
}

fn mistral_clip(body: &[u8]) -> Result<Vec<u8>, String> {
    #[derive(serde::Deserialize)]
    struct Answer {
        audio_data: String,
    }
    let answer: Answer =
        serde_json::from_slice(body).map_err(|e| format!("answered unexpected JSON: {e}"))?;
    base64::engine::general_purpose::STANDARD
        .decode(answer.audio_data.trim())
        .map_err(|e| format!("answered audio that is not base64: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::Multipart;
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::post;
    use axum::{Json, Router};
    use std::sync::{Arc, Mutex};

    const CLIP: &[u8] = b"RIFF\x24\x00\x00\x00WAVEfmt ";

    type Seen = Arc<Mutex<Option<(String, serde_json::Value)>>>;

    async fn serve(app: Router) -> (String, String) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        ("http://127.0.0.1".to_string(), addr.port().to_string())
    }

    fn provider(host: String, port: String, kind: TtsKind, key: &str) -> TtsProvider {
        use crate::speech_settings::SpeechProvider;
        TtsProvider {
            host,
            port,
            api_key: key.to_string(),
            ..TtsProvider::default_for(kind)
        }
    }

    fn bearer(headers: &HeaderMap) -> String {
        headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string()
    }

    #[tokio::test]
    async fn mistral_sends_a_voice_id_and_decodes_audio_data() {
        let seen: Seen = Arc::default();
        let app = Router::new().route(
            "/v1/audio/speech",
            post({
                let seen = seen.clone();
                move |headers: HeaderMap, Json(body): Json<serde_json::Value>| async move {
                    *seen.lock().unwrap() = Some((bearer(&headers), body));
                    Json(serde_json::json!({
                        "audio_data": base64::engine::general_purpose::STANDARD.encode(CLIP)
                    }))
                }
            }),
        );
        let (host, port) = serve(app).await;
        let clip = speak(
            TtsKind::Mistral,
            &provider(host, port, TtsKind::Mistral, "m-key"),
            "Hello there.",
        )
        .await
        .unwrap();
        assert_eq!(clip, CLIP);
        let (auth, body) = seen.lock().unwrap().clone().unwrap();
        assert_eq!(auth, "Bearer m-key");
        assert_eq!(body["model"], "voxtral-mini-tts-2603");
        assert_eq!(body["input"], "Hello there.");
        assert_eq!(body["voice_id"], "en_paul_neutral");
        assert_eq!(body["response_format"], "wav");
    }

    #[tokio::test]
    async fn network_sends_the_openai_shape_and_passes_the_wav_through() {
        let seen: Seen = Arc::default();
        let app = Router::new().route(
            "/v1/audio/speech",
            post({
                let seen = seen.clone();
                move |headers: HeaderMap, Json(body): Json<serde_json::Value>| async move {
                    *seen.lock().unwrap() = Some((bearer(&headers), body));
                    ([("content-type", "audio/wav")], CLIP)
                }
            }),
        );
        let (host, port) = serve(app).await;
        let clip = speak(
            TtsKind::Network,
            &provider(host, port, TtsKind::Network, ""),
            "Hi.",
        )
        .await
        .unwrap();
        assert_eq!(clip, CLIP);
        let (auth, body) = seen.lock().unwrap().clone().unwrap();
        assert_eq!(auth, "");
        assert_eq!(body["voice"], "casual_female");
        assert_eq!(body["model"], "mistralai/Voxtral-4B-TTS-2603");
    }

    #[tokio::test]
    async fn kyutai_posts_the_form_fields_pocket_tts_reads() {
        let seen: Seen = Arc::default();
        let app = Router::new().route(
            "/tts",
            post({
                let seen = seen.clone();
                move |mut form: Multipart| async move {
                    let mut fields = serde_json::Map::new();
                    while let Some(field) = form.next_field().await.unwrap() {
                        let name = field.name().unwrap_or_default().to_string();
                        fields.insert(name, serde_json::json!(field.text().await.unwrap()));
                    }
                    *seen.lock().unwrap() = Some((String::new(), fields.into()));
                    ([("content-type", "audio/wav")], CLIP)
                }
            }),
        );
        let (host, port) = serve(app).await;
        let clip = speak(
            TtsKind::Kyutai,
            &provider(host, port, TtsKind::Kyutai, ""),
            "Bonjour.",
        )
        .await
        .unwrap();
        assert_eq!(clip, CLIP);
        let (_, fields) = seen.lock().unwrap().clone().unwrap();
        assert_eq!(fields["text"], "Bonjour.");
        assert_eq!(fields["voice_url"], "alba");
    }

    #[tokio::test]
    async fn an_error_status_becomes_a_reason_naming_the_provider() {
        let app = Router::new().route(
            "/tts",
            post(|| async { (StatusCode::BAD_REQUEST, "voice_url must start with http://") }),
        );
        let (host, port) = serve(app).await;
        let reason = speak(
            TtsKind::Kyutai,
            &provider(host, port, TtsKind::Kyutai, ""),
            "Hi.",
        )
        .await
        .unwrap_err();
        assert!(reason.contains("kyutai"), "{reason}");
        assert!(reason.contains("400"), "{reason}");
        assert!(reason.contains("voice_url must start"), "{reason}");
    }

    #[tokio::test]
    async fn a_kind_with_no_host_says_so() {
        use crate::speech_settings::SpeechProvider;
        let reason = speak(
            TtsKind::Network,
            &TtsProvider::default_for(TtsKind::Network),
            "Hi.",
        )
        .await
        .unwrap_err();
        assert!(reason.contains("no host"), "{reason}");
    }
}
