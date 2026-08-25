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
pub const SETUP_SCRIPT: &str = include_str!("../bin/setup-twa");
pub const INIT_JS: &str = include_str!("../twa/init.js");
pub const MANIFEST_TEMPLATE: &str = include_str!("../twa/twa-manifest.json.template");

/// OS packages the toolchain install shells out to and cannot supply itself:
/// SDKMAN and the Android SDK manager unpack their downloads with them. Every
/// other prerequisite is installed user-locally by the setup script.
pub const HOST_PACKAGES: [&str; 3] = ["curl", "unzip", "zip"];

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

/// The two scripts the build runs: the toolchain install, and the build that
/// follows it.
pub struct Scripts {
    pub setup: PathBuf,
    pub build: PathBuf,
}

/// Write the embedded build inputs into the data dir and return the script
/// paths. Rewritten on every build so an upgraded binary replaces a stale copy.
pub fn materialize(data_dir: &Path) -> Result<Scripts> {
    let dir = work_dir(data_dir);
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("creating twa work dir: {}", dir.display()))?;

    let build = dir.join("twa-build");
    std::fs::write(&build, BUILD_SCRIPT).with_context(|| format!("writing {}", build.display()))?;
    let setup = dir.join("setup-twa");
    std::fs::write(&setup, SETUP_SCRIPT).with_context(|| format!("writing {}", setup.display()))?;
    std::fs::write(dir.join("init.js"), INIT_JS).context("writing twa init.js")?;
    std::fs::write(dir.join("twa-manifest.json.template"), MANIFEST_TEMPLATE)
        .context("writing twa manifest template")?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for script in [&build, &setup] {
            std::fs::set_permissions(script, std::fs::Permissions::from_mode(0o700))
                .with_context(|| format!("chmod {}", script.display()))?;
        }
    }

    Ok(Scripts { setup, build })
}

/// Ask the build script whether it can build. It runs the same toolchain
/// bootstrap and looks for the same tools the build does, so the pre-phase's
/// notion of "missing" cannot drift from what the build actually needs.
pub fn toolchain_check(build_script: &Path) -> std::process::Command {
    let mut command = std::process::Command::new("bash");
    command
        .arg(build_script)
        .arg("--check-toolchain")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    command
}

pub fn toolchain_present(build_script: &Path) -> bool {
    toolchain_check(build_script)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

fn on_path(tool: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| is_executable(&dir.join(tool)))
}

/// The host packages that are needed and absent, in a stable order.
pub fn missing_host_packages(present: impl Fn(&str) -> bool) -> Vec<&'static str> {
    HOST_PACKAGES
        .into_iter()
        .filter(|tool| !present(tool))
        .collect()
}

pub fn missing_host_packages_on_path() -> Vec<&'static str> {
    missing_host_packages(on_path)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PackageManager {
    Apt,
    Dnf,
    Pacman,
    Zypper,
}

impl PackageManager {
    /// Apt is the fallback rather than an error: naming one concrete command
    /// the user can paste beats making them work out their own.
    pub fn detect(present: impl Fn(&str) -> bool) -> Self {
        for (tool, manager) in [
            ("apt-get", Self::Apt),
            ("dnf", Self::Dnf),
            ("pacman", Self::Pacman),
            ("zypper", Self::Zypper),
        ] {
            if present(tool) {
                return manager;
            }
        }
        Self::Apt
    }

    pub fn install_command(self, packages: &[&str]) -> String {
        let list = packages.join(" ");
        match self {
            Self::Apt => format!("sudo apt-get install -y {list}"),
            Self::Dnf => format!("sudo dnf install -y {list}"),
            Self::Pacman => format!("sudo pacman -S --noconfirm {list}"),
            Self::Zypper => format!("sudo zypper install -y {list}"),
        }
    }
}

pub fn host_package_install_command(packages: &[&str]) -> String {
    PackageManager::detect(on_path).install_command(packages)
}

