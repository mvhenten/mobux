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
/// `endpoint`, `p256dh`, and `auth` are consumed by `push::notify_bell`; the
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
            );",
        )
        .context("initializing sqlite schema")?;
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

    fn lock_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| anyhow!("db connection mutex poisoned"))
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

    fn fresh_db() -> Db {
        let path = std::env::temp_dir().join(format!(
            "mobux-test-{}-{}.sqlite",
            std::process::id(),
            unix_seconds().expect("clock"),
        ));
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
}
