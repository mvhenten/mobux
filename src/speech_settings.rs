//! Speech providers: the `stt` and `tts` blocks of `config.json` are the one
//! store for them. Every request reads the file, so a hand edit applies without
//! a restart, and every Settings save writes it through [`ConfigFile`].

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::config::{self, SpeechConfig, SttKind, SttProvider, TtsKind, TtsProvider};
use crate::config_file::{ConfigFile, EditError};
use crate::db;

/// What the `stt` and `tts` blocks share, so each operation has one copy.
pub trait SpeechProvider:
    Clone + Default + Serialize + DeserializeOwned + Send + Sync + 'static
{
    type Kind: Copy + Ord + Default + Serialize + DeserializeOwned + Send + Sync + 'static;
    const BLOCK: &'static str;
    const KINDS: &'static [Self::Kind];
    fn block(config: &config::Config) -> &SpeechConfig<Self::Kind, Self>;
    fn default_for(kind: Self::Kind) -> Self;
    /// Every empty field taken from `default`; the key is kept as stated.
    fn filled(&self, default: Self) -> Self;
    fn api_key(&self) -> &str;
    fn set_api_key(&mut self, key: String);
}

fn or_default(value: &str, default: String) -> String {
    if value.is_empty() {
        return default;
    }
    value.to_string()
}

impl SpeechProvider for SttProvider {
    type Kind = SttKind;
    const BLOCK: &'static str = "stt";
    const KINDS: &'static [SttKind] = &SttKind::ALL;

    fn block(config: &config::Config) -> &SpeechConfig<SttKind, Self> {
        &config.stt
    }

    fn default_for(kind: SttKind) -> Self {
        let provider = |host: &str, port: &str, model: &str| SttProvider {
            host: host.to_string(),
            port: port.to_string(),
            model: model.to_string(),
            api_key: String::new(),
        };
        match kind {
            SttKind::Local => provider("", "", crate::local_stt::DEFAULT_MODEL),
            SttKind::Network => provider("", "", "Systran/faster-whisper-base.en"),
            SttKind::Openai => provider("https://api.openai.com", "443", "whisper-1"),
            SttKind::Mistral => provider("https://api.mistral.ai", "443", "voxtral-mini-latest"),
            SttKind::Kyutai => provider("ws://localhost", "8080", "stt-1b-en_fr"),
        }
    }

    fn filled(&self, default: Self) -> Self {
        SttProvider {
            host: or_default(&self.host, default.host),
            port: or_default(&self.port, default.port),
            model: or_default(&self.model, default.model),
            api_key: self.api_key.clone(),
        }
    }

    fn api_key(&self) -> &str {
        &self.api_key
    }

    fn set_api_key(&mut self, key: String) {
        self.api_key = key;
    }
}

impl SpeechProvider for TtsProvider {
    type Kind = TtsKind;
    const BLOCK: &'static str = "tts";
    const KINDS: &'static [TtsKind] = &TtsKind::ALL;

    fn block(config: &config::Config) -> &SpeechConfig<TtsKind, Self> {
        &config.tts
    }

    fn default_for(kind: TtsKind) -> Self {
        let provider = |host: &str, port: &str, model: &str, voice: &str| TtsProvider {
            host: host.to_string(),
            port: port.to_string(),
            model: model.to_string(),
            voice: voice.to_string(),
            api_key: String::new(),
        };
        match kind {
            TtsKind::Local => provider("", "", "", ""),
            TtsKind::Mistral => provider(
                "https://api.mistral.ai",
                "443",
                "voxtral-mini-tts-2603",
                "en_paul_neutral",
            ),
            TtsKind::Network => provider("", "", "mistralai/Voxtral-4B-TTS-2603", "casual_female"),
            TtsKind::Kyutai => provider("http://localhost", "8000", "pocket-tts", "alba"),
        }
    }

    fn filled(&self, default: Self) -> Self {
        TtsProvider {
            host: or_default(&self.host, default.host),
            port: or_default(&self.port, default.port),
            model: or_default(&self.model, default.model),
            voice: or_default(&self.voice, default.voice),
            api_key: self.api_key.clone(),
        }
    }

    fn api_key(&self) -> &str {
        &self.api_key
    }

    fn set_api_key(&mut self, key: String) {
        self.api_key = key;
    }
}

/// A kind's settings as stated in the file, every empty field filled from that
/// kind's defaults.
pub fn provider<P: SpeechProvider>(block: &SpeechConfig<P::Kind, P>, kind: P::Kind) -> P {
    let default = P::default_for(kind);
    match block.providers.get(&kind) {
        Some(stated) => stated.filled(default),
        None => default,
    }
}

/// Every kind as `GET /api/settings/*` shows it: the filled settings with
/// `has_key` in place of the key.
pub fn views<P: SpeechProvider>(
    block: &SpeechConfig<P::Kind, P>,
) -> BTreeMap<P::Kind, serde_json::Value> {
    P::KINDS
        .iter()
        .map(|&kind| {
            let filled = provider(block, kind);
            let has_key = !filled.api_key().is_empty();
            let mut view = serde_json::to_value(filled).expect("a provider serializes");
            let fields = view.as_object_mut().expect("a provider is an object");
            fields.remove("api_key");
            fields.insert("has_key".to_string(), has_key.into());
            (kind, view)
        })
        .collect()
}

