//! Speech providers: the `stt` and `tts` blocks of `config.json` are the one
//! store for them. Every request reads the file, so a hand edit applies without
//! a restart, and every Settings save writes it through [`ConfigFile`].

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::config::{self, SttConfig, SttProvider, TtsConfig, TtsProvider};
use crate::config_file::{ConfigFile, EditError};
use crate::db;

/// The speech-to-text kinds Settings offers, in the order it lists them.
pub const STT_KINDS: &[&str] = &["local", "network", "openai", "mistral", "kyutai"];

/// The text-to-speech kinds Settings offers, in the order it lists them.
pub const TTS_KINDS: &[&str] = &["local", "mistral", "network", "kyutai"];

pub fn stt_default(kind: &str) -> SttProvider {
    let provider = |host: &str, port: &str, model: &str| SttProvider {
        host: host.to_string(),
        port: port.to_string(),
        model: model.to_string(),
        api_key: String::new(),
    };
    match kind {
        config::LOCAL_SPEECH_KIND => provider("", "", crate::local_stt::DEFAULT_MODEL),
        "openai" => provider("https://api.openai.com", "443", "whisper-1"),
        "mistral" => provider("https://api.mistral.ai", "443", "voxtral-mini-latest"),
        "kyutai" => provider("ws://localhost", "8080", "stt-1b-en_fr"),
        _ => provider("", "", "Systran/faster-whisper-base.en"),
    }
}

pub fn tts_default(kind: &str) -> TtsProvider {
    let provider = |host: &str, port: &str, model: &str, voice: &str| TtsProvider {
        host: host.to_string(),
        port: port.to_string(),
        model: model.to_string(),
        voice: voice.to_string(),
        api_key: String::new(),
    };
    match kind {
        "mistral" => provider(
            "https://api.mistral.ai",
            "443",
            "voxtral-mini-tts-2603",
            "en_paul_neutral",
        ),
        "network" => provider("", "", "mistralai/Voxtral-4B-TTS-2603", "casual_female"),
        "kyutai" => provider("http://localhost", "8000", "pocket-tts", "alba"),
        _ => provider("", "", "", ""),
    }
}

fn or_default(value: &str, default: String) -> String {
    if value.is_empty() {
        return default;
    }
    value.to_string()
}

/// A kind's settings as stated in the file, every empty field filled from that
/// kind's defaults.
pub fn stt_provider(stt: &SttConfig, kind: &str) -> SttProvider {
    let default = stt_default(kind);
    let Some(stated) = stt.providers.get(kind) else {
        return default;
    };
    SttProvider {
        host: or_default(&stated.host, default.host),
        port: or_default(&stated.port, default.port),
        model: or_default(&stated.model, default.model),
        api_key: stated.api_key.clone(),
    }
}

pub fn tts_provider(tts: &TtsConfig, kind: &str) -> TtsProvider {
    let default = tts_default(kind);
    let Some(stated) = tts.providers.get(kind) else {
        return default;
    };
    TtsProvider {
        host: or_default(&stated.host, default.host),
        port: or_default(&stated.port, default.port),
        model: or_default(&stated.model, default.model),
        voice: or_default(&stated.voice, default.voice),
        api_key: stated.api_key.clone(),
    }
}

/// `scheme://host:port`, `http://` when the host names no scheme. Empty when
/// there is no host.
pub fn base_url(host: &str, port: &str) -> String {
    let host = host.trim().trim_end_matches('/');
    if host.is_empty() {
        return String::new();
    }
    let with_scheme = if host.contains("://") {
        host.to_string()
    } else {
        format!("http://{host}")
    };
    let port = port.trim();
    if port.is_empty() {
        return with_scheme;
    }
    format!("{with_scheme}:{port}")
}

/// Where a speech-to-text kind is reached: the websocket for Kyutai, the
/// OpenAI-shaped transcription route for every other remote kind.
pub fn stt_url(kind: &str, provider: &SttProvider) -> String {
    let base = base_url(&provider.host, &provider.port);
    if base.is_empty() {
        return base;
    }
    if kind == "kyutai" {
        return format!("{base}{}", crate::kyutai_stt::PATH);
    }
    format!("{base}/v1/audio/transcriptions")
}

/// One kind as `GET /api/settings/*` shows it: everything but the key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SttProviderView {
    pub host: String,
    pub port: String,
    pub model: String,
    pub has_key: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TtsProviderView {
    pub host: String,
    pub port: String,
    pub model: String,
    pub voice: String,
    pub has_key: bool,
}

