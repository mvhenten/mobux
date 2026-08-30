//! `mobux update` — the CLI face of the in-app self-updater.
//!
//! The check reuses `update::fetch_latest_version`, so the CLI and the
//! background poller read the same crates.io sparse index through the same
//! `MOBUX_UPDATE_CHECK_URL` seam. The install reuses the embedded
//! `update_runner.sh` in `--install-only` mode, so the release-asset download,
//! the sha256 verification, the atomic rename over the live binary and the
//! `cargo install` fallback are one implementation rather than two.
//!
//! What the CLI owns instead of the script: the restart. The in-app updater
//! only ever runs under systemd, while `mobux update` may be updating a binary
//! that no service points at, so it restarts the unit when `mobux service
//! install` left one behind and says so plainly when it did not.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::cli::UpdateCommand;
use crate::{service, update};

/// The prebuilt release asset the updater prefers, per install.sh.
const ASSET_TARGET: &str = "x86_64-unknown-linux-gnu";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    UpToDate {
        current: String,
        latest: String,
    },
    Available {
        current: String,
        latest: String,
    },
    /// One of the two versions is not semver, so "newer" has no answer. Kept
    /// apart from `UpToDate` because a failed comparison must never read as
    /// "nothing to do".
    Unknown {
        current: String,
        latest: String,
    },
}

/// Compare the running version against the published one.
pub fn decide(current: &str, latest: &str) -> Decision {
    let (current, latest) = (current.to_string(), latest.to_string());
    if !update::is_semver(&current) || !update::is_semver(&latest) {
        return Decision::Unknown { current, latest };
    }
    if update::is_newer(&current, &latest) {
        return Decision::Available { current, latest };
    }
    Decision::UpToDate { current, latest }
}

/// The one line both `update` and `update --check` print.
pub fn describe(decision: &Decision) -> String {
    match decision {
        Decision::UpToDate { current, latest } => {
            format!("mobux {current} is up to date (latest published: {latest})")
        }
        Decision::Available { current, latest } => {
            format!("mobux {current} — an update is available: {latest}")
        }
        Decision::Unknown { current, latest } => {
            format!("mobux {current} — cannot compare against the published version {latest:?}")
        }
    }
}

/// The release ships a prebuilt asset for Linux x86_64 only; everywhere else
/// the updater compiles from source through `cargo install`.
pub fn has_prebuilt_asset(os: &str, arch: &str) -> bool {
    os == "linux" && arch == "x86_64"
}

pub async fn run(command: UpdateCommand) -> i32 {
    let current = update::UpdateState::current_version();
    let latest = match update::fetch_latest_version().await {
        Ok(latest) => latest,
        Err(e) => {
            eprintln!("mobux: could not check for updates: {e}");
            eprintln!(
                "       point MOBUX_UPDATE_CHECK_URL at a reachable mirror of the crates.io \
                 index, or install by hand: cargo install mobux --locked"
            );
            return 1;
        }
    };

    let decision = decide(current, &latest);
    println!("{}", describe(&decision));

    if command == UpdateCommand::Check {
        return 0;
    }

    match decision {
        Decision::UpToDate { .. } => 0,
        Decision::Unknown { latest, .. } => {
            eprintln!(
                "mobux: refusing to install {latest:?} — it is not a version this binary can \
                 compare against. Install the version you want by hand: \
                 cargo install mobux --locked --version <VERSION>"
            );
            1
        }
        Decision::Available { latest, .. } => apply(&latest),
    }
}

// ---------------------------------------------------------------------------
// Everything below shells out to bash and systemctl; the tests never call it.
// ---------------------------------------------------------------------------

fn apply(version: &str) -> i32 {
    match install(version) {
        Ok(bin) => restart_or_report(version, &bin),
        Err(message) => {
            eprintln!("mobux: {message}");
            1
        }
    }
}

