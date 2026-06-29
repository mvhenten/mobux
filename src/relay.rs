//! Mesh relay (EDD phase 2): stateless pass-through to peer mobux nodes.
//!
//! A node serves the UI same-origin and *relays* API + WebSocket traffic to any
//! peer on the tailnet, so one survivor's URL reaches every host. The relay:
//!
//! - forwards `/r/<peer>/api/...` (HTTP) and `/r/<peer>/ws/...` (WebSocket),
//! - swaps the client's `X-Mobux-Upstream-Authorization` into `Authorization`
//!   when forwarding (and never forwards the upstream header otherwise), so the
//!   relay stores no peer credentials,
//! - accepts the peer's self-signed cert unconditionally (trust comes from the
//!   peer's password, not transport cert verification),
//! - refuses to relay a request that is itself a relay path (loop guard).
//!
//! Peer resolution for phase 2 is intentionally minimal: a `peer` path segment
//! is base64url-encoded `host:port` (new encoding) or `host:port`/`host` plain
//! for backward compat. Default port = the relay's own mobux port. If
//! `MOBUX_PEERS` is set (comma-separated `host:port` list) the peer must be in
//! it; otherwise any peer is dialable (dev convenience). The integration point
//! with phase 1's `/api/peers` enumeration is exactly this allowlist.

use std::sync::Arc;

use axum::{
    body::Body,
    extract::{ws::Message as AxumMessage, Path, WebSocketUpgrade},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::{SinkExt, StreamExt};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::aws_lc_rs;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as TungMessage;

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

/// Percent-decode `%XX` sequences in a path segment (no `+`→space, path
/// segments are not query strings).  Returns `Err` if the input contains an
/// invalid or incomplete `%XX` sequence, or if a decoded `%2F` (slash) or any
/// residual `%` remains after decoding (guards against path-traversal /
/// double-encoding attacks).
fn decode_peer_segment(s: &str) -> Result<String, String> {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err(format!("invalid percent-encoding in peer: {s}"));
            }
            let hi = char::from(bytes[i + 1])
                .to_digit(16)
                .ok_or_else(|| format!("invalid percent-encoding in peer: {s}"))?;
            let lo = char::from(bytes[i + 2])
                .to_digit(16)
                .ok_or_else(|| format!("invalid percent-encoding in peer: {s}"))?;
            let decoded = ((hi << 4) | lo) as u8;
            out.push(decoded as char);
            i += 3;
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    // Reject if decoded result still contains a '%' (double-encoded) or '/'
    if out.contains('%') {
        return Err(format!(
            "residual percent-encoding in peer after decode: {s}"
        ));
    }
    Ok(out)
}

/// Canonicalize a `peer` path segment into `host:port`.
///
/// Accepts three encodings, tried in order:
/// 1. Base64url (`A-Za-z0-9_-`): the new encoding; avoids colon-in-path issues.
///    Only accepted when the decoded result contains `:` (i.e. it's a host:port).
/// 2. Percent-encoded (`host%3Aport`): backward compat for old clients.
/// 3. Plain `host` or `host:port`.
pub fn canonical_peer(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("empty peer".into());
    }

    // Try base64url decode when the segment is all base64url chars (no `%` or `:`).
    // A decoded value that contains `:` is a host:port pair — use it directly.
    // Bare hostnames (no port) also land here but their decoded bytes won't
    // contain `:`, so they fall through cleanly to the percent-decode path.
    let is_b64url = !raw.contains('%')
        && !raw.contains(':')
        && raw
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '=');
    if is_b64url {
        if let Ok(bytes) = URL_SAFE_NO_PAD.decode(raw) {
            if let Ok(decoded) = String::from_utf8(bytes) {
                if decoded.contains(':') {
                    return parse_peer_str(decoded.trim());
                }
            }
        }
    }

    // Fall back: percent-decode (backward compat) then parse as host[:port].
    let decoded = decode_peer_segment(raw)?;
    parse_peer_str(&decoded)
}

