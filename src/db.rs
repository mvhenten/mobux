//! SQLite-backed state for VAPID keys and Web Push subscriptions.
//!
//! See `docs/twa-push-implementation-plan.md` (Phase 2) for the design.
//! All API methods are sync; wrap in `tokio::task::spawn_blocking` when
//! invoked from an async context.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use p256::ecdsa::SigningKey;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// Raw VAPID keypair as stored in the database.
///
/// `public_key` is the 65-byte uncompressed P-256 SEC1 point (`0x04 || X || Y`).
/// `private_key` is the 32-byte big-endian scalar.
#[derive(Debug, Clone)]
pub struct VapidKeys {
    pub public_key: Vec<u8>,
    pub private_key: Vec<u8>,
}

/// A persisted Web Push subscription (read shape).
///
/// `endpoint`, `p256dh`, and `auth` are consumed by `push::notify`; the
/// `/api/push/devices` endpoint deliberately omits them, since the device-
/// management UI only needs identifiers, labels, and timestamps.
#[derive(Debug, Clone)]
pub struct Subscription {
    pub id: i64,
    pub endpoint: String,
    pub p256dh: Vec<u8>,
    pub auth: Vec<u8>,
    pub label: Option<String>,
    pub created_at: i64,
    pub last_seen_at: i64,
}

/// A configured fleet node (issue #176 phase 2): a human name and the `ssh`
/// target the hub dials to reach its tmux. The hub authenticates to nodes
/// with its own SSH keys — no browser credentials involved.
#[derive(Debug, Clone, Serialize)]
pub struct Node {
    pub name: String,
    pub target: String,
    pub created_at: i64,
}

/// New subscription payload for `insert_subscription`.
#[derive(Debug, Clone)]
pub struct NewSubscription {
    pub endpoint: String,
    pub p256dh: Vec<u8>,
    pub auth: Vec<u8>,
    pub label: Option<String>,
}

/// User-tunable notification preferences. Single row, id=1, in `notification_prefs`.
#[derive(Debug, Clone, Copy)]
pub struct NotificationPrefs {
    /// Notify on terminal BEL (`\x07`) in any session's PTY stream.
    pub bell: bool,
    /// Notify when the literal 🔔 (U+1F514) emoji appears in PTY output —
    /// useful when an LLM (or any tool) wants to ping you intentionally.
    pub bell_emoji: bool,
    /// Notify when a program exits (any exit code). Detected via OSC 133;D
    /// semantic-prompt sequences; requires the user's prompt to emit them
    /// (Starship, Powerlevel10k, or a custom PS1 — see docs).
    pub program_exit: bool,
    /// Notify only when a program exits with a non-zero status. Same
    /// requirement as `program_exit`.
    pub program_exit_nonzero: bool,
}

impl Default for NotificationPrefs {
    fn default() -> Self {
        // Bell + emoji are server-detectable now and on by default.
        // Exit-code prefs are off until the user installs the shell hook.
        Self {
            bell: true,
            bell_emoji: true,
            program_exit: false,
            program_exit_nonzero: false,
        }
    }
}

/// SQLite-backed state. Cheap to clone (`Arc` inside).
#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
}

