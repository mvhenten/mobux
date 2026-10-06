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

/// Global UI preferences. Single row, id=1, in `ui_preferences`. These were
/// formerly per-device localStorage keys; mobux is single-user, so they now
/// live on the server as one shared, authoritative row (#211).
#[derive(Debug, Clone)]
pub struct UiPreferences {
    /// Terminal renderer: `xterm` (default) or `sterk`.
    pub renderer: String,
    /// Colour theme id (client-defined; server stores it verbatim).
    pub theme: String,
    /// Default terminal view on session open: `xterm` or `reader`.
    pub default_view: String,
    /// Whether the reader OSC-133 setup hint has been dismissed.
    pub osc133_hint_dismissed: bool,
    /// Web Speech voice name for Listen mode (empty = browser default).
    pub listen_voice: String,
    /// Listen speech rate, clamped 0.5–2.0.
    pub listen_rate: f64,
    /// Listen speech pitch, clamped 0.5–2.0.
    pub listen_pitch: f64,
    /// Selected fleet node for the Home session list (empty = local host).
    /// Stored verbatim; a since-removed node is reconciled to local by the
    /// client.
    pub selected_node: String,
}

impl Default for UiPreferences {
    fn default() -> Self {
        Self {
            renderer: "xterm".to_string(),
            theme: "tomorrow-night-soft".to_string(),
            default_view: "xterm".to_string(),
            osc133_hint_dismissed: false,
            listen_voice: String::new(),
            listen_rate: 1.0,
            listen_pitch: 1.0,
            selected_node: String::new(),
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

            -- UI preferences (#211): single global row of client
            -- display/behaviour prefs. mobux is single-user, so there is no
            -- per-user or per-device modelling — one row, the server is
            -- authoritative, every client reads it at boot.
            CREATE TABLE IF NOT EXISTS ui_preferences (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                renderer TEXT NOT NULL,
                theme TEXT NOT NULL,
                default_view TEXT NOT NULL,
                osc133_hint_dismissed INTEGER NOT NULL,
                listen_voice TEXT NOT NULL,
                listen_rate REAL NOT NULL,
                listen_pitch REAL NOT NULL,
                selected_node TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS stt_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                kind TEXT NOT NULL,
                url TEXT NOT NULL,
                model TEXT NOT NULL,
                api_key TEXT
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

        // Additive migration: the selected Home node moved from per-device
        // localStorage into this global row. Older DBs predate the column.
        let _ = conn.execute_batch(
            "ALTER TABLE ui_preferences ADD COLUMN selected_node TEXT NOT NULL DEFAULT '';",
        );

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
        Self::migrate_local_stt_in_process(conn)?;

        Ok(())
    }

    /// Retire the container-backed local provider.
    ///
    /// The local kind now runs whisper in-process, so an install upgrading
    /// into this version still carries the container installer scripts and a
    /// faster-whisper model id pointed at a port nothing listens on. Clear the
    /// scripts and reset the local row onto the in-process defaults; every
    /// other kind is a user-configured endpoint and is left alone.
    fn migrate_local_stt_in_process(conn: &Connection) -> Result<()> {
        let cmd_columns: Vec<String> = conn
            .prepare("PRAGMA table_info(stt_config)")
            .and_then(|mut stmt| {
                stmt.query_map([], |r| r.get::<_, String>(1))?
                    .collect::<std::result::Result<Vec<_>, _>>()
            })
            .unwrap_or_default()
            .into_iter()
            .filter(|c| matches!(c.as_str(), "install_cmd" | "start_cmd" | "stop_cmd"))
            .collect();
        if !cmd_columns.is_empty() {
            let assignments = cmd_columns
                .iter()
                .map(|c| format!("{c} = NULL"))
                .collect::<Vec<_>>()
                .join(", ");
            let _ = conn.execute(&format!("UPDATE stt_config SET {assignments}"), []);
        }

        let local: Option<String> = conn
            .query_row(
                "SELECT model FROM stt_providers WHERE kind = 'local'",
                [],
                |r| r.get(0),
            )
            .optional()
            .context("reading the local stt provider")?;
        let Some(model) = local else {
            return Ok(());
        };
        if crate::local_stt::is_known_model(&model) {
            return Ok(());
        }
        conn.execute(
            "UPDATE stt_providers SET host = '', port = '', url = '', model = ?1
             WHERE kind = 'local'",
            params![crate::local_stt::DEFAULT_MODEL],
        )
        .context("resetting the local stt provider onto the in-process engine")?;
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

    /// Read the single UI-preferences row, seeding defaults on first access.
    pub fn ui_preferences(&self) -> Result<UiPreferences> {
        let conn = self.lock_conn()?;
        let row: Option<UiPreferences> = conn
            .query_row(
                "SELECT renderer, theme, default_view, osc133_hint_dismissed,
                        listen_voice, listen_rate, listen_pitch, selected_node
                 FROM ui_preferences WHERE id = 1",
                [],
                |row| {
                    Ok(UiPreferences {
                        renderer: row.get(0)?,
                        theme: row.get(1)?,
                        default_view: row.get(2)?,
                        osc133_hint_dismissed: row.get::<_, i64>(3)? != 0,
                        listen_voice: row.get(4)?,
                        listen_rate: row.get(5)?,
                        listen_pitch: row.get(6)?,
                        selected_node: row.get(7)?,
                    })
                },
            )
            .optional()
            .context("reading ui_preferences")?;

        if let Some(prefs) = row {
            return Ok(prefs);
        }

        let defaults = UiPreferences::default();
        Self::upsert_ui_preferences(&conn, &defaults)
            .context("inserting default ui_preferences")?;
        Ok(defaults)
    }

    /// Overwrite the UI-preferences row wholesale (the client PUTs the full blob).
    pub fn set_ui_preferences(&self, prefs: UiPreferences) -> Result<()> {
        let conn = self.lock_conn()?;
        Self::upsert_ui_preferences(&conn, &prefs).context("upserting ui_preferences")?;
        Ok(())
    }

    fn upsert_ui_preferences(conn: &Connection, prefs: &UiPreferences) -> rusqlite::Result<()> {
        conn.execute(
            "INSERT INTO ui_preferences
                 (id, renderer, theme, default_view, osc133_hint_dismissed,
                  listen_voice, listen_rate, listen_pitch, selected_node)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
                 renderer = excluded.renderer,
                 theme = excluded.theme,
                 default_view = excluded.default_view,
                 osc133_hint_dismissed = excluded.osc133_hint_dismissed,
                 listen_voice = excluded.listen_voice,
                 listen_rate = excluded.listen_rate,
                 listen_pitch = excluded.listen_pitch,
                 selected_node = excluded.selected_node",
            params![
                prefs.renderer,
                prefs.theme,
                prefs.default_view,
                prefs.osc133_hint_dismissed as i64,
                prefs.listen_voice,
                prefs.listen_rate,
                prefs.listen_pitch,
                prefs.selected_node,
            ],
        )?;
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

    pub fn stt_saved_active_kind(&self) -> Result<Option<String>> {
        let conn = self.lock_conn()?;
        conn.query_row("SELECT kind FROM stt_active_kind WHERE id = 1", [], |r| {
            r.get(0)
        })
        .optional()
        .context("reading stt_active_kind")
    }

    pub fn stt_saved_providers(&self) -> Result<Vec<SttProviderRow>> {
        let conn = self.lock_conn()?;
        let mut stmt = conn
            .prepare("SELECT kind, host, port, model, api_key FROM stt_providers ORDER BY kind")
            .context("preparing stt_providers read")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(SttProviderRow {
                    kind: r.get(0)?,
                    host: r.get(1)?,
                    port: r.get(2)?,
                    model: r.get(3)?,
                    api_key: r.get(4)?,
                })
            })
            .context("reading stt_providers")?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("reading stt_providers")?;
        Ok(rows)
    }

    /// Run once config.json holds the rows, so the copy is one-time. The
    /// tables stay.
    pub fn clear_stt_saved(&self) -> Result<()> {
        let conn = self.lock_conn()?;
        conn.execute_batch(
            "DELETE FROM stt_providers; DELETE FROM stt_active_kind; DELETE FROM stt_config;",
        )
        .context("clearing the stored stt providers")
    }

    fn lock_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| anyhow!("db connection mutex poisoned"))
    }
}

/// Per-kind STT provider settings stored in `stt_providers`.
#[derive(Debug, Clone)]
pub struct SttProviderRow {
    pub kind: String,
    pub host: String,
    pub port: String,
    pub model: String,
    pub api_key: Option<String>,
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
    fn ui_preferences_round_trip() {
        let db = fresh_db();

        // First read seeds and returns the defaults.
        let defaults = db.ui_preferences().expect("seed defaults");
        assert_eq!(defaults.renderer, "xterm");
        assert_eq!(defaults.theme, "tomorrow-night-soft");
        assert_eq!(defaults.default_view, "xterm");
        assert!(!defaults.osc133_hint_dismissed);
        assert_eq!(defaults.listen_voice, "");
        assert_eq!(defaults.listen_rate, 1.0);
        assert_eq!(defaults.listen_pitch, 1.0);
        assert_eq!(defaults.selected_node, "");

        db.set_ui_preferences(UiPreferences {
            renderer: "sterk".to_string(),
            theme: "nord".to_string(),
            default_view: "reader".to_string(),
            osc133_hint_dismissed: true,
            listen_voice: "Daniel".to_string(),
            listen_rate: 1.4,
            listen_pitch: 0.8,
            selected_node: "gpu-box".to_string(),
        })
        .expect("write");

        let got = db.ui_preferences().expect("read back");
        assert_eq!(got.renderer, "sterk");
        assert_eq!(got.theme, "nord");
        assert_eq!(got.default_view, "reader");
        assert!(got.osc133_hint_dismissed);
        assert_eq!(got.listen_voice, "Daniel");
        assert_eq!(got.listen_rate, 1.4);
        assert_eq!(got.listen_pitch, 0.8);
        assert_eq!(got.selected_node, "gpu-box");
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

    // Upgrade path off the container-backed provider: a DB written by it
    // carries the installer scripts and a faster-whisper model id aimed at
    // port 5200. Opening it must land on the in-process engine instead of
    // dictating into a port nothing listens on.
    fn seed_container_era_db(path: &Path) {
        let conn = rusqlite::Connection::open(path).unwrap();
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
            CREATE TABLE IF NOT EXISTS stt_providers (
                kind TEXT PRIMARY KEY,
                host TEXT NOT NULL DEFAULT '',
                port TEXT NOT NULL DEFAULT '',
                url  TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL DEFAULT '',
                api_key TEXT
            );
            INSERT INTO stt_config (id, kind, url, model, api_key, install_cmd, start_cmd, stop_cmd)
            VALUES (1, 'local', 'http://127.0.0.1:5200/v1/audio/transcriptions',
                    'Systran/faster-whisper-small', NULL,
                    'podman pull ghcr.io/speaches-ai/speaches:latest-cpu',
                    'podman run -d --name mobux-stt -p 5200:8000 speaches',
                    'podman stop mobux-stt');
            INSERT INTO stt_providers (kind, host, port, url, model, api_key)
            VALUES ('local', 'http://127.0.0.1', '5200',
                    'http://127.0.0.1:5200/v1/audio/transcriptions',
                    'Systran/faster-whisper-small', NULL),
                   ('openai', 'https://api.openai.com', '443',
                    'https://api.openai.com:443/v1/audio/transcriptions',
                    'whisper-1', 'sk-kept');",
        )
        .expect("seed container-era db");
    }

