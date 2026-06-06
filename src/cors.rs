//! Cross-origin support for the fat-client architecture.
//!
//! By default mobux is same-origin only: the embedded frontend is served from
//! the same host it talks to, so no CORS headers are emitted and browsers
//! enforce same-origin as usual. When `MOBUX_ALLOWED_ORIGINS` is set (a
//! comma-separated list of exact origins, e.g.
//! `https://mvhenten.github.io,https://app.example.com`), a standalone
//! frontend hosted on one of those origins may call this backend's API and
//! open WebSockets directly.
//!
//! Because the frontend authenticates with credentials (Basic auth header /
//! session cookie), CORS runs in *credentials mode*: we must echo the matched
//! origin (never `*`) and send `Access-Control-Allow-Credentials: true`.
//!
//! Chrome's Private Network Access (PNA) adds a wrinkle: a page on a public
//! origin (GitHub Pages) calling a backend on a private network (the tailnet)
//! triggers a preflight carrying `Access-Control-Request-Private-Network:
//! true`. The server must answer `Access-Control-Allow-Private-Network: true`
//! or the request is blocked. `CorsLayer` doesn't emit that header, so a small
//! middleware (`private_network_access`) adds it on preflight responses whose
//! origin is on the allowlist.

use std::sync::Arc;

use axum::{
    extract::State,
    http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode},
    middleware::Next,
    response::Response,
};
use tower_http::cors::{AllowOrigin, CorsLayer};

/// Header Chrome sends on a PNA preflight.
const REQ_PRIVATE_NETWORK: &str = "access-control-request-private-network";
/// Header the server must echo to grant PNA access.
const ALLOW_PRIVATE_NETWORK: &str = "access-control-allow-private-network";

/// Parse `MOBUX_ALLOWED_ORIGINS` into a normalized origin list.
///
/// Empty/whitespace entries are dropped; surrounding whitespace and a trailing
/// slash are trimmed so `https://x.com/` and `https://x.com` match. An
/// empty/unset value yields an empty list, which means "no CORS" (today's
/// same-origin-only behavior).
pub fn parse_allowed_origins(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim().trim_end_matches('/'))
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// Whether `origin` (an `Origin` header value) is on the allowlist. Matching is
/// exact (scheme + host + port), case-sensitive per the URL origin rules, with
/// a tolerated trailing slash on the request value.
pub fn origin_allowed(allowed: &[String], origin: &str) -> bool {
    let origin = origin.trim_end_matches('/');
    allowed.iter().any(|a| a == origin)
}

/// Build a credentials-mode `CorsLayer` for the configured allowlist, or
/// `None` when the allowlist is empty (same-origin-only).
///
/// The layer echoes the matched origin, allows credentials, the verbs the API
/// uses, and the `Authorization` + `Content-Type` request headers (so
/// cross-origin Basic auth and JSON bodies work), and handles OPTIONS
/// preflight for every route it wraps.
pub fn build_cors_layer(allowed: Vec<String>) -> Option<CorsLayer> {
    if allowed.is_empty() {
        return None;
    }

    let allowed = Arc::new(allowed);
    let predicate = AllowOrigin::predicate(move |origin: &HeaderValue, _req| {
        origin
            .to_str()
            .map(|o| origin_allowed(&allowed, o))
            .unwrap_or(false)
    });

    Some(
        CorsLayer::new()
            .allow_origin(predicate)
            .allow_credentials(true)
            .allow_methods([
                Method::GET,
                Method::POST,
                Method::PUT,
                Method::DELETE,
                Method::OPTIONS,
            ])
            .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]),
    )
}

/// Decide whether a request is a PNA preflight that should be granted: it must
/// be an `OPTIONS` request carrying `Access-Control-Request-Private-Network:
/// true` from an allowlisted origin. Extracted as a pure function so the
/// decision is unit-testable without a full middleware harness.
pub fn should_grant_private_network(
    method: &Method,
    headers: &HeaderMap,
    allowed: &[String],
) -> bool {
    if method != Method::OPTIONS {
        return false;
    }
    let wants_private_network = headers
        .get(REQ_PRIVATE_NETWORK)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let origin_ok = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(|o| origin_allowed(allowed, o))
        .unwrap_or(false);
    wants_private_network && origin_ok
}

