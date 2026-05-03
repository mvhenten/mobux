//! Web Push delivery on terminal BEL.
//!
//! See `docs/twa-push-implementation-plan.md` (Phase 6) for the design.
//!
//! ## Library choice
//!
//! Uses [`web-push-native`] for VAPID JWT signing and RFC 8188 (`aes128gcm`)
//! payload encryption, plus [`reqwest`] (rustls-only build) to POST to the push
//! service. The previously-considered `web-push` crate was ruled out because it
//! transitively pulls `openssl-sys`, breaking the project's hermetic-rustls
//! build. `web-push-native` keeps the build openssl-free — verified with
//! `cargo tree -i openssl-sys` (empty).
//!
//! ## Best-effort delivery
//!
//! All errors are logged via `eprintln!` and swallowed. Push delivery must
//! never block or error the WebSocket forwarding loop. Dead subscriptions
//! (HTTP 404 / 410) are pruned from the database on the fly.
//!
//! [`web-push-native`]: https://crates.io/crates/web-push-native
//! [`reqwest`]: https://crates.io/crates/reqwest

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use reqwest::StatusCode;
use serde_json::json;
use web_push_native::{
    jwt_simple::algorithms::ES256KeyPair, p256::PublicKey, Auth, WebPushBuilder,
};

use crate::db::{Db, NotificationPrefs, Subscription, VapidKeys};
use crate::tmux;

/// Per-process notification suppression / dedupe state, shared between the
/// WS handler (which knows when tmux is about to repaint) and the trigger
/// dispatcher.
///
/// `scan_suppressed`: per-session "skip scanning until this Instant".
/// Set when the server knows tmux will paint already-seen content (initial
/// WS attach, window/pane switch, resize). Re-paint chunks during this
/// window are not scanned for triggers.
///
/// `recent_fires`: backstop dedupe keyed on `(session, tag)`. If the same
/// tag fired in the last `DEDUP_WINDOW`, the second fire is dropped. Catches
/// edge cases where suppression timing didn't quite cover a repaint.
#[derive(Default)]
pub struct NotifyState {
    scan_suppressed: Mutex<HashMap<String, Instant>>,
    recent_fires: Mutex<HashMap<(String, String), Instant>>,
}

const DEDUP_WINDOW: Duration = Duration::from_secs(5);

impl NotifyState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Suppress trigger scanning for `session` for at least `dur`. Extends
    /// an existing window; never shrinks it.
    pub fn suppress(&self, session: &str, dur: Duration) {
        let until = Instant::now() + dur;
        let mut g = self.scan_suppressed.lock().unwrap();
        let cur = g.get(session).copied();
        if cur.is_none_or(|c| until > c) {
            g.insert(session.to_string(), until);
        }
    }

    pub fn is_suppressed(&self, session: &str) -> bool {
        let g = self.scan_suppressed.lock().unwrap();
        g.get(session).is_some_and(|t| Instant::now() < *t)
    }

    /// Returns true if `(session, tag)` has NOT fired within `DEDUP_WINDOW`,
    /// recording the fire as a side effect. Returns false otherwise.
    fn try_record_fire(&self, session: &str, tag: &str) -> bool {
        let now = Instant::now();
        let mut g = self.recent_fires.lock().unwrap();
        let key = (session.to_string(), tag.to_string());
        if let Some(prev) = g.get(&key) {
            if now.duration_since(*prev) < DEDUP_WINDOW {
                return false;
            }
        }
        g.insert(key, now);
        // Opportunistic GC so the map can't grow without bound.
        g.retain(|_, t| now.duration_since(*t) < DEDUP_WINDOW * 4);
        true
    }
}

/// 🔔 (U+1F514) encoded as UTF-8.
const BELL_EMOJI_UTF8: &[u8] = &[0xf0, 0x9f, 0x94, 0x94];

/// OSC 133 ; D — semantic shell prompt sequence emitted after each command,
/// carrying the exit code. Body is `\x1b]133;D;<digits>` followed by the
/// string terminator (BEL `\x07` or ESC `\x1b\\`).
const OSC_133_D_PREFIX: &[u8] = b"\x1b]133;D;";

/// What a chunk of PTY output is asking the user to be notified about.
#[derive(Debug, Clone, Copy)]
pub enum Trigger {
    Bell,
    BellEmoji,
    ProgramExit { code: i32 },
}