    #[test]
    fn opening_a_container_era_db_resets_the_local_provider_and_keeps_the_remote_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mobux.sqlite");
        seed_container_era_db(&path);

        let db = Db::open(&path).expect("open a container-era db");

        let rows = db.stt_saved_providers().expect("read rows");
        let row = |kind: &str| rows.iter().find(|r| r.kind == kind).cloned().expect("row");
        let local = row("local");
        assert_eq!(local.model, crate::local_stt::DEFAULT_MODEL);
        assert_eq!(local.host, "");
        assert_eq!(local.port, "");

        let openai = row("openai");
        assert_eq!(openai.host, "https://api.openai.com");
        assert_eq!(openai.model, "whisper-1");
        assert_eq!(
            openai.api_key.as_deref(),
            Some("sk-kept"),
            "a configured endpoint is not touched by the local migration"
        );

        let conn = db.conn.lock().unwrap();
        let leftovers: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM stt_config
                 WHERE install_cmd IS NOT NULL OR start_cmd IS NOT NULL OR stop_cmd IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(leftovers, 0, "no container command survives the upgrade");
    }

    // Re-opening must not churn a row the migration has already fixed.
    #[test]
    fn the_migration_leaves_a_model_the_engine_can_run_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mobux.sqlite");
        seed_container_era_db(&path);
        drop(Db::open(&path).expect("first open"));
        let db = Db::open(&path).expect("second open");
        let rows = db.stt_saved_providers().expect("read rows");
        let local = rows.iter().find(|r| r.kind == "local").expect("local row");
        assert_eq!(local.model, crate::local_stt::DEFAULT_MODEL);
    }

    #[test]
    fn clearing_the_stored_stt_rows_keeps_the_tables() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mobux.sqlite");
        seed_container_era_db(&path);
        let db = Db::open(&path).expect("open");
        db.clear_stt_saved().expect("clear");
        assert!(db.stt_saved_providers().expect("read rows").is_empty());
        assert_eq!(db.stt_saved_active_kind().expect("read active"), None);
        drop(db);
        let db = Db::open(&path).expect("reopen");
        assert!(db.stt_saved_providers().expect("read rows").is_empty());
    }
}
