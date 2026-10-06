//! Kyutai STT through `moshi-server`. It has no batch endpoint: a websocket on
//! `/api/asr-streaming` takes msgpack `Audio` frames of 24 kHz mono f32 and
//! answers with `Word` messages. A `Marker` sent after the clip comes back
//! once every word before it has been emitted, which is how a whole clip is
//! known to be done.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use crate::transcribe::{ProviderConfig, TranscribeError, FORWARD_TIMEOUT, PROBE_TIMEOUT};

pub const PATH: &str = "/api/asr-streaming";
pub const SAMPLE_RATE: u32 = 24_000;
/// 80 ms at 24 kHz: one step of the model.
pub const FRAME: usize = 1920;
/// moshi-server's own default key, used when none is configured.
const DEFAULT_KEY: &str = "public_token";
const API_KEY_HEADER: &str = "kyutai-api-key";
/// Silence after the marker pushes the clip's tail through the model's delay
/// (0.5 s for stt-1b, 2.5 s for stt-2.6b) so the marker can come back.
const TRAILING_SILENCE: Duration = Duration::from_secs(4);
const MARKER_ID: i64 = 0;

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum InMsg {
    Audio { pcm: Vec<f32> },
    Marker { id: i64 },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum OutMsg {
    Word {
        text: String,
    },
    Marker {
        id: i64,
    },
    Error {
        message: String,
    },
    #[serde(other)]
    Other,
}

/// The clip cut into model steps, the last one padded with silence.
pub fn frames(pcm: &[f32]) -> Vec<Vec<f32>> {
    pcm.chunks(FRAME)
        .map(|chunk| {
            let mut frame = chunk.to_vec();
            frame.resize(FRAME, 0.0);
            frame
        })
        .collect()
}

fn silence_frames() -> usize {
    let samples = TRAILING_SILENCE.as_millis() as usize * SAMPLE_RATE as usize / 1000;
    samples.div_ceil(FRAME)
}

fn encode(message: &InMsg) -> Result<Message, TranscribeError> {
    rmp_serde::to_vec_named(message)
        .map(|bytes| Message::Binary(bytes.into()))
        .map_err(|e| TranscribeError::ProviderError(format!("encoding a frame: {e}")))
}

/// Everything the websocket carries for one clip, in order.
fn outgoing(pcm: &[f32]) -> Result<Vec<Message>, TranscribeError> {
    let mut messages = Vec::new();
    for frame in frames(pcm) {
        messages.push(encode(&InMsg::Audio { pcm: frame })?);
    }
    messages.push(encode(&InMsg::Marker { id: MARKER_ID })?);
    let silence = vec![0.0f32; FRAME];
    for _ in 0..silence_frames() {
        messages.push(encode(&InMsg::Audio {
            pcm: silence.clone(),
        })?);
    }
    Ok(messages)
}

async fn connect(
    config: &ProviderConfig,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    TranscribeError,
> {
    let mut request = config
        .url
        .as_str()
        .into_client_request()
        .map_err(|e| TranscribeError::ProviderUnavailable(format!("{}: {e}", config.url)))?;
    let key = config.api_key.as_deref().unwrap_or(DEFAULT_KEY);
    let value = HeaderValue::from_str(key)
        .map_err(|e| TranscribeError::ProviderError(format!("api key: {e}")))?;
    request.headers_mut().insert(API_KEY_HEADER, value);
    let (socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| TranscribeError::ProviderUnavailable(format!("{}: {e}", config.url)))?;
    Ok(socket)
}

/// Transcribe a WAV clip, giving up after the same timeout the HTTP forwarder
/// uses.
pub async fn transcribe(config: &ProviderConfig, clip: &[u8]) -> Result<String, TranscribeError> {
    transcribe_within(config, clip, FORWARD_TIMEOUT).await
}

async fn transcribe_within(
    config: &ProviderConfig,
    clip: &[u8],
    timeout: Duration,
) -> Result<String, TranscribeError> {
    if clip.is_empty() {
        return Ok(String::new());
    }
    let pcm =
        crate::wav::decode_to_mono(clip, SAMPLE_RATE).map_err(TranscribeError::ProviderError)?;
    tokio::time::timeout(timeout, stream(config, &pcm))
        .await
        .map_err(|_| {
            TranscribeError::ProviderUnavailable(format!(
                "{} did not finish the clip within {}s",
                config.url,
                timeout.as_secs()
            ))
        })?
}

async fn stream(config: &ProviderConfig, pcm: &[f32]) -> Result<String, TranscribeError> {
    let messages = outgoing(pcm)?;
    let (mut sink, mut source) = connect(config).await?.split();

    let send = async move {
        for message in messages {
            sink.send(message)
                .await
                .map_err(|e| TranscribeError::NetworkError(e.to_string()))?;
        }
        Ok::<_, TranscribeError>(sink)
    };

    let receive = async move {
        let mut words = Vec::new();
        while let Some(message) = source.next().await {
            let message = message.map_err(|e| TranscribeError::NetworkError(e.to_string()))?;
            let Message::Binary(bytes) = message else {
                continue;
            };
            let decoded: OutMsg = rmp_serde::from_slice(&bytes)
                .map_err(|e| TranscribeError::ProviderError(format!("decoding a message: {e}")))?;
            match decoded {
                OutMsg::Word { text } => words.push(text),
                OutMsg::Marker { id } if id == MARKER_ID => return Ok(words.join(" ")),
                OutMsg::Error { message } => return Err(TranscribeError::ProviderError(message)),
                OutMsg::Marker { .. } | OutMsg::Other => {}
            }
        }
        Err(TranscribeError::ProviderError(
            "moshi-server closed the stream before the clip finished".to_string(),
        ))
    };

    let (sent, text) = tokio::join!(send, receive);
    let text = text?;
    if let Ok(mut sink) = sent {
        let _ = sink.close().await;
    }
    Ok(text.trim().to_string())
}

/// Whether moshi-server accepts the websocket with the configured key.
pub async fn probe(config: &ProviderConfig) -> bool {
    matches!(
        tokio::time::timeout(PROBE_TIMEOUT, connect(config)).await,
        Ok(Ok(_))
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
    use axum::http::HeaderMap;
    use axum::routing::get;
    use axum::Router;
    use std::sync::{Arc, Mutex};

    #[derive(Debug, Deserialize)]
    #[serde(tag = "type")]
    enum Seen {
        Audio { pcm: Vec<f32> },
        Marker { id: i64 },
    }

    #[derive(Serialize)]
    #[serde(tag = "type")]
    enum Reply {
        Ready,
        Word { text: String, start_time: f64 },
        EndWord { stop_time: f64 },
        Marker { id: i64 },
    }

    fn wav16k(samples: usize) -> Vec<u8> {
        let data_len = (samples * 2) as u32;
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_len).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&16_000u32.to_le_bytes());
        out.extend_from_slice(&32_000u32.to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_len.to_le_bytes());
        out.resize(out.len() + data_len as usize, 0);
        out
    }

    #[test]
    fn a_browser_clip_is_resampled_to_24k() {
        let pcm = crate::wav::decode_to_mono(&wav16k(16_000), SAMPLE_RATE).unwrap();
        assert_eq!(pcm.len(), 24_000);
    }

    #[test]
    fn frames_are_one_model_step_and_the_last_is_padded() {
        let pcm = vec![0.5f32; FRAME * 2 + 10];
        let frames = frames(&pcm);
        assert_eq!(frames.len(), 3);
        assert!(frames.iter().all(|f| f.len() == FRAME));
        assert_eq!(frames[2][9], 0.5);
        assert_eq!(frames[2][10], 0.0);
    }

    #[test]
    fn the_marker_follows_the_audio_and_silence_follows_the_marker() {
        let messages = outgoing(&vec![0.1f32; FRAME]).unwrap();
        let decoded: Vec<Seen> = messages
            .iter()
            .map(|m| match m {
                Message::Binary(bytes) => rmp_serde::from_slice(bytes).unwrap(),
                other => panic!("not binary: {other:?}"),
            })
            .collect();
        assert!(matches!(&decoded[0], Seen::Audio { pcm } if pcm[0] == 0.1));
        assert!(matches!(decoded[1], Seen::Marker { id: 0 }));
        assert_eq!(decoded.len(), 2 + silence_frames());
        assert!(decoded[2..]
            .iter()
            .all(|m| matches!(m, Seen::Audio { pcm } if pcm.iter().all(|s| *s == 0.0))));
    }

    async fn serve(app: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("ws://{addr}{PATH}")
    }

    fn reply(message: &Reply) -> WsMessage {
        WsMessage::Binary(rmp_serde::to_vec_named(message).unwrap().into())
    }

    async fn answer(mut socket: WebSocket, frames: Arc<Mutex<usize>>) {
        let _ = socket.send(reply(&Reply::Ready)).await;
        while let Some(Ok(message)) = socket.recv().await {
            let WsMessage::Binary(bytes) = message else {
                continue;
            };
            match rmp_serde::from_slice::<Seen>(&bytes).unwrap() {
                Seen::Audio { pcm } => {
                    assert_eq!(pcm.len(), FRAME);
                    *frames.lock().unwrap() += 1;
                }
                Seen::Marker { id } => {
                    for (i, word) in ["hello", "world"].iter().enumerate() {
                        let word = Reply::Word {
                            text: word.to_string(),
                            start_time: i as f64,
                        };
                        socket.send(reply(&word)).await.unwrap();
                        let end = Reply::EndWord {
                            stop_time: i as f64 + 0.5,
                        };
                        socket.send(reply(&end)).await.unwrap();
                    }
                    socket.send(reply(&Reply::Marker { id })).await.unwrap();
                }
            }
        }
    }

    #[tokio::test]
    async fn words_are_joined_until_the_marker_returns() {
        let frames = Arc::new(Mutex::new(0usize));
        let key = Arc::new(Mutex::new(String::new()));
        let app = Router::new().route(
            PATH,
            get({
                let frames = frames.clone();
                let key = key.clone();
                move |headers: HeaderMap, ws: WebSocketUpgrade| async move {
                    *key.lock().unwrap() = headers
                        .get(API_KEY_HEADER)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or_default()
                        .to_string();
                    ws.on_upgrade(move |socket| answer(socket, frames))
                }
            }),
        );
        let url = serve(app).await;
        let config = ProviderConfig {
            url,
            model: "stt-1b-en_fr".to_string(),
            api_key: None,
        };
        let text = transcribe(&config, &wav16k(16_000)).await.unwrap();
        assert_eq!(text, "hello world");
        assert_eq!(key.lock().unwrap().as_str(), DEFAULT_KEY);
        assert!(*frames.lock().unwrap() >= 24_000 / FRAME);
        assert!(probe(&config).await);
    }

    #[tokio::test]
    async fn a_server_that_never_answers_times_out() {
        let app = Router::new().route(
            PATH,
            get(|ws: WebSocketUpgrade| async move {
                ws.on_upgrade(
                    |mut socket| async move { while let Some(Ok(_)) = socket.recv().await {} },
                )
            }),
        );
        let url = serve(app).await;
        let config = ProviderConfig {
            url,
            model: String::new(),
            api_key: Some("secret".to_string()),
        };
        let started = std::time::Instant::now();
        let result = transcribe_within(&config, &wav16k(1600), Duration::from_secs(1)).await;
        assert!(
            matches!(result, Err(TranscribeError::ProviderUnavailable(_))),
            "{result:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[tokio::test]
    async fn an_unreachable_server_probes_false() {
        let config = ProviderConfig {
            url: format!("ws://127.0.0.1:19998{PATH}"),
            model: String::new(),
            api_key: None,
        };
        assert!(!probe(&config).await);
    }
}
