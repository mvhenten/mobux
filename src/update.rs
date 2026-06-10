//! Self-update support (issue #130).
//!
//! Two concerns live here:
//!
//!   * **Update checker** — a background tokio task polls the crates.io sparse
//!     index for the latest published `mobux` version every ~6h, caches the
//!     result in memory with a timestamp, and exposes it to the API handlers.
//!     Version comparison is real semver, not string compare.
//!   * **Detached updater** — an embedded bash script is written to
//!     `MOBUX_DATA_DIR` and spawned fully detached (setsid + stdio to a log
//!     file). It snapshots the current binary, `cargo install`s the new
//!     version, restarts the systemd unit, health-checks the new version on
//!     `/api/identify`, and rolls back on failure. Everything is parameterized
//!     — no hardcoded prod port or unit name.
//!
//! Design decisions (from #130 + mesh-edd):
//!   * v1 installs via `cargo install` (no prebuilt binaries).
//!   * Rollback runs in a process that outlives the server, since the restart
//!     kills the server mid-update.
//!   * The crates.io URL is overridable via `MOBUX_UPDATE_CHECK_URL` so CI /
//!     tests stay hermetic (no live network).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::RwLock;

/// How often the background task refreshes the cached latest version.
const POLL_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Timeout for a single crates.io fetch. Kept short; a failed poll just leaves
/// the previous cache value in place and retries on the next tick.
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// The crate this binary builds as — the name we query crates.io for.
const CRATE_NAME: &str = "mobux";

/// User-Agent sent to crates.io. Their crawler policy
/// (<https://crates.io/data-access>) requires a UA that identifies the client
/// and a contact; this points back at the repo.
const USER_AGENT: &str = concat!(
    "mobux/",
    env!("CARGO_PKG_VERSION"),
    " (self-update; +https://github.com/mvhenten/mobux)"
);

/// In-memory cache of the latest-version check, shared with the API handlers.
#[derive(Clone)]
pub struct UpdateState {
    inner: Arc<RwLock<Cache>>,
    /// Set while an updater is being spawned / running, so a second concurrent
    /// `POST /api/update/run` is rejected instead of racing the snapshot. Belt
    /// to the script's flock braces.
    running: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Default)]
struct Cache {
    /// Latest version string from crates.io, if a poll has succeeded.
    latest: Option<String>,
    /// RFC3339 timestamp of the last successful poll.
    checked_at: Option<String>,
    /// Last error message from a failed poll (surfaced for debugging).
    last_error: Option<String>,
}

/// The JSON shape returned by the status/check endpoints.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct UpdateStatus {
    /// This running binary's version (CARGO_PKG_VERSION).
    pub current: String,
    /// Latest published version, if known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<String>,
    /// True when `latest` is strictly newer than `current` (semver).
    pub available: bool,
    /// RFC3339 timestamp of the last successful check, if any.
    #[serde(rename = "checkedAt", skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    /// Last poll error, if the most recent attempt failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl UpdateState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(Cache::default())),
            running: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    /// This binary's compile-time version.
    pub fn current_version() -> &'static str {
        env!("CARGO_PKG_VERSION")
    }

    /// Atomically claim the "an update is running" flag. Returns `true` to the
    /// first caller and `false` to any concurrent caller until the run
    /// finishes. The first caller owns the flag and must clear it (via
    /// [`UpdateState::end_run`]) if it does NOT go on to spawn a detached
    /// updater — once the updater is spawned the flag stays set for this
    /// process's lifetime, since a successful update restarts it anyway.
    pub fn try_begin_run(&self) -> bool {
        use std::sync::atomic::Ordering;
        self.running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// Release the running flag. Called when a claimed run is abandoned before
    /// spawning (e.g. nothing to update, or the spawn itself failed) so a later
    /// retry isn't permanently locked out.
    pub fn end_run(&self) {
        self.running
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// Snapshot the cache into the API status shape.
    pub async fn status(&self) -> UpdateStatus {
        let c = self.inner.read().await;
        let current = Self::current_version().to_string();
        let available = c
            .latest
            .as_deref()
            .map(|l| is_newer(&current, l))
            .unwrap_or(false);
        UpdateStatus {
            current,
            latest: c.latest.clone(),
            available,
            checked_at: c.checked_at.clone(),
            error: c.last_error.clone(),
        }
    }

    /// Force a poll now, update the cache, and return the fresh status. On
    /// failure the cache keeps any previously-known latest version but records
    /// the error.
    pub async fn refresh(&self) -> UpdateStatus {
        match fetch_latest_version().await {
            Ok(latest) => {
                let mut c = self.inner.write().await;
                c.latest = Some(latest);
                c.checked_at = Some(now_rfc3339());
                c.last_error = None;
            }
            Err(e) => {
                let mut c = self.inner.write().await;
                c.last_error = Some(e);
            }
        }
        self.status().await
    }
}

impl Default for UpdateState {
    fn default() -> Self {
        Self::new()
    }
}

/// Spawn the background poller. Polls immediately, then every `POLL_INTERVAL`.
pub fn spawn_checker(state: UpdateState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(POLL_INTERVAL);
        loop {
            tick.tick().await;
            let _ = state.refresh().await;
        }
    });
}

