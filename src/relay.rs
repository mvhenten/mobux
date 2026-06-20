//! Mesh relay (EDD phase 2): stateless pass-through to peer mobux nodes.
//!
//! A node serves the UI same-origin and *relays* API + WebSocket traffic to any
//! peer on the tailnet, so one survivor's URL reaches every host. The relay:
//!
//! - forwards `/r/<peer>/api/...` (HTTP) and `/r/<peer>/ws/...` (WebSocket),
//! - swaps the client's `X-Mobux-Upstream-Authorization` into `Authorization`
//!   when forwarding (and never forwards the upstream header otherwise), so the
//!   relay stores no peer credentials,
//! - validates the peer's self-signed cert by **TOFU fingerprint pinning**
//!   (persisted in the sqlite db, see `db::peer_pin`), distinguishing a pin
//!   mismatch from any other failure,
//! - refuses to relay a request that is itself a relay path (loop guard).
//!
//! Peer resolution for phase 2 is intentionally minimal: a `peer` path segment
//! is `host` or `host:port` (default port = the relay's own mobux port). If
//! `MOBUX_PEERS` is set (comma-separated `host:port` list) the peer must be in
//! it; otherwise any peer is dialable (dev convenience). The integration point
//! with phase 1's `/api/peers` enumeration is exactly this allowlist.

use std::sync::{Arc, Mutex};

use axum::{
    body::Body,
    extract::{ws::Message as AxumMessage, Path, State, WebSocketUpgrade},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::aws_lc_rs;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as TungMessage;

use crate::AppState;

/// Header the client uses to carry the *peer's* Basic-auth creds. The relay
/// moves its value into `Authorization` for the forwarded request and strips
/// this header, so it never reaches the peer under its own name and is never
/// forwarded when absent.
pub const UPSTREAM_AUTH_HEADER: &str = "x-mobux-upstream-authorization";

/// Hop counter to break relay loops even across a multi-node chain (a peer that
/// is itself asked to relay back). Present + over the cap → refuse.
pub const HOP_HEADER: &str = "x-mobux-relay-hop";
const MAX_HOPS: u32 = 4;

/// The mobux port a bare `host` peer is assumed to listen on. The relay's own
/// public port (`PORT`) is the natural default in a homogeneous mesh.
fn default_peer_port() -> u16 {
    std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080)
}

/// Canonicalize a `peer` path segment (`host` or `host:port`) into `host:port`.
/// Rejects empty hosts, embedded slashes, and anything that already looks like
/// a relay path (defence in depth against crafted peer values).
pub fn canonical_peer(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("empty peer".into());
    }
    if raw.contains('/') || raw.contains(' ') {
        return Err("invalid peer (host or host:port only)".into());
    }
    match raw.rsplit_once(':') {
        Some((host, port)) => {
            if host.is_empty() {
                return Err("empty peer host".into());
            }
            let port: u16 = port
                .parse()
                .map_err(|_| format!("invalid peer port: {port}"))?;
            Ok(format!("{host}:{port}"))
        }
        None => Ok(format!("{raw}:{}", default_peer_port())),
    }
}

/// Enforce the optional `MOBUX_PEERS` allowlist. Empty/unset = allow any (dev).
fn peer_allowed(peer: &str) -> bool {
    match std::env::var("MOBUX_PEERS") {
        Ok(list) if !list.trim().is_empty() => list
            .split(',')
            .filter_map(|e| canonical_peer(e).ok())
            .any(|allowed| allowed == peer),
        _ => true,
    }
}

/// Compute the lowercase-hex SHA-256 of a cert DER — the pin fingerprint.
pub fn cert_fingerprint(der: &[u8]) -> String {
    let digest = Sha256::digest(der);
    hex::encode(digest)
}

// ── TOFU cert verifier ──────────────────────────────────────────────────────

/// Result of a pinned-TLS dial, distinguishing a pin mismatch (security event,
/// surfaced to the UI as a re-pin prompt) from any other failure.
#[derive(Debug)]
pub enum RelayError {
    /// The peer presented a cert whose fingerprint differs from the stored pin.
    PinMismatch { expected: String, actual: String },
    /// Transport/HTTP/parse failure — not a pinning decision.
    Upstream(String),
    /// Caller-side problem (bad peer, loop, allowlist) → 4xx.
    BadRequest(String),
}

