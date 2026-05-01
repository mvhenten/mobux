//! TLS certificate management for mobux.
//!
//! Two modes:
//!
//! 1. **Default (CA mode)**: Generate a long-lived local root CA at
//!    `$MOBUX_CONFIG_DIR/ca.{crt,key}` (10 years, ECDSA P-256, CN=`mobux local CA`)
//!    and a 90-day per-host leaf cert. The CA cert is later served by the
//!    install page so users can install it on their devices.
//! 2. **ACME mode**: When `MOBUX_ACME_DOMAINS` is set, obtain a real
//!    Let's Encrypt cert via HTTP-01. Renew automatically.
//!
//! The user-supplied `MOBUX_CERT_FILE` / `MOBUX_KEY_FILE` env vars take
//! priority over both modes — handled in `main.rs`, not here.

use std::collections::HashMap;
use std::fs;
use std::net::IpAddr;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use rcgen::{
    BasicConstraints, CertificateParams, DnType, IsCa, KeyPair, KeyUsagePurpose, SanType,
    PKCS_ECDSA_P256_SHA256,
};
use rustls_pki_types::{CertificateDer, PrivateKeyDer};
use time::OffsetDateTime;

const CA_VALIDITY_DAYS: i64 = 365 * 10;
const LEAF_VALIDITY_DAYS: i64 = 90;
const LEAF_REISSUE_THRESHOLD_DAYS: i64 = 14;
const ACME_RENEW_THRESHOLD_DAYS: i64 = 30;
const ACME_RENEW_INTERVAL: Duration = Duration::from_secs(24 * 3600);
const ACME_DEFAULT_DIRECTORY: &str = "https://acme-v02.api.letsencrypt.org/directory";

/// Shared state for the HTTP-01 challenge server route. The map is `token ->
/// key_authorization`. `main.rs` mounts a route that reads from it; this
/// module's ACME order code writes to it.
pub type AcmeChallenges = Arc<Mutex<HashMap<String, String>>>;

