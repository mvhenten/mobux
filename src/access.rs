//! Cloudflare Access token verification for the Access listener (#333).
//! Checks the JWT Cloudflare puts on every request it lets through against
//! the team's published keys, the application AUD and the identity allowlist.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use jsonwebtoken::errors::ErrorKind;
use jsonwebtoken::jwk::{AlgorithmParameters, Jwk};
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use tokio::sync::{Mutex, RwLock};

use crate::config::AccessConfig;

pub const ASSERTION_HEADER: &str = "cf-access-jwt-assertion";
pub const AUTHORIZATION_COOKIE: &str = "CF_Authorization";

pub const CHALLENGE: &str = "Bearer realm=\"cloudflare-access\"";

const CLOCK_LEEWAY_SECS: u64 = 30;
const MIN_REFETCH_INTERVAL: Duration = Duration::from_secs(60);
const JWKS_FETCH_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Identity {
    Email(String),
    ServiceToken(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified {
    pub identity: Identity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rejection {
    MissingToken,
    Malformed,
    BadSignature,
    UnknownKey,
    KeysUnavailable(String),
    Expired,
    NotYetValid,
    WrongAudience,
    WrongIssuer,
    IdentityNotAllowed,
}

impl fmt::Display for Rejection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Rejection::MissingToken => write!(
                f,
                "no Cloudflare Access token: sign in through the Access hostname"
            ),
            Rejection::Malformed => write!(f, "the Cloudflare Access token is malformed"),
            Rejection::BadSignature => {
                write!(f, "the Cloudflare Access token signature does not verify")
            }
            Rejection::UnknownKey => write!(
                f,
                "the Cloudflare Access token is signed with a key the team does not publish"
            ),
            Rejection::KeysUnavailable(_) => {
                write!(f, "the team's signing keys could not be fetched")
            }
            Rejection::Expired => write!(
                f,
                "the Cloudflare Access session has expired: sign in again"
            ),
            Rejection::NotYetValid => write!(f, "the Cloudflare Access token is not valid yet"),
            Rejection::WrongAudience => write!(
                f,
                "the Cloudflare Access token is for another application (AUD mismatch)"
            ),
            Rejection::WrongIssuer => write!(
                f,
                "the Cloudflare Access token was issued by another team domain"
            ),
            Rejection::IdentityNotAllowed => write!(
                f,
                "this Cloudflare Access identity is not on the mobux allowlist"
            ),
        }
    }
}

impl std::error::Error for Rejection {}

impl Rejection {
    /// What the operator log needs beyond the one-line reason a client gets.
    pub fn detail(&self) -> Option<&str> {
        match self {
            Rejection::KeysUnavailable(reason) => Some(reason),
            _ => None,
        }
    }
}