impl RelayError {
    fn into_response(self) -> Response {
        match self {
            RelayError::PinMismatch { expected, actual } => structured_error(
                StatusCode::CONFLICT,
                "pin_mismatch",
                &format!(
                    "peer certificate fingerprint changed (pinned {expected}, got {actual}); \
                     delete the pin to re-trust this peer"
                ),
            ),
            RelayError::Upstream(msg) => {
                structured_error(StatusCode::BAD_GATEWAY, "upstream_error", &msg)
            }
            RelayError::BadRequest(msg) => {
                structured_error(StatusCode::BAD_REQUEST, "bad_request", &msg)
            }
        }
    }
}

fn structured_error(status: StatusCode, kind: &str, message: &str) -> Response {
    let body = serde_json::json!({ "error": kind, "message": message });
    (status, axum::Json(body)).into_response()
}

/// rustls verifier that pins the peer leaf cert by SHA-256.
///
/// `expected` is the stored pin (None on first contact). The observed leaf
/// fingerprint is captured into `observed` so the caller can persist it after a
/// successful first-contact handshake. A mismatch is recorded in `mismatch` and
/// surfaced as a `rustls::Error` so the handshake aborts; the caller maps that
/// back to `RelayError::PinMismatch` using `mismatch`.
#[derive(Debug)]
struct TofuVerifier {
    expected: Option<String>,
    observed: Mutex<Option<String>>,
    mismatch: Mutex<Option<(String, String)>>,
}

impl TofuVerifier {
    fn new(expected: Option<String>) -> Self {
        Self {
            expected,
            observed: Mutex::new(None),
            mismatch: Mutex::new(None),
        }
    }
}