/// Construct an empty challenge map suitable for sharing between the ACME
/// order code and the HTTP-01 challenge route handler.
pub fn new_acme_challenges() -> AcmeChallenges {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Resolved certificate paths returned to `main.rs`.
#[derive(Debug, Clone)]
pub struct CertPaths {
    /// Leaf cert PEM (chain).
    pub cert: PathBuf,
    /// Leaf private key PEM.
    pub key: PathBuf,
    /// CA cert PEM, only set in default (CA) mode. Phase 8's install page
    /// serves this to clients so they can install it as a trusted root.
    #[allow(dead_code)]
    pub ca_cert: Option<PathBuf>,
}

/// True if ACME mode is enabled (i.e. `MOBUX_ACME_DOMAINS` is set and non-empty).
pub fn acme_mode_enabled() -> bool {
    std::env::var("MOBUX_ACME_DOMAINS")
        .ok()
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
}

/// Orchestrator: resolve cert + key paths for the running server.
///
/// In ACME mode the caller must pass `Some(challenges)` — the same handle
/// shared with the HTTP-01 route in `main.rs`. In CA mode the handle is unused
/// and may be `None`.
pub async fn ensure_certs(
    extra_hosts: &[String],
    acme_challenges: Option<AcmeChallenges>,
) -> Result<CertPaths> {
    if acme_mode_enabled() {
        let challenges = acme_challenges
            .ok_or_else(|| anyhow!("ACME mode enabled but no challenge handle provided"))?;
        return ensure_acme(challenges).await;
    }

    ensure_ca_mode(extra_hosts)
}

/// Load a rustls `ServerConfig` from PEM files on disk.
pub fn load_rustls_config(cert_path: &Path, key_path: &Path) -> Result<rustls::ServerConfig> {
    let cert_pem = fs::read(cert_path).context("reading cert file")?;
    let key_pem = fs::read(key_path).context("reading key file")?;

    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut &cert_pem[..])
        .collect::<std::result::Result<Vec<_>, _>>()
        .context("parsing cert PEM")?;

    let key: PrivateKeyDer<'static> = rustls_pemfile::private_key(&mut &key_pem[..])
        .context("parsing key PEM")?
        .context("no private key found in PEM")?;

    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("building rustls ServerConfig")?;

    Ok(config)
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

fn config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("MOBUX_CONFIG_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".config").join("mobux")
}

fn ca_cert_path() -> PathBuf {
    config_dir().join("ca.crt")
}

fn ca_key_path() -> PathBuf {
    config_dir().join("ca.key")
}

fn leaf_cert_path() -> PathBuf {
    config_dir().join("leaf.crt")
}

fn leaf_key_path() -> PathBuf {
    config_dir().join("leaf.key")
}

fn leaf_meta_path() -> PathBuf {
    // Stores hash of the SAN list so we can detect host-set changes
    // without re-parsing the leaf cert.
    config_dir().join("leaf.meta")
}

fn leaf_expiry_path() -> PathBuf {
    // Stores the leaf's not_after as a unix timestamp (seconds, decimal).
    // This avoids pulling in x509-parser just to read the validity field.
    config_dir().join("leaf.expiry")
}

fn acme_expiry_path() -> PathBuf {
    acme_dir().join("cert.expiry")
}

fn acme_dir() -> PathBuf {
    config_dir().join("acme")
}

fn acme_account_path() -> PathBuf {
    acme_dir().join("account.json")
}

fn acme_cert_path() -> PathBuf {
    acme_dir().join("cert.pem")
}

fn acme_key_path() -> PathBuf {
    acme_dir().join("key.pem")
}

// ---------------------------------------------------------------------------
// CA mode
// ---------------------------------------------------------------------------

struct CaMaterial {
    cert: rcgen::Certificate,
    key: KeyPair,
}

fn ensure_ca_mode(extra_hosts: &[String]) -> Result<CertPaths> {
    let dir = config_dir();
    fs::create_dir_all(&dir).with_context(|| format!("creating config dir: {}", dir.display()))?;

    let ca = ensure_ca()?;
    issue_leaf_if_needed(&ca, extra_hosts)?;

    Ok(CertPaths {
        cert: leaf_cert_path(),
        key: leaf_key_path(),
        ca_cert: Some(ca_cert_path()),
    })
}

/// Read or generate the local root CA (`mobux local CA`).
fn ensure_ca() -> Result<CaMaterial> {
    let cert_path = ca_cert_path();
    let key_path = ca_key_path();

    if cert_path.exists() && key_path.exists() {
        let key_pem = fs::read_to_string(&key_path)
            .with_context(|| format!("reading {}", key_path.display()))?;
        let cert_pem = fs::read_to_string(&cert_path)
            .with_context(|| format!("reading {}", cert_path.display()))?;
        let key = KeyPair::from_pem(&key_pem).context("parsing CA key PEM")?;
        let params =
            CertificateParams::from_ca_cert_pem(&cert_pem).context("parsing CA cert PEM")?;
        let cert = params.self_signed(&key).context("re-binding CA cert")?;
        return Ok(CaMaterial { cert, key });
    }

    eprintln!(
        "[ssl] Generating new local root CA at {}",
        config_dir().display()
    );

    let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).context("generating CA key")?;
    let mut params = CertificateParams::default();
    params
        .distinguished_name
        .push(DnType::CommonName, "mobux local CA");
    params
        .distinguished_name
        .push(DnType::OrganizationName, "mobux");
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];

    let now = OffsetDateTime::now_utc();
    params.not_before = now;
    params.not_after = now
        .checked_add(time::Duration::days(CA_VALIDITY_DAYS))
        .ok_or_else(|| anyhow!("CA not_after overflow"))?;

    let cert = params.self_signed(&key).context("self-signing CA cert")?;

    write_secret(&key_path, key.serialize_pem().as_bytes())?;
    fs::write(&cert_path, cert.pem()).context("writing CA cert")?;

    eprintln!("[ssl] CA written: {}", cert_path.display());
    eprintln!("[ssl] CA key:     {} (mode 0600)", key_path.display());

    Ok(CaMaterial { cert, key })
}