pub fn stt_views(stt: &SttConfig) -> BTreeMap<String, SttProviderView> {
    let mut kinds: Vec<String> = STT_KINDS.iter().map(|k| k.to_string()).collect();
    kinds.extend(stt.providers.keys().cloned());
    kinds
        .into_iter()
        .map(|kind| {
            let p = stt_provider(stt, &kind);
            let view = SttProviderView {
                host: p.host,
                port: p.port,
                model: p.model,
                has_key: !p.api_key.is_empty(),
            };
            (kind, view)
        })
        .collect()
}

pub fn tts_views(tts: &TtsConfig) -> BTreeMap<String, TtsProviderView> {
    let mut kinds: Vec<String> = TTS_KINDS.iter().map(|k| k.to_string()).collect();
    kinds.extend(tts.providers.keys().cloned());
    kinds
        .into_iter()
        .map(|kind| {
            let p = tts_provider(tts, &kind);
            let view = TtsProviderView {
                host: p.host,
                port: p.port,
                model: p.model,
                voice: p.voice,
                has_key: !p.api_key.is_empty(),
            };
            (kind, view)
        })
        .collect()
}

/// `PUT /api/settings/stt`: one kind's settings, made active. An absent or
/// empty `api_key` keeps the stored one.
#[derive(Debug, Clone, Deserialize)]
pub struct SttChange {
    pub kind: String,
    pub host: String,
    pub port: String,
    pub model: String,
    #[serde(default)]
    pub api_key: Option<String>,
}

/// `PUT /api/settings/tts`, the same rules as [`SttChange`].
#[derive(Debug, Clone, Deserialize)]
pub struct TtsChange {
    pub kind: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub voice: String,
    #[serde(default)]
    pub api_key: Option<String>,
}

fn kept_key(new: Option<String>, stored: Option<&String>) -> String {
    match new.filter(|key| !key.is_empty()) {
        Some(key) => key,
        None => stored.cloned().unwrap_or_default(),
    }
}

fn check_kind(kind: &str) -> Result<(), EditError> {
    let valid = !kind.is_empty()
        && kind
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if valid {
        return Ok(());
    }
    Err(EditError::Invalid(format!(
        "kind: `{kind}` must be letters, digits, `-` and `_`"
    )))
}

pub struct SpeechSettings {
    file: Arc<ConfigFile>,
}

impl SpeechSettings {
    pub fn new(file: Arc<ConfigFile>) -> Self {
        SpeechSettings { file }
    }

    pub fn stt(&self) -> Result<SttConfig, String> {
        self.file
            .read()
            .map(|config| config.stt)
            .map_err(|e| e.to_string())
    }

    pub fn tts(&self) -> Result<TtsConfig, String> {
        self.file
            .read()
            .map(|config| config.tts)
            .map_err(|e| e.to_string())
    }

    pub async fn set_stt(&self, change: SttChange) -> Result<(), EditError> {
        check_kind(&change.kind)?;
        self.file
            .edit_with(|current| {
                let mut providers = current.stt.providers.clone();
                let api_key = kept_key(
                    change.api_key,
                    providers.get(&change.kind).map(|p| &p.api_key),
                );
                providers.insert(
                    change.kind.clone(),
                    SttProvider {
                        host: change.host,
                        port: change.port,
                        model: change.model,
                        api_key,
                    },
                );
                vec![
                    ("stt", "active", serde_json::json!(change.kind)),
                    ("stt", "providers", serde_json::json!(providers)),
                ]
            })
            .await
    }

    pub async fn set_tts(&self, change: TtsChange) -> Result<(), EditError> {
        check_kind(&change.kind)?;
        self.file
            .edit_with(|current| {
                let mut providers = current.tts.providers.clone();
                let api_key = kept_key(
                    change.api_key,
                    providers.get(&change.kind).map(|p| &p.api_key),
                );
                providers.insert(
                    change.kind.clone(),
                    TtsProvider {
                        host: change.host,
                        port: change.port,
                        model: change.model,
                        voice: change.voice,
                        api_key,
                    },
                );
                vec![
                    ("tts", "active", serde_json::json!(change.kind)),
                    ("tts", "providers", serde_json::json!(providers)),
                ]
            })
            .await
    }