/// Scan a single chunk of PTY output for notification triggers. One chunk
/// may produce multiple triggers; each is fired independently respecting
/// `NotificationPrefs`.
pub fn scan_pty_chunk(chunk: &[u8]) -> Vec<Trigger> {
    let mut out = Vec::new();
    if chunk.contains(&0x07) {
        out.push(Trigger::Bell);
    }
    if chunk
        .windows(BELL_EMOJI_UTF8.len())
        .any(|w| w == BELL_EMOJI_UTF8)
    {
        out.push(Trigger::BellEmoji);
    }
    let mut start = 0;
    while start + OSC_133_D_PREFIX.len() <= chunk.len() {
        let Some(pos) = chunk[start..]
            .windows(OSC_133_D_PREFIX.len())
            .position(|w| w == OSC_133_D_PREFIX)
        else {
            break;
        };
        let code_start = start + pos + OSC_133_D_PREFIX.len();
        let mut code_end = code_start;
        while code_end < chunk.len() && chunk[code_end].is_ascii_digit() {
            code_end += 1;
        }
        start = code_end.max(code_start + 1);
        if code_end == code_start {
            continue;
        }
        if let Ok(s) = std::str::from_utf8(&chunk[code_start..code_end]) {
            if let Ok(n) = s.parse::<i32>() {
                out.push(Trigger::ProgramExit { code: n });
            }
        }
    }
    out
}

/// Apply a trigger respecting `prefs`. Looks up the active tmux window so
/// the notification can deep-link at the originating window, dedupes
/// against `state.recent_fires`, then spawns `notify` (best-effort,
/// fire-and-forget) when the corresponding pref is on.
pub fn handle_trigger(
    db: Arc<Db>,
    state: Arc<NotifyState>,
    session_name: &str,
    trigger: Trigger,
    prefs: NotificationPrefs,
) {
    let session = session_name.to_string();
    tokio::spawn(async move {
        let payload = match build_payload(&session, trigger, prefs).await {
            Some(p) => p,
            None => return,
        };
        let tag = payload.tag.clone().unwrap_or_default();
        if !state.try_record_fire(&session, &tag) {
            return;
        }
        notify(db, payload).await;
    });
}

async fn build_payload(
    session: &str,
    trigger: Trigger,
    prefs: NotificationPrefs,
) -> Option<Payload> {
    match trigger {
        Trigger::Bell if prefs.bell => Some(Payload {
            title: "mobux".to_string(),
            body: format!("session {session}: 🔔"),
            tag: Some(format!("bell-{session}")),
            url: Some(session_url(session).await),
        }),
        Trigger::BellEmoji if prefs.bell_emoji => Some(Payload {
            title: "mobux".to_string(),
            body: format!("session {session}: 🔔 ping"),
            tag: Some(format!("emoji-{session}")),
            url: Some(session_url(session).await),
        }),
        Trigger::ProgramExit { code } => {
            let fire = if code != 0 {
                prefs.program_exit_nonzero || prefs.program_exit
            } else {
                prefs.program_exit
            };
            if !fire {
                return None;
            }
            let label = if code == 0 {
                "ok".to_string()
            } else {
                format!("exit {code}")
            };
            Some(Payload {
                title: "mobux".to_string(),
                body: format!("session {session}: {label}"),
                tag: Some(format!("exit-{session}")),
                url: Some(session_url(session).await),
            })
        }
        _ => None,
    }
}

/// Build the deep-link URL for a notification from `session`. When the
/// active tmux window can be queried, embeds it as `?w={index}` so the
/// client can switch to the originating window on click.
async fn session_url(session: &str) -> String {
    match tmux::active_window_index(session).await {
        Ok(idx) if !idx.is_empty() => format!("/s/{session}?w={idx}"),
        _ => format!("/s/{session}"),
    }
}

/// Default VAPID contact (RFC 8292 requires `mailto:` or `https:`).
/// Override with `MOBUX_VAPID_CONTACT`.
const DEFAULT_VAPID_CONTACT: &str = "mailto:admin@example.com";

/// A single push payload.
pub struct Payload {
    pub title: String,
    pub body: String,
    /// Notification `tag`. Same tag from the same origin replaces an existing
    /// notification rather than stacking — free OS-side coalescing.
    pub tag: Option<String>,
    /// Path the SW should deep-link to on click. Defaults to `/`.
    pub url: Option<String>,
}