fn install(version: &str) -> Result<PathBuf, String> {
    if std::env::var_os("MOBUX_UPDATE_DISABLE_RUN").is_some() {
        return Err(
            "self-update is disabled on this host (MOBUX_UPDATE_DISABLE_RUN); update mobux \
             the way this host manages it"
                .to_string(),
        );
    }

    let bin = std::env::current_exe()
        .map_err(|e| format!("could not resolve this binary's own path: {e}"))?;
    check_replaceable(&bin)?;

    let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
    if !has_prebuilt_asset(os, arch) {
        println!(
            "no prebuilt {ASSET_TARGET} asset for {os}/{arch} — installing from source with \
             cargo install, which takes several minutes"
        );
    }

    let dir = crate::resolve_data_dir().map_err(|e| format!("resolving the data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    let script = update::write_updater_script(&dir).map_err(|e| e.to_string())?;

    println!("installing mobux {version} over {}", bin.display());
    let status = Command::new("bash")
        .arg(&script)
        .arg("--install-only")
        .env("MOBUX_UPDATE_VERSION", version)
        .env("MOBUX_UPDATE_BIN", &bin)
        .env("MOBUX_UPDATE_ROOT", update::cargo_root(&bin))
        .status()
        .map_err(|e| format!("running the updater ({}): {e}", script.display()))?;

    match status.code() {
        Some(0) => Ok(bin),
        Some(4) => Err(
            "another update already holds the updater lock; wait for it to finish and try again"
                .to_string(),
        ),
        Some(code) => Err(format!(
            "the updater failed (exit {code}) and {} is unchanged. When no release asset exists \
             for this platform the fallback needs cargo: cargo install mobux --locked --version \
             {version}",
            bin.display()
        )),
        None => Err(format!(
            "the updater was killed by a signal; {} may be half-replaced — reinstall with \
             cargo install mobux --locked --version {version}",
            bin.display()
        )),
    }
}

/// The updater renames the new binary over the live one, which needs a writable
/// parent directory rather than a writable file. Probe for that before spending
/// a download on it, so "not yours to replace" is reported as such.
fn check_replaceable(bin: &Path) -> Result<(), String> {
    let dir = bin
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", bin.display()))?;
    let probe = dir.join(format!(".mobux-update-probe-{}", std::process::id()));
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|e| {
            format!(
                "cannot replace {}: {} is not writable ({e}). Run the update as the user that \
                 owns it, or install your own copy: cargo install mobux --locked",
                bin.display(),
                dir.display()
            )
        })?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

fn restart_or_report(version: &str, bin: &Path) -> i32 {
    let unit = service::unit_name(std::env::var("MOBUX_SERVICE_NAME").ok());
    let installed = service::config_dir()
        .map(|dir| service::unit_path(&dir, &unit).exists())
        .unwrap_or(false);

    if !installed {
        println!("mobux {version} installed at {}", bin.display());
        println!("no systemd --user unit {unit:?} here — restart any running mobux by hand");
        return 0;
    }

    match systemctl_restart(&unit) {
        Ok(()) => {
            println!("mobux {version} installed and unit {unit:?} restarted");
            0
        }
        Err(message) => {
            eprintln!("mobux: {message}");
            eprintln!(
                "       mobux {version} IS installed at {} — only the restart failed. The old \
                 version keeps serving until you run: systemctl --user restart {unit}",
                bin.display()
            );
            1
        }
    }
}

fn systemctl_restart(unit: &str) -> Result<(), String> {
    let output = Command::new("systemctl")
        .args(["--user", "restart", unit])
        .output()
        .map_err(|e| format!("running systemctl --user restart {unit}: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "systemctl --user restart {unit} failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_newer_published_version_is_an_update() {
        assert_eq!(
            decide("0.1.5", "0.1.6"),
            Decision::Available {
                current: "0.1.5".to_string(),
                latest: "0.1.6".to_string(),
            }
        );
        // Not a string compare: 0.1.20 beats 0.1.9.
        assert!(matches!(
            decide("0.1.9", "0.1.20"),
            Decision::Available { .. }
        ));
    }

    #[test]
    fn the_same_or_an_older_published_version_is_up_to_date() {
        assert_eq!(
            decide("0.1.5", "0.1.5"),
            Decision::UpToDate {
                current: "0.1.5".to_string(),
                latest: "0.1.5".to_string(),
            }
        );
        // A local build ahead of crates.io still has nothing to install.
        assert!(matches!(
            decide("0.2.0", "0.1.5"),
            Decision::UpToDate { .. }
        ));
    }

    #[test]
    fn an_unparseable_version_is_not_silently_up_to_date() {
        assert!(matches!(
            decide("0.1.5", "nightly"),
            Decision::Unknown { .. }
        ));
        assert!(matches!(decide("dev", "0.1.5"), Decision::Unknown { .. }));
        // Two components is not semver, so the comparison has no answer.
        assert!(matches!(decide("0.1", "0.1.5"), Decision::Unknown { .. }));
    }

    #[test]
    fn every_outcome_prints_both_versions() {
        for decision in [
            decide("0.1.5", "0.1.6"),
            decide("0.1.5", "0.1.5"),
            decide("0.1.5", "nightly"),
        ] {
            let line = describe(&decision);
            assert!(line.contains("0.1.5"), "{line}");
        }
        assert!(describe(&decide("0.1.5", "0.1.6")).contains("update is available"));
        assert!(describe(&decide("0.1.5", "0.1.5")).contains("up to date"));
    }

    #[test]
    fn only_linux_x86_64_has_a_prebuilt_asset() {
        assert!(has_prebuilt_asset("linux", "x86_64"));
        assert!(!has_prebuilt_asset("linux", "aarch64"));
        assert!(!has_prebuilt_asset("macos", "x86_64"));
    }

    /// The check path end to end against a local server — proving the CLI reads
    /// the same seam `MOBUX_UPDATE_CHECK_URL` overrides, with no live network.
    #[tokio::test]
    async fn the_check_decides_from_what_the_check_url_serves() {
        let url = update::serve_once(
            "200 OK",
            "{\"name\":\"mobux\",\"vers\":\"999.0.0\",\"yanked\":false}\n",
        )
        .await;
        let latest = update::fetch_latest_version_from(&url).await.unwrap();
        assert!(matches!(
            decide(update::UpdateState::current_version(), &latest),
            Decision::Available { .. }
        ));
    }
}