impl ServerCertVerifier for TofuVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let fp = cert_fingerprint(end_entity.as_ref());
        *self.observed.lock().unwrap() = Some(fp.clone());

        match &self.expected {
            Some(pin) if pin != &fp => {
                *self.mismatch.lock().unwrap() = Some((pin.clone(), fp));
                Err(rustls::Error::General(
                    "mobux: peer cert pin mismatch".into(),
                ))
            }
            // Pinned & matching, or first contact (no pin yet): accept. We
            // deliberately ignore CA chain / hostname / expiry — peers serve
            // self-signed leafs and trust is the pin, exactly per the EDD.
            _ => Ok(ServerCertVerified::assertion()),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &aws_lc_rs::default_provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &aws_lc_rs::default_provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        aws_lc_rs::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// Build a rustls `ClientConfig` whose only trust anchor is the TOFU pin. The
/// returned `Arc<TofuVerifier>` lets the caller read the observed fingerprint /
/// mismatch after the handshake.
fn pinned_client_config(expected: Option<String>) -> (ClientConfig, Arc<TofuVerifier>) {
    let verifier = Arc::new(TofuVerifier::new(expected));
    let config = ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(verifier.clone())
        .with_no_client_auth();
    (config, verifier)
}

/// After a (possibly failed) pinned dial, turn the verifier state + transport
/// error into the right `RelayError`, and persist a first-contact pin.
fn resolve_pin_outcome(
    state: &AppState,
    peer: &str,
    had_pin: bool,
    verifier: &TofuVerifier,
    transport_err: Option<String>,
) -> Result<(), RelayError> {
    if let Some((expected, actual)) = verifier.mismatch.lock().unwrap().clone() {
        return Err(RelayError::PinMismatch { expected, actual });
    }
    if let Some(err) = transport_err {
        return Err(RelayError::Upstream(err));
    }
    // Success. On first contact, persist the observed fingerprint (TOFU).
    if !had_pin {
        if let Some(fp) = verifier.observed.lock().unwrap().clone() {
            if let Err(e) = state.db.insert_peer_pin(peer, &fp) {
                eprintln!("[relay] WARN: failed to persist pin for {peer}: {e:#}");
            }
        }
    }
    Ok(())
}

// ── Header plumbing ──────────────────────────────────────────────────────────

/// Headers that must not be copied verbatim onto the forwarded request: hop-by-
/// hop headers, the relay's own auth, the upstream-auth carrier (handled
/// specially), and Host (reqwest sets it from the target URL).
fn is_stripped_request_header(name: &HeaderName) -> bool {
    let n = name.as_str();
    n == header::HOST.as_str()
        || n == header::AUTHORIZATION.as_str()
        || n == header::CONNECTION.as_str()
        || n == header::COOKIE.as_str()
        || n == UPSTREAM_AUTH_HEADER
        || n == "keep-alive"
        || n == "proxy-authenticate"
        || n == "proxy-authorization"
        || n == "te"
        || n == "trailer"
        || n == "transfer-encoding"
        || n == "upgrade"
}

/// Build the header set to forward upstream: copy through everything not
/// stripped, then map `X-Mobux-Upstream-Authorization` → `Authorization`.
/// Returns the rebuilt map. The relay's own `Authorization` is dropped, so a
/// leaked relay credential never reaches the peer.
pub fn build_forward_headers(incoming: &HeaderMap) -> HeaderMap {
    let mut out = HeaderMap::new();
    for (name, value) in incoming.iter() {
        if is_stripped_request_header(name) {
            continue;
        }
        out.append(name.clone(), value.clone());
    }
    if let Some(upstream) = incoming.get(HeaderName::from_static(UPSTREAM_AUTH_HEADER)) {
        out.insert(header::AUTHORIZATION, upstream.clone());
    }
    out
}

/// Response headers we must not echo back to the browser (hop-by-hop +
/// re-set-by-axum framing).
fn is_stripped_response_header(name: &HeaderName) -> bool {
    let n = name.as_str();
    n == header::CONNECTION.as_str()
        || n == header::TRANSFER_ENCODING.as_str()
        || n == "keep-alive"
        || n == "proxy-authenticate"
        || n == "te"
        || n == "trailer"
        || n == "upgrade"
}

/// Reject requests that would form a relay loop: an already-relayed path, or a
/// hop count over the cap. Returns the next hop count to forward.
fn check_loop_guard(headers: &HeaderMap, forward_path: &str) -> Result<u32, RelayError> {
    if forward_path.starts_with("/r/") {
        return Err(RelayError::BadRequest(
            "refusing to relay a path that is itself a relay path (loop guard)".into(),
        ));
    }
    let hop = headers
        .get(HeaderName::from_static(HOP_HEADER))
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0);
    if hop >= MAX_HOPS {
        return Err(RelayError::BadRequest(format!(
            "relay hop limit ({MAX_HOPS}) exceeded (loop guard)"
        )));
    }
    Ok(hop + 1)
}

// ── HTTP relay handler ───────────────────────────────────────────────────────

/// `/r/{peer}/{*rest}` — forward an HTTP request to the peer's mobux port over
/// pinned HTTPS. `rest` is the path *after* the peer segment (e.g. `api/sessions`).
pub async fn relay_http(
    State(state): State<AppState>,
    Path((peer, rest)): Path<(String, String)>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    match relay_http_inner(state, peer, rest, method, uri, headers, body).await {
        Ok(resp) => resp,
        Err(e) => e.into_response(),
    }
}