/// Middleware adding `Access-Control-Allow-Private-Network: true` to preflight
/// responses for allowlisted origins that requested it. No-op for everything
/// else (non-OPTIONS, non-PNA, or off-allowlist origins).
pub async fn private_network_access(
    State(allowed): State<Arc<Vec<String>>>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let grant = should_grant_private_network(req.method(), req.headers(), &allowed);

    let mut resp = next.run(req).await;

    if grant {
        resp.headers_mut()
            .insert(ALLOW_PRIVATE_NETWORK, HeaderValue::from_static("true"));
        // A bare preflight reaching the fallback would be a redirect; make sure
        // the browser sees a clean 2xx/no-content for the PNA preflight.
        if resp.status().is_redirection() {
            *resp.status_mut() = StatusCode::NO_CONTENT;
        }
    }

    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_empty_yields_no_origins() {
        assert!(parse_allowed_origins("").is_empty());
        assert!(parse_allowed_origins("   ").is_empty());
        assert!(parse_allowed_origins(",, ,").is_empty());
    }

    #[test]
    fn parse_splits_and_trims() {
        let got = parse_allowed_origins(
            " https://a.example.com , https://b.example.com/ ,https://c.example.com",
        );
        assert_eq!(
            got,
            vec![
                "https://a.example.com".to_string(),
                "https://b.example.com".to_string(),
                "https://c.example.com".to_string(),
            ]
        );
    }

    #[test]
    fn matching_is_exact() {
        let allowed = parse_allowed_origins("https://app.example.com");
        assert!(origin_allowed(&allowed, "https://app.example.com"));
        // trailing slash on the request value is tolerated
        assert!(origin_allowed(&allowed, "https://app.example.com/"));
        // different scheme, host, or port must not match
        assert!(!origin_allowed(&allowed, "http://app.example.com"));
        assert!(!origin_allowed(&allowed, "https://evil.example.com"));
        assert!(!origin_allowed(&allowed, "https://app.example.com:8443"));
        assert!(!origin_allowed(
            &allowed,
            "https://app.example.com.evil.com"
        ));
    }

    #[test]
    fn no_layer_when_allowlist_empty() {
        assert!(build_cors_layer(vec![]).is_none());
    }

    #[test]
    fn layer_built_when_allowlist_present() {
        assert!(build_cors_layer(parse_allowed_origins("https://app.example.com")).is_some());
    }

    fn pna_headers(origin: &str, request_private: bool) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
        if request_private {
            h.insert(REQ_PRIVATE_NETWORK, HeaderValue::from_static("true"));
        }
        h
    }

    #[test]
    fn pna_granted_for_allowlisted_preflight() {
        let allowed = parse_allowed_origins("https://app.example.com");
        let headers = pna_headers("https://app.example.com", true);
        assert!(should_grant_private_network(
            &Method::OPTIONS,
            &headers,
            &allowed
        ));
    }

    #[test]
    fn pna_denied_for_non_preflight() {
        let allowed = parse_allowed_origins("https://app.example.com");
        let headers = pna_headers("https://app.example.com", true);
        // A real (non-OPTIONS) request never gets the PNA grant header.
        assert!(!should_grant_private_network(
            &Method::GET,
            &headers,
            &allowed
        ));
    }

    #[test]
    fn pna_denied_when_header_absent() {
        let allowed = parse_allowed_origins("https://app.example.com");
        let headers = pna_headers("https://app.example.com", false);
        assert!(!should_grant_private_network(
            &Method::OPTIONS,
            &headers,
            &allowed
        ));
    }

    #[test]
    fn pna_denied_for_offlist_origin() {
        let allowed = parse_allowed_origins("https://app.example.com");
        let headers = pna_headers("https://evil.example.com", true);
        assert!(!should_grant_private_network(
            &Method::OPTIONS,
            &headers,
            &allowed
        ));
    }
}