/// Issue a fresh leaf cert if none exists, or if SAN set changed, or if the
/// existing leaf is within the reissue threshold of expiry.
fn issue_leaf_if_needed(ca: &CaMaterial, extra_hosts: &[String]) -> Result<()> {
    let hosts = collect_hosts(extra_hosts);
    let want_hash = hash_hosts(&hosts);

    let cert_path = leaf_cert_path();
    let meta_path = leaf_meta_path();

    let same_hosts = fs::read_to_string(&meta_path)
        .map(|s| s.trim() == want_hash)
        .unwrap_or(false);

    let remaining = remaining_days_from_sidecar(&leaf_expiry_path()).unwrap_or(-1);
    let fresh = cert_path.exists() && remaining > LEAF_REISSUE_THRESHOLD_DAYS;

    if same_hosts && fresh {
        eprintln!(
            "[ssl] Reusing leaf cert at {} ({} day(s) remaining)",
            cert_path.display(),
            remaining
        );
        return Ok(());
    }

    issue_leaf(ca, &hosts)?;
    fs::write(&meta_path, want_hash).context("writing leaf meta")?;
    Ok(())
}

/// Generate a 90-day leaf cert covering `hosts` (DNS names + IP literals).
fn issue_leaf(ca: &CaMaterial, hosts: &[String]) -> Result<()> {
    let sans = build_sans(hosts)?;

    let san_display: Vec<String> = sans
        .iter()
        .map(|s| match s {
            SanType::DnsName(n) => n.to_string(),
            SanType::IpAddress(ip) => ip.to_string(),
            _ => "?".to_string(),
        })
        .collect();
    eprintln!("[ssl] Issuing leaf cert");
    eprintln!("[ssl]   SANs: {}", san_display.join(", "));
    eprintln!("[ssl]   Validity: {} days", LEAF_VALIDITY_DAYS);

    let leaf_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).context("generating leaf key")?;
    let mut params = CertificateParams::default();
    params
        .distinguished_name
        .push(DnType::CommonName, "mobux server");
    params.subject_alt_names = sans;
    params.is_ca = IsCa::NoCa;
    params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyEncipherment,
    ];
    params.extended_key_usages = vec![
        rcgen::ExtendedKeyUsagePurpose::ServerAuth,
        rcgen::ExtendedKeyUsagePurpose::ClientAuth,
    ];

    let now = OffsetDateTime::now_utc();
    let not_after = now
        .checked_add(time::Duration::days(LEAF_VALIDITY_DAYS))
        .ok_or_else(|| anyhow!("leaf not_after overflow"))?;
    params.not_before = now;
    params.not_after = not_after;

    let leaf = params
        .signed_by(&leaf_key, &ca.cert, &ca.key)
        .context("signing leaf cert with CA")?;

    // Write a chain so clients receive the CA along with the leaf — useful for
    // some HTTP clients that don't otherwise build the chain.
    let mut chain = leaf.pem();
    chain.push('\n');
    chain.push_str(&ca.cert.pem());

    write_secret(&leaf_key_path(), leaf_key.serialize_pem().as_bytes())?;
    fs::write(leaf_cert_path(), chain).context("writing leaf cert")?;
    fs::write(leaf_expiry_path(), not_after.unix_timestamp().to_string())
        .context("writing leaf expiry sidecar")?;

    Ok(())
}

fn collect_hosts(extra_hosts: &[String]) -> Vec<String> {
    let mut out: Vec<String> = vec![
        "localhost".into(),
        "127.0.0.1".into(),
        "::1".into(),
        "0.0.0.0".into(),
    ];
    if let Ok(hn) = hostname::get() {
        if let Some(s) = hn.to_str() {
            out.push(s.to_string());
        }
    }
    for h in extra_hosts {
        let h = h.trim();
        if !h.is_empty() {
            out.push(h.to_string());
        }
    }
    out.sort();
    out.dedup();
    out
}

fn build_sans(hosts: &[String]) -> Result<Vec<SanType>> {
    let mut sans: Vec<SanType> = Vec::with_capacity(hosts.len());
    for h in hosts {
        if let Ok(ip) = h.parse::<IpAddr>() {
            sans.push(SanType::IpAddress(ip));
        } else {
            let name: rcgen::Ia5String = h
                .as_str()
                .try_into()
                .with_context(|| format!("invalid DNS SAN: {h}"))?;
            sans.push(SanType::DnsName(name));
        }
    }
    Ok(sans)
}