/// Parse an already-decoded `host` or `host:port` string into canonical `host:port`.
fn parse_peer_str(s: &str) -> Result<String, String> {
    if s.contains('/') || s.contains(' ') {
        return Err("invalid peer (host or host:port only)".into());
    }
    match s.rsplit_once(':') {
        Some((host, port)) => {
            if host.is_empty() {
                return Err("empty peer host".into());
            }
            let port: u16 = port
                .parse()
                .map_err(|_| format!("invalid peer port: {port}"))?;
            Ok(format!("{host}:{port}"))
        }
        None => Ok(format!("{s}:{}", default_peer_port())),
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

// ── TLS verifier ─────────────────────────────────────────────────────────────

/// Relay errors surfaced to the caller.
#[derive(Debug)]
pub enum RelayError {
    /// Transport/HTTP/parse failure.
    Upstream(String),
    /// Caller-side problem (bad peer, loop, allowlist) → 4xx.
    BadRequest(String),
}

impl RelayError {
    fn into_response(self) -> Response {
        match self {
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

/// Simple accept-all TLS verifier for peers with self-signed certs.
/// Security comes from the peer's password, not transport cert verification.
#[derive(Debug)]
struct AcceptAnyCert;

impl ServerCertVerifier for AcceptAnyCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
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

/// Build a rustls `ClientConfig` that accepts any self-signed peer cert.
fn accept_any_cert_config() -> ClientConfig {
    ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAnyCert))
        .with_no_client_auth()
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
/// re-set-by-axum framing). `WWW-Authenticate` is stripped on *every* relayed
/// response (not just 401s): if it reached the browser on the relay origin the
/// browser would pop its native Basic-auth "Sign in" dialog before the SPA's JS
/// could intercept the 401 and show the in-app credential prompt. The 401
/// status + body still pass through, so the client knows auth is needed.
fn is_stripped_response_header(name: &HeaderName) -> bool {
    let n = name.as_str();
    n == header::CONNECTION.as_str()
        || n == header::TRANSFER_ENCODING.as_str()
        || n == header::WWW_AUTHENTICATE.as_str()
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

/// `/r/{peer}/{*rest}` — forward an HTTP request to the peer's mobux port.
/// `rest` is the path *after* the peer segment (e.g. `api/sessions`).
pub async fn relay_http(
    Path((peer, rest)): Path<(String, String)>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    match relay_http_inner(peer, rest, method, uri, headers, body).await {
        Ok(resp) => resp,
        Err(e) => e.into_response(),
    }
}

async fn relay_http_inner(
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

    let client = reqwest::Client::builder()
        .use_preconfigured_tls(accept_any_cert_config())
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
        Ok(r) => r,
        Err(e) => return Err(RelayError::Upstream(e.to_string())),
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
/// never rides an actual browser WS header).
pub async fn relay_ws(
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

    ws.on_upgrade(move |client_socket| async move {
        if let Err(e) = pump_ws(target, upstream_auth, client_socket).await {
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
    target: String,
    upstream_auth: Option<String>,
    client_socket: axum::extract::ws::WebSocket,
) -> Result<(), String> {
    let connector = tokio_tungstenite::Connector::Rustls(Arc::new(accept_any_cert_config()));

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
        Ok(ok) => ok,
        Err(e) => return Err(format!("ws dial: {e}")),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn hv(s: &str) -> HeaderValue {
        HeaderValue::from_str(s).unwrap()
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

    #[test]
    fn response_strips_www_authenticate_so_browser_never_prompts() {
        // A peer 401 carries `WWW-Authenticate: Basic realm=...`. If the relay
        // echoed it back on its own origin, the browser would show its native
        // "Sign in" dialog before the SPA could intercept the 401. The header
        // must be stripped on every relayed response; the 401 status + body
        // still pass through so JS can react and show the in-app prompt.
        assert!(
            is_stripped_response_header(&header::WWW_AUTHENTICATE),
            "WWW-Authenticate must never be forwarded to the browser"
        );
        // Sanity: a benign header is still forwarded.
        assert!(!is_stripped_response_header(&header::CONTENT_TYPE));

        // Mirror the response-builder copy loop (relay_http_inner ~line 438):
        // build the peer's 401 header set, then copy through the same filter the
        // relay uses and assert WWW-Authenticate is gone but status is intact.
        let mut peer_headers = HeaderMap::new();
        peer_headers.insert(
            header::WWW_AUTHENTICATE,
            hv("Basic realm=\"mobux\", charset=\"UTF-8\""),
        );
        peer_headers.insert(header::CONTENT_TYPE, hv("application/json"));

        let status = StatusCode::UNAUTHORIZED;
        let mut out = Response::builder().status(status);
        for (name, value) in peer_headers.iter() {
            if is_stripped_response_header(name) {
                continue;
            }
            out = out.header(name, value);
        }
        let resp = out.body(Body::empty()).unwrap();

        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "401 preserved");
        assert!(
            resp.headers().get(header::WWW_AUTHENTICATE).is_none(),
            "relay must not forward the peer's WWW-Authenticate challenge"
        );
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/json",
            "non-stripped headers still pass through"
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

    #[test]
    fn canonical_peer_decodes_encoded_colon() {
        assert_eq!(
            canonical_peer("devbox.example.ts.net%3A5151"),
            Ok("devbox.example.ts.net:5151".to_string())
        );
    }

    #[test]
    fn canonical_peer_bare_host_gets_default_port() {
        assert_eq!(
            canonical_peer("devbox.example.ts.net"),
            Ok(format!("devbox.example.ts.net:{}", default_peer_port()))
        );
    }

    #[test]
    fn canonical_peer_raw_host_port_back_compat() {
        assert_eq!(canonical_peer("host:5151"), Ok("host:5151".to_string()));
    }

    #[test]
    fn canonical_peer_rejects_encoded_slash() {
        assert!(canonical_peer("host%2Fevil:5151").is_err());
    }

    #[test]
    fn canonical_peer_rejects_leftover_percent() {
        assert!(canonical_peer("host%ZZevil:5151").is_err());
    }

    // ── base64url peer encoding roundtrip ────────────────────────────────────

    #[test]
    fn peer_encoding_roundtrip_base64url() {
        // host:port with a colon must survive base64url encode → canonical_peer
        // without corruption. Regression test for the "session can't be opened"
        // bug where percent-encoding mangled the colon in the path segment.
        std::env::remove_var("PORT");

        let original = "192.168.1.5:8080";
        let encoded = URL_SAFE_NO_PAD.encode(original);
        let decoded = canonical_peer(&encoded).unwrap();
        assert_eq!(decoded, "192.168.1.5:8080");

        // Tailscale FQDN with port
        let ts = "devbox.example.ts.net:5151";
        let encoded2 = URL_SAFE_NO_PAD.encode(ts);
        let decoded2 = canonical_peer(&encoded2).unwrap();
        assert_eq!(decoded2, ts);
    }
}
