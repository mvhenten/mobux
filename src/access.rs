//! Cloudflare Access token verification for the Access listener (#333).
//! Checks the JWT Cloudflare puts on every request it lets through against
//! the team's published keys, the application AUD and the identity allowlist.

// Wired into the Access listener in the next stage of #333.
#![cfg_attr(not(test), allow(dead_code))]

use std::collections::HashMap;
use std::fmt;
use std::time::{Duration, Instant};

use axum::http::{header, HeaderMap};
use jsonwebtoken::errors::ErrorKind;
use jsonwebtoken::jwk::{AlgorithmParameters, Jwk};
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use tokio::sync::{Mutex, RwLock};

use crate::config::AccessConfig;

pub const ASSERTION_HEADER: &str = "cf-access-jwt-assertion";
pub const AUTHORIZATION_COOKIE: &str = "CF_Authorization";

const CLOCK_LEEWAY_SECS: u64 = 30;
const MIN_REFETCH_INTERVAL: Duration = Duration::from_secs(60);

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
            Rejection::KeysUnavailable(reason) => write!(
                f,
                "could not fetch the Cloudflare Access signing keys: {reason}"
            ),
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

/// The raw Access JWT from the `Cf-Access-Jwt-Assertion` header, or failing
/// that the `CF_Authorization` cookie.
pub fn token_from_headers(headers: &HeaderMap) -> Result<String, Rejection> {
    let assertion = headers
        .get(ASSERTION_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(token) = assertion {
        return Ok(token.to_string());
    }
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, value)| *name == AUTHORIZATION_COOKIE && !value.is_empty())
        .map(|(_, value)| value.to_string())
        .ok_or(Rejection::MissingToken)
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
}

pub struct Verifier {
    jwks_url: String,
    issuer: String,
    aud: String,
    allowed_emails: Vec<String>,
    service_tokens: Vec<String>,
    client: reqwest::Client,
    min_refetch_interval: Duration,
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
            cache: RwLock::new(KeyCache::default()),
            refetch: Mutex::new(()),
        }
    }

    pub async fn verify_headers(&self, headers: &HeaderMap) -> Result<Verified, Rejection> {
        let token = token_from_headers(headers)?;
        self.verify(&token).await
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
        let may_refetch = self
            .cache
            .read()
            .await
            .last_fetch
            .is_none_or(|at| at.elapsed() >= self.min_refetch_interval);
        if !may_refetch {
            return Err(Rejection::UnknownKey);
        }
        self.cache.write().await.last_fetch = Some(Instant::now());
        let keys = self.fetch_keys().await?;
        let found = keys.get(kid).cloned();
        self.cache.write().await.keys = keys;
        found.ok_or(Rejection::UnknownKey)
    }

    async fn fetch_keys(&self) -> Result<HashMap<String, DecodingKey>, Rejection> {
        let unavailable = |error: reqwest::Error| Rejection::KeysUnavailable(error.to_string());
        let set: RawJwkSet = self
            .client
            .get(&self.jwks_url)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
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
    }

    impl Jwks {
        async fn serve(kids: &[&str]) -> Jwks {
            let keys = Arc::new(std::sync::Mutex::new(
                kids.iter().map(|kid| jwk(kid)).collect::<Vec<_>>(),
            ));
            let fetches = Arc::new(AtomicUsize::new(0));
            let (served, counted) = (keys.clone(), fetches.clone());
            let app = axum::Router::new().route(
                "/cdn-cgi/access/certs",
                axum::routing::get(move || {
                    let (served, counted) = (served.clone(), counted.clone());
                    async move {
                        counted.fetch_add(1, Ordering::SeqCst);
                        let keys = served.lock().unwrap().clone();
                        axum::Json(json!({ "keys": keys }))
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
            }
        }

        fn publish(&self, kid: &str) {
            self.keys.lock().unwrap().push(jwk(kid));
        }

        fn fetches(&self) -> usize {
            self.fetches.load(Ordering::SeqCst)
        }

        fn verifier(&self, refetch_interval: Duration) -> Verifier {
            let config = AccessConfig {
                port: 5153,
                team_domain: self.origin.clone(),
                aud: AUD.to_string(),
                hostname: "mobux.example.com".to_string(),
                allowed_emails: vec!["Owner@Example.com".to_string()],
                service_tokens: vec!["robot.access".to_string()],
            };
            let mut verifier = Verifier::new(&config, reqwest::Client::new());
            verifier.min_refetch_interval = refetch_interval;
            verifier
        }

        fn claims(&self) -> Value {
            let now = now();
            json!({
                "aud": [AUD],
                "iss": self.origin,
                "email": "owner@example.com",
                "iat": now,
                "nbf": now,
                "exp": now + 600,
            })
        }
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
        assert_eq!(token_from_headers(&headers), Ok("from-header".to_string()));
    }

    #[test]
    fn extracts_the_token_from_the_authorization_cookie() {
        let headers = headers(&[("cookie", "theme=dark; CF_Authorization=from-cookie; x=1")]);
        assert_eq!(token_from_headers(&headers), Ok("from-cookie".to_string()));
    }

    #[test]
    fn prefers_the_header_over_the_cookie() {
        let headers = headers(&[
            ("cookie", "CF_Authorization=from-cookie"),
            ("cf-access-jwt-assertion", "from-header"),
        ]);
        assert_eq!(token_from_headers(&headers), Ok("from-header".to_string()));
    }

    #[test]
    fn reports_a_missing_token() {
        let headers = headers(&[("cookie", "theme=dark; CF_Authorization=")]);
        assert_eq!(token_from_headers(&headers), Err(Rejection::MissingToken));
        assert_eq!(
            token_from_headers(&HeaderMap::new()),
            Err(Rejection::MissingToken)
        );
    }
}