fn hash_hosts(hosts: &[String]) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    for h in hosts {
        h.hash(&mut hasher);
        0u8.hash(&mut hasher); // separator so ["a","bc"] != ["ab","c"]
    }
    format!("{:016x}", hasher.finish())
}

fn write_secret(path: &Path, contents: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("creating dir: {}", parent.display()))?;
    }
    fs::write(path, contents).with_context(|| format!("writing {}", path.display()))?;
    let mut perms = fs::metadata(path)
        .with_context(|| format!("stat {}", path.display()))?
        .permissions();
    perms.set_mode(0o600);
    fs::set_permissions(path, perms).with_context(|| format!("chmod 0600 {}", path.display()))?;
    Ok(())
}

/// Read the recorded `not_after` for a cert (written at issuance time) and
/// return how many days remain until it expires. Returns `None` when the
/// sidecar is missing or unreadable — callers should treat that as expired.
fn remaining_days_from_sidecar(expiry_path: &Path) -> Option<i64> {
    let raw = fs::read_to_string(expiry_path).ok()?;
    let ts: i64 = raw.trim().parse().ok()?;
    let now = OffsetDateTime::now_utc().unix_timestamp();
    Some((ts - now) / 86400)
}

// ---------------------------------------------------------------------------
// ACME mode
// ---------------------------------------------------------------------------

async fn ensure_acme(challenges: AcmeChallenges) -> Result<CertPaths> {
    fs::create_dir_all(acme_dir())
        .with_context(|| format!("creating ACME dir: {}", acme_dir().display()))?;

    let domains = parse_acme_domains()?;
    let email = std::env::var("MOBUX_ACME_EMAIL")
        .context("MOBUX_ACME_EMAIL is required when MOBUX_ACME_DOMAINS is set")?;
    let directory = std::env::var("MOBUX_ACME_DIRECTORY")
        .unwrap_or_else(|_| ACME_DEFAULT_DIRECTORY.to_string());

    let cert_path = acme_cert_path();
    let key_path = acme_key_path();

    let remaining = remaining_days_from_sidecar(&acme_expiry_path()).unwrap_or(-1);
    let need_obtain =
        !cert_path.exists() || !key_path.exists() || remaining <= ACME_RENEW_THRESHOLD_DAYS;

    if need_obtain {
        obtain_acme_cert(&domains, &email, &directory, challenges.clone()).await?;
    } else {
        eprintln!(
            "[ssl] ACME cert at {} valid for {} more day(s)",
            cert_path.display(),
            remaining
        );
    }

    spawn_renewal_task(domains, email, directory, challenges);

    Ok(CertPaths {
        cert: cert_path,
        key: key_path,
        ca_cert: None,
    })
}

fn parse_acme_domains() -> Result<Vec<String>> {
    let raw = std::env::var("MOBUX_ACME_DOMAINS").context("MOBUX_ACME_DOMAINS not set")?;
    let domains: Vec<String> = raw
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if domains.is_empty() {
        return Err(anyhow!("MOBUX_ACME_DOMAINS contains no domains"));
    }
    Ok(domains)
}