/// `PUT /api/settings/{stt,tts}`: one kind's settings, made active. An absent
/// or empty `api_key` keeps the stored one.
#[derive(Debug, Clone, Deserialize)]
pub struct Change<K, P> {
    pub kind: K,
    #[serde(flatten)]
    pub provider: P,
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
pub fn stt_url(kind: SttKind, provider: &SttProvider) -> String {
    let base = base_url(&provider.host, &provider.port);
    if base.is_empty() {
        return base;
    }
    if kind == SttKind::Kyutai {
        return format!("{base}{}", crate::kyutai_stt::PATH);
    }
    format!("{base}/v1/audio/transcriptions")
}

pub struct SpeechSettings {
    file: Arc<ConfigFile>,
}

impl SpeechSettings {
    pub fn new(file: Arc<ConfigFile>) -> Self {
        SpeechSettings { file }
    }

    pub fn read<P: SpeechProvider>(&self) -> Result<SpeechConfig<P::Kind, P>, String> {
        self.file
            .read()
            .map(|config| P::block(&config).clone())
            .map_err(|e| e.to_string())
    }

    pub async fn set<P: SpeechProvider>(
        &self,
        change: Change<P::Kind, P>,
    ) -> Result<(), EditError> {
        self.file
            .edit_with(|current| {
                let mut providers = P::block(current).providers.clone();
                let mut provider = change.provider;
                if provider.api_key().is_empty() {
                    let stored = providers
                        .get(&change.kind)
                        .map(|p| p.api_key().to_string())
                        .unwrap_or_default();
                    provider.set_api_key(stored);
                }
                providers.insert(change.kind, provider);
                vec![
                    (P::BLOCK, "active", serde_json::json!(change.kind)),
                    (P::BLOCK, "providers", serde_json::json!(providers)),
                ]
            })
            .await
    }