/// Current time as an RFC3339 string (UTC).
fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ── crates.io fetching + parsing ──────────────────────────────────────────

/// Where to fetch the version list. Defaults to the crates.io **sparse index**
/// (crawler-friendly, no rate-limit headache, official). The path layout is
/// documented at <https://doc.rust-lang.org/cargo/reference/registry-index.html>.
/// Overridable via `MOBUX_UPDATE_CHECK_URL` (full URL) so tests/CI never hit
/// the live network.
fn check_url() -> String {
    if let Ok(u) = std::env::var("MOBUX_UPDATE_CHECK_URL") {
        if !u.trim().is_empty() {
            return u;
        }
    }
    sparse_index_url(CRATE_NAME)
}

/// Build the sparse-index path for a crate name per cargo's index layout:
/// 1-char → `1/{name}`, 2 → `2/{name}`, 3 → `3/{first}/{name}`, else
/// `{c1}{c2}/{c3}{c4}/{name}`. mobux is 5 chars → `mo/bu/mobux`.
fn sparse_index_url(name: &str) -> String {
    let lower = name.to_lowercase();
    let path = match lower.len() {
        0 => lower.clone(),
        1 => format!("1/{lower}"),
        2 => format!("2/{lower}"),
        3 => format!("3/{}/{}", &lower[0..1], lower),
        _ => format!("{}/{}/{}", &lower[0..2], &lower[2..4], lower),
    };
    format!("https://index.crates.io/{path}")
}

/// Fetch and parse the latest non-yanked version from the configured URL.
async fn fetch_latest_version() -> Result<String, String> {
    let url = check_url();
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|e| format!("building http client: {e}"))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("fetching {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("{url} returned HTTP {}", resp.status()));
    }
    let body = resp
        .text()
        .await
        .map_err(|e| format!("reading {url}: {e}"))?;
    latest_from_index(&body)
        .ok_or_else(|| format!("no usable version found in index response from {url}"))
}

/// Parse the crates.io sparse-index body (newline-delimited JSON, one object
/// per published version) and return the highest non-yanked semver. Lines that
/// don't parse are skipped so a single malformed line can't break the check.
pub fn latest_from_index(body: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Entry {
        vers: String,
        #[serde(default)]
        yanked: bool,
    }

    let mut best: Option<(SemVer, String)> = None;
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Entry>(line) else {
            continue;
        };
        if entry.yanked {
            continue;
        }
        let Some(parsed) = SemVer::parse(&entry.vers) else {
            continue;
        };
        match &best {
            Some((b, _)) if parsed <= *b => {}
            _ => best = Some((parsed, entry.vers)),
        }
    }
    best.map(|(_, s)| s)
}

// ── semver comparison ─────────────────────────────────────────────────────

/// Minimal semver for comparison: major.minor.patch with optional pre-release.
/// Build metadata is ignored (per semver §10). Pre-release ordering follows
/// semver §11 (a version with a pre-release is lower than the same without).
/// We deliberately avoid a heavy semver crate dep — the comparison we need is
/// small and well-defined.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SemVer {
    major: u64,
    minor: u64,
    patch: u64,
    /// Dot-separated pre-release identifiers; empty = a normal release.
    pre: Vec<String>,
}