impl Db {
    /// Open (or create) the database at `path` and ensure the schema exists.
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)
            .with_context(|| format!("opening sqlite db at {}", path.display()))?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS vapid_keys (
                id INTEGER PRIMARY KEY,
                public_key BLOB NOT NULL,
                private_key BLOB NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id INTEGER PRIMARY KEY,
                endpoint TEXT UNIQUE NOT NULL,
                p256dh BLOB NOT NULL,
                auth BLOB NOT NULL,
                label TEXT,
                created_at INTEGER NOT NULL,
                last_seen_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS notification_prefs (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                bell INTEGER NOT NULL,
                bell_emoji INTEGER NOT NULL,
                program_exit INTEGER NOT NULL,
                program_exit_nonzero INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS stt_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                kind TEXT NOT NULL,
                url TEXT NOT NULL,
                model TEXT NOT NULL,
                api_key TEXT,
                install_cmd TEXT,
                start_cmd TEXT,
                stop_cmd TEXT
            );

            -- Per-kind STT provider settings (one row per kind).
            -- host/port stored separately so the frontend can display them split.
            -- url is the full assembled URL (scheme://host:port/v1/audio/transcriptions).
            CREATE TABLE IF NOT EXISTS stt_providers (
                kind TEXT PRIMARY KEY,
                host TEXT NOT NULL DEFAULT '',
                port TEXT NOT NULL DEFAULT '',
                url  TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL DEFAULT '',
                api_key TEXT
            );

            -- Single-row table that tracks which provider kind is active.
            CREATE TABLE IF NOT EXISTS stt_active_kind (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                kind TEXT NOT NULL DEFAULT 'local'
            );

            -- Configured fleet nodes (issue #176 phase 2). target is
            -- whatever `ssh <target>` accepts (user@host, user@host:port,
            -- or an ssh_config alias) — validated at write time, not here.
            CREATE TABLE IF NOT EXISTS nodes (
                name TEXT PRIMARY KEY,
                target TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );",
        )
        .context("initializing sqlite schema")?;

        // Additive migration: add stop_cmd column to existing DBs that
        // were created before this field was introduced. SQLite ignores
        // duplicate column errors only through IF NOT EXISTS on indexes,
        // not columns, so we catch the error and treat it as a no-op.
        let _ = conn.execute_batch("ALTER TABLE stt_config ADD COLUMN stop_cmd TEXT;");

        // Migration: drop tables from the removed peer-relay feature
        // (mesh enumeration + TOFU cert pinning). DROP TABLE IF EXISTS is
        // always safe — the tables may not exist on fresh installs.
        let _ = conn.execute_batch(
            "DROP TABLE IF EXISTS peer_pins;
             DROP TABLE IF EXISTS mesh_settings;",
        );

        // Migrate legacy stt_config row into stt_providers + stt_active_kind
        // if not yet done (providers table empty).
        Self::migrate_stt_providers(conn)?;

        Ok(())
    }

    /// Migrate the legacy single-row `stt_config` into per-kind `stt_providers`.
    ///
    /// Only runs when `stt_providers` is empty, so it is safe to call on every
    /// startup — no-op once data has been migrated or written directly.
    fn migrate_stt_providers(conn: &Connection) -> Result<()> {
        // Check whether stt_providers already has any rows.
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM stt_providers", [], |r| r.get(0))
            .unwrap_or(0);
        if count > 0 {
            return Ok(());
        }

        // Try to read the legacy stt_config row.
        let row: Option<(String, String, String, Option<String>)> = conn
            .query_row(
                "SELECT kind, url, model, api_key FROM stt_config WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .unwrap_or(None);

        if let Some((kind, url, model, api_key)) = row {
            // Parse host/port from URL for the migrated row.
            let (host, port) = split_url_host_port(&url);
            let _ = conn.execute(
                "INSERT OR IGNORE INTO stt_providers (kind, host, port, url, model, api_key)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![kind, host, port, url, model, api_key],
            );
            let _ = conn.execute(
                "INSERT OR IGNORE INTO stt_active_kind (id, kind) VALUES (1, ?1)",
                params![kind],
            );
        }

        Ok(())
    }

    /// Return the existing VAPID keypair, generating + persisting one on first call.
    pub fn vapid_keys(&self) -> Result<VapidKeys> {
        let conn = self.lock_conn()?;

        let existing: Option<(Vec<u8>, Vec<u8>)> = conn
            .query_row(
                "SELECT public_key, private_key FROM vapid_keys ORDER BY id ASC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .context("reading vapid_keys")?;

        if let Some((public_key, private_key)) = existing {
            return Ok(VapidKeys {
                public_key,
                private_key,
            });
        }

        let keys = generate_vapid_keypair();
        let now = unix_seconds()?;
        conn.execute(
            "INSERT INTO vapid_keys (public_key, private_key, created_at) VALUES (?1, ?2, ?3)",
            params![keys.public_key, keys.private_key, now],
        )
        .context("inserting generated vapid keypair")?;

        Ok(keys)
    }

    /// List all push subscriptions, oldest first.
    pub fn list_subscriptions(&self) -> Result<Vec<Subscription>> {
        let conn = self.lock_conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, endpoint, p256dh, auth, label, created_at, last_seen_at
                 FROM push_subscriptions
                 ORDER BY id ASC",
            )
            .context("preparing list_subscriptions")?;

        let rows = stmt
            .query_map([], |row| {
                Ok(Subscription {
                    id: row.get(0)?,
                    endpoint: row.get(1)?,
                    p256dh: row.get(2)?,
                    auth: row.get(3)?,
                    label: row.get(4)?,
                    created_at: row.get(5)?,
                    last_seen_at: row.get(6)?,
                })
            })
            .context("executing list_subscriptions")?;

        let mut out: Vec<Subscription> = Vec::new();
        for row in rows {
            out.push(row.context("decoding subscription row")?);
        }
        Ok(out)
    }

    /// Insert a new subscription, or update an existing one (matched by endpoint).
    ///
    /// On conflict: refresh `last_seen_at`, refresh keys (the browser may rotate
    /// them on resubscribe), and update `label` only if a new one was supplied
    /// — preserve the previously-set label otherwise.
    pub fn insert_subscription(&self, sub: NewSubscription) -> Result<()> {
        let conn = self.lock_conn()?;
        let now = unix_seconds()?;
        conn.execute(
            "INSERT INTO push_subscriptions
                 (endpoint, p256dh, auth, label, created_at, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(endpoint) DO UPDATE SET
                 p256dh = excluded.p256dh,
                 auth = excluded.auth,
                 label = COALESCE(excluded.label, push_subscriptions.label),
                 last_seen_at = excluded.last_seen_at",
            params![sub.endpoint, sub.p256dh, sub.auth, sub.label, now],
        )
        .context("upserting push subscription")?;
        Ok(())
    }

    /// Read notification preferences. Returns the defaults (and persists them)
    /// if the row hasn't been written yet.
    pub fn notification_prefs(&self) -> Result<NotificationPrefs> {
        let conn = self.lock_conn()?;
        let row: Option<(i64, i64, i64, i64)> = conn
            .query_row(
                "SELECT bell, bell_emoji, program_exit, program_exit_nonzero
                 FROM notification_prefs WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .context("reading notification_prefs")?;

        if let Some((bell, bell_emoji, program_exit, program_exit_nonzero)) = row {
            return Ok(NotificationPrefs {
                bell: bell != 0,
                bell_emoji: bell_emoji != 0,
                program_exit: program_exit != 0,
                program_exit_nonzero: program_exit_nonzero != 0,
            });
        }

        let defaults = NotificationPrefs::default();
        conn.execute(
            "INSERT INTO notification_prefs
                 (id, bell, bell_emoji, program_exit, program_exit_nonzero)
             VALUES (1, ?1, ?2, ?3, ?4)",
            params![
                defaults.bell as i64,
                defaults.bell_emoji as i64,
                defaults.program_exit as i64,
                defaults.program_exit_nonzero as i64,
            ],
        )
        .context("inserting default notification_prefs")?;
        Ok(defaults)
    }

    /// Overwrite notification preferences. Upserts the single row.
    pub fn set_notification_prefs(&self, prefs: NotificationPrefs) -> Result<()> {
        let conn = self.lock_conn()?;
        conn.execute(
            "INSERT INTO notification_prefs
                 (id, bell, bell_emoji, program_exit, program_exit_nonzero)
             VALUES (1, ?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
                 bell = excluded.bell,
                 bell_emoji = excluded.bell_emoji,
                 program_exit = excluded.program_exit,
                 program_exit_nonzero = excluded.program_exit_nonzero",
            params![
                prefs.bell as i64,
                prefs.bell_emoji as i64,
                prefs.program_exit as i64,
                prefs.program_exit_nonzero as i64,
            ],
        )
        .context("upserting notification_prefs")?;
        Ok(())
    }

    /// Remove a subscription by endpoint. No-op if it doesn't exist.
    pub fn remove_subscription(&self, endpoint: &str) -> Result<()> {
        let conn = self.lock_conn()?;
        conn.execute(
            "DELETE FROM push_subscriptions WHERE endpoint = ?1",
            params![endpoint],
        )
        .context("deleting push subscription")?;
        Ok(())
    }

    /// List configured fleet nodes, oldest first.
    pub fn list_nodes(&self) -> Result<Vec<Node>> {
        let conn = self.lock_conn()?;
        let mut stmt = conn
            .prepare("SELECT name, target, created_at FROM nodes ORDER BY created_at ASC")
            .context("preparing list_nodes")?;

        let rows = stmt
            .query_map([], |row| {
                Ok(Node {
                    name: row.get(0)?,
                    target: row.get(1)?,
                    created_at: row.get(2)?,
                })
            })
            .context("executing list_nodes")?;

        let mut out: Vec<Node> = Vec::new();
        for row in rows {
            out.push(row.context("decoding node row")?);
        }
        Ok(out)
    }

    /// Look up a single node by name.
    pub fn get_node(&self, name: &str) -> Result<Option<Node>> {
        let conn = self.lock_conn()?;
        conn.query_row(
            "SELECT name, target, created_at FROM nodes WHERE name = ?1",
            params![name],
            |row| {
                Ok(Node {
                    name: row.get(0)?,
                    target: row.get(1)?,
                    created_at: row.get(2)?,
                })
            },
        )
        .optional()
        .context("reading node")
    }

    /// Replace the entire node list atomically (used by `PUT
    /// /api/settings/nodes`, which is a full-list replace, not a patch).
    pub fn replace_nodes(&self, nodes: Vec<(String, String)>) -> Result<()> {
        let mut conn = self.lock_conn()?;
        let now = unix_seconds()?;
        let tx = conn.transaction().context("starting nodes transaction")?;
        tx.execute("DELETE FROM nodes", [])
            .context("clearing nodes")?;
        for (name, target) in nodes {
            tx.execute(
                "INSERT INTO nodes (name, target, created_at) VALUES (?1, ?2, ?3)",
                params![name, target, now],
            )
            .context("inserting node")?;
        }
        tx.commit().context("committing nodes transaction")?;
        Ok(())
    }

    /// Read STT provider config. Seeds defaults and persists them on first call.
    pub fn stt_config(&self) -> Result<SttConfig> {
        let conn = self.lock_conn()?;
        type Row = (
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        );
        // stop_cmd may not exist in older DBs (schema migration adds column
        // lazily via ALTER TABLE on first write); use COALESCE-fallback select.
        let row: Option<Row> = conn
            .query_row(
                "SELECT kind, url, model, api_key, install_cmd, start_cmd, stop_cmd FROM stt_config WHERE id = 1",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .optional()
            .context("reading stt_config")?;

        if let Some((kind, url, model, api_key, install_cmd, start_cmd, stop_cmd)) = row {
            return Ok(SttConfig {
                kind,
                url,
                model,
                api_key,
                install_cmd,
                start_cmd,
                stop_cmd,
            });
        }

        let defaults = SttConfig::default();
        conn.execute(
            "INSERT INTO stt_config (id, kind, url, model, api_key, install_cmd, start_cmd, stop_cmd)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                defaults.kind,
                defaults.url,
                defaults.model,
                defaults.api_key,
                defaults.install_cmd,
                defaults.start_cmd,
                defaults.stop_cmd
            ],
        )
        .context("inserting default stt_config")?;
        Ok(defaults)
    }

    /// Overwrite STT provider config. Upserts the single row.
    pub fn set_stt_config(&self, cfg: SttConfig) -> Result<()> {
        let conn = self.lock_conn()?;
        conn.execute(
            "INSERT INTO stt_config (id, kind, url, model, api_key, install_cmd, start_cmd, stop_cmd)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
                 kind = excluded.kind,
                 url = excluded.url,
                 model = excluded.model,
                 api_key = excluded.api_key,
                 install_cmd = excluded.install_cmd,
                 start_cmd = excluded.start_cmd,
                 stop_cmd = excluded.stop_cmd",
            params![
                cfg.kind,
                cfg.url,
                cfg.model,
                cfg.api_key,
                cfg.install_cmd,
                cfg.start_cmd,
                cfg.stop_cmd
            ],
        )
        .context("upserting stt_config")?;
        Ok(())
    }

    /// Return the active STT kind ("local", "network", or "openai").
    /// Defaults to "local" if never set.
    pub fn stt_active_kind(&self) -> Result<String> {
        let conn = self.lock_conn()?;
        let kind: Option<String> = conn
            .query_row("SELECT kind FROM stt_active_kind WHERE id = 1", [], |r| {
                r.get(0)
            })
            .optional()
            .context("reading stt_active_kind")?;
        Ok(kind.unwrap_or_else(|| "local".to_string()))
    }

    /// Set the active STT kind.
    pub fn set_stt_active_kind(&self, kind: &str) -> Result<()> {
        let conn = self.lock_conn()?;
        conn.execute(
            "INSERT INTO stt_active_kind (id, kind) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET kind = excluded.kind",
            params![kind],
        )
        .context("upserting stt_active_kind")?;
        Ok(())
    }

    /// Return a single provider's settings, or None if never saved.
    pub fn stt_provider(&self, kind: &str) -> Result<Option<SttProviderRow>> {
        let conn = self.lock_conn()?;
        let row: Option<(String, String, String, String, Option<String>)> = conn
            .query_row(
                "SELECT kind, host, port, model, api_key FROM stt_providers WHERE kind = ?1",
                params![kind],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()
            .context("reading stt_provider")?;
        Ok(
            row.map(|(kind, host, port, model, api_key)| SttProviderRow {
                kind,
                host,
                port,
                model,
                api_key,
            }),
        )
    }

    /// Return all three provider rows (inserting defaults for any that don't exist yet).
    pub fn stt_all_providers(&self) -> Result<[SttProviderRow; 3]> {
        let kinds = ["local", "network", "openai"];
        let mut out = [
            SttProviderRow::default_for("local"),
            SttProviderRow::default_for("network"),
            SttProviderRow::default_for("openai"),
        ];
        let conn = self.lock_conn()?;
        for (i, kind) in kinds.iter().enumerate() {
            let row: Option<(String, String, String, Option<String>)> = conn
                .query_row(
                    "SELECT host, port, model, api_key FROM stt_providers WHERE kind = ?1",
                    params![kind],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()
                .context("reading stt_providers")?;
            if let Some((host, port, model, api_key)) = row {
                out[i] = SttProviderRow {
                    kind: kind.to_string(),
                    host,
                    port,
                    model,
                    api_key,
                };
            }
        }
        Ok(out)
    }

    /// Upsert per-kind provider settings. Empty api_key keeps the existing stored key.
    pub fn set_stt_provider(&self, row: SttProviderRow) -> Result<()> {
        // Preserve existing api_key when none supplied.
        let api_key = if row.api_key.as_deref().is_some_and(|k| !k.is_empty()) {
            row.api_key
        } else {
            let conn = self.lock_conn()?;
            let existing: Option<Option<String>> = conn
                .query_row(
                    "SELECT api_key FROM stt_providers WHERE kind = ?1",
                    params![row.kind],
                    |r| r.get(0),
                )
                .optional()
                .context("reading existing api_key")?;
            drop(conn);
            existing.flatten()
        };

        let url = build_url(&row.host, &row.port);
        let conn = self.lock_conn()?;
        conn.execute(
            "INSERT INTO stt_providers (kind, host, port, url, model, api_key)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(kind) DO UPDATE SET
                 host    = excluded.host,
                 port    = excluded.port,
                 url     = excluded.url,
                 model   = excluded.model,
                 api_key = excluded.api_key",
            params![row.kind, row.host, row.port, url, row.model, api_key],
        )
        .context("upserting stt_provider")?;
        Ok(())
    }

    fn lock_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| anyhow!("db connection mutex poisoned"))
    }
}

/// STT provider configuration. Single row, id=1.
#[derive(Debug, Clone)]
pub struct SttConfig {
    pub kind: String, // "local", "network", "openai"
    pub url: String,
    pub model: String,
    pub api_key: Option<String>,
    pub install_cmd: Option<String>,
    pub start_cmd: Option<String>,
    pub stop_cmd: Option<String>,
}

impl Default for SttConfig {
    fn default() -> Self {
        Self {
            kind: "local".to_string(),
            url: "http://127.0.0.1:5200/v1/audio/transcriptions".to_string(),
            model: "Systran/faster-whisper-small".to_string(),
            api_key: None,
            install_cmd: Some(crate::stt_scripts::INSTALL_SCRIPT.to_string()),
            start_cmd: Some(crate::stt_scripts::SERVE_SCRIPT.to_string()),
            stop_cmd: Some(crate::stt_scripts::STOP_SCRIPT.to_string()),
        }
    }
}

/// Per-kind STT provider settings stored in `stt_providers`.
#[derive(Debug, Clone)]
pub struct SttProviderRow {
    pub kind: String, // "local", "network", "openai"
    pub host: String,
    pub port: String,
    pub model: String,
    pub api_key: Option<String>,
}

impl SttProviderRow {
    pub fn default_for(kind: &str) -> Self {
        match kind {
            "openai" => Self {
                kind: "openai".to_string(),
                host: "https://api.openai.com".to_string(),
                port: "443".to_string(),
                model: "whisper-1".to_string(),
                api_key: None,
            },
            "network" => Self {
                kind: "network".to_string(),
                host: String::new(),
                port: String::new(),
                model: "Systran/faster-whisper-base.en".to_string(),
                api_key: None,
            },
            _ => Self {
                kind: "local".to_string(),
                host: "http://127.0.0.1".to_string(),
                port: "5200".to_string(),
                model: "Systran/faster-whisper-small".to_string(),
                api_key: None,
            },
        }
    }

    /// Assemble the full transcription endpoint URL from host + port.
    pub fn transcription_url(&self) -> String {
        build_url(&self.host, &self.port)
    }
}

/// Build a full transcription URL from scheme+host and port strings.
/// Accepts a bare hostname (no scheme) and defaults to http://.
fn build_url(host: &str, port: &str) -> String {
    let host = host.trim_end_matches('/');
    if host.is_empty() {
        return String::new();
    }
    // Ensure a scheme is present; default to http:// for bare hostnames.
    let host_with_scheme = if host.contains("://") {
        host.to_string()
    } else {
        format!("http://{}", host)
    };
    let base = if port.is_empty() {
        host_with_scheme
    } else {
        format!("{}:{}", host_with_scheme, port)
    };
    format!("{}/v1/audio/transcriptions", base)
}

/// Split a full URL into (scheme+hostname, port-string).
fn split_url_host_port(url: &str) -> (String, String) {
    // Use simple string ops to avoid pulling in a URL parser at the db layer.
    // url is expected to be "scheme://host:port/path"
    if url.is_empty() {
        return (String::new(), String::new());
    }
    // Strip the path after the third slash (after scheme://).
    let scheme_end = url.find("://").map(|i| i + 3).unwrap_or(0);
    let after_scheme = &url[scheme_end..];
    let path_start = after_scheme.find('/').unwrap_or(after_scheme.len());
    let authority = &after_scheme[..path_start];
    // Split on last ':' in authority (handles IPv6 only if no brackets, which is fine here).
    if let Some(colon) = authority.rfind(':') {
        let host_part = &authority[..colon];
        let port_part = &authority[colon + 1..];
        let host_with_scheme = if scheme_end > 0 {
            format!("{}{}", &url[..scheme_end], host_part)
        } else {
            host_part.to_string()
        };
        (host_with_scheme, port_part.to_string())
    } else {
        // No port — return the whole authority with scheme, empty port.
        let host_with_scheme = if scheme_end > 0 {
            format!("{}{}", &url[..scheme_end], authority)
        } else {
            authority.to_string()
        };
        (host_with_scheme, String::new())
    }
}

fn generate_vapid_keypair() -> VapidKeys {
    let signing_key = SigningKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
    let private_scalar = signing_key.to_bytes();
    let verifying_key = signing_key.verifying_key();
    let encoded_point = verifying_key.to_encoded_point(false);
    VapidKeys {
        public_key: encoded_point.as_bytes().to_vec(),
        private_key: private_scalar.to_vec(),
    }
}

fn unix_seconds() -> Result<i64> {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("reading system clock")?
        .as_secs();
    i64::try_from(secs).map_err(|_| anyhow!("system clock past i64 seconds range"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    // Monotonically-increasing counter for unique test DB paths.
    // Using a seconds-only timestamp caused races when multiple tests run in
    // the same second under the same PID.
    static TEST_DB_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn fresh_db() -> Db {
        let n = TEST_DB_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("mobux-test-{}-{}.sqlite", std::process::id(), n,));
        let _ = std::fs::remove_file(&path);
        Db::open(&path).expect("open db")
    }

    #[test]
    fn vapid_keys_are_idempotent() {
        let db = fresh_db();
        let first = db.vapid_keys().expect("first call");
        assert_eq!(first.public_key.len(), 65, "uncompressed P-256 point");
        assert_eq!(first.private_key.len(), 32, "P-256 scalar");
        assert_eq!(first.public_key[0], 0x04, "uncompressed point prefix");

        let second = db.vapid_keys().expect("second call");
        assert_eq!(first.public_key, second.public_key);
        assert_eq!(first.private_key, second.private_key);
    }

    #[test]
    fn subscription_upsert_round_trip() {
        let db = fresh_db();
        assert!(db.list_subscriptions().expect("empty list").is_empty());

        db.insert_subscription(NewSubscription {
            endpoint: "https://push.example/abc".to_string(),
            p256dh: vec![1, 2, 3],
            auth: vec![4, 5, 6],
            label: Some("phone".to_string()),
        })
        .expect("insert");

        let after_first = db.list_subscriptions().expect("list 1");
        assert_eq!(after_first.len(), 1);
        assert_eq!(after_first[0].label.as_deref(), Some("phone"));

        // Re-insert with new keys but no label: keys update, label preserved.
        db.insert_subscription(NewSubscription {
            endpoint: "https://push.example/abc".to_string(),
            p256dh: vec![9, 9, 9],
            auth: vec![8, 8, 8],
            label: None,
        })
        .expect("upsert");

        let after_second = db.list_subscriptions().expect("list 2");
        assert_eq!(after_second.len(), 1, "endpoint is unique");
        assert_eq!(after_second[0].p256dh, vec![9, 9, 9]);
        assert_eq!(after_second[0].auth, vec![8, 8, 8]);
        assert_eq!(after_second[0].label.as_deref(), Some("phone"));

        db.remove_subscription("https://push.example/abc")
            .expect("remove");
        assert!(db.list_subscriptions().expect("list 3").is_empty());
    }

    #[test]
    fn node_read_helpers_reflect_stored_rows() {
        let db = fresh_db();
        assert!(db.list_nodes().expect("empty list").is_empty());
        assert!(db.get_node("gpu-box").expect("get missing").is_none());

        db.replace_nodes(vec![(
            "gpu-box".to_string(),
            "mvhenten@gpu-box.local".to_string(),
        )])
        .expect("seed");

        let nodes = db.list_nodes().expect("list");
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].name, "gpu-box");
        assert_eq!(nodes[0].target, "mvhenten@gpu-box.local");

        let got = db.get_node("gpu-box").expect("get").expect("present");
        assert_eq!(got.target, "mvhenten@gpu-box.local");
    }

    #[test]
    fn replace_nodes_is_a_full_swap() {
        let db = fresh_db();
        db.replace_nodes(vec![(
            "stale".to_string(),
            "mvhenten@stale.local".to_string(),
        )])
        .expect("seed");

        db.replace_nodes(vec![
            ("gpu-box".to_string(), "mvhenten@gpu-box.local".to_string()),
            ("devbox".to_string(), "mvhenten@devbox.local".to_string()),
        ])
        .expect("replace");

        let nodes = db.list_nodes().expect("list");
        assert_eq!(
            nodes.len(),
            2,
            "stale node is gone, replaced by the PUT body"
        );
        assert!(nodes.iter().any(|n| n.name == "gpu-box"));
        assert!(nodes.iter().any(|n| n.name == "devbox"));
        assert!(db.get_node("stale").expect("get stale").is_none());

        db.replace_nodes(vec![]).expect("replace with empty list");
        assert!(db
            .list_nodes()
            .expect("list after empty replace")
            .is_empty());
    }

    #[test]
    fn stt_provider_round_trip() {
        let db = fresh_db();

        // Fresh DB: active kind defaults to "local", no provider rows yet.
        assert_eq!(db.stt_active_kind().expect("active kind"), "local");
        assert!(
            db.stt_provider("local").expect("no row").is_none(),
            "no row written yet"
        );

        // Save a network provider.
        db.set_stt_provider(SttProviderRow {
            kind: "network".to_string(),
            host: "http://lab.example".to_string(),
            port: "8081".to_string(),
            model: "Systran/faster-whisper-medium.en".to_string(),
            api_key: None,
        })
        .expect("save network");
        db.set_stt_active_kind("network").expect("set active");

        let row = db
            .stt_provider("network")
            .expect("read network")
            .expect("row exists");
        assert_eq!(row.host, "http://lab.example");
        assert_eq!(row.port, "8081");
        assert_eq!(row.model, "Systran/faster-whisper-medium.en");
        assert!(row.api_key.is_none());
        assert_eq!(
            row.transcription_url(),
            "http://lab.example:8081/v1/audio/transcriptions"
        );
        assert_eq!(db.stt_active_kind().expect("active kind"), "network");

        // Save openai with an api_key.
        db.set_stt_provider(SttProviderRow {
            kind: "openai".to_string(),
            host: "https://api.openai.com".to_string(),
            port: "443".to_string(),
            model: "whisper-1".to_string(),
            api_key: Some("sk-secret".to_string()),
        })
        .expect("save openai");

        let oai = db
            .stt_provider("openai")
            .expect("read openai")
            .expect("oai row");
        assert_eq!(oai.api_key.as_deref(), Some("sk-secret"));

        // Overwrite with empty api_key — existing key is preserved.
        db.set_stt_provider(SttProviderRow {
            kind: "openai".to_string(),
            host: "https://api.openai.com".to_string(),
            port: "443".to_string(),
            model: "gpt-4o-transcribe".to_string(),
            api_key: Some(String::new()),
        })
        .expect("update openai no key");
        let oai2 = db
            .stt_provider("openai")
            .expect("read openai 2")
            .expect("oai row 2");
        assert_eq!(
            oai2.api_key.as_deref(),
            Some("sk-secret"),
            "empty api_key preserves stored key"
        );
        assert_eq!(oai2.model, "gpt-4o-transcribe");
    }

    #[test]
    fn stt_all_providers_returns_defaults_for_missing_kinds() {
        let db = fresh_db();
        let rows = db.stt_all_providers().expect("all providers");
        assert_eq!(rows.len(), 3);
        // All three kinds present as defaults.
        let kinds: Vec<&str> = rows.iter().map(|r| r.kind.as_str()).collect();
        assert!(kinds.contains(&"local"));
        assert!(kinds.contains(&"network"));
        assert!(kinds.contains(&"openai"));
    }

    #[test]
    fn stt_migration_from_legacy_config() {
        let db = fresh_db();

        // Simulate a pre-migration DB: write a legacy stt_config row directly.
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT OR REPLACE INTO stt_config
                 (id, kind, url, model, api_key, install_cmd, start_cmd, stop_cmd)
                 VALUES (1, 'network', 'http://lab.local:9090/v1/audio/transcriptions',
                         'Systran/faster-whisper-small', 'oldkey', NULL, NULL, NULL)",
                [],
            )
            .expect("insert legacy");
        }

        // Re-open the same DB — migration should copy the legacy row into stt_providers.
        // Since stt_providers is already empty at this point we can trigger migrate
        // by calling migrate_stt_providers directly through a fresh_db that sees our row.
        // Instead, check that the fresh_db() + manual insert scenario works:
        // The migration ran at open time and providers was empty — it should have
        // migrated the legacy row. But fresh_db already opened before we inserted.
        // So test the migration path by opening a NEW db at the same path.
        let path = {
            let conn = db.conn.lock().unwrap();
            // We need the path — indirect approach: write to a known temp path.
            drop(conn);
            std::env::temp_dir().join(format!(
                "mobux-migrate-test-{}.sqlite",
                unix_seconds().expect("clock"),
            ))
        };
        {
            // Write legacy config to a fresh SQLite file.
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS stt_config (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    kind TEXT NOT NULL,
                    url TEXT NOT NULL,
                    model TEXT NOT NULL,
                    api_key TEXT,
                    install_cmd TEXT,
                    start_cmd TEXT,
                    stop_cmd TEXT
                );
                INSERT INTO stt_config (id, kind, url, model, api_key)
                VALUES (1, 'openai', 'https://api.openai.com:443/v1/audio/transcriptions',
                        'whisper-1', 'sk-migrated');",
            )
            .expect("seed legacy db");
        }
        // Open via Db::open — this triggers schema creation + migration.
        let migrated = Db::open(&path).expect("open migrated db");
        let row = migrated
            .stt_provider("openai")
            .expect("read migrated")
            .expect("migrated row exists");
        assert_eq!(row.kind, "openai");
        assert_eq!(row.model, "whisper-1");
        assert_eq!(row.api_key.as_deref(), Some("sk-migrated"));
        assert_eq!(
            migrated.stt_active_kind().expect("active kind"),
            "openai",
            "migration sets active kind from legacy row"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn build_url_helper() {
        assert_eq!(
            build_url("http://127.0.0.1", "5200"),
            "http://127.0.0.1:5200/v1/audio/transcriptions"
        );
        assert_eq!(
            build_url("https://api.openai.com", "443"),
            "https://api.openai.com:443/v1/audio/transcriptions"
        );
        assert_eq!(build_url("", ""), "");
        // Bare hostname (no scheme) — should default to http://.
        assert_eq!(
            build_url("lab", "8081"),
            "http://lab:8081/v1/audio/transcriptions"
        );
        assert_eq!(build_url("lab", ""), "http://lab/v1/audio/transcriptions");
    }

    #[test]
    fn split_url_host_port_helper() {
        assert_eq!(
            split_url_host_port("http://127.0.0.1:5200/v1/audio/transcriptions"),
            ("http://127.0.0.1".to_string(), "5200".to_string())
        );
        assert_eq!(
            split_url_host_port("https://api.openai.com:443/v1/audio/transcriptions"),
            ("https://api.openai.com".to_string(), "443".to_string())
        );
        assert_eq!(split_url_host_port(""), (String::new(), String::new()));
    }

    #[test]
    fn default_stt_commands_are_self_contained() {
        let db = fresh_db();
        let cfg = db.stt_config().expect("default stt_config");
        for cmd in [&cfg.install_cmd, &cfg.start_cmd, &cfg.stop_cmd] {
            let cmd = cmd.as_deref().expect("default command present");
            assert!(cmd.contains("podman"), "expected podman in: {cmd}");
            assert!(
                !cmd.contains("bin/stt-"),
                "default command must not reference a bin/stt- path: {cmd}"
            );
        }
    }
}
