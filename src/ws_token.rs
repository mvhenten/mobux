//! Short-lived, single-use WebSocket auth tokens.
//!
//! Browsers cannot attach HTTP Basic auth (or, cross-site, cookies) to a
//! WebSocket upgrade request initiated from a different origin. To let the
//! fat-client frontend open a `/ws/<session>` connection to a backend on
//! another origin, an already-authenticated client first calls
//! `POST /api/ws-token` (which is gated by the normal auth middleware) to mint
//! a token, then opens the WS with `?token=<value>`.
//!
//! Tokens are:
//! - random (32 bytes, URL-safe base64 → ~43 chars),
//! - short-lived (default 30s),
//! - single-use (consumed on first successful validation),
//! - in-memory only (no persistence; they don't outlive a restart by design).

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64URL, Engine};
use rand::RngCore;

/// How long a freshly minted token stays valid.
pub const DEFAULT_TTL: Duration = Duration::from_secs(30);

/// In-memory store of pending WS tokens.
///
/// `Instant` is the expiry deadline (mint time + TTL). The store is small and
/// short-lived entries only, so a plain `HashMap` behind a `Mutex` is fine.
pub struct WsTokenStore {
    ttl: Duration,
    entries: Mutex<HashMap<String, Instant>>,
}

impl WsTokenStore {
    pub fn new() -> Self {
        Self::with_ttl(DEFAULT_TTL)
    }

    pub fn with_ttl(ttl: Duration) -> Self {
        Self {
            ttl,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Mint a new random token, store it with `now + ttl` expiry, and return
    /// it. Opportunistically evicts expired entries so the map can't grow
    /// without bound under a stream of unconsumed tokens.
    pub fn mint(&self) -> String {
        self.mint_at(Instant::now())
    }

    fn mint_at(&self, now: Instant) -> String {
        let mut raw = [0u8; 32];
        rand::rng().fill_bytes(&mut raw);
        let token = BASE64URL.encode(raw);

        let mut entries = self.entries.lock().unwrap();
        entries.retain(|_, &mut expiry| expiry > now);
        entries.insert(token.clone(), now + self.ttl);
        token
    }

    /// Validate and atomically consume a token. Returns `true` exactly once
    /// for a given valid, unexpired token; any later call (or one for an
    /// unknown/expired token) returns `false`.
    pub fn consume(&self, token: &str) -> bool {
        self.consume_at(token, Instant::now())
    }

    fn consume_at(&self, token: &str, now: Instant) -> bool {
        let mut entries = self.entries.lock().unwrap();
        match entries.remove(token) {
            Some(expiry) => expiry > now,
            None => false,
        }
    }
}

impl Default for WsTokenStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mint_produces_unique_urlsafe_tokens() {
        let store = WsTokenStore::new();
        let a = store.mint();
        let b = store.mint();
        assert_ne!(a, b, "tokens must be unique");
        // 32 bytes URL-safe base64 (no pad) = 43 chars.
        assert_eq!(a.len(), 43);
        assert!(
            !a.contains('+') && !a.contains('/') && !a.contains('='),
            "token must be URL-safe with no padding: {a}"
        );
    }

    #[test]
    fn valid_token_consumes_once() {
        let store = WsTokenStore::new();
        let t = store.mint();
        assert!(store.consume(&t), "first consume of a valid token succeeds");
        assert!(
            !store.consume(&t),
            "second consume of the same token must fail (single-use)"
        );
    }

    #[test]
    fn unknown_token_is_rejected() {
        let store = WsTokenStore::new();
        assert!(!store.consume("does-not-exist"));
    }

    #[test]
    fn expired_token_is_rejected() {
        let store = WsTokenStore::with_ttl(Duration::from_secs(30));
        let now = Instant::now();
        let t = store.mint_at(now);
        // 31s later: past the 30s TTL.
        let later = now + Duration::from_secs(31);
        assert!(
            !store.consume_at(&t, later),
            "token past its TTL must be rejected"
        );
    }

    #[test]
    fn token_valid_right_up_to_expiry() {
        let store = WsTokenStore::with_ttl(Duration::from_secs(30));
        let now = Instant::now();
        let t = store.mint_at(now);
        // 29s later: still inside the window.
        let later = now + Duration::from_secs(29);
        assert!(store.consume_at(&t, later), "token within TTL is valid");
    }

    #[test]
    fn minting_evicts_expired_entries() {
        let store = WsTokenStore::with_ttl(Duration::from_secs(30));
        let now = Instant::now();
        let stale = store.mint_at(now);
        // Minting much later should sweep the stale entry out of the map.
        let _fresh = store.mint_at(now + Duration::from_secs(60));
        assert_eq!(
            store.entries.lock().unwrap().len(),
            1,
            "expired entries are evicted on mint"
        );
        // And the stale one is gone.
        assert!(!store.consume_at(&stale, now + Duration::from_secs(60)));
    }
}