#[allow(clippy::too_many_arguments)]
async fn relay_http_inner(
    state: AppState,
    peer: String,
    rest: String,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, RelayError> {
    let peer = canonical_peer(&peer).map_err(RelayError::BadRequest)?;
    if !peer_allowed(&peer) {
        return Err(RelayError::BadRequest(format!(
            "peer {peer} not in MOBUX_PEERS allowlist"
        )));
    }

    let forward_path = format!("/{}", rest.trim_start_matches('/'));
    let next_hop = check_loop_guard(&headers, &forward_path)?;

    let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    let url_str = format!("https://{peer}{forward_path}{query}");
    // Parse the target URL up front. reqwest's `request(method, &str)` defers
    // URL parsing to `.send()`, where a parse failure surfaces as an opaque
    // `Builder`-kind error that `Display`s as the bare string "builder error"
    // — the exact "Failed to load sessions: builder error" the UI showed when
    // a relayed path/peer didn't form a valid URL. Parse it here so a malformed
    // URL becomes an actionable message instead.
    let url = reqwest::Url::parse(&url_str)
        .map_err(|e| RelayError::BadRequest(format!("invalid peer URL ({url_str}): {e}")))?;

    let body_bytes = axum::body::to_bytes(body, usize::MAX)
        .await
        .map_err(|e| RelayError::BadRequest(format!("reading request body: {e}")))?;

    let mut fwd_headers = build_forward_headers(&headers);
    fwd_headers.insert(
        HeaderName::from_static(HOP_HEADER),
        HeaderValue::from_str(&next_hop.to_string()).unwrap(),
    );

    let pin = state
        .db
        .peer_pin(&peer)
        .map_err(|e| RelayError::Upstream(format!("reading pin: {e}")))?;
    let had_pin = pin.is_some();
    let (tls, verifier) = pinned_client_config(pin);

    let client = reqwest::Client::builder()
        .use_preconfigured_tls(tls)
        // Peers are on the tailnet; keep the hop snappy and fail fast.
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| RelayError::Upstream(format!("building client: {e}")))?;

    let upstream = client
        .request(method, url)
        .headers(fwd_headers)
        .body(body_bytes)
        .send()
        .await;

    let resp = match upstream {
        Ok(r) => {
            resolve_pin_outcome(&state, &peer, had_pin, &verifier, None)?;
            r
        }
        Err(e) => {
            resolve_pin_outcome(&state, &peer, had_pin, &verifier, Some(e.to_string()))?;
            // resolve_pin_outcome already returned on mismatch/upstream; this
            // is unreachable, but keep the type checker happy.
            return Err(RelayError::Upstream(e.to_string()));
        }
    };

    let status = resp.status();
    let resp_headers = resp.headers().clone();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| RelayError::Upstream(format!("reading upstream body: {e}")))?;

    let mut out = Response::builder().status(status);
    for (name, value) in resp_headers.iter() {
        if is_stripped_response_header(name) {
            continue;
        }
        out = out.header(name, value);
    }
    out.body(Body::from(bytes))
        .map_err(|e| RelayError::Upstream(format!("building response: {e}")))
}

// ── WebSocket relay handler ──────────────────────────────────────────────────

/// `/r/{peer}/ws/{*rest}` — relay a WebSocket upgrade to the peer.
///
/// Browsers cannot set headers on a WS upgrade, so the same-origin terminal WS
/// authenticates via the `mobux_session` cookie (see `auth_middleware`). The
/// relay endpoint is behind that same middleware, so reaching it already proves
/// the client is authed to *this* node. For the peer's creds we mirror the
/// browser's constraint: the client passes the peer Basic-auth in the
/// `?upstream_auth=<base64(user:pass)>` query param, which the relay turns into
/// an `Authorization` header on the *server-to-peer* upgrade (server-side, so it
/// never rides an actual browser WS header). Documented in the PR.
pub async fn relay_ws(
    State(state): State<AppState>,
    Path((peer, rest)): Path<(String, String)>,
    uri: Uri,
    ws: WebSocketUpgrade,
) -> Response {
    let peer = match canonical_peer(&peer) {
        Ok(p) => p,
        Err(e) => return RelayError::BadRequest(e).into_response(),
    };
    if !peer_allowed(&peer) {
        return RelayError::BadRequest(format!("peer {peer} not in MOBUX_PEERS allowlist"))
            .into_response();
    }

    // The route is `/r/{peer}/ws/{*rest}`, so `rest` is the path *after* `ws/`
    // (e.g. the session name). Re-prepend `/ws/` to hit the peer's WS endpoint.
    let forward_path = format!("/ws/{}", rest.trim_start_matches('/'));
    if forward_path.starts_with("/r/") {
        return RelayError::BadRequest("loop guard: relay path".into()).into_response();
    }

    // Pull the peer creds + strip them from the query we forward upstream.
    let (upstream_auth, fwd_query) = split_ws_query(uri.query());
    let target = format!("wss://{peer}{forward_path}{fwd_query}");

    let pin = match state.db.peer_pin(&peer) {
        Ok(p) => p,
        Err(e) => return RelayError::Upstream(format!("reading pin: {e}")).into_response(),
    };

    ws.on_upgrade(move |client_socket| async move {
        if let Err(e) = pump_ws(state, peer, target, upstream_auth, pin, client_socket).await {
            eprintln!("[relay] ws error: {e}");
        }
    })
}