/// Send `payload` as a Web Push notification to every subscribed device.
///
/// Best-effort: errors are logged and swallowed. Dead subscriptions
/// (HTTP 404 / 410) are pruned from the DB on the fly. Returns when all
/// delivery attempts have completed.
pub async fn notify(db: Arc<Db>, payload: Payload) {
    let vapid = match db.vapid_keys() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("push: load vapid keys failed: {e:#}");
            return;
        }
    };

    let subs = match db.list_subscriptions() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("push: list subscriptions failed: {e:#}");
            return;
        }
    };

    if subs.is_empty() {
        return;
    }

    let payload_bytes = json!({
        "title": payload.title,
        "body": payload.body,
        "tag": payload.tag,
        "url": payload.url.unwrap_or_else(|| "/".to_string()),
    })
    .to_string()
    .into_bytes();

    let contact =
        std::env::var("MOBUX_VAPID_CONTACT").unwrap_or_else(|_| DEFAULT_VAPID_CONTACT.to_string());

    eprintln!(
        "push: notify title={:?} subscribers={}",
        payload.title,
        subs.len()
    );

    let client = reqwest::Client::new();
    let mut sent = 0usize;
    let mut failed = 0usize;
    let mut pruned = 0usize;

    for sub in subs {
        match deliver(&client, &vapid, &contact, &sub, payload_bytes.clone()).await {
            DeliveryOutcome::Ok => sent += 1,
            DeliveryOutcome::Gone => {
                if let Err(e) = db.remove_subscription(&sub.endpoint) {
                    eprintln!(
                        "push: failed to prune dead subscription {}: {e:#}",
                        sub.endpoint
                    );
                } else {
                    pruned += 1;
                }
            }
            DeliveryOutcome::Failed => failed += 1,
        }
    }

    eprintln!("push: notify sent={sent} failed={failed} pruned={pruned}");
}

enum DeliveryOutcome {
    Ok,
    /// Subscription is dead (404 / 410) — caller should prune it.
    Gone,
    Failed,
}

/// Build, encrypt, and POST a single push request. All errors are mapped to
/// `Failed` (or `Gone` for 404 / 410) and logged. Never panics.
async fn deliver(
    client: &reqwest::Client,
    vapid: &VapidKeys,
    contact: &str,
    sub: &Subscription,
    payload: Vec<u8>,
) -> DeliveryOutcome {
    let key_pair = match ES256KeyPair::from_bytes(&vapid.private_key) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("push: invalid VAPID private key: {e}");
            return DeliveryOutcome::Failed;
        }
    };

    let endpoint_uri = match sub.endpoint.parse() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("push: bad endpoint {}: {e}", sub.endpoint);
            return DeliveryOutcome::Failed;
        }
    };

    let ua_public = match PublicKey::from_sec1_bytes(&sub.p256dh) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("push: bad p256dh for {}: {e}", sub.endpoint);
            return DeliveryOutcome::Failed;
        }
    };

    if sub.auth.len() != 16 {
        eprintln!(
            "push: bad auth length {} for {} (expected 16)",
            sub.auth.len(),
            sub.endpoint
        );
        return DeliveryOutcome::Failed;
    }
    // `clone_from_slice` is deprecated in generic-array 1.x but is the
    // documented API of `web-push-native 0.4` (which still uses 0.x). Track
    // upstream for an updated constructor.
    #[allow(deprecated)]
    let ua_auth = Auth::clone_from_slice(&sub.auth);

    let builder =
        WebPushBuilder::new(endpoint_uri, ua_public, ua_auth).with_vapid(&key_pair, contact);

    let request = match builder.build(payload) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("push: build request for {} failed: {e}", sub.endpoint);
            return DeliveryOutcome::Failed;
        }
    };

    // Convert http::Request to reqwest::Request.
    let (parts, body) = request.into_parts();
    let url = parts.uri.to_string();
    let mut req = client.post(&url).body(body);
    for (name, value) in parts.headers.iter() {
        req = req.header(name.as_str(), value.as_bytes());
    }

    match req.send().await {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                DeliveryOutcome::Ok
            } else if status == StatusCode::NOT_FOUND || status == StatusCode::GONE {
                eprintln!("push: subscription gone ({}) for {}", status, sub.endpoint);
                DeliveryOutcome::Gone
            } else {
                let body = resp.text().await.unwrap_or_default();
                eprintln!(
                    "push: delivery failed ({}) for {}: {}",
                    status, sub.endpoint, body
                );
                DeliveryOutcome::Failed
            }
        }
        Err(e) => {
            eprintln!("push: HTTP error for {}: {e}", sub.endpoint);
            DeliveryOutcome::Failed
        }
    }
}