impl SemVer {
    fn parse(s: &str) -> Option<SemVer> {
        let s = s.trim();
        // Split off build metadata (`+...`) — ignored for precedence.
        let s = s.split('+').next().unwrap_or(s);
        // Split off pre-release (`-...`).
        let (core, pre) = match s.split_once('-') {
            Some((c, p)) => (c, p),
            None => (s, ""),
        };
        let mut parts = core.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next()?.parse().ok()?;
        if parts.next().is_some() {
            return None; // more than 3 core components is not semver
        }
        let pre = if pre.is_empty() {
            Vec::new()
        } else {
            pre.split('.').map(|p| p.to_string()).collect()
        };
        Some(SemVer {
            major,
            minor,
            patch,
            pre,
        })
    }
}

impl PartialOrd for SemVer {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for SemVer {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        use std::cmp::Ordering;
        match (self.major, self.minor, self.patch).cmp(&(other.major, other.minor, other.patch)) {
            Ordering::Equal => {}
            ord => return ord,
        }
        // Equal core: a release outranks a pre-release of the same core.
        match (self.pre.is_empty(), other.pre.is_empty()) {
            (true, true) => Ordering::Equal,
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => cmp_pre(&self.pre, &other.pre),
        }
    }
}

/// Compare pre-release identifier lists per semver §11: numeric identifiers
/// compare numerically and rank below alphanumeric ones; a longer list wins
/// when all preceding identifiers are equal.
fn cmp_pre(a: &[String], b: &[String]) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    for (x, y) in a.iter().zip(b.iter()) {
        let xn = x.parse::<u64>().ok();
        let yn = y.parse::<u64>().ok();
        let ord = match (xn, yn) {
            (Some(xv), Some(yv)) => xv.cmp(&yv),
            (Some(_), None) => Ordering::Less, // numeric < alphanumeric
            (None, Some(_)) => Ordering::Greater,
            (None, None) => x.cmp(y),
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }
    a.len().cmp(&b.len())
}

/// True when `latest` is a strictly newer semver than `current`. Unparseable
/// versions return false (never offer an update we can't reason about).
pub fn is_newer(current: &str, latest: &str) -> bool {
    match (SemVer::parse(current), SemVer::parse(latest)) {
        (Some(c), Some(l)) => l > c,
        _ => false,
    }
}

// ── detached updater spawn ────────────────────────────────────────────────

/// The embedded updater script. Written to MOBUX_DATA_DIR and run detached.
const UPDATER_SCRIPT: &str = include_str!("update_runner.sh");

/// Structured reasons `/api/update/run` declines to start an update.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RunError {
    /// Not running under systemd, so there's no unit to restart — refuse
    /// rather than spawn a half-updater that can't bring the service back.
    NotSystemd { message: String },
    /// No newer version is known, so there's nothing to install.
    NoUpdateAvailable { message: String },
    /// An update is already in progress in this process — refuse the second
    /// request so two updaters can't race the binary snapshot.
    AlreadyRunning { message: String },
    /// Couldn't lay down or launch the updater script.
    SpawnFailed { message: String },
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RunError::NotSystemd { message }
            | RunError::NoUpdateAvailable { message }
            | RunError::AlreadyRunning { message }
            | RunError::SpawnFailed { message } => write!(f, "{message}"),
        }
    }
}

/// Resolve the systemd `--user` unit name to restart, or `None` when we're
/// clearly not running under systemd. `INVOCATION_ID` is set by systemd for
/// every unit it starts; its absence means "not launched by systemd", so a
/// `systemctl restart` would be meaningless. `MOBUX_SERVICE_NAME` overrides the
/// unit name (default "mobux").
pub fn resolve_service_name() -> Option<String> {
    std::env::var_os("INVOCATION_ID")?;
    let name = std::env::var("MOBUX_SERVICE_NAME")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "mobux".to_string());
    Some(name)
}