/// Split a relay WS query string into (upstream_auth value, forwarded query).
/// `upstream_auth` is consumed by the relay and never forwarded.
fn split_ws_query(query: Option<&str>) -> (Option<String>, String) {
    let Some(q) = query else {
        return (None, String::new());
    };
    let mut auth = None;
    let mut kept: Vec<&str> = Vec::new();
    for pair in q.split('&') {
        if let Some(v) = pair.strip_prefix("upstream_auth=") {
            auth = Some(v.to_string());
        } else if !pair.is_empty() {
            kept.push(pair);
        }
    }
    let fwd = if kept.is_empty() {
        String::new()
    } else {
        format!("?{}", kept.join("&"))
    };
    (auth, fwd)
}

async fn pump_ws(
    state: AppState,
    peer: String,
    target: String,
    upstream_auth: Option<String>,
    pin: Option<String>,
    client_socket: axum::extract::ws::WebSocket,
) -> Result<(), String> {
    let had_pin = pin.is_some();
    let (tls, verifier) = pinned_client_config(pin);
    let connector = tokio_tungstenite::Connector::Rustls(Arc::new(tls));

    let mut request = target
        .into_client_request()
        .map_err(|e| format!("building ws request: {e}"))?;
    if let Some(auth) = upstream_auth {
        // `upstream_auth` is URL-encoded base64(user:pass); decode the percent-
        // encoding minimally (only '%XX' and '+') and send as Basic auth.
        let decoded = percent_decode(&auth);
        request.headers_mut().insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Basic {decoded}"))
                .map_err(|e| format!("bad upstream auth: {e}"))?,
        );
    }

    let dial =
        tokio_tungstenite::connect_async_tls_with_config(request, None, false, Some(connector))
            .await;

    let (peer_ws, _resp) = match dial {
        Ok(ok) => {
            resolve_pin_outcome(&state, &peer, had_pin, &verifier, None)
                .map_err(|e| format!("{e:?}"))?;
            ok
        }
        Err(e) => {
            // Map a pin mismatch to a clear log; the client just sees the WS
            // close since headers are already negotiated with the browser.
            resolve_pin_outcome(&state, &peer, had_pin, &verifier, Some(e.to_string()))
                .map_err(|e| format!("{e:?}"))?;
            return Err(format!("ws dial: {e}"));
        }
    };

    let (mut peer_tx, mut peer_rx) = peer_ws.split();
    let (mut client_tx, mut client_rx) = client_socket.split();

    loop {
        tokio::select! {
            // browser → peer
            msg = client_rx.next() => match msg {
                Some(Ok(m)) => {
                    if let Some(tm) = axum_to_tung(m) {
                        if peer_tx.send(tm).await.is_err() { break; }
                    }
                }
                _ => break,
            },
            // peer → browser
            msg = peer_rx.next() => match msg {
                Some(Ok(m)) => {
                    if let Some(am) = tung_to_axum(m) {
                        if client_tx.send(am).await.is_err() { break; }
                    }
                }
                _ => break,
            },
        }
    }
    Ok(())
}

fn axum_to_tung(m: AxumMessage) -> Option<TungMessage> {
    match m {
        AxumMessage::Text(t) => Some(TungMessage::Text(t.as_str().into())),
        AxumMessage::Binary(b) => Some(TungMessage::Binary(b)),
        AxumMessage::Ping(p) => Some(TungMessage::Ping(p)),
        AxumMessage::Pong(p) => Some(TungMessage::Pong(p)),
        AxumMessage::Close(_) => Some(TungMessage::Close(None)),
    }
}

