use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use rcgen::{
    CertificateParams, DnType, IsCa, KeyPair, SanType,
};
use rustls_pki_types::{CertificateDer, PrivateKeyDer};

const CERT_VALIDITY_DAYS: u32 = 30;

/// Returns (cert_pem, key_pem) file paths, generating them if needed.
pub fn ensure_dev_cert(extra_hosts: &[String]) -> Result<(PathBuf, PathBuf)> {
    let cache_dir = cache_dir();
    fs::create_dir_all(&cache_dir)
        .with_context(|| format!("creating cert cache dir: {}", cache_dir.display()))?;

    let cert_path = cache_dir.join("dev-server.crt");
    let key_path = cache_dir.join("dev-server.key");

    if cert_path.exists() && key_path.exists() && !is_expired(&cert_path) {
        eprintln!("[ssl] Using cached certificate from {}", cache_dir.display());
        return Ok((cert_path, key_path));
    }

    generate_cert(&cert_path, &key_path, extra_hosts)?;
    Ok((cert_path, key_path))
}

/// Load rustls ServerConfig from PEM files on disk.
pub fn load_rustls_config(cert_path: &PathBuf, key_path: &PathBuf) -> Result<rustls::ServerConfig> {
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

fn cache_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("MOBUX_CERT_DIR") {
        return PathBuf::from(dir);
    }

    dirs_cache().join("mobux").join("ssl")
}

fn dirs_cache() -> PathBuf {
    // XDG_DATA_HOME or ~/.local/share
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        return PathBuf::from(xdg);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".local").join("share")
}

/// Very rough expiry check: if the file was last modified more than
/// (CERT_VALIDITY_DAYS - 1) days ago, consider it expired.
fn is_expired(cert_path: &PathBuf) -> bool {
    let Ok(meta) = fs::metadata(cert_path) else {
        return true;
    };
    let Ok(modified) = meta.modified() else {
        return true;
    };
    let age = SystemTime::now()
        .duration_since(modified)
        .unwrap_or_default();
    let max_age_secs = ((CERT_VALIDITY_DAYS - 1) as u64) * 24 * 3600;
    age.as_secs() > max_age_secs
}

fn generate_cert(cert_path: &PathBuf, key_path: &PathBuf, extra_hosts: &[String]) -> Result<()> {
    // Collect SANs
    let mut sans: Vec<SanType> = vec![
        SanType::DnsName("localhost".try_into()?),
        SanType::IpAddress(std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1))),
        SanType::IpAddress(std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)),
        SanType::IpAddress(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED)),
    ];

    // Add machine hostname
    if let Ok(hn) = hostname::get() {
        if let Some(hn_str) = hn.to_str() {
            if let Ok(name) = hn_str.try_into() {
                sans.push(SanType::DnsName(name));
            }
        }
    }

    // Add extra hosts (from env or args)
    for host in extra_hosts {
        if let Ok(ip) = host.parse::<std::net::IpAddr>() {
            sans.push(SanType::IpAddress(ip));
        } else if let Ok(name) = host.as_str().try_into() {
            sans.push(SanType::DnsName(name));
        }
    }

    let san_display: Vec<String> = sans
        .iter()
        .map(|s| match s {
            SanType::DnsName(n) => n.to_string(),
            SanType::IpAddress(ip) => ip.to_string(),
            _ => "?".to_string(),
        })
        .collect();

    eprintln!("[ssl] Generating self-signed certificate …");
    eprintln!("[ssl]   SANs: {}", san_display.join(", "));
    eprintln!("[ssl]   Valid for {} days", CERT_VALIDITY_DAYS);
    eprintln!("[ssl]   Cache: {}", cert_path.parent().unwrap().display());

    let key_pair = KeyPair::generate()?;

    let mut params = CertificateParams::default();
    params.distinguished_name.push(DnType::CommonName, "Mobux Dev Server");
    params.distinguished_name.push(DnType::OrganizationName, "Local Development");
    params.subject_alt_names = sans;
    params.not_before = rcgen::date_time_ymd(2024, 1, 1);

    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    let end = now.as_secs() + (CERT_VALIDITY_DAYS as u64) * 24 * 3600;
    // Approximate year/month/day for the end date
    let end_days = end / 86400;
    let (y, m, d) = days_to_ymd(end_days);
    params.not_after = rcgen::date_time_ymd(y as i32, m as u8, d as u8);
    params.is_ca = IsCa::NoCa;

    let cert = params.self_signed(&key_pair)?;

    fs::write(key_path, key_pair.serialize_pem()).context("writing key file")?;
    fs::write(cert_path, cert.pem()).context("writing cert file")?;

    eprintln!("[ssl] Certificate generated successfully.");
    eprintln!("[ssl] ⚠  Your browser will show a security warning — this is expected.");
    eprintln!("[ssl]    In Chrome, type 'thisisunsafe' on the warning page to bypass it.");

    Ok(())
}

/// Convert days since epoch to (year, month, day) — rough civil calendar conversion.
fn days_to_ymd(days: u64) -> (u64, u64, u64) {
    // Algorithm from https://howardhinnant.github.io/date_algorithms.html
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