/// The candidate Access JWTs a request carries: the `Cf-Access-Jwt-Assertion`
/// header alone when present, otherwise every `CF_Authorization` cookie in
/// the order sent.
pub fn tokens_from_headers(headers: &HeaderMap) -> Result<Vec<String>, Rejection> {
    let assertion = headers
        .get(ASSERTION_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(token) = assertion {
        return Ok(vec![token.to_string()]);
    }
    let cookies: Vec<String> = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .filter(|(name, _)| *name == AUTHORIZATION_COOKIE)
        .map(|(_, value)| unquote(value.trim()).to_string())
        .filter(|value| !value.is_empty())
        .collect();
    if cookies.is_empty() {
        return Err(Rejection::MissingToken);
    }
    Ok(cookies)
}

fn unquote(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .unwrap_or(value)
}

#[derive(Debug, Deserialize)]
struct AccessClaims {
    #[serde(default)]
    email: String,
    #[serde(default)]
    common_name: String,
}

#[derive(Debug, Deserialize)]
struct RawJwkSet {
    keys: Vec<serde_json::Value>,
}

#[derive(Default)]
struct KeyCache {
    keys: HashMap<String, DecodingKey>,
    last_fetch: Option<Instant>,
    last_error: Option<String>,
}

pub struct Verifier {
    jwks_url: String,
    issuer: String,
    aud: String,
    allowed_emails: Vec<String>,
    service_tokens: Vec<String>,
    client: reqwest::Client,
    min_refetch_interval: Duration,
    fetch_timeout: Duration,
    cache: RwLock<KeyCache>,
    refetch: Mutex<()>,
}

impl Verifier {
    pub fn new(config: &AccessConfig, client: reqwest::Client) -> Self {
        Verifier {
            jwks_url: config.jwks_url(),
            issuer: config.issuer(),
            aud: config.aud.clone(),
            allowed_emails: config
                .allowed_emails
                .iter()
                .map(|email| email.trim().to_lowercase())
                .collect(),
            service_tokens: config
                .service_tokens
                .iter()
                .map(|token| token.trim().to_string())
                .collect(),
            client,
            min_refetch_interval: MIN_REFETCH_INTERVAL,
            fetch_timeout: JWKS_FETCH_TIMEOUT,
            cache: RwLock::new(KeyCache::default()),
            refetch: Mutex::new(()),
        }
    }

    pub async fn verify_headers(&self, headers: &HeaderMap) -> Result<Verified, Rejection> {
        let mut first_rejection = None;
        for token in tokens_from_headers(headers)? {
            match self.verify(&token).await {
                Ok(verified) => return Ok(verified),
                Err(rejection) => {
                    first_rejection.get_or_insert(rejection);
                }
            }
        }
        Err(first_rejection.unwrap_or(Rejection::MissingToken))
    }

    pub async fn verify(&self, token: &str) -> Result<Verified, Rejection> {
        let header = jsonwebtoken::decode_header(token).map_err(|_| Rejection::Malformed)?;
        if header.alg != Algorithm::RS256 {
            return Err(Rejection::Malformed);
        }
        let kid = header.kid.ok_or(Rejection::Malformed)?;
        let key = self.key_for(&kid).await?;

        let mut validation = Validation::new(Algorithm::RS256);
        validation.leeway = CLOCK_LEEWAY_SECS;
        validation.validate_nbf = true;
        validation.set_audience(&[&self.aud]);
        validation.set_issuer(&[&self.issuer]);
        validation.set_required_spec_claims(&["exp", "iss", "aud"]);

        let claims = jsonwebtoken::decode::<AccessClaims>(token, &key, &validation)
            .map_err(|error| rejection_for(error.kind()))?
            .claims;
        self.identity(claims).map(|identity| Verified { identity })
    }

    fn identity(&self, claims: AccessClaims) -> Result<Identity, Rejection> {
        let email = claims.email.trim().to_lowercase();
        if !email.is_empty() && self.allowed_emails.contains(&email) {
            return Ok(Identity::Email(email));
        }
        let common_name = claims.common_name.trim();
        if !common_name.is_empty() && self.service_tokens.iter().any(|t| t == common_name) {
            return Ok(Identity::ServiceToken(common_name.to_string()));
        }
        Err(Rejection::IdentityNotAllowed)
    }

    async fn key_for(&self, kid: &str) -> Result<DecodingKey, Rejection> {
        if let Some(key) = self.cache.read().await.keys.get(kid) {
            return Ok(key.clone());
        }
        let _refetching = self.refetch.lock().await;
        if let Some(key) = self.cache.read().await.keys.get(kid) {
            return Ok(key.clone());
        }
        {
            let cache = self.cache.read().await;
            let may_refetch = cache
                .last_fetch
                .is_none_or(|at| at.elapsed() >= self.min_refetch_interval);
            if !may_refetch {
                return Err(match &cache.last_error {
                    Some(error) => Rejection::KeysUnavailable(error.clone()),
                    None => Rejection::UnknownKey,
                });
            }
        }
        self.cache.write().await.last_fetch = Some(Instant::now());
        let fetched = self.fetch_keys().await;
        let mut cache = self.cache.write().await;
        match fetched {
            Ok(keys) => {
                let found = keys.get(kid).cloned();
                cache.keys = keys;
                cache.last_error = None;
                found.ok_or(Rejection::UnknownKey)
            }
            Err(error) => {
                cache.last_error = Some(error.clone());
                Err(Rejection::KeysUnavailable(error))
            }
        }
    }

    async fn fetch_keys(&self) -> Result<HashMap<String, DecodingKey>, String> {
        let unavailable = |error: reqwest::Error| error.to_string();
        let set: RawJwkSet = self
            .client
            .get(&self.jwks_url)
            .timeout(self.fetch_timeout)
            .send()
            .await
            .map_err(unavailable)?
            .error_for_status()
            .map_err(unavailable)?
            .json()
            .await
            .map_err(unavailable)?;
        Ok(set.keys.into_iter().filter_map(rsa_key).collect())
    }
}

fn rsa_key(value: serde_json::Value) -> Option<(String, DecodingKey)> {
    let jwk: Jwk = serde_json::from_value(value).ok()?;
    let kid = jwk.common.key_id.clone()?;
    let AlgorithmParameters::RSA(params) = &jwk.algorithm else {
        return None;
    };
    let key = DecodingKey::from_rsa_components(&params.n, &params.e).ok()?;
    Some((kid, key))
}

fn rejection_for(kind: &ErrorKind) -> Rejection {
    match kind {
        ErrorKind::InvalidSignature => Rejection::BadSignature,
        ErrorKind::ExpiredSignature => Rejection::Expired,
        ErrorKind::ImmatureSignature => Rejection::NotYetValid,
        ErrorKind::InvalidAudience => Rejection::WrongAudience,
        ErrorKind::InvalidIssuer => Rejection::WrongIssuer,
        _ => Rejection::Malformed,
    }
}

/// The Access listener's gate: the token verifier plus the public hostname a
/// browser on the tunnel sends as its `Origin`.
pub struct AccessGuard {
    verifier: Verifier,
    hostname: String,
}

impl AccessGuard {
    pub fn new(config: &AccessConfig, client: reqwest::Client) -> Self {
        AccessGuard {
            verifier: Verifier::new(config, client),
            hostname: config.hostname.trim().to_lowercase(),
        }
    }

    /// Cloudflare sets `CF_Authorization` with `SameSite=None`, so a page on
    /// another site can make the browser send it, a WebSocket upgrade or a form
    /// post included. A request whose `Origin` is neither this host nor the
    /// configured public hostname is refused before the token is looked at.
    fn origin_allowed(&self, headers: &HeaderMap) -> bool {
        let Some(origin) = headers.get(header::ORIGIN) else {
            return true;
        };
        let Some((scheme, authority)) = origin.to_str().ok().and_then(|o| o.split_once("://"))
        else {
            return false;
        };
        let authority = authority.to_lowercase();
        if !self.hostname.is_empty()
            && scheme.eq_ignore_ascii_case("https")
            && authority == self.hostname
        {
            return true;
        }
        headers
            .get(header::HOST)
            .and_then(|host| host.to_str().ok())
            .is_some_and(|host| host.trim().to_lowercase() == authority)
    }
}

/// Guards every request on the Access listener: a path in
/// `ACCESS_PUBLIC_PATHS` passes, anything else needs a same-site `Origin` (or none) and a
/// verified Access token, and carries its [`Verified`] identity on to the
/// handler. The PIN session is never consulted.
pub async fn guard(
    State(gate): State<Arc<AccessGuard>>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    if crate::is_access_public_path(request.uri().path()) {
        return next.run(request).await;
    }
    if !gate.origin_allowed(request.headers()) {
        eprintln!(
            "[access] 403 {}: cross-site Origin {:?}",
            request.uri().path(),
            request.headers().get(header::ORIGIN)
        );
        return (
            StatusCode::FORBIDDEN,
            "cross-site request refused: the Origin does not match this host\n",
        )
            .into_response();
    }
    match gate.verifier.verify_headers(request.headers()).await {
        Ok(verified) => {
            strip_tokens(request.headers_mut());
            request.extensions_mut().insert(verified);
            next.run(request).await
        }
        Err(rejection) => {
            match rejection.detail() {
                Some(detail) => eprintln!(
                    "[access] 401 {}: {rejection}: {detail}",
                    request.uri().path()
                ),
                None => eprintln!("[access] 401 {}: {rejection}", request.uri().path()),
            }
            unauthorized(&rejection)
        }
    }
}

fn unauthorized(rejection: &Rejection) -> Response {
    let body = format!("{rejection}\n");
    let mut response = (StatusCode::UNAUTHORIZED, body).into_response();
    response.headers_mut().insert(
        header::WWW_AUTHENTICATE,
        HeaderValue::from_static(CHALLENGE),
    );
    response
}

/// Drops the Access token from a verified request so nothing downstream, a
/// proxied local app in particular, receives a credential for the whole site.
fn strip_tokens(headers: &mut HeaderMap) {
    headers.remove(ASSERTION_HEADER);
    crate::proxy::strip_cookie(headers, AUTHORIZATION_COOKIE);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};

    use axum::http::HeaderValue;
    use jsonwebtoken::{EncodingKey, Header};
    use rsa::pkcs1::EncodeRsaPrivateKey;
    use serde_json::{json, Value};

    const AUD: &str = "mobux-aud-tag";
    const KID: &str = "key-1";

    fn signing_key() -> &'static EncodingKey {
        static KEY: OnceLock<EncodingKey> = OnceLock::new();
        KEY.get_or_init(|| {
            let private = rsa::RsaPrivateKey::new(&mut rsa::rand_core::OsRng, 2048).unwrap();
            EncodingKey::from_rsa_der(private.to_pkcs1_der().unwrap().as_bytes())
        })
    }

    fn jwk(kid: &str) -> Value {
        let mut jwk = Jwk::from_encoding_key(signing_key(), Algorithm::RS256).unwrap();
        jwk.common.key_id = Some(kid.to_string());
        serde_json::to_value(jwk).unwrap()
    }

    struct Jwks {
        origin: String,
        keys: Arc<std::sync::Mutex<Vec<Value>>>,
        fetches: Arc<AtomicUsize>,
        failing: Arc<AtomicBool>,
    }

    impl Jwks {
        async fn serve(kids: &[&str]) -> Jwks {
            let keys = Arc::new(std::sync::Mutex::new(
                kids.iter().map(|kid| jwk(kid)).collect::<Vec<_>>(),
            ));
            let fetches = Arc::new(AtomicUsize::new(0));
            let failing = Arc::new(AtomicBool::new(false));
            let (served, counted, fails) = (keys.clone(), fetches.clone(), failing.clone());
            let app = axum::Router::new().route(
                "/cdn-cgi/access/certs",
                axum::routing::get(move || {
                    let (served, counted, fails) = (served.clone(), counted.clone(), fails.clone());
                    async move {
                        counted.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        if fails.load(Ordering::SeqCst) {
                            return Err(axum::http::StatusCode::BAD_GATEWAY);
                        }
                        let keys = served.lock().unwrap().clone();
                        Ok(axum::Json(json!({ "keys": keys })))
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            Jwks {
                origin,
                keys,
                fetches,
                failing,
            }
        }

        fn publish(&self, kid: &str) {
            self.keys.lock().unwrap().push(jwk(kid));
        }

        fn fetches(&self) -> usize {
            self.fetches.load(Ordering::SeqCst)
        }

        fn verifier(&self, refetch_interval: Duration) -> Verifier {
            verifier_for(&self.origin, refetch_interval)
        }

        fn claims(&self) -> Value {
            claims_for(&self.origin)
        }
    }

    fn verifier_for(origin: &str, refetch_interval: Duration) -> Verifier {
        let config = AccessConfig {
            port: 5153,
            team_domain: origin.to_string(),
            aud: AUD.to_string(),
            hostname: "mobux.example.com".to_string(),
            allowed_emails: vec!["Owner@Example.com".to_string()],
            service_tokens: vec!["robot.access".to_string()],
        };
        let mut verifier = Verifier::new(&config, reqwest::Client::new());
        verifier.min_refetch_interval = refetch_interval;
        verifier
    }

    fn claims_for(origin: &str) -> Value {
        let now = now();
        json!({
            "aud": [AUD],
            "iss": origin,
            "email": "owner@example.com",
            "iat": now,
            "nbf": now,
            "exp": now + 600,
        })
    }

    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    fn sign(kid: &str, claims: &Value) -> String {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some(kid.to_string());
        jsonwebtoken::encode(&header, claims, signing_key()).unwrap()
    }

    fn with(mut claims: Value, field: &str, value: Value) -> Value {
        claims[field] = value;
        claims
    }

    async fn verify(jwks: &Jwks, claims: Value) -> Result<Verified, Rejection> {
        jwks.verifier(MIN_REFETCH_INTERVAL)
            .verify(&sign(KID, &claims))
            .await
    }

    #[tokio::test]
    async fn admits_an_allowed_email_case_insensitively() {
        let jwks = Jwks::serve(&[KID]).await;
        let claims = with(jwks.claims(), "email", json!("OWNER@example.COM"));
        assert_eq!(
            verify(&jwks, claims).await,
            Ok(Verified {
                identity: Identity::Email("owner@example.com".to_string())
            })
        );
    }

    #[tokio::test]
    async fn admits_a_listed_service_token() {
        let jwks = Jwks::serve(&[KID]).await;
        let claims = with(jwks.claims(), "email", json!(""));
        let claims = with(claims, "common_name", json!("robot.access"));
        assert_eq!(
            verify(&jwks, claims).await,
            Ok(Verified {
                identity: Identity::ServiceToken("robot.access".to_string())
            })
        );
    }

    #[tokio::test]
    async fn verifies_the_token_a_request_carries() {
        let jwks = Jwks::serve(&[KID]).await;
        let cookie = format!("CF_Authorization={}", sign(KID, &jwks.claims()));
        let request = headers(&[("cookie", &cookie)]);
        assert!(jwks
            .verifier(MIN_REFETCH_INTERVAL)
            .verify_headers(&request)
            .await
            .is_ok());
        assert_eq!(
            jwks.verifier(MIN_REFETCH_INTERVAL)
                .verify_headers(&HeaderMap::new())
                .await,
            Err(Rejection::MissingToken)
        );
    }

    #[tokio::test]
    async fn rejects_an_expired_token() {
        let jwks = Jwks::serve(&[KID]).await;
        let claims = with(jwks.claims(), "exp", json!(now() - 120));
        assert_eq!(verify(&jwks, claims).await, Err(Rejection::Expired));
    }

    #[tokio::test]
    async fn rejects_a_token_not_valid_beyond_the_leeway() {
        let jwks = Jwks::serve(&[KID]).await;
        let claims = with(jwks.claims(), "nbf", json!(now() + 300));
        assert_eq!(verify(&jwks, claims).await, Err(Rejection::NotYetValid));
    }

    #[tokio::test]
    async fn rejects_another_applications_audience() {
        let jwks = Jwks::serve(&[KID]).await;
        let claims = with(jwks.claims(), "aud", json!(["other-app"]));
        assert_eq!(verify(&jwks, claims).await, Err(Rejection::WrongAudience));
    }

    #[tokio::test]
    async fn rejects_another_teams_issuer() {
        let jwks = Jwks::serve(&[KID]).await;
        let claims = with(
            jwks.claims(),
            "iss",
            json!("https://other.cloudflareaccess.com"),
        );
        assert_eq!(verify(&jwks, claims).await, Err(Rejection::WrongIssuer));
    }

    #[tokio::test]
    async fn rejects_an_unlisted_email() {
        let jwks = Jwks::serve(&[KID]).await;
        let claims = with(jwks.claims(), "email", json!("stranger@example.com"));
        assert_eq!(
            verify(&jwks, claims).await,
            Err(Rejection::IdentityNotAllowed)
        );
    }

    #[tokio::test]
    async fn rejects_a_malformed_token() {
        let jwks = Jwks::serve(&[KID]).await;
        let verifier = jwks.verifier(MIN_REFETCH_INTERVAL);
        assert_eq!(
            verifier.verify("not.a.jwt").await,
            Err(Rejection::Malformed)
        );
        assert_eq!(jwks.fetches(), 0);
    }

    #[tokio::test]
    async fn rejects_a_tampered_signature() {
        let jwks = Jwks::serve(&[KID]).await;
        let token = sign(KID, &jwks.claims());
        let (signed, signature) = token.rsplit_once('.').unwrap();
        let flipped = if signature.starts_with('A') { "B" } else { "A" };
        let tampered = format!("{signed}.{flipped}{}", &signature[1..]);
        assert_eq!(
            jwks.verifier(MIN_REFETCH_INTERVAL).verify(&tampered).await,
            Err(Rejection::BadSignature)
        );
    }

    #[tokio::test]
    async fn refetches_once_for_a_rotated_key() {
        let jwks = Jwks::serve(&[KID]).await;
        let verifier = jwks.verifier(Duration::ZERO);
        assert!(verifier.verify(&sign(KID, &jwks.claims())).await.is_ok());
        assert_eq!(jwks.fetches(), 1);

        jwks.publish("key-2");
        assert!(verifier
            .verify(&sign("key-2", &jwks.claims()))
            .await
            .is_ok());
        assert_eq!(jwks.fetches(), 2);

        assert!(verifier
            .verify(&sign("key-2", &jwks.claims()))
            .await
            .is_ok());
        assert_eq!(jwks.fetches(), 2);
    }

    #[tokio::test]
    async fn rate_limits_refetches_for_unknown_keys() {
        let jwks = Jwks::serve(&[KID]).await;
        let verifier = jwks.verifier(MIN_REFETCH_INTERVAL);
        assert!(verifier.verify(&sign(KID, &jwks.claims())).await.is_ok());
        assert_eq!(jwks.fetches(), 1);

        jwks.publish("key-2");
        for _ in 0..3 {
            assert_eq!(
                verifier.verify(&sign("key-2", &jwks.claims())).await,
                Err(Rejection::UnknownKey)
            );
        }
        assert_eq!(jwks.fetches(), 1);
    }

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.append(*name, HeaderValue::from_str(value).unwrap());
        }
        headers
    }

    #[test]
    fn extracts_the_token_from_the_assertion_header() {
        let headers = headers(&[("cf-access-jwt-assertion", "from-header")]);
        assert_eq!(
            tokens_from_headers(&headers),
            Ok(vec!["from-header".to_string()])
        );
    }

    #[test]
    fn extracts_the_token_from_the_authorization_cookie() {
        let headers = headers(&[("cookie", "theme=dark; CF_Authorization=from-cookie; x=1")]);
        assert_eq!(
            tokens_from_headers(&headers),
            Ok(vec!["from-cookie".to_string()])
        );
    }

    #[test]
    fn prefers_the_header_over_the_cookie() {
        let headers = headers(&[
            ("cookie", "CF_Authorization=from-cookie"),
            ("cf-access-jwt-assertion", "from-header"),
        ]);
        assert_eq!(
            tokens_from_headers(&headers),
            Ok(vec!["from-header".to_string()])
        );
    }

    #[test]
    fn unquotes_and_keeps_every_authorization_cookie() {
        let headers = headers(&[(
            "cookie",
            "CF_Authorization=\"first\"; theme=dark; CF_Authorization=second",
        )]);
        assert_eq!(
            tokens_from_headers(&headers),
            Ok(vec!["first".to_string(), "second".to_string()])
        );
    }

    #[tokio::test]
    async fn tries_each_authorization_cookie_in_order() {
        let jwks = Jwks::serve(&[KID]).await;
        let cookie = format!(
            "CF_Authorization=stale.token.value; CF_Authorization={}",
            sign(KID, &jwks.claims())
        );
        let request = headers(&[("cookie", &cookie)]);
        assert!(jwks
            .verifier(MIN_REFETCH_INTERVAL)
            .verify_headers(&request)
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn rejects_a_token_whose_header_says_hs256() {
        let jwks = Jwks::serve(&[KID]).await;
        let mut header = Header::new(Algorithm::HS256);
        header.kid = Some(KID.to_string());
        let token = jsonwebtoken::encode(
            &header,
            &jwks.claims(),
            &EncodingKey::from_secret(b"shared-secret"),
        )
        .unwrap();
        assert_eq!(
            jwks.verifier(MIN_REFETCH_INTERVAL).verify(&token).await,
            Err(Rejection::Malformed)
        );
    }

    #[tokio::test]
    async fn rejects_a_token_whose_header_says_none() {
        use base64::Engine;
        let jwks = Jwks::serve(&[KID]).await;
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let token = format!(
            "{}.{}.",
            b64.encode(json!({ "alg": "none", "kid": KID }).to_string()),
            b64.encode(jwks.claims().to_string())
        );
        assert_eq!(
            jwks.verifier(MIN_REFETCH_INTERVAL).verify(&token).await,
            Err(Rejection::Malformed)
        );
    }

    #[tokio::test]
    async fn admits_an_audience_given_as_a_plain_string() {
        let jwks = Jwks::serve(&[KID]).await;
        let claims = with(jwks.claims(), "aud", json!(AUD));
        assert!(verify(&jwks, claims).await.is_ok());
    }

    #[tokio::test]
    async fn rejects_a_token_without_an_expiry_as_malformed() {
        let jwks = Jwks::serve(&[KID]).await;
        let mut claims = jwks.claims();
        claims.as_object_mut().unwrap().remove("exp");
        assert_eq!(verify(&jwks, claims).await, Err(Rejection::Malformed));
    }

    #[tokio::test]
    async fn admits_an_unlisted_email_with_a_listed_common_name_as_the_service_token() {
        let jwks = Jwks::serve(&[KID]).await;
        let claims = with(jwks.claims(), "email", json!("stranger@example.com"));
        let claims = with(claims, "common_name", json!("robot.access"));
        assert_eq!(
            verify(&jwks, claims).await,
            Ok(Verified {
                identity: Identity::ServiceToken("robot.access".to_string())
            })
        );
    }

    #[tokio::test]
    async fn fetches_once_for_concurrent_requests_with_the_same_unknown_key() {
        let jwks = Jwks::serve(&[KID]).await;
        let verifier = jwks.verifier(Duration::ZERO);
        let token = sign(KID, &jwks.claims());
        let (first, second) = tokio::join!(verifier.verify(&token), verifier.verify(&token));
        assert!(first.is_ok() && second.is_ok());
        assert_eq!(jwks.fetches(), 1);
    }

    #[tokio::test]
    async fn a_failed_fetch_counts_against_the_limit_and_reports_keys_unavailable() {
        let jwks = Jwks::serve(&[KID]).await;
        jwks.failing.store(true, Ordering::SeqCst);
        let verifier = jwks.verifier(MIN_REFETCH_INTERVAL);
        for kid in [KID, "key-2"] {
            let outcome = verifier.verify(&sign(kid, &jwks.claims())).await;
            assert!(
                matches!(outcome, Err(Rejection::KeysUnavailable(_))),
                "{outcome:?}"
            );
        }
        assert_eq!(jwks.fetches(), 1);
    }

    #[tokio::test]
    async fn a_key_server_that_never_answers_times_out_as_keys_unavailable() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                held.push(socket);
            }
        });
        let mut verifier = verifier_for(&origin, MIN_REFETCH_INTERVAL);
        verifier.fetch_timeout = Duration::from_millis(300);
        let outcome = tokio::time::timeout(
            Duration::from_secs(5),
            verifier.verify(&sign(KID, &claims_for(&origin))),
        )
        .await
        .expect("the key fetch outlived its timeout");
        assert!(
            matches!(outcome, Err(Rejection::KeysUnavailable(_))),
            "{outcome:?}"
        );
    }

    #[test]
    fn reports_a_missing_token() {
        let headers = headers(&[("cookie", "theme=dark; CF_Authorization=")]);
        assert_eq!(tokens_from_headers(&headers), Err(Rejection::MissingToken));
        assert_eq!(
            tokens_from_headers(&HeaderMap::new()),
            Err(Rejection::MissingToken)
        );
    }

    mod listener {
        use super::*;
        use axum::routing::get;
        use axum::{Extension, Router};
        use tower::ServiceExt;

        async fn seen(Extension(verified): Extension<Verified>, headers: HeaderMap) -> String {
            let cookie = headers
                .get(header::COOKIE)
                .map(|value| value.to_str().unwrap().to_string())
                .unwrap_or_default();
            format!(
                "{:?} assertion={} cookie={cookie}",
                verified.identity,
                headers.contains_key(ASSERTION_HEADER)
            )
        }

        fn router(jwks: &Jwks) -> Router {
            Router::new()
                .route("/api/sessions", get(seen))
                .route("/static/manifest.json", get(|| async { "manifest" }))
                .route("/.well-known/assetlinks.json", get(|| async { "links" }))
                .route("/api/identify", get(|| async { "mobux" }))
                .route("/install/mobux-ca.crt", get(|| async { "ca" }))
                .layer(axum::middleware::from_fn_with_state(
                    Arc::new(AccessGuard {
                        verifier: jwks.verifier(MIN_REFETCH_INTERVAL),
                        hostname: "mobux.example.com".to_string(),
                    }),
                    guard,
                ))
        }

        async fn call(jwks: &Jwks, path: &str, pairs: &[(&'static str, &str)]) -> Response {
            let mut request = Request::builder()
                .uri(path)
                .header("host", "127.0.0.1:5153");
            for (name, value) in pairs {
                request = request.header(*name, *value);
            }
            router(jwks)
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap()
        }

        async fn body(response: Response) -> String {
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            String::from_utf8(bytes.to_vec()).unwrap()
        }

        async fn assert_refused(response: Response, rejection: Rejection) {
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            let challenges: Vec<_> = response
                .headers()
                .get_all(header::WWW_AUTHENTICATE)
                .iter()
                .map(|value| value.to_str().unwrap().to_string())
                .collect();
            assert_eq!(challenges, vec![CHALLENGE.to_string()]);
            assert_eq!(body(response).await, format!("{rejection}\n"));
        }

        #[tokio::test]
        async fn admits_a_header_token_and_hands_on_the_identity() {
            let jwks = Jwks::serve(&[KID]).await;
            let token = sign(KID, &jwks.claims());
            let response = call(&jwks, "/api/sessions", &[(ASSERTION_HEADER, &token)]).await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                body(response).await,
                "Email(\"owner@example.com\") assertion=false cookie="
            );
        }

        #[tokio::test]
        async fn admits_a_cookie_token_and_keeps_the_other_cookies() {
            let jwks = Jwks::serve(&[KID]).await;
            let cookie = format!(
                "theme=dark; CF_Authorization={}; lang=nl",
                sign(KID, &jwks.claims())
            );
            let response = call(&jwks, "/api/sessions", &[("cookie", &cookie)]).await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                body(response).await,
                "Email(\"owner@example.com\") assertion=false cookie=theme=dark; lang=nl"
            );
        }

        #[tokio::test]
        async fn refuses_a_request_without_a_token_with_the_bearer_challenge() {
            let jwks = Jwks::serve(&[KID]).await;
            let response = call(&jwks, "/api/sessions", &[]).await;
            assert_refused(response, Rejection::MissingToken).await;
        }

        #[tokio::test]
        async fn ignores_the_pin_credentials() {
            let jwks = Jwks::serve(&[KID]).await;
            let response = call(
                &jwks,
                "/api/sessions",
                &[
                    ("authorization", "Basic c21va2U6MDAwMDA="),
                    ("cookie", "mobux_session=anything"),
                ],
            )
            .await;
            assert_refused(response, Rejection::MissingToken).await;
        }

        #[tokio::test]
        async fn refuses_an_expired_token_naming_the_reason() {
            let jwks = Jwks::serve(&[KID]).await;
            let token = sign(KID, &with(jwks.claims(), "exp", json!(now() - 120)));
            let response = call(&jwks, "/api/sessions", &[(ASSERTION_HEADER, &token)]).await;
            assert_refused(response, Rejection::Expired).await;
        }

        #[tokio::test]
        async fn refuses_a_token_for_another_audience() {
            let jwks = Jwks::serve(&[KID]).await;
            let token = sign(KID, &with(jwks.claims(), "aud", json!(["other-app"])));
            let response = call(&jwks, "/api/sessions", &[(ASSERTION_HEADER, &token)]).await;
            assert_refused(response, Rejection::WrongAudience).await;
        }

        async fn status(jwks: &Jwks, origin: &str) -> StatusCode {
            let token = sign(KID, &jwks.claims());
            call(
                jwks,
                "/api/sessions",
                &[(ASSERTION_HEADER, &token), ("origin", origin)],
            )
            .await
            .status()
        }

        #[tokio::test]
        async fn refuses_a_cross_site_origin_even_with_a_valid_token() {
            let jwks = Jwks::serve(&[KID]).await;
            let token = sign(KID, &jwks.claims());
            let response = call(
                &jwks,
                "/api/sessions",
                &[
                    (ASSERTION_HEADER, &token),
                    ("origin", "http://evil.example"),
                ],
            )
            .await;
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            assert!(!response.headers().contains_key(header::WWW_AUTHENTICATE));
            assert_eq!(
                body(response).await,
                "cross-site request refused: the Origin does not match this host\n"
            );
        }

        #[tokio::test]
        async fn admits_an_origin_matching_the_host_in_either_scheme() {
            let jwks = Jwks::serve(&[KID]).await;
            assert_eq!(status(&jwks, "http://127.0.0.1:5153").await, StatusCode::OK);
            assert_eq!(
                status(&jwks, "https://127.0.0.1:5153").await,
                StatusCode::OK
            );
            assert_eq!(
                status(&jwks, "http://127.0.0.1:5154").await,
                StatusCode::FORBIDDEN
            );
        }

        #[tokio::test]
        async fn admits_the_configured_hostname_over_https_only() {
            let jwks = Jwks::serve(&[KID]).await;
            assert_eq!(
                status(&jwks, "https://Mobux.Example.com").await,
                StatusCode::OK
            );
            assert_eq!(
                status(&jwks, "http://mobux.example.com").await,
                StatusCode::FORBIDDEN
            );
            assert_eq!(
                status(&jwks, "https://mobux.example.com.evil.example").await,
                StatusCode::FORBIDDEN
            );
        }

        #[tokio::test]
        async fn refuses_an_opaque_origin() {
            let jwks = Jwks::serve(&[KID]).await;
            assert_eq!(status(&jwks, "null").await, StatusCode::FORBIDDEN);
        }

        #[tokio::test]
        async fn keeps_the_key_fetch_error_out_of_the_response() {
            let jwks = Jwks::serve(&[KID]).await;
            jwks.failing.store(true, Ordering::SeqCst);
            let token = sign(KID, &jwks.claims());
            let response = call(&jwks, "/api/sessions", &[(ASSERTION_HEADER, &token)]).await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            let body = body(response).await;
            assert_eq!(body, "the team's signing keys could not be fetched\n");
            assert!(!body.contains(&jwks.origin), "{body}");
        }

        #[tokio::test]
        async fn serves_the_public_paths_without_a_token() {
            let jwks = Jwks::serve(&[KID]).await;
            for (path, expected) in [
                ("/static/manifest.json", "manifest"),
                ("/.well-known/assetlinks.json", "links"),
            ] {
                let response = call(&jwks, path, &[]).await;
                assert_eq!(response.status(), StatusCode::OK, "{path}");
                assert_eq!(body(response).await, expected);
            }
            assert_eq!(jwks.fetches(), 0);
        }

        #[tokio::test]
        async fn the_install_files_and_identify_need_a_token() {
            let jwks = Jwks::serve(&[KID]).await;
            for path in ["/install/mobux-ca.crt", "/api/identify"] {
                let response = call(&jwks, path, &[]).await;
                assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
            }
        }
    }
}