fn tung_to_axum(m: TungMessage) -> Option<AxumMessage> {
    match m {
        TungMessage::Text(t) => Some(AxumMessage::Text(t.as_str().into())),
        TungMessage::Binary(b) => Some(AxumMessage::Binary(b)),
        TungMessage::Ping(p) => Some(AxumMessage::Ping(p)),
        TungMessage::Pong(p) => Some(AxumMessage::Pong(p)),
        TungMessage::Close(_) => Some(AxumMessage::Close(None)),
        // tungstenite's raw frame variant has no axum analogue; drop it.
        TungMessage::Frame(_) => None,
    }
}

/// Minimal percent-decode for the `upstream_auth` query value (`%XX` + `+`).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ── Pin management endpoint ──────────────────────────────────────────────────

/// `DELETE /api/peers/{peer}/pin` — drop a peer's pin so the next contact
/// re-pins (one-tap re-trust after a peer reinstall). Authed via the normal
/// middleware. Returns `{deleted: bool}`.
pub async fn delete_peer_pin(State(state): State<AppState>, Path(peer): Path<String>) -> Response {
    let peer = match canonical_peer(&peer) {
        Ok(p) => p,
        Err(e) => return RelayError::BadRequest(e).into_response(),
    };
    match state.db.delete_peer_pin(&peer) {
        Ok(deleted) => (
            StatusCode::OK,
            axum::Json(serde_json::json!({ "deleted": deleted })),
        )
            .into_response(),
        Err(e) => RelayError::Upstream(format!("deleting pin: {e}")).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hv(s: &str) -> HeaderValue {
        HeaderValue::from_str(s).unwrap()
    }

    // ── fingerprint pin/verify/mismatch ──────────────────────────────────────

    #[test]
    fn fingerprint_is_stable_lowercase_hex_sha256() {
        let fp = cert_fingerprint(b"hello");
        // Known SHA-256("hello").
        assert_eq!(
            fp,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert_eq!(fp, cert_fingerprint(b"hello"), "deterministic");
        assert_ne!(fp, cert_fingerprint(b"hella"), "input-sensitive");
    }

    #[test]
    fn verifier_records_observed_on_first_contact() {
        let v = TofuVerifier::new(None);
        let der = CertificateDer::from(b"fake-cert-der".to_vec());
        let name = ServerName::try_from("peer.example").unwrap();
        let ok = v.verify_server_cert(&der, &[], &name, &[], UnixTime::now());
        assert!(ok.is_ok(), "first contact accepts");
        assert_eq!(
            v.observed.lock().unwrap().clone(),
            Some(cert_fingerprint(b"fake-cert-der"))
        );
        assert!(v.mismatch.lock().unwrap().is_none());
    }

    #[test]
    fn verifier_accepts_matching_pin() {
        let der = CertificateDer::from(b"cert".to_vec());
        let v = TofuVerifier::new(Some(cert_fingerprint(b"cert")));
        let name = ServerName::try_from("peer.example").unwrap();
        assert!(v
            .verify_server_cert(&der, &[], &name, &[], UnixTime::now())
            .is_ok());
        assert!(v.mismatch.lock().unwrap().is_none());
    }

    #[test]
    fn verifier_flags_pin_mismatch() {
        let der = CertificateDer::from(b"new-cert".to_vec());
        let v = TofuVerifier::new(Some("deadbeef".to_string()));
        let name = ServerName::try_from("peer.example").unwrap();
        let res = v.verify_server_cert(&der, &[], &name, &[], UnixTime::now());
        assert!(res.is_err(), "mismatch aborts handshake");
        let (expected, actual) = v.mismatch.lock().unwrap().clone().unwrap();
        assert_eq!(expected, "deadbeef");
        assert_eq!(actual, cert_fingerprint(b"new-cert"));
    }

    // ── header-swap logic ────────────────────────────────────────────────────

    #[test]
    fn forward_headers_swap_upstream_auth_into_authorization() {
        let mut h = HeaderMap::new();
        h.insert(header::AUTHORIZATION, hv("Basic relay-creds"));
        h.insert(
            HeaderName::from_static(UPSTREAM_AUTH_HEADER),
            hv("Basic peer-creds"),
        );
        h.insert(header::CONTENT_TYPE, hv("application/json"));

        let out = build_forward_headers(&h);
        assert_eq!(
            out.get(header::AUTHORIZATION).unwrap(),
            "Basic peer-creds",
            "upstream auth becomes Authorization"
        );
        assert!(
            out.get(HeaderName::from_static(UPSTREAM_AUTH_HEADER))
                .is_none(),
            "upstream header is stripped, never forwarded"
        );
        assert_eq!(out.get(header::CONTENT_TYPE).unwrap(), "application/json");
    }

    #[test]
    fn forward_headers_drop_relay_auth_when_no_upstream() {
        let mut h = HeaderMap::new();
        h.insert(header::AUTHORIZATION, hv("Basic relay-creds"));
        h.insert(header::COOKIE, hv("mobux_session=secret"));
        let out = build_forward_headers(&h);
        assert!(
            out.get(header::AUTHORIZATION).is_none(),
            "relay's own creds never reach the peer"
        );
        assert!(
            out.get(header::COOKIE).is_none(),
            "relay cookie not forwarded"
        );
    }

    // ── peer canonicalization + loop guard ───────────────────────────────────

    #[test]
    fn canonical_peer_adds_default_port_and_validates() {
        // Default port comes from PORT (unset in test → 8080).
        std::env::remove_var("PORT");
        assert_eq!(canonical_peer("host-b").unwrap(), "host-b:8080");
        assert_eq!(canonical_peer("host-b:5151").unwrap(), "host-b:5151");
        assert!(canonical_peer("").is_err());
        assert!(canonical_peer("a/b").is_err());
        assert!(canonical_peer("host:notaport").is_err());
    }

    #[test]
    fn loop_guard_rejects_relay_paths_and_hop_cap() {
        let h = HeaderMap::new();
        assert!(check_loop_guard(&h, "/r/other/api/x").is_err());
        assert_eq!(check_loop_guard(&h, "/api/sessions").unwrap(), 1);

        let mut h2 = HeaderMap::new();
        h2.insert(HeaderName::from_static(HOP_HEADER), hv("2"));
        assert_eq!(check_loop_guard(&h2, "/api/sessions").unwrap(), 3);

        let mut h3 = HeaderMap::new();
        h3.insert(
            HeaderName::from_static(HOP_HEADER),
            hv(&MAX_HOPS.to_string()),
        );
        assert!(check_loop_guard(&h3, "/api/sessions").is_err());
    }

    #[test]
    fn split_ws_query_extracts_and_strips_upstream_auth() {
        let (auth, fwd) = split_ws_query(Some("token=abc&upstream_auth=QmFzaWM&x=1"));
        assert_eq!(auth.as_deref(), Some("QmFzaWM"));
        assert_eq!(fwd, "?token=abc&x=1");

        let (auth2, fwd2) = split_ws_query(Some("upstream_auth=only"));
        assert_eq!(auth2.as_deref(), Some("only"));
        assert_eq!(fwd2, "");

        let (auth3, fwd3) = split_ws_query(None);
        assert!(auth3.is_none());
        assert_eq!(fwd3, "");
    }

    #[test]
    fn forwarded_url_parses_for_normal_paths() {
        // The relay parses `https://{peer}{path}{query}` up front so a parse
        // failure is a clear BadRequest instead of reqwest's opaque deferred
        // "builder error". A normal relayed API path must parse cleanly.
        let url = reqwest::Url::parse("https://devbox:5151/api/sessions?x=1");
        assert!(url.is_ok());
        // A malformed authority (e.g. an unclosed IPv6 bracket) must be
        // rejected here, rather than slipping through to reqwest's `.send()`
        // where it surfaces as the opaque "builder error".
        assert!(reqwest::Url::parse("https://[bad:5151/api/sessions").is_err());
    }

    #[test]
    fn percent_decode_handles_basic_creds() {
        // base64 can contain '+' and '/'; '+' must stay '+' if percent-encoded,
        // but a literal '+' decodes to space (query convention). Caller encodes
        // base64 with %2B for '+', so:
        assert_eq!(percent_decode("dXNlcjpwYXNz"), "dXNlcjpwYXNz");
        assert_eq!(percent_decode("a%2Bb"), "a+b");
        assert_eq!(percent_decode("a%2Fb"), "a/b");
    }
}