    /// Copy the speech-to-text settings sqlite used to hold into a file that
    /// states no `stt` block, then clear the rows. Runs at startup.
    pub async fn adopt_stored_stt(&self, db: &db::Db) -> Result<bool, String> {
        let stated = config::load_partial_from(self.file.path())
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
            .edit_with(|_| {
                vec![
                    ("stt", "active", serde_json::json!(stored.active)),
                    ("stt", "providers", serde_json::json!(stored.providers)),
                ]
            })
            .await
            .map_err(|e| match e {
                EditError::Invalid(message) | EditError::Io(message) => message,
            })?;
        db.clear_stt_saved().map_err(|e| format!("{e:#}"))?;
        Ok(true)
    }
}

fn stt_kind(name: String) -> anyhow::Result<SttKind> {
    serde_json::from_value(serde_json::Value::String(name.clone()))
        .map_err(|_| anyhow::anyhow!("stored stt kind `{name}` is not one this build knows"))
}

/// What sqlite holds, as the `stt` block. `None` when nothing was ever saved.
fn stored_stt(db: &db::Db) -> anyhow::Result<Option<config::SttConfig>> {
    let active = db.stt_saved_active_kind()?;
    let rows = db.stt_saved_providers()?;
    if active.is_none() && rows.is_empty() {
        return Ok(None);
    }
    let mut providers = BTreeMap::new();
    for row in rows {
        let provider = SttProvider {
            host: row.host,
            port: row.port,
            model: row.model,
            api_key: row.api_key.unwrap_or_default(),
        };
        providers.insert(stt_kind(row.kind)?, provider);
    }
    Ok(Some(config::SttConfig {
        active: active.map(stt_kind).transpose()?.unwrap_or_default(),
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

        fn stt(&self) -> config::SttConfig {
            self.speech.read::<SttProvider>().unwrap()
        }
    }

    fn change(kind: SttKind, key: &str) -> Change<SttKind, SttProvider> {
        Change {
            kind,
            provider: SttProvider {
                host: "https://api.mistral.ai".to_string(),
                port: "443".to_string(),
                model: "voxtral-mini-latest".to_string(),
                api_key: key.to_string(),
            },
        }
    }

    #[tokio::test]
    async fn a_saved_kind_lands_in_the_file_and_becomes_active() {
        let f = fixture(Some(r#"{"server": {"port": 5151}}"#));
        f.speech
            .set(change(SttKind::Mistral, "sk-1"))
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
            .set(change(SttKind::Mistral, "sk-1"))
            .await
            .unwrap();
        f.speech.set(change(SttKind::Mistral, "")).await.unwrap();
        assert_eq!(f.stt().providers[&SttKind::Mistral].api_key, "sk-1");
    }

    #[tokio::test]
    async fn saving_one_kind_keeps_the_others() {
        let f = fixture(None);
        f.speech
            .set(change(SttKind::Mistral, "sk-1"))
            .await
            .unwrap();
        f.speech.set(change(SttKind::Network, "")).await.unwrap();
        let stt = f.stt();
        assert_eq!(stt.active, SttKind::Network);
        assert_eq!(stt.providers[&SttKind::Mistral].api_key, "sk-1");
    }

    #[test]
    fn a_put_body_names_the_kind_beside_the_fields() {
        let change: Change<TtsKind, TtsProvider> = serde_json::from_str(
            r#"{"kind": "kyutai", "host": "http://pocket", "port": "8000", "voice": "alba"}"#,
        )
        .unwrap();
        assert_eq!(change.kind, TtsKind::Kyutai);
        assert_eq!(change.provider.voice, "alba");
        assert_eq!(change.provider.api_key, "");
        assert!(
            serde_json::from_str::<Change<SttKind, SttProvider>>(r#"{"kind": "groq"}"#).is_err()
        );
    }

    #[test]
    fn a_hand_edit_is_read_on_the_next_call() {
        let f = fixture(Some(r#"{"stt": {"active": "openai"}}"#));
        assert_eq!(f.stt().active, SttKind::Openai);
        std::fs::write(
            f.dir.path().join(config::CONFIG_FILE_NAME),
            r#"{"stt": {"active": "kyutai"}}"#,
        )
        .unwrap();
        assert_eq!(f.stt().active, SttKind::Kyutai);
    }

    #[test]
    fn empty_fields_take_the_kind_defaults_and_the_view_hides_the_key() {
        let stt: config::SttConfig = serde_json::from_str(
            r#"{"active": "mistral", "providers": {"mistral": {"api_key": "sk-1"}}}"#,
        )
        .unwrap();
        let views = views(&stt);
        assert_eq!(views[&SttKind::Mistral]["host"], "https://api.mistral.ai");
        assert_eq!(views[&SttKind::Mistral]["model"], "voxtral-mini-latest");
        assert_eq!(views[&SttKind::Mistral]["has_key"], true);
        assert_eq!(views[&SttKind::Openai]["has_key"], false);
        assert_eq!(views.len(), SttKind::ALL.len());
        let json = serde_json::to_string(&views).unwrap();
        assert!(!json.contains("sk-1"), "{json}");
        assert!(!json.contains("api_key"), "{json}");
    }

    #[tokio::test]
    async fn tts_saves_follow_the_same_rules() {
        let f = fixture(None);
        let tts = |key: &str| Change {
            kind: TtsKind::Kyutai,
            provider: TtsProvider {
                host: "http://pocket".to_string(),
                port: "8000".to_string(),
                voice: "alba".to_string(),
                api_key: key.to_string(),
                ..TtsProvider::default()
            },
        };
        f.speech.set(tts("k")).await.unwrap();
        f.speech.set(tts("")).await.unwrap();
        let stored = f.speech.read::<TtsProvider>().unwrap();
        assert_eq!(stored.active, TtsKind::Kyutai);
        assert_eq!(stored.providers[&TtsKind::Kyutai].api_key, "k");
        assert_eq!(provider(&stored, TtsKind::Kyutai).model, "pocket-tts");
    }

    fn db_with_rows() -> (tempfile::TempDir, db::Db) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mobux.db");
        let db = db::Db::open(&path).unwrap();
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute_batch(
                "INSERT INTO stt_providers (kind, host, port, url, model, api_key)
                 VALUES ('openai', 'https://api.openai.com', '443', '', 'whisper-1', 'sk-old');
                 INSERT INTO stt_active_kind (id, kind) VALUES (1, 'openai');",
            )
            .unwrap();
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

        assert!(db.stt_saved_providers().unwrap().is_empty());
        assert_eq!(db.stt_saved_active_kind().unwrap(), None);

        std::fs::write(
            f.dir.path().join(config::CONFIG_FILE_NAME),
            r#"{"mcp": {"port": 8415}}"#,
        )
        .unwrap();
        assert!(!f.speech.adopt_stored_stt(&db).await.unwrap());
        assert_eq!(f.stt().active, SttKind::Local);
    }

    #[tokio::test]
    async fn a_stated_stt_block_is_never_overwritten() {
        let (_db_dir, db) = db_with_rows();
        let f = fixture(Some(r#"{"stt": {"active": "mistral"}}"#));
        assert!(!f.speech.adopt_stored_stt(&db).await.unwrap());
        assert_eq!(f.stt().active, SttKind::Mistral);
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
        let kyutai = SttProvider::default_for(SttKind::Kyutai);
        assert_eq!(
            stt_url(SttKind::Kyutai, &kyutai),
            "ws://localhost:8080/api/asr-streaming"
        );
        let mistral = SttProvider::default_for(SttKind::Mistral);
        assert_eq!(
            stt_url(SttKind::Mistral, &mistral),
            "https://api.mistral.ai:443/v1/audio/transcriptions"
        );
        assert_eq!(base_url("lab", ""), "http://lab");
        let network = SttProvider::default_for(SttKind::Network);
        assert_eq!(stt_url(SttKind::Network, &network), "");
    }
}
