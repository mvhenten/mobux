//! Building the Android TWA package from the running server.
//!
//! `make twa` only exists inside a source checkout, and the installed binary
//! runs as a systemd service whose working directory is the user's home — so
//! neither the build inputs nor the old cwd-relative artifact paths resolve
//! there. Everything the build needs is embedded and materialised under the
//! data dir instead, which makes "Generate package" work on a deployed
//! instance and on a dev checkout alike.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

pub const BUILD_SCRIPT: &str = include_str!("../bin/twa-build");
pub const INIT_JS: &str = include_str!("../twa/init.js");
pub const MANIFEST_TEMPLATE: &str = include_str!("../twa/twa-manifest.json.template");

/// Where a repo checkout's `make twa` writes its artifacts. Still honoured so
/// a dev instance started from the checkout serves what `make twa` produced.
pub const CHECKOUT_APK_PATH: &str = "web/static/install/mobux.apk";
pub const CHECKOUT_ASSETLINKS_PATH: &str = "web/static/.well-known/assetlinks.json";

pub fn work_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("twa")
}

pub fn apk_path(data_dir: &Path) -> PathBuf {
    data_dir.join("install").join("mobux.apk")
}

pub fn assetlinks_path(data_dir: &Path) -> PathBuf {
    data_dir.join(".well-known").join("assetlinks.json")
}

/// The artifact a request should be served, preferring what this server built
/// over what a checkout's `make twa` left behind.
pub fn resolve_artifact(built: PathBuf, checkout: &str) -> PathBuf {
    if built.is_file() {
        return built;
    }
    PathBuf::from(checkout)
}

/// Write the embedded build inputs into the data dir and return the script
/// path. Rewritten on every build so an upgraded binary replaces a stale copy.
pub fn materialize(data_dir: &Path) -> Result<PathBuf> {
    let dir = work_dir(data_dir);
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("creating twa work dir: {}", dir.display()))?;

    let script = dir.join("twa-build");
    std::fs::write(&script, BUILD_SCRIPT)
        .with_context(|| format!("writing {}", script.display()))?;
    std::fs::write(dir.join("init.js"), INIT_JS).context("writing twa init.js")?;
    std::fs::write(dir.join("twa-manifest.json.template"), MANIFEST_TEMPLATE)
        .context("writing twa manifest template")?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("chmod {}", script.display()))?;
    }

    Ok(script)
}

/// Operator override for the domain the package is pinned to.
pub fn configured_domain() -> Option<String> {
    std::env::var("MOBUX_DOMAIN").ok()
}

/// The authority the APK will be pinned to. An explicit `MOBUX_DOMAIN` wins;
/// otherwise it comes off the request's `Host` header, so the package points
/// at whatever address the user actually reaches this server on and nobody has
/// to type it. A default TLS port is dropped — `example.com:443` and
/// `example.com` are different TWA hosts to Android.
pub fn resolve_domain(
    configured: Option<&str>,
    host_header: Option<&str>,
) -> Result<String, String> {
    let usable = |s: &Option<&str>| {
        s.map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    let raw = usable(&configured)
        .or_else(|| usable(&host_header))
        .ok_or_else(|| "no Host header on the request and MOBUX_DOMAIN is not set".to_string())?;

    let domain = raw.strip_suffix(":443").unwrap_or(&raw);
    validate_domain(domain).map(|_| domain.to_string())
}

fn validate_domain(domain: &str) -> Result<(), String> {
    if domain.is_empty() {
        return Err("empty domain".to_string());
    }
    let (host, port) = match domain.rsplit_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (domain, None),
    };
    if host.is_empty()
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err(format!("{domain:?} is not a usable host name"));
    }
    if let Some(p) = port {
        if p.parse::<u16>().is_err() {
            return Err(format!("{domain:?} has an invalid port"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_comes_from_the_host_header() {
        assert_eq!(
            resolve_domain(None, Some("box.example.com")).unwrap(),
            "box.example.com"
        );
        assert_eq!(
            resolve_domain(None, Some("sandbox:5152")).unwrap(),
            "sandbox:5152"
        );
    }

    #[test]
    fn a_configured_domain_wins_over_the_host_header() {
        assert_eq!(
            resolve_domain(Some("pinned.example.com"), Some("box.example.com")).unwrap(),
            "pinned.example.com"
        );
        assert_eq!(
            resolve_domain(Some("  "), Some("box.example.com")).unwrap(),
            "box.example.com"
        );
    }

    #[test]
    fn default_tls_port_is_dropped() {
        assert_eq!(
            resolve_domain(None, Some("box.example.com:443")).unwrap(),
            "box.example.com"
        );
    }

    #[test]
    fn a_missing_host_header_is_an_error_not_a_guess() {
        assert!(resolve_domain(None, None).is_err());
        assert!(resolve_domain(None, Some("   ")).is_err());
    }

    #[test]
    fn a_host_header_carrying_a_scheme_or_path_is_rejected() {
        for bad in [
            "https://box.example.com",
            "box.example.com/app",
            "box:notaport",
        ] {
            assert!(
                resolve_domain(None, Some(bad)).is_err(),
                "should reject {bad:?}"
            );
        }
    }

    #[test]
    fn materialize_writes_an_executable_script_and_its_inputs() {
        let dir = tempfile::tempdir().unwrap();
        let script = materialize(dir.path()).unwrap();
        assert!(script.is_file());
        assert!(work_dir(dir.path()).join("init.js").is_file());
        assert!(work_dir(dir.path())
            .join("twa-manifest.json.template")
            .is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&script).unwrap().permissions().mode();
            assert_eq!(mode & 0o100, 0o100, "script must be owner-executable");
        }
    }

    /// The build script runs under `set -euo pipefail`, so a password pipeline
    /// whose producer is killed by SIGPIPE aborts the whole build with a bare
    /// exit 141 before the keystore is ever generated.
    #[test]
    fn the_generated_keystore_password_survives_pipefail() {
        let marker = "generate_keystore_password() {";
        let body = BUILD_SCRIPT
            .split_once(marker)
            .and_then(|(_, rest)| rest.split_once("\n}\n"))
            .map(|(body, _)| body)
            .expect("twa-build must define generate_keystore_password()");

        let program = format!(
            "set -euo pipefail\n{marker}{body}\n}}\nfor _ in $(seq 20); do generate_keystore_password; echo; done\n"
        );
        let out = std::process::Command::new("bash")
            .arg("-c")
            .arg(&program)
            .output()
            .expect("running bash");

        assert_eq!(
            out.status.code(),
            Some(0),
            "password generation exited {:?}: {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr)
        );
        let stdout = String::from_utf8(out.stdout).expect("password must be ascii");
        let passwords: Vec<&str> = stdout.lines().collect();
        assert_eq!(passwords.len(), 20);
        for password in passwords {
            assert_eq!(password.len(), 32, "wrong length: {password:?}");
            assert!(
                password.chars().all(|c| c.is_ascii_alphanumeric()),
                "not alphanumeric: {password:?}"
            );
        }
    }

    #[test]
    fn artifact_resolution_prefers_the_built_copy() {
        let dir = tempfile::tempdir().unwrap();
        let built = apk_path(dir.path());
        assert_eq!(
            resolve_artifact(built.clone(), CHECKOUT_APK_PATH),
            PathBuf::from(CHECKOUT_APK_PATH)
        );
        std::fs::create_dir_all(built.parent().unwrap()).unwrap();
        std::fs::write(&built, b"apk").unwrap();
        assert_eq!(resolve_artifact(built.clone(), CHECKOUT_APK_PATH), built);
    }
}