pub fn missing_host_packages_error(packages: &[&str], install_command: &str) -> String {
    format!(
        "The build tools need {} on this host, and only the system package manager can install {}. Run: {install_command}",
        packages.join(", "),
        if packages.len() == 1 { "it" } else { "them" },
    )
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
        let scripts = materialize(dir.path()).unwrap();
        assert!(scripts.build.is_file());
        assert!(scripts.setup.is_file());
        assert!(work_dir(dir.path()).join("init.js").is_file());
        assert!(work_dir(dir.path())
            .join("twa-manifest.json.template")
            .is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for script in [&scripts.build, &scripts.setup] {
                let mode = std::fs::metadata(script).unwrap().permissions().mode();
                assert_eq!(mode & 0o100, 0o100, "script must be owner-executable");
            }
        }
    }

    #[test]
    fn the_preflight_names_only_the_packages_that_are_absent() {
        assert!(missing_host_packages(|_| true).is_empty());
        assert_eq!(missing_host_packages(|tool| tool != "zip"), vec!["zip"]);
        assert_eq!(
            missing_host_packages(|tool| tool == "curl"),
            vec!["unzip", "zip"]
        );
    }

    #[test]
    fn the_install_command_matches_the_hosts_package_manager() {
        let missing = ["unzip", "zip"];
        assert_eq!(
            PackageManager::detect(|t| t == "apt-get").install_command(&missing),
            "sudo apt-get install -y unzip zip"
        );
        assert_eq!(
            PackageManager::detect(|t| t == "dnf").install_command(&missing),
            "sudo dnf install -y unzip zip"
        );
        assert_eq!(
            PackageManager::detect(|_| false),
            PackageManager::Apt,
            "an unrecognised host still gets a command it can paste"
        );
    }

    #[test]
    fn the_preflight_error_carries_the_command_that_fixes_it() {
        let error = missing_host_packages_error(&["zip"], "sudo apt-get install -y zip");
        assert!(error.contains("zip"), "{error}");
        assert!(error.contains("sudo apt-get install -y zip"), "{error}");
    }

    /// The toolchain pre-phase decides by asking the build script itself, so
    /// these two cases are the real detection, not a copy of it. `HOME` points
    /// at an empty dir so no SDKMAN or nvm install on the host can leak in.
    #[cfg(unix)]
    fn toolchain_check_with(tools: &[&str]) -> bool {
        use std::os::unix::fs::PermissionsExt;

        let home = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        for tool in ["bash", "dirname"] {
            let out = std::process::Command::new("sh")
                .arg("-c")
                .arg(format!("command -v {tool}"))
                .output()
                .expect("resolving a host tool");
            let target = String::from_utf8(out.stdout).unwrap().trim().to_string();
            assert!(!target.is_empty(), "{tool} must exist to run this test");
            std::os::unix::fs::symlink(target, bin.path().join(tool)).unwrap();
        }
        for tool in tools {
            let stub = bin.path().join(tool);
            std::fs::write(&stub, "#!/bin/sh\nexit 0\n").unwrap();
            std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let data_dir = tempfile::tempdir().unwrap();
        let scripts = materialize(data_dir.path()).unwrap();
        toolchain_check(&scripts.build)
            .env("PATH", bin.path())
            .env("HOME", home.path())
            .env_remove("SDKMAN_DIR")
            .env_remove("NVM_DIR")
            .env_remove("ANDROID_SDK_ROOT")
            .env_remove("ANDROID_HOME")
            .env_remove("NPM_PREFIX")
            .status()
            .expect("running the toolchain check")
            .success()
    }

    #[cfg(unix)]
    #[test]
    fn a_host_without_the_toolchain_reports_it_missing() {
        assert!(!toolchain_check_with(&[]));
        assert!(
            !toolchain_check_with(&["node", "java", "keytool"]),
            "a partial toolchain is still missing"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_host_with_the_toolchain_reports_it_present() {
        assert!(toolchain_check_with(&[
            "node",
            "java",
            "keytool",
            "bubblewrap"
        ]));
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

    /// The launcher Google ships for every cmdline-tools binary: it walks `$0`
    /// through `while [ -h ]` — file symlinks only — and derives the classpath
    /// root from where that lands.
    #[cfg(unix)]
    const FAKE_SDKMANAGER: &str = r#"#!/usr/bin/env bash
PRG="$0"
while [ -h "$PRG" ]; do
    ls=$(ls -ld "$PRG")
    link=${ls#*' -> '}
    case $link in
    /*) PRG="$link" ;;
    *) PRG="$(dirname "$PRG")/$link" ;;
    esac
done
APP_HOME=$(cd "$(dirname "$PRG")/.." && pwd -P)
if [ ! -f "$APP_HOME/lib/sdkmanager-classpath.jar" ]; then
    echo "Error: Could not find or load main class com.android.sdklib.tool.sdkmanager.SdkManagerCli" >&2
    exit 1
fi
echo "12.0"
"#;

    #[cfg(unix)]
    fn fake_android_sdk() -> tempfile::TempDir {
        use std::os::unix::fs::PermissionsExt;

        let sdk = tempfile::tempdir().unwrap();
        let tools = sdk.path().join("cmdline-tools").join("latest");
        std::fs::create_dir_all(tools.join("bin")).unwrap();
        std::fs::create_dir_all(tools.join("lib")).unwrap();
        std::fs::write(tools.join("lib").join("sdkmanager-classpath.jar"), b"jar").unwrap();

        let launcher = tools.join("bin").join("sdkmanager");
        std::fs::write(&launcher, FAKE_SDKMANAGER).unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
        sdk
    }

    #[cfg(unix)]
    fn bash(program: &str) -> std::process::Output {
        std::process::Command::new("bash")
            .arg("-c")
            .arg(program)
            .output()
            .expect("running bash")
    }

    /// Run the setup script's link step against a fake SDK. The script returns
    /// early when sourced, so nothing gets installed.
    #[cfg(unix)]
    fn link_android_bin(sdk: &Path) -> std::process::Output {
        bash(&format!(
            "set -euo pipefail\nexport ANDROID_SDK_ROOT='{}'\n. '{}'\nensure_android_bin_links\n",
            sdk.display(),
            concat!(env!("CARGO_MANIFEST_DIR"), "/bin/setup-twa"),
        ))
    }

    #[cfg(unix)]
    fn sdkmanager_version(sdk: &Path) -> std::process::Output {
        bash(&format!("'{}/bin/sdkmanager' --version", sdk.display()))
    }

    /// Bubblewrap only accepts an SDK with a `<SDK>/bin`, so setup makes one.
    /// As a symlinked directory it satisfies bubblewrap and breaks every tool
    /// behind it, which is what a real APK build hits the moment bubblewrap
    /// shells out to sdkmanager.
    #[cfg(unix)]
    #[test]
    fn the_sdk_bin_dir_keeps_the_launchers_working() {
        let sdk = fake_android_sdk();

        let broken = bash(&format!(
            "ln -s cmdline-tools/latest/bin '{}/bin'",
            sdk.path().display()
        ));
        assert!(broken.status.success());
        let out = sdkmanager_version(sdk.path());
        assert!(
            !out.status.success() && String::from_utf8_lossy(&out.stderr).contains("SdkManagerCli"),
            "a directory symlink must break the launcher, or this test proves nothing"
        );

        let linked = link_android_bin(sdk.path());
        assert!(
            linked.status.success(),
            "link step failed: {}",
            String::from_utf8_lossy(&linked.stderr)
        );
        assert!(!sdk.path().join("bin").is_symlink());

        let out = sdkmanager_version(sdk.path());
        assert!(
            out.status.success(),
            "sdkmanager failed through {}/bin: {}",
            sdk.path().display(),
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "12.0");
    }

    #[cfg(unix)]
    #[test]
    fn re_running_setup_repairs_a_stale_link() {
        let sdk = fake_android_sdk();
        assert!(link_android_bin(sdk.path()).status.success());

        let link = sdk.path().join("bin").join("sdkmanager");
        std::fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink("cmdline-tools/latest/bin/sdkmanager", &link).unwrap();
        assert!(!sdkmanager_version(sdk.path()).status.success());

        assert!(link_android_bin(sdk.path()).status.success());
        assert!(sdkmanager_version(sdk.path()).status.success());
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