async fn obtain_acme_cert(
    domains: &[String],
    email: &str,
    directory: &str,
    challenges: AcmeChallenges,
) -> Result<()> {
    use instant_acme::{
        AuthorizationStatus, ChallengeType, Identifier, NewOrder, OrderStatus, RetryPolicy,
    };

    eprintln!(
        "[ssl] ACME: requesting cert for {} via {}",
        domains.join(", "),
        directory
    );

    let contact = format!("mailto:{email}");
    let account = load_or_create_account(directory, &contact).await?;

    let identifiers: Vec<Identifier> = domains.iter().map(|d| Identifier::Dns(d.clone())).collect();
    let mut order = account
        .new_order(&NewOrder::new(&identifiers))
        .await
        .context("creating ACME order")?;

    let mut authorizations = order.authorizations();
    let mut tokens_added: Vec<String> = Vec::new();
    while let Some(result) = authorizations.next().await {
        let mut authz = result.context("fetching authorization")?;
        match authz.status {
            AuthorizationStatus::Pending => {}
            AuthorizationStatus::Valid => continue,
            other => return Err(anyhow!("unexpected authorization status: {other:?}")),
        }

        let mut challenge = authz
            .challenge(ChallengeType::Http01)
            .ok_or_else(|| anyhow!("ACME server did not offer http-01 challenge"))?;

        let key_auth = challenge.key_authorization();
        let token = challenge.token.clone();
        let value = key_auth.as_str().to_string();
        challenges
            .lock()
            .map_err(|_| anyhow!("acme challenges mutex poisoned"))?
            .insert(token.clone(), value);
        tokens_added.push(token);

        challenge
            .set_ready()
            .await
            .context("marking ACME challenge ready")?;
    }

    let status = order
        .poll_ready(&RetryPolicy::default())
        .await
        .context("polling ACME order ready")?;
    if status != OrderStatus::Ready {
        return Err(anyhow!("ACME order did not become ready: {status:?}"));
    }

    let private_key_pem = order.finalize().await.context("finalizing ACME order")?;
    let cert_chain_pem = order
        .poll_certificate(&RetryPolicy::default())
        .await
        .context("polling ACME certificate")?;

    write_secret(&acme_key_path(), private_key_pem.as_bytes())?;
    fs::write(acme_cert_path(), cert_chain_pem).context("writing ACME cert")?;
    // Let's Encrypt issues 90-day certs; record an expiry one day shy of that
    // so the renewal task triggers slightly early on the boundary.
    let assumed_validity_days: i64 = 90;
    let expiry = OffsetDateTime::now_utc().unix_timestamp() + (assumed_validity_days - 1) * 86400;
    fs::write(acme_expiry_path(), expiry.to_string()).context("writing ACME expiry sidecar")?;

    // Drop tokens once we're done — they should not be reused.
    if let Ok(mut map) = challenges.lock() {
        for tok in tokens_added {
            map.remove(&tok);
        }
    }

    eprintln!(
        "[ssl] ACME: cert installed at {}",
        acme_cert_path().display()
    );
    Ok(())
}

async fn load_or_create_account(directory: &str, contact: &str) -> Result<instant_acme::Account> {
    use instant_acme::{Account, NewAccount};

    let creds_path = acme_account_path();
    if creds_path.exists() {
        let raw = fs::read_to_string(&creds_path)
            .with_context(|| format!("reading {}", creds_path.display()))?;
        let creds: instant_acme::AccountCredentials =
            serde_json::from_str(&raw).context("parsing ACME account credentials")?;
        let account = Account::builder()?
            .from_credentials(creds)
            .await
            .context("loading ACME account from credentials")?;
        return Ok(account);
    }

    let (account, credentials) = Account::builder()?
        .create(
            &NewAccount {
                contact: &[contact],
                terms_of_service_agreed: true,
                only_return_existing: false,
            },
            directory.to_string(),
            None,
        )
        .await
        .context("creating ACME account")?;

    let json =
        serde_json::to_string_pretty(&credentials).context("serializing ACME credentials")?;
    write_secret(&creds_path, json.as_bytes())?;

    Ok(account)
}

fn spawn_renewal_task(
    domains: Vec<String>,
    email: String,
    directory: String,
    challenges: AcmeChallenges,
) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(ACME_RENEW_INTERVAL).await;
            let remaining = remaining_days_from_sidecar(&acme_expiry_path()).unwrap_or(-1);
            if remaining > ACME_RENEW_THRESHOLD_DAYS {
                continue;
            }
            eprintln!(
                "[ssl] ACME: cert has {} day(s) remaining; renewing",
                remaining
            );
            if let Err(e) = obtain_acme_cert(&domains, &email, &directory, challenges.clone()).await
            {
                eprintln!("[ssl] ACME renewal failed: {e:#}");
            }
        }
    });
}

// ---------------------------------------------------------------------------
// HTTP-01 challenge accessor (used by the route handler in main.rs)
// ---------------------------------------------------------------------------

/// Lookup the key-authorization for an HTTP-01 challenge token.
pub fn lookup_acme_challenge(challenges: &AcmeChallenges, token: &str) -> Option<String> {
    challenges.lock().ok().and_then(|m| m.get(token).cloned())
}
