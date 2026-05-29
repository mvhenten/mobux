//! Web Push delivery.
//!
//! See `docs/twa-push-implementation-plan.md` (Phase 6) for the design.
//!
//! ## Trigger source
//!
//! Bell triggers come from tmux's `alert-bell` hook (set up at startup
//! via `tmux::install_bell_hook`). The hook fires *exactly once per
//! actual bell* and includes the originating session and window in its
//! format context — tmux is the source of truth, so there is no
//! repaint-vs-event ambiguity and no need for client-side dedupe.
//!
//! `bell_emoji` and `program_exit` triggers in `NotificationPrefs` are
//! currently dormant: they require content scanning of the PTY stream,
//! which only works correctly against an append-only source like
//! `tmux pipe-pane`. That plumbing is a separate piece of work — until
//! it lands, those prefs are accepted by the settings UI but no event
//! source feeds them. Scripted notifications still work via
//! `POST /api/push/notify`.
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
//! never block or error any handler. Dead subscriptions (HTTP 404 / 410)
//! are pruned from the database on the fly.
//!
//! [`web-push-native`]: https://crates.io/crates/web-push-native
//! [`reqwest`]: https://crates.io/crates/reqwest

use std::sync::Arc;

use reqwest::StatusCode;
use serde_json::json;
use web_push_native::{
    jwt_simple::algorithms::ES256KeyPair, p256::PublicKey, Auth, WebPushBuilder,
};

use crate::db::{Db, Subscription, VapidKeys};

/// Build the deep-link URL for a session notification, embedding
/// `?w={window}` so a click can land on the originating tmux window.
fn session_url(session: &str, window: Option<&str>) -> String {
    match window {
        Some(w) if !w.is_empty() => format!("/s/{session}?w={w}"),
        _ => format!("/s/{session}"),
    }
}

/// Fire a "bell" push for `session` (and optional `window`). Spawned
/// fire-and-forget by the tmux-hook callback — tmux already deduped the
/// event, so callers don't need to.
pub fn fire_bell(db: Arc<Db>, session: &str, window: Option<&str>) {
    let payload = Payload {
        title: "mobux".to_string(),
        body: format!("session {session}: 🔔"),
        tag: Some(format!("bell-{session}")),
        url: Some(session_url(session, window)),
    };
    tokio::spawn(notify(db, payload));
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