    /// Copy the speech-to-text settings sqlite used to hold into a file that
    /// states no `stt` block. Runs at startup; once the block is written the
    /// rows are never read again.
    pub async fn adopt_stored_stt(&self, db: &db::Db) -> Result<bool, String> {
        let stated = self
            .file
            .read_partial()
            .map_err(|e| e.to_string())?
            .and_then(|partial| partial.stt)
            .is_some();
        if stated {
            return Ok(false);
        }
        let Some(stored) = stored_stt(db).map_err(|e| format!("{e:#}"))? else {
            return Ok(false);
        };
        self.file
            .edit(&[
                ("stt", "active", serde_json::json!(stored.active)),
                ("stt", "providers", serde_json::json!(stored.providers)),
            ])
            .await
            .map_err(|e| match e {
                EditError::Invalid(message) | EditError::Io(message) => message,
            })?;
        Ok(true)
    }
}

/// What sqlite holds, as the `stt` block. `None` when nothing was ever saved.
fn stored_stt(db: &db::Db) -> anyhow::Result<Option<SttConfig>> {
    let active = db.stt_saved_active_kind()?;
    let rows = db.stt_saved_providers()?;
    if active.is_none() && rows.is_empty() {
        return Ok(None);
    }
    let providers = rows
        .into_iter()
        .map(|row| {
            let provider = SttProvider {
                host: row.host,
                port: row.port,
                model: row.model,
                api_key: row.api_key.unwrap_or_default(),
            };
            (row.kind, provider)
        })
        .collect();
    Ok(Some(SttConfig {
        active: active.unwrap_or_else(|| config::LOCAL_SPEECH_KIND.to_string()),
        providers,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config_file::read_optional;

    struct Fixture {
        dir: tempfile::TempDir,
        speech: SpeechSettings,
    }

    fn fixture(initial: Option<&str>) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(config::CONFIG_FILE_NAME);
        if let Some(initial) = initial {
            std::fs::write(&path, initial).unwrap();
        }
        let speech = SpeechSettings::new(Arc::new(ConfigFile::new(path)));
        Fixture { dir, speech }
    }

    impl Fixture {
        fn document(&self) -> serde_json::Value {
            let raw = read_optional(&self.dir.path().join(config::CONFIG_FILE_NAME))
                .unwrap()
                .expect("the file exists");
            serde_json::from_str(&raw).unwrap()
        }
    }

    fn change(kind: &str, key: Option<&str>) -> SttChange {
        SttChange {
            kind: kind.to_string(),
            host: "https://api.mistral.ai".to_string(),
            port: "443".to_string(),
            model: "voxtral-mini-latest".to_string(),
            api_key: key.map(str::to_string),
        }
    }

    #[tokio::test]
    async fn a_saved_kind_lands_in_the_file_and_becomes_active() {
        let f = fixture(Some(r#"{"server": {"port": 5151}}"#));
        f.speech
            .set_stt(change("mistral", Some("sk-1")))
            .await
            .unwrap();
        let doc = f.document();
        assert_eq!(doc["server"]["port"], 5151);
        assert_eq!(doc["stt"]["active"], "mistral");
        assert_eq!(doc["stt"]["providers"]["mistral"]["api_key"], "sk-1");
    }

    #[tokio::test]
    async fn an_empty_key_keeps_the_stored_one() {
        let f = fixture(None);
        f.speech
            .set_stt(change("mistral", Some("sk-1")))
            .await
            .unwrap();
        f.speech.set_stt(change("mistral", Some(""))).await.unwrap();
        f.speech.set_stt(change("mistral", None)).await.unwrap();
        let stt = f.speech.stt().unwrap();
        assert_eq!(stt.providers["mistral"].api_key, "sk-1");
    }

    #[tokio::test]
    async fn saving_one_kind_keeps_the_others() {
        let f = fixture(None);
        f.speech
            .set_stt(change("mistral", Some("sk-1")))
            .await
            .unwrap();
        f.speech.set_stt(change("network", None)).await.unwrap();
        let stt = f.speech.stt().unwrap();
        assert_eq!(stt.active, "network");
        assert_eq!(stt.providers["mistral"].api_key, "sk-1");
    }

    #[tokio::test]
    async fn a_kind_that_is_not_a_name_is_refused() {
        let f = fixture(None);
        let refused = f.speech.set_stt(change("../x", None)).await;
        assert!(matches!(refused, Err(EditError::Invalid(_))));
    }

    #[test]
    fn a_hand_edit_is_read_on_the_next_call() {
        let f = fixture(Some(r#"{"stt": {"active": "openai"}}"#));
        assert_eq!(f.speech.stt().unwrap().active, "openai");
        std::fs::write(
            f.dir.path().join(config::CONFIG_FILE_NAME),
            r#"{"stt": {"active": "kyutai"}}"#,
        )
        .unwrap();
        assert_eq!(f.speech.stt().unwrap().active, "kyutai");
    }

    #[test]
    fn empty_fields_take_the_kind_defaults_and_the_view_hides_the_key() {
        let stt: SttConfig = serde_json::from_str(
            r#"{"active": "mistral", "providers": {"mistral": {"api_key": "sk-1"}}}"#,
        )
        .unwrap();
        let views = stt_views(&stt);
        assert_eq!(views["mistral"].host, "https://api.mistral.ai");
        assert_eq!(views["mistral"].model, "voxtral-mini-latest");
        assert!(views["mistral"].has_key);
        assert!(!views["openai"].has_key);
        for kind in STT_KINDS {
            assert!(views.contains_key(*kind), "{kind}");
        }
        let json = serde_json::to_string(&views).unwrap();
        assert!(!json.contains("sk-1"), "{json}");
    }

    #[tokio::test]
    async fn tts_saves_follow_the_same_rules() {
        let f = fixture(None);
        let tts = |key: Option<&str>| TtsChange {
            kind: "kyutai".to_string(),
            host: "http://pocket".to_string(),
            port: "8000".to_string(),
            model: String::new(),
            voice: "alba".to_string(),
            api_key: key.map(str::to_string),
        };
        f.speech.set_tts(tts(Some("k"))).await.unwrap();
        f.speech.set_tts(tts(None)).await.unwrap();
        let stored = f.speech.tts().unwrap();
        assert_eq!(stored.active, "kyutai");
        assert_eq!(stored.providers["kyutai"].api_key, "k");
        assert_eq!(tts_provider(&stored, "kyutai").model, "pocket-tts");
        assert!(!serde_json::to_string(&tts_views(&stored))
            .unwrap()
            .contains("\"k\""));
    }

    fn db_with_rows() -> (tempfile::TempDir, db::Db) {
        let dir = tempfile::tempdir().unwrap();
        let db = db::Db::open(&dir.path().join("mobux.db")).unwrap();
        db.set_stt_provider(db::SttProviderRow {
            kind: "openai".to_string(),
            host: "https://api.openai.com".to_string(),
            port: "443".to_string(),
            model: "whisper-1".to_string(),
            api_key: Some("sk-old".to_string()),
        })
        .unwrap();
        db.set_stt_active_kind("openai").unwrap();
        (dir, db)
    }

    #[tokio::test]
    async fn stored_rows_are_copied_into_a_file_without_an_stt_block_once() {
        let (_db_dir, db) = db_with_rows();
        let f = fixture(Some(r#"{"mcp": {"port": 8415}}"#));
        assert!(f.speech.adopt_stored_stt(&db).await.unwrap());
        let doc = f.document();
        assert_eq!(doc["mcp"]["port"], 8415);
        assert_eq!(doc["stt"]["active"], "openai");
        assert_eq!(doc["stt"]["providers"]["openai"]["api_key"], "sk-old");

        db.set_stt_active_kind("network").unwrap();
        assert!(!f.speech.adopt_stored_stt(&db).await.unwrap());
        assert_eq!(f.speech.stt().unwrap().active, "openai");
    }

    #[tokio::test]
    async fn a_stated_stt_block_is_never_overwritten() {
        let (_db_dir, db) = db_with_rows();
        let f = fixture(Some(r#"{"stt": {"active": "mistral"}}"#));
        assert!(!f.speech.adopt_stored_stt(&db).await.unwrap());
        assert_eq!(f.speech.stt().unwrap().active, "mistral");
    }

    #[tokio::test]
    async fn nothing_stored_writes_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let db = db::Db::open(&dir.path().join("mobux.db")).unwrap();
        let f = fixture(None);
        assert!(!f.speech.adopt_stored_stt(&db).await.unwrap());
        assert!(read_optional(&f.dir.path().join(config::CONFIG_FILE_NAME))
            .unwrap()
            .is_none());
    }

    #[test]
    fn urls_carry_the_route_each_kind_speaks() {
        let kyutai = stt_default("kyutai");
        assert_eq!(
            stt_url("kyutai", &kyutai),
            "ws://localhost:8080/api/asr-streaming"
        );
        let mistral = stt_default("mistral");
        assert_eq!(
            stt_url("mistral", &mistral),
            "https://api.mistral.ai:443/v1/audio/transcriptions"
        );
        assert_eq!(base_url("lab", ""), "http://lab");
        assert_eq!(stt_url("network", &stt_default("network")), "");
    }
}