/// Path to the currently-running binary (`std::env::current_exe`), used to
/// snapshot/restore and to derive the cargo `--root`.
fn current_exe() -> Result<PathBuf, RunError> {
    std::env::current_exe().map_err(|e| RunError::SpawnFailed {
        message: format!("resolving current executable: {e}"),
    })
}

/// Derive cargo's `--root` from the binary path: `<root>/bin/mobux` → `<root>`.
/// Falls back to `~/.cargo` if the layout is unexpected.
fn cargo_root(bin: &Path) -> String {
    bin.parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| {
            directories::BaseDirs::new()
                .map(|d| d.home_dir().join(".cargo").to_string_lossy().into_owned())
                .unwrap_or_else(|| "~/.cargo".to_string())
        })
}

/// Resolve a usable `cargo` for the updater: search PATH, then fall back to
/// `~/.cargo/bin/cargo` (the systemd unit PATH usually lacks it). Returned as
/// `MOBUX_UPDATE_CARGO` so the script doesn't have to repeat the search. `None`
/// means an update run would be a guaranteed no-op — refuse before the 202.
fn resolve_cargo() -> Option<PathBuf> {
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join("cargo");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let fallback = directories::BaseDirs::new()?
        .home_dir()
        .join(".cargo/bin/cargo");
    fallback.is_file().then_some(fallback)
}

/// Write the updater script into `data_dir` (mode 0700) and return its path.
fn write_updater_script(data_dir: &Path) -> Result<PathBuf, RunError> {
    let path = data_dir.join("mobux-update.sh");
    std::fs::write(&path, UPDATER_SCRIPT).map_err(|e| RunError::SpawnFailed {
        message: format!("writing updater script to {}: {e}", path.display()),
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).map_err(|e| {
            RunError::SpawnFailed {
                message: format!("chmod updater script: {e}"),
            }
        })?;
    }
    Ok(path)
}

/// Spawn the detached updater for `version`. The child is fully detached
/// (`setsid`, own session, stdio redirected to a log file in `data_dir`) so it
/// survives the server restart it triggers. Returns the log path on success.
///
/// Refuses with [`RunError::NotSystemd`] when there's no resolvable unit (so we
/// never strand the service down with no way to restart it).
pub fn spawn_updater(
    data_dir: &Path,
    version: &str,
    port: u16,
    use_tls: bool,
) -> Result<PathBuf, RunError> {
    // Hard off-switch. Set on hosts that manage updates externally, and by the
    // test/CI harness so a self-update never actually `cargo install`s anything
    // (CI runs steps under systemd, so INVOCATION_ID alone isn't enough to keep
    // tests from spawning a real updater).
    if std::env::var_os("MOBUX_UPDATE_DISABLE_RUN").is_some() {
        return Err(RunError::NotSystemd {
            message: "in-app update is disabled on this host (MOBUX_UPDATE_DISABLE_RUN)"
                .to_string(),
        });
    }

    let Some(service) = resolve_service_name() else {
        return Err(RunError::NotSystemd {
            message: "not running under systemd (no INVOCATION_ID); in-app update \
                      is only available for the systemd --user service"
                .to_string(),
        });
    };

    // Preflight: without a resolvable cargo the script would fail on its first
    // real step, leaving the UI to poll a version that never changes. Refuse
    // here so the caller gets an immediate, actionable error instead.
    let Some(cargo) = resolve_cargo() else {
        return Err(RunError::SpawnFailed {
            message: "cargo not found on PATH or at ~/.cargo/bin/cargo; add \
                      ~/.cargo/bin to the unit's Environment=PATH (see DEPLOY.md)"
                .to_string(),
        });
    };

    let bin = current_exe()?;
    let root = cargo_root(&bin);
    let script = write_updater_script(data_dir)?;
    let log_path = data_dir.join("mobux-update.log");
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| RunError::SpawnFailed {
            message: format!("opening update log {}: {e}", log_path.display()),
        })?;
    let log_err = log.try_clone().map_err(|e| RunError::SpawnFailed {
        message: format!("cloning log handle: {e}"),
    })?;

    let scheme = if use_tls { "https" } else { "http" };

    // `setsid` detaches into a new session so the child isn't killed when the
    // systemd unit (this process) is restarted. stdin from /dev/null; stdout +
    // stderr to the log file.
    let mut cmd = std::process::Command::new("setsid");
    cmd.arg("bash")
        .arg(&script)
        .env("MOBUX_UPDATE_VERSION", version)
        .env("MOBUX_UPDATE_BIN", &bin)
        .env("MOBUX_UPDATE_ROOT", &root)
        .env("MOBUX_UPDATE_CARGO", &cargo)
        .env("MOBUX_UPDATE_SERVICE", &service)
        .env("MOBUX_UPDATE_PORT", port.to_string())
        .env("MOBUX_UPDATE_SCHEME", scheme)
        .env("MOBUX_UPDATE_LOG", &log_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(log))
        .stderr(std::process::Stdio::from(log_err));

    cmd.spawn().map_err(|e| RunError::SpawnFailed {
        message: format!("spawning updater (setsid bash {}): {e}", script.display()),
    })?;

    Ok(log_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sparse_index_path_layout() {
        assert_eq!(
            sparse_index_url("mobux"),
            "https://index.crates.io/mo/bu/mobux"
        );
        assert_eq!(sparse_index_url("a"), "https://index.crates.io/1/a");
        assert_eq!(sparse_index_url("ab"), "https://index.crates.io/2/ab");
        assert_eq!(sparse_index_url("abc"), "https://index.crates.io/3/a/abc");
        assert_eq!(
            sparse_index_url("serde"),
            "https://index.crates.io/se/rd/serde"
        );
    }

    #[test]
    fn semver_basic_ordering() {
        assert!(is_newer("0.1.4", "0.1.5"));
        assert!(is_newer("0.1.4", "0.2.0"));
        assert!(is_newer("0.9.9", "1.0.0"));
        assert!(!is_newer("0.1.4", "0.1.4"));
        assert!(!is_newer("0.1.5", "0.1.4"));
        assert!(!is_newer("1.0.0", "0.9.9"));
    }

    #[test]
    fn disable_run_guard_refuses_without_spawning() {
        // The hard off-switch must short-circuit before any systemd check or
        // spawn. Use a temp dir as the data dir; nothing should be written.
        let tmp = std::env::temp_dir().join(format!("mobux-update-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        // SAFETY: single-threaded test; we set+remove the env around the call.
        unsafe { std::env::set_var("MOBUX_UPDATE_DISABLE_RUN", "1") };
        let res = spawn_updater(&tmp, "999.0.0", 8281, false);
        unsafe { std::env::remove_var("MOBUX_UPDATE_DISABLE_RUN") };
        assert!(matches!(res, Err(RunError::NotSystemd { .. })));
        // No updater script should have been written (guard runs first).
        assert!(!tmp.join("mobux-update.sh").exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn run_guard_admits_one_and_rejects_concurrent() {
        let st = UpdateState::new();
        // First claim wins.
        assert!(st.try_begin_run(), "first run must claim the lock");
        // A second concurrent claim is rejected while the first holds it.
        assert!(!st.try_begin_run(), "second run must be rejected");
        assert!(!st.try_begin_run(), "still rejected while running");
        // Releasing (abandoned run) lets a later run claim again.
        st.end_run();
        assert!(st.try_begin_run(), "lock reusable after release");
    }

    #[test]
    fn run_guard_shared_across_clones() {
        // The flag lives behind an Arc, so a cloned handle (as axum hands to
        // each request via AppState) sees the same lock.
        let st = UpdateState::new();
        let clone = st.clone();
        assert!(st.try_begin_run());
        assert!(!clone.try_begin_run(), "clone shares the running flag");
        clone.end_run();
        assert!(st.try_begin_run(), "release via one handle frees the other");
    }

    #[test]
    fn semver_not_string_compare() {
        // String compare would say "0.1.10" < "0.1.9"; semver must not.
        assert!(is_newer("0.1.9", "0.1.10"));
        assert!(!is_newer("0.1.10", "0.1.9"));
        // And "0.10.0" > "0.9.0".
        assert!(is_newer("0.9.0", "0.10.0"));
    }

    #[test]
    fn semver_prerelease_ordering() {
        // A pre-release is older than the same released version.
        assert!(is_newer("1.0.0-alpha", "1.0.0"));
        assert!(!is_newer("1.0.0", "1.0.0-alpha"));
        // Pre-release precedence (semver §11 example chain).
        assert!(is_newer("1.0.0-alpha", "1.0.0-alpha.1"));
        assert!(is_newer("1.0.0-alpha.1", "1.0.0-alpha.beta"));
        assert!(is_newer("1.0.0-beta", "1.0.0-beta.2"));
        assert!(is_newer("1.0.0-beta.11", "1.0.0-rc.1"));
        assert!(is_newer("1.0.0-rc.1", "1.0.0"));
    }

    #[test]
    fn semver_build_metadata_ignored() {
        assert!(!is_newer("1.0.0+build.1", "1.0.0+build.2"));
        assert!(!is_newer("1.0.0", "1.0.0+anything"));
    }

    #[test]
    fn semver_garbage_is_safe() {
        assert!(!is_newer("not-a-version", "1.0.0"));
        assert!(!is_newer("1.0.0", "garbage"));
        assert!(!is_newer("1.0", "1.0.1")); // too few components -> unparseable
    }

    #[test]
    fn parse_index_picks_highest_non_yanked() {
        let body = r#"
{"name":"mobux","vers":"0.1.0","yanked":false}
{"name":"mobux","vers":"0.1.10","yanked":false}
{"name":"mobux","vers":"0.1.9","yanked":false}
{"name":"mobux","vers":"0.2.0","yanked":true}
"#;
        // 0.2.0 is yanked, so 0.1.10 wins (and not "0.1.9" via string sort).
        assert_eq!(latest_from_index(body).as_deref(), Some("0.1.10"));
    }

    #[test]
    fn parse_index_skips_malformed_lines() {
        let body = "not json\n{\"name\":\"mobux\",\"vers\":\"1.2.3\",\"yanked\":false}\n{bad";
        assert_eq!(latest_from_index(body).as_deref(), Some("1.2.3"));
    }

    #[test]
    fn parse_index_all_yanked_is_none() {
        let body = r#"{"name":"mobux","vers":"0.1.0","yanked":true}"#;
        assert_eq!(latest_from_index(body), None);
    }

    #[test]
    fn parse_index_empty_is_none() {
        assert_eq!(latest_from_index(""), None);
        assert_eq!(latest_from_index("\n  \n"), None);
    }

    #[test]
    fn parse_index_handles_prerelease_below_release() {
        let body = r#"
{"name":"mobux","vers":"1.0.0-rc.1","yanked":false}
{"name":"mobux","vers":"0.9.0","yanked":false}
"#;
        // 1.0.0-rc.1 > 0.9.0, so it wins even as a pre-release.
        assert_eq!(latest_from_index(body).as_deref(), Some("1.0.0-rc.1"));
    }

    #[tokio::test]
    async fn status_reports_available_when_cache_newer() {
        let st = UpdateState::new();
        {
            let mut c = st.inner.write().await;
            // current is CARGO_PKG_VERSION; fabricate a clearly-newer latest.
            c.latest = Some("999.0.0".to_string());
            c.checked_at = Some("2024-01-01T00:00:00Z".to_string());
        }
        let s = st.status().await;
        assert!(s.available);
        assert_eq!(s.latest.as_deref(), Some("999.0.0"));
        assert_eq!(s.current, UpdateState::current_version());
        assert_eq!(s.checked_at.as_deref(), Some("2024-01-01T00:00:00Z"));
    }

    #[tokio::test]
    async fn status_not_available_when_cache_equals_current() {
        let st = UpdateState::new();
        {
            let mut c = st.inner.write().await;
            c.latest = Some(UpdateState::current_version().to_string());
        }
        let s = st.status().await;
        assert!(!s.available);
    }

    #[tokio::test]
    async fn status_empty_cache_not_available() {
        let st = UpdateState::new();
        let s = st.status().await;
        assert!(!s.available);
        assert_eq!(s.latest, None);
        assert_eq!(s.checked_at, None);
    }
}
