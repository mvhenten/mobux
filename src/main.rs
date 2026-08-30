use std::{
    env,
    io::{Read, Write},
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result};
use axum::{
    extract::{ws::Message, Path, Query, State, WebSocketUpgrade},
    http::{
        header::{AUTHORIZATION, WWW_AUTHENTICATE},
        HeaderMap, HeaderValue, Request, StatusCode,
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use base64::{
    engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD as BASE64URL},
    Engine,
};
use futures_util::{future, SinkExt, StreamExt};
use portable_pty::{native_pty_system, PtySize};
use rand::{distr::Alphanumeric, Rng};
use regex::Regex;
use serde::Deserialize;
use serde_json::json;

/// Frontend assets compiled into the binary so `cargo install mobux` yields a
/// self-contained executable that serves the UI from memory — no `web/` dir
/// next to the binary required. Source maps are excluded (dev-only, large) and
/// the optional install/well-known files are served by their own disk-based
/// handlers, so they're excluded here too.
#[derive(rust_embed::RustEmbed)]
#[folder = "web/static"]
#[exclude = "vendor/*.map"]
#[exclude = "install/*"]
#[exclude = ".well-known/*"]
struct StaticAssets;

mod cli;
mod config;
mod configure;
mod db;
mod host_suggestions;
mod nodes;
mod push;
mod service;
mod session_history;
mod shell_integration;
mod ssl;
mod stt_debug;
mod stt_scripts;
mod terminal_cursor;
mod tmux;
mod transcribe;
mod twa;
mod update;
mod update_cli;

#[derive(Clone, Debug, PartialEq)]
enum InstallPhase {
    Idle,
    /// The TWA build's pre-phase: the toolchain is missing and is being
    /// installed before the package build starts. Minutes of downloads, so
    /// the UI says what it is waiting for rather than "building".
    InstallingTools,
    Running,
    Success,
    Failed(String),
}

impl InstallPhase {
    /// Whether a job holds the single-flight claim. Both working phases do.
    fn is_active(&self) -> bool {
        matches!(self, Self::InstallingTools | Self::Running)
    }
}

/// The OS packages a job stopped on, and the one command that installs them.
/// The command is absent on a host with no package manager we recognise.
#[derive(Clone)]
struct MissingHostPackages {
    packages: Vec<String>,
    install_command: Option<String>,
}

/// A long-running shell job the UI polls: current phase plus the tail of what
/// it printed, so a build that takes minutes shows progress rather than a
/// spinner.
struct BackgroundJobState {
    phase: InstallPhase,
    output_tail: Vec<String>,
    missing_host_packages: Option<MissingHostPackages>,
}

impl BackgroundJobState {
    fn idle() -> Arc<tokio::sync::Mutex<Self>> {
        Arc::new(tokio::sync::Mutex::new(Self {
            phase: InstallPhase::Idle,
            output_tail: vec![],
            missing_host_packages: None,
        }))
    }
}

const JOB_OUTPUT_TAIL_LINES: usize = 200;

fn phase_parts(phase: &InstallPhase) -> (&'static str, Option<String>) {
    match phase {
        InstallPhase::Idle => ("idle", None),
        InstallPhase::InstallingTools => ("installing_tools", None),
        InstallPhase::Running => ("running", None),
        InstallPhase::Success => ("success", None),
        InstallPhase::Failed(e) => ("failed", Some(e.clone())),
    }
}

/// Drop terminal control sequences from a line of job output. The install and
/// build scripts colour their logs, and the page renders the tail as text, so
/// the escapes would otherwise show up as literal `[1;34m` in the log pane and
/// inside the error a failure is reported with.
fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        // CSI (`ESC [ … final`) and OSC (`ESC ] … BEL`) cover what the scripts
        // and the Android toolchain emit; any other escape drops its next
        // character, which is what an unknown two-byte sequence is.
        match chars.next() {
            Some('[') => {
                for c in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
                for c in chars.by_ref() {
                    if c == '\u{7}' || c == '\u{1b}' {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// Run `command` to completion, streaming both its streams into the job's
/// rolling output tail. Returns the failure that ended it, if any, leaving the
/// phase alone so a caller can run another command after this one.
async fn stream_into_job(
    job: &Arc<tokio::sync::Mutex<BackgroundJobState>>,
    mut command: tokio::process::Command,
) -> Result<(), String> {
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, BufReader};

    let mut child = match command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return Err(format!("spawn error: {e}")),
    };

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let job_for_stdout = job.clone();
    let job_for_stderr = job.clone();

    let stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let mut guard = job_for_stdout.lock().await;
            if guard.output_tail.len() >= JOB_OUTPUT_TAIL_LINES {
                guard.output_tail.remove(0);
            }
            guard.output_tail.push(strip_ansi(&line));
        }
    });

    let stderr_task = tokio::spawn(async move {
        let mut last_line = String::new();
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let line = strip_ansi(&line);
            let mut guard = job_for_stderr.lock().await;
            if guard.output_tail.len() >= JOB_OUTPUT_TAIL_LINES {
                guard.output_tail.remove(0);
            }
            guard.output_tail.push(line.clone());
            drop(guard);
            last_line = line;
        }
        last_line
    });

    let _ = stdout_task.await;
    let stderr_summary = stderr_task.await.unwrap_or_default();

    match child.wait().await {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!(
            "exit {}: {}",
            s.code().unwrap_or(-1),
            stderr_summary
        )),
        Err(e) => Err(format!("wait error: {e}")),
    }
}

/// A single-command job: stream it, then record success or the failure.
async fn run_streaming_job(
    job: Arc<tokio::sync::Mutex<BackgroundJobState>>,
    command: tokio::process::Command,
) {
    let outcome = stream_into_job(&job, command).await;
    let mut guard = job.lock().await;
    guard.phase = match outcome {
        Ok(()) => InstallPhase::Success,
        Err(e) => InstallPhase::Failed(e),
    };
}

/// Stop the build on a gap only the host's package manager can close, keeping
/// the packages and the fixing command as fields the install page can render.
async fn record_host_package_gap(
    job: &Arc<tokio::sync::Mutex<BackgroundJobState>>,
    gap: twa::HostPackageGap,
) {
    let mut guard = job.lock().await;
    guard.phase = InstallPhase::Failed(gap.message);
    guard.missing_host_packages = Some(MissingHostPackages {
        packages: gap.packages,
        install_command: gap.install_command,
    });
}

async fn push_job_line(job: &Arc<tokio::sync::Mutex<BackgroundJobState>>, line: String) {
    let mut guard = job.lock().await;
    if guard.output_tail.len() >= JOB_OUTPUT_TAIL_LINES {
        guard.output_tail.remove(0);
    }
    guard.output_tail.push(line);
}

/// The TWA build, optionally preceded by the toolchain install. `setup` is
/// `Some` only when the toolchain is missing, and it gets its own phase so the
/// page can say "installing build tools" through the minutes it spends
/// downloading a JDK and an Android SDK.
async fn run_twa_build_job(
    job: Arc<tokio::sync::Mutex<BackgroundJobState>>,
    setup: Option<tokio::process::Command>,
    build: tokio::process::Command,
) {
    if let Some(setup) = setup {
        {
            let mut guard = job.lock().await;
            guard.phase = InstallPhase::InstallingTools;
        }
        push_job_line(
            &job,
            "Installing the Android build tools. This takes a few minutes.".to_string(),
        )
        .await;
        if let Err(e) = stream_into_job(&job, setup).await {
            let mut guard = job.lock().await;
            guard.phase = InstallPhase::Failed(format!("installing the build tools failed: {e}"));
            return;
        }
        let mut guard = job.lock().await;
        guard.phase = InstallPhase::Running;
    }

    push_job_line(&job, "Building the Android package.".to_string()).await;
    run_streaming_job(job, build).await;
}

#[derive(Clone)]
struct AppState {
    session_name_re: Arc<Regex>,
    auth: Option<AuthConfig>,
    cache_bust: String,
    db: Arc<db::Db>,
    /// Bearer-equivalent secret that the tmux `alert-bell` hook posts back
    /// with on the internal trigger endpoint. Generated fresh on every
    /// startup; the hook is reinstalled with the new value.
    internal_token: Arc<String>,
    /// Every setting this instance resolved at startup, layered from the
    /// defaults, the config file, the environment and the flags.
    config: Arc<config::Config>,
    /// Where mobux persists state — used to write/spawn the detached updater.
    /// Resolved from `paths.data_dir`, falling back to the platform data
    /// directory, so it is a path rather than the raw setting.
    data_dir: PathBuf,
    /// Where `config.json` and the generated TLS material live, resolved once
    /// at startup so no handler re-derives it.
    config_dir: PathBuf,
    /// In-memory cache of the latest crates.io version (self-update, #130).
    update: update::UpdateState,
    /// SHA-256 prefix of the vendored JS bundles, computed by `web/build.js`
    /// and written to `web/static/build-info.json` at build time. Read from
    /// the embedded copy of that file so released binaries carry the hash
    /// wherever they run. Injected into the settings page so operators can
    /// verify whether the bundle matches what the browser has loaded.
    build_hash: String,
    /// Tracks background STT install state (phase + rolling output tail).
    stt_install: Arc<tokio::sync::Mutex<BackgroundJobState>>,
    /// Tracks the background TWA/APK build behind the install page's
    /// "Generate package" button. One build at a time.
    twa_build: Arc<tokio::sync::Mutex<BackgroundJobState>>,
    /// Per-session OSC 133-segmented conversation record (issue #220):
    /// JSONL under `<data_dir>/history/<session>.jsonl`, fed from the PTY
    /// relay in `handle_ws`, served paginated by `api_session_conversation`.
    session_history: Arc<session_history::SessionHistoryStore>,
}

#[derive(Clone)]
struct AuthConfig {
    user: String,
    pass: String,
    session_cookie_name: String,
    session_cookie_value: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let options = match cli::parse(env::args().skip(1)) {
        cli::Parsed::Run(options) => options,
        cli::Parsed::Service(command) => std::process::exit(service::run(&command)),
        cli::Parsed::Update(command) => std::process::exit(update_cli::run(command).await),
        cli::Parsed::Configure(command) => std::process::exit(configure::run(&command)),
        cli::Parsed::Help => {
            print!("{}", cli::help_text(PKG_VERSION));
            return Ok(());
        }
        cli::Parsed::Version => {
            println!("mobux {PKG_VERSION}");
            return Ok(());
        }
        cli::Parsed::Invalid(message) => {
            eprintln!("mobux: {message}\n");
            eprint!("{}", cli::help_text(PKG_VERSION));
            std::process::exit(2);
        }
    };

    // Multiple deps now pull rustls (axum-server tls, instant-acme, reqwest);
    // each enables its own crypto backend feature, so rustls cannot pick one
    // automatically. Install aws-lc-rs explicitly to match axum-server's
    // TLS path that actually serves traffic.
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .map_err(|_| anyhow::anyhow!("failed to install rustls crypto provider"))?;

    let settings = Arc::new(resolve_config(&options)?);

    let config_dir = config::config_dir();
    let auth = load_auth_config(&config_dir, &settings);
    let data_dir = resolve_data_dir(&settings)?;
    std::fs::create_dir_all(&data_dir)
        .with_context(|| format!("creating data dir: {}", data_dir.display()))?;
    let db_path = data_dir.join("mobux.db");
    println!("data dir: {}", data_dir.display());
    let db = Arc::new(db::Db::open(&db_path)?);
    // Eagerly generate the VAPID keypair on first boot so subsequent push
    // endpoints can rely on it being present. Idempotent on later starts.
    let _ = db.vapid_keys()?;

    let internal_token: String = (&mut rand::rng())
        .sample_iter(Alphanumeric)
        .take(32)
        .map(char::from)
        .collect();

    let port = settings.server.port;
    let use_tls = settings.tls.enabled;

    // Read from the RustEmbed copy, not the source tree: `CARGO_MANIFEST_DIR`
    // is the build machine's path, which doesn't exist where a released
    // binary runs (#172). The embedded file is also exactly what the server
    // serves at /static/build-info.json, so server and FE hashes match by
    // construction.
    let build_hash = StaticAssets::get("build-info.json")
        .and_then(|f| serde_json::from_slice::<serde_json::Value>(&f.data).ok())
        .and_then(|v| v["hash"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "unknown".to_string());

    let update_state = update::UpdateState::new(settings.update.check_url.clone());
    // Kick off the background crates.io poller (polls now, then every ~6h).
    update::spawn_checker(update_state.clone());

    let state = AppState {
        // tmux forbids '.' and ':' in session names (they're target-spec
        // separators) and silently rewrites '.' to '_'. Allowing '.' here let
        // a name like "my.app" pass validation while tmux created "my_app",
        // so every later op targeting "my.app" failed with "can't find
        // session". Keep '.' out of the allowed set.
        session_name_re: Arc::new(Regex::new(r"^[a-zA-Z0-9_-]+$")?),
        auth,
        cache_bust: format!(
            "{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs()
        ),
        db,
        internal_token: Arc::new(internal_token),
        config: settings.clone(),
        data_dir: data_dir.clone(),
        config_dir: config_dir.clone(),
        update: update_state,
        build_hash,
        stt_install: BackgroundJobState::idle(),
        twa_build: BackgroundJobState::idle(),
        session_history: Arc::new(session_history::SessionHistoryStore::new(&data_dir)),
    };

    // Stand up the internal hook-callback listener on a 127.0.0.1 port
    // (separate from the public listener — no TLS, no auth middleware).
    // Bind first so we know the assigned port before installing the
    // tmux hook that targets it.
    let internal_app = Router::new()
        .route("/internal/trigger", post(api_internal_trigger))
        .with_state(state.clone());
    let internal_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let internal_port = internal_listener.local_addr()?.port();
    tokio::spawn(async move {
        if let Err(e) = axum::serve(internal_listener, internal_app).await {
            eprintln!("internal listener error: {e:#}");
        }
    });
    if let Err(e) = tmux::install_bell_hook(internal_port, &state.internal_token).await {
        eprintln!("warning: failed to install tmux alert-bell hook: {e:#}");
    } else {
        println!("tmux alert-bell hook installed (internal port {internal_port})");
    }

    let state_for_mw = state.clone();
    let app = Router::new()
        .route("/", get(root_redirect))
        .route("/api/identify", get(api_identify))
        .route("/api/build-info", get(api_build_info))
        .route("/api/sessions", get(api_sessions).post(api_create_session))
        .route("/api/sessions/{name}/kill", post(api_kill_session))
        .route("/api/sessions/{name}/rename", post(api_rename_session))
        .route("/api/sessions/{name}/panes", get(api_list_panes))
        .route(
            "/api/sessions/{name}/panes/{pane}/select",
            post(api_select_pane),
        )
        .route("/api/sessions/{name}/history", get(api_session_history))
        // Distinct path from the tmux-scrollback `history` route above: this
        // is the OSC 133-segmented conversation record (issue #220), a
        // different shape (paginated JSON entries, not a scrollback blob)
        // decoupled from terminal scrollback entirely. `history` was
        // already taken by that pre-existing route (terminal-engine.js's
        // initial-repaint fetch), so it can't be reused/extended here.
        .route(
            "/api/sessions/{name}/conversation",
            get(api_session_conversation),
        )
        .route("/api/sessions/{name}/command", post(api_tmux_command))
        .route(
            "/api/settings/nodes",
            get(api_get_settings_nodes).put(api_set_settings_nodes),
        )
        .route("/api/nodes", get(api_nodes_status))
        .route("/api/host-suggestions", get(api_host_suggestions))
        .route(
            "/api/telemetry",
            post(api_telemetry).layer(axum::extract::DefaultBodyLimit::max(64 * 1024)),
        )
        .route(
            "/api/upload",
            post(api_upload).layer(axum::extract::DefaultBodyLimit::max(200 * 1024 * 1024)),
        )
        // 60 s of 16 kHz mono 16-bit PCM is ~1.9 MB; the default 2 MB body
        // limit is too tight once the multipart envelope is added. Allow 8 MB
        // for this route only (the 70 s sample cap is enforced after decode).
        .route(
            "/transcribe",
            post(api_transcribe).layer(axum::extract::DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
        .route("/api/push/vapid-public-key", get(api_push_vapid_public_key))
        .route(
            "/api/push/subscribe",
            post(api_push_subscribe).delete(api_push_unsubscribe),
        )
        .route("/api/push/devices", get(api_push_devices))
        .route("/api/push/notify", post(api_push_notify))
        .route(
            "/api/settings/notifications",
            get(api_get_notification_prefs).put(api_set_notification_prefs),
        )
        .route(
            "/api/settings/preferences",
            get(api_get_ui_preferences).put(api_set_ui_preferences),
        )
        .route(
            "/api/settings/stt",
            get(api_get_stt_config).put(api_set_stt_config),
        )
        .route("/api/stt/status", get(api_stt_status))
        .route("/api/stt/models", get(api_stt_models))
        .route(
            "/api/stt/install",
            post(api_stt_install).layer(axum::extract::DefaultBodyLimit::max(1024)),
        )
        .route("/api/stt/install/status", get(api_stt_install_status))
        .route("/api/install/apk/build", post(api_install_apk_build))
        .route("/api/install/apk/status", get(api_install_apk_status))
        .route("/api/stt/start", post(api_stt_start))
        .route("/api/stt/stop", post(api_stt_stop))
        .route(
            "/api/shell-integration/status",
            get(api_shell_integration_status),
        )
        .route(
            "/api/shell-integration/install",
            post(api_shell_integration_install),
        )
        .route(
            "/api/shell-integration/uninstall",
            post(api_shell_integration_uninstall),
        )
        // Self-update (#130).
        .route("/api/update/status", get(api_update_status))
        .route("/api/update/check", post(api_update_check))
        .route("/api/update/run", post(api_update_run))
        .route("/settings", get(settings_page))
        .route("/s/{name}", get(terminal_page))
        .route("/ws/{name}", get(terminal_ws))
        .route("/sw.js", get(serve_sw))
        .route("/install", get(install_page))
        .route("/install/mobux.apk", get(serve_install_apk))
        .route("/install/mobux-ca.crt", get(serve_install_ca))
        .route("/.well-known/assetlinks.json", get(serve_assetlinks))
        // New client SPA (web/spa, built to web/static/spa/). Served at /app and
        // /app/* with an SPA history fallback: every sub-path returns the SPA's
        // index.html so client routing (hash router today, history-safe for the
        // future) works when served straight from the binary. Built assets live
        // under /static/spa/ and are handled by serve_static. The old
        // Rust-rendered pages (/, /s/:name, /settings, /install) are untouched —
        // both UIs coexist; the SPA is shadow-mounted at /app.
        .route("/app", get(serve_spa_index))
        .route("/app/{*rest}", get(serve_spa_index))
        .route("/static/{*path}", get(serve_static));

    // Test-only: serve a fixed sparse-index body so the update checker can be
    // exercised hermetically (no live crates.io). Registered only when
    // MOBUX_UPDATE_TEST_INDEX is set; never present in a normal/prod run.
    let app = if std::env::var_os("MOBUX_UPDATE_TEST_INDEX").is_some() {
        app.route("/api/update/test-index", get(api_update_test_index))
    } else {
        app
    };

    let app = app
        .fallback(get(|| async { axum::response::Redirect::temporary("/") }))
        .with_state(state.clone())
        .layer(middleware::from_fn_with_state(
            state_for_mw,
            auth_middleware,
        ));

    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    if state.auth.is_some() {
        println!("auth: enabled (HTTP Basic)");
    } else {
        println!(
            "auth: disabled (pass --pin, or set MOBUX_PIN or MOBUX_AUTH_USER/MOBUX_AUTH_PASS)"
        );
    }

    println!("telemetry: /api/telemetry active, logs to stderr");

    if settings.app.dev {
        println!("dev mode: ON (MOBUX_DEV)");
    }

    if use_tls {
        let cert_file = settings.tls.cert_file.trim();
        let key_file = settings.tls.key_file.trim();
        let (cert_path, key_path) = if !cert_file.is_empty() && !key_file.is_empty() {
            eprintln!("[ssl] Using provided cert: {cert_file}, key: {key_file}");
            (PathBuf::from(cert_file), PathBuf::from(key_file))
        } else {
            // ACME mode needs the HTTP-01 route reachable BEFORE the order
            // runs, so spin up a tiny HTTP-only server first. Same server
            // stays up for renewals.
            let challenges = if ssl::acme_mode_enabled(&settings.tls) {
                let c = ssl::new_acme_challenges();
                spawn_acme_http_server(c.clone(), settings.tls.acme_http_port).await?;
                Some(c)
            } else {
                None
            };
            let paths = ssl::ensure_certs(&config_dir, &settings.tls, challenges).await?;
            (paths.cert, paths.key)
        };
        let tls_config = ssl::load_rustls_config(&cert_path, &key_path)?;
        let rustls_config =
            axum_server::tls_rustls::RustlsConfig::from_config(std::sync::Arc::new(tls_config));

        println!("mobux listening on https://{}", addr);
        axum_server::bind_rustls(addr, rustls_config)
            .serve(app.into_make_service())
            .await?;
    } else {
        println!("mobux listening on http://{}", addr);
        let listener = tokio::net::TcpListener::bind(addr).await?;
        axum::serve(listener, app).await?;
    }

    Ok(())
}

/// The one place startup layers its settings: the defaults, the config file,
/// the environment and the flags. A `--config` path that cannot be read is
/// fatal; the default path is allowed to be absent, since mobux runs without a
/// config file.
fn resolve_config(options: &cli::RunOptions) -> Result<config::Config> {
    let explicit = options.config_path.is_some();
    let path = options
        .config_path
        .clone()
        .unwrap_or_else(config::config_file_path);

    let file = match config::load_partial_from(&path) {
        Ok(Some(file)) => file,
        Ok(None) if explicit => {
            return Err(anyhow::anyhow!("{}: no such config file", path.display()))
        }
        Ok(None) => config::PartialConfig::default(),
        Err(err) => return Err(err.into()),
    };

    let env = config::EnvSnapshot::from_env();
    if let Some(message) = config::port_deprecation(&env, &options.overrides) {
        eprintln!("[config] {message}");
    }

    Ok(config::resolve(
        config::Config::default(),
        file,
        &env,
        options.overrides.clone(),
    ))
}

fn resolve_data_dir(settings: &config::Config) -> Result<PathBuf> {
    let data_dir = settings.paths.data_dir.trim();
    if !data_dir.is_empty() {
        return Ok(PathBuf::from(data_dir));
    }
    let dirs = directories::ProjectDirs::from("", "", "mobux")
        .ok_or_else(|| anyhow::anyhow!("could not resolve user home directory for data dir"))?;
    Ok(dirs.data_dir().to_path_buf())
}

/// Bind a tiny HTTP-only axum server that serves
/// `/.well-known/acme-challenge/{token}`. Only used in ACME mode.
async fn spawn_acme_http_server(challenges: ssl::AcmeChallenges, port: u16) -> Result<()> {
    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    let router = Router::new()
        .route(
            "/.well-known/acme-challenge/{token}",
            get(serve_acme_challenge),
        )
        .layer(Extension(challenges));

    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| {
        anyhow::anyhow!(
            "ACME mode: failed to bind HTTP listener on {addr} for HTTP-01 challenges \
             (set MOBUX_ACME_HTTP_PORT to override): {e}"
        )
    })?;

    eprintln!("[ssl] ACME: HTTP-01 challenge server listening on http://{addr}");
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            eprintln!("[ssl] ACME HTTP server exited with error: {e}");
        }
    });

    Ok(())
}

async fn serve_acme_challenge(
    Path(token): Path<String>,
    Extension(challenges): Extension<ssl::AcmeChallenges>,
) -> Response {
    match ssl::lookup_acme_challenge(&challenges, &token) {
        Some(value) => (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "text/plain")],
            value,
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "unknown acme challenge token").into_response(),
    }
}

/// Load (or generate-and-persist) the session cookie value. Persisting it
/// across restarts means restarting mobux doesn't invalidate every connected
/// client's session and re-prompt them for the basic-auth password.
fn ensure_session_cookie_value(config_dir: &std::path::Path) -> String {
    let path = config_dir.join("session-cookie");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if trimmed.len() >= 32 {
            return trimmed.to_string();
        }
    }

    let value: String = rand::rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect();

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(&path, &value) {
        eprintln!(
            "[auth] WARN: could not persist session cookie to {}: {e}. \
             Restarts will re-prompt clients for credentials.",
            path.display()
        );
    } else {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
    }
    value
}

fn load_auth_config(config_dir: &std::path::Path, settings: &config::Config) -> Option<AuthConfig> {
    let credentials = settings.credentials()?;

    Some(AuthConfig {
        user: credentials.user,
        pass: credentials.pass,
        session_cookie_name: "mobux_session".to_string(),
        session_cookie_value: ensure_session_cookie_value(config_dir),
    })
}

/// Routes that bypass auth so first-contact device enrollment works:
/// the install page must be reachable to download the APK + CA, the
/// digital-asset-links file must be reachable for the TWA verification,
/// the icon assets are needed by the bubblewrap build (which fetches
/// them over HTTPS from the running server), and the service worker
/// must be reachable for the SW registration request — some Android
/// browsers fetch /sw.js without page credentials.
///
/// `/api/identify` is intentionally unauthenticated: the self-update health
/// check polls it on a freshly-restarted binary before any credentials exist.
/// It leaks nothing beyond "this is mobux, version X".
fn is_public_path(path: &str) -> bool {
    path == "/api/identify"
        // Test-only update-index fixture: the background poller fetches it
        // without credentials, so it must bypass auth. Only ever routed when
        // MOBUX_UPDATE_TEST_INDEX is set (see router construction).
        || path == "/api/update/test-index"
        || path == "/install"
        || path.starts_with("/install/")
        || path.starts_with("/.well-known/")
        || path.starts_with("/static/icon-")
        || path == "/static/manifest.json"
        || path == "/sw.js"
}

/// Build the `Set-Cookie` header value for the session cookie.
///
/// `Secure` is only added when `use_tls` is true: on a plain-HTTP bind the
/// browser will not store a `Secure` cookie, so every subsequent request
/// falls back to a fresh Basic-auth prompt instead of the cached session.
fn build_session_cookie(name: &str, value: &str, use_tls: bool) -> String {
    if use_tls {
        format!("{name}={value}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000")
    } else {
        format!("{name}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000")
    }
}

async fn auth_middleware(
    State(state): State<AppState>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let Some(auth) = &state.auth else {
        return next.run(req).await;
    };

    if is_public_path(req.uri().path()) {
        return next.run(req).await;
    }

    let cookie_ok = req
        .headers()
        .get(axum::http::header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .map(|cookie| {
            cookie
                .split(';')
                .filter_map(|p| p.trim().split_once('='))
                .any(|(k, v)| k == auth.session_cookie_name && v == auth.session_cookie_value)
        })
        .unwrap_or(false);

    if cookie_ok {
        return next.run(req).await;
    }

    let basic_ok = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Basic "))
        .and_then(|b64| BASE64.decode(b64).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .and_then(|pair| {
            let mut parts = pair.splitn(2, ':');
            let user = parts.next()?.to_string();
            let pass = parts.next()?.to_string();
            Some((user, pass))
        })
        .map(|(user, pass)| user == auth.user && pass == auth.pass)
        .unwrap_or(false);

    if basic_ok {
        let mut resp = next.run(req).await;
        let set_cookie = build_session_cookie(
            &auth.session_cookie_name,
            &auth.session_cookie_value,
            state.config.tls.enabled,
        );
        if let Ok(v) = HeaderValue::from_str(&set_cookie) {
            resp.headers_mut().append(axum::http::header::SET_COOKIE, v);
        }
        return resp;
    }

    let mut resp = (StatusCode::UNAUTHORIZED, "Authentication required").into_response();
    resp.headers_mut().insert(
        WWW_AUTHENTICATE,
        HeaderValue::from_static("Basic realm=\"mobux\""),
    );
    resp
}

/// Dev-only root redirect: `GET /` → 307 `/app` with `Cache-Control: no-store`
/// so browsers and BFCache never pin a stale redirect. The old `index` handler
/// is kept intact; it is just no longer mounted at `/`.
async fn root_redirect() -> impl IntoResponse {
    (
        axum::http::StatusCode::TEMPORARY_REDIRECT,
        [
            (axum::http::header::LOCATION, "/app"),
            (axum::http::header::CACHE_CONTROL, "no-store"),
        ],
    )
}

// Old `index` handler removed — the root path now redirects to `/app` via
// `root_redirect`. `render_index` is also removed; the SPA Home page is canonical.

async fn api_sessions(
    State(state): State<AppState>,
    Query(q): Query<NodeQuery>,
) -> Result<Json<Vec<tmux::Session>>, AppError> {
    let target = resolve_node_target(&state, q.node.as_deref()).await?;
    let sessions = tmux::list_sessions(target.as_deref())
        .await
        .map_err(AppError::bad_request)?;
    Ok(Json(sessions))
}

/// Shape returned by `/api/identify`.
#[derive(serde::Serialize)]
struct Identify {
    app: String,
    version: String,
}

/// Unauthenticated identify probe (self-update health-check). Returns only the
/// app name and crate version — nothing else leaks. Bypasses auth via
/// `is_public_path`.
async fn api_identify() -> Json<Identify> {
    Json(Identify {
        app: "mobux".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

/// Build-info for the SPA's Build card. Returns the same data the inline
/// settings page injects as window globals (`MOBUX_BUILD_SERVER`, `MOBUX_VERSION`),
/// so the SPA can fetch it without needing server-side HTML injection.
async fn api_build_info(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({
        "version": PKG_VERSION,
        "build_hash": state.build_hash,
        "dev_mode": state.config.app.dev,
    }))
}

// ── self-update (#130) ─────────────────────────────────────────────────────

/// Cached update status: current version, latest known, availability,
/// last-checked timestamp. Reads the in-memory cache the background poller
/// maintains — no network call here.
async fn api_update_status(State(state): State<AppState>) -> Json<update::UpdateStatus> {
    Json(state.update.status().await)
}

/// Force an immediate crates.io poll and return the refreshed status.
async fn api_update_check(State(state): State<AppState>) -> Json<update::UpdateStatus> {
    Json(state.update.refresh().await)
}

/// Spawn the detached updater toward the latest known version. Returns 202 when
/// started; a structured 4xx/5xx otherwise (not systemd, nothing to update,
/// spawn failed).
async fn api_update_run(State(state): State<AppState>) -> Response {
    let status = state.update.status().await;
    let Some(latest) = status.latest.clone() else {
        let err = update::RunError::NoUpdateAvailable {
            message: "no latest version known yet; run a check first".to_string(),
        };
        return (StatusCode::CONFLICT, Json(json!({ "error": err }))).into_response();
    };
    if !status.available {
        let err = update::RunError::NoUpdateAvailable {
            message: format!(
                "already on the latest version ({})",
                update::UpdateState::current_version()
            ),
        };
        return (StatusCode::CONFLICT, Json(json!({ "error": err }))).into_response();
    }

    // In-process lock: only one updater may be in flight. A concurrent second
    // request is rejected here (409) so the two scripts never race the binary
    // snapshot. The script's flock is the cross-process backstop.
    if !state.update.try_begin_run() {
        let err = update::RunError::AlreadyRunning {
            message: "an update is already in progress".to_string(),
        };
        return (StatusCode::CONFLICT, Json(json!({ "error": err }))).into_response();
    }

    match update::spawn_updater(
        &state.update,
        &state.data_dir,
        &state.config.app.service_name,
        &latest,
        state.config.server.port,
        state.config.tls.enabled,
    ) {
        Ok(log_path) => {
            // Keep the flag set: a successful update restarts the process, and
            // until then no second run should start. If the detached updater
            // fails without restarting us, spawn_updater's supervisor thread
            // releases the flag so a retry isn't permanently blocked.
            (
                StatusCode::ACCEPTED,
                Json(json!({
                    "started": true,
                    "version": latest,
                    "log": log_path.to_string_lossy(),
                })),
            )
                .into_response()
        }
        Err(err) => {
            // We claimed the lock but never spawned — release it so a later
            // retry isn't permanently blocked.
            state.update.end_run();
            let status = match err {
                // 412 Precondition Failed: the environment can't support in-app
                // update (no systemd unit / disabled on this host).
                update::RunError::NotSystemd { .. } => StatusCode::PRECONDITION_FAILED,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            };
            (status, Json(json!({ "error": err }))).into_response()
        }
    }
}

/// Test-only handler: echoes `MOBUX_UPDATE_TEST_INDEX` as a sparse-index body
/// so the update checker can be driven hermetically. Only routed when that env
/// var is set.
async fn api_update_test_index() -> impl IntoResponse {
    let body = std::env::var("MOBUX_UPDATE_TEST_INDEX").unwrap_or_default();
    ([(axum::http::header::CONTENT_TYPE, "text/plain")], body)
}

#[derive(Deserialize)]
struct CreateReq {
    name: String,
}

async fn api_create_session(
    State(state): State<AppState>,
    Query(q): Query<NodeQuery>,
    Json(payload): Json<CreateReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    let name = payload.name.trim();
    validate_session_name(&state, name)?;
    let target = resolve_node_target(&state, q.node.as_deref()).await?;
    tmux::new_session(
        name,
        target.as_deref(),
        &state.config.session.shell,
        &state.data_dir,
    )
    .await
    .map_err(AppError::bad_request)?;
    Ok(Json(json!({"ok": true, "name": name})))
}

async fn api_kill_session(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Query(q): Query<NodeQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    validate_session_name(&state, &name)?;
    let target = resolve_node_target(&state, q.node.as_deref()).await?;
    tmux::kill_session(&name, target.as_deref())
        .await
        .map_err(AppError::bad_request)?;
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
struct RenameReq {
    name: String,
}

async fn api_rename_session(
    State(state): State<AppState>,
    Path(old_name): Path<String>,
    Query(q): Query<NodeQuery>,
    Json(payload): Json<RenameReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    validate_session_name(&state, &old_name)?;
    validate_session_name(&state, &payload.name)?;
    let target = resolve_node_target(&state, q.node.as_deref()).await?;
    tmux::rename_session(&old_name, &payload.name, target.as_deref())
        .await
        .map_err(AppError::bad_request)?;
    Ok(Json(json!({"ok": true})))
}

async fn api_list_panes(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Query(q): Query<NodeQuery>,
) -> Result<Json<Vec<tmux::Pane>>, AppError> {
    validate_session_name(&state, &name)?;
    let target = resolve_node_target(&state, q.node.as_deref()).await?;
    let panes = tmux::list_panes(&name, target.as_deref())
        .await
        .map_err(AppError::bad_request)?;
    Ok(Json(panes))
}

async fn api_select_pane(
    State(state): State<AppState>,
    Path((name, pane)): Path<(String, String)>,
    Query(q): Query<NodeQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    validate_session_name(&state, &name)?;
    let target = resolve_node_target(&state, q.node.as_deref()).await?;
    tmux::select_pane(&name, &pane, target.as_deref())
        .await
        .map_err(AppError::bad_request)?;
    Ok(Json(json!({"ok": true})))
}

async fn api_session_history(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Query(q): Query<NodeQuery>,
) -> Result<String, AppError> {
    validate_session_name(&state, &name)?;
    let target = resolve_node_target(&state, q.node.as_deref()).await?;
    let history = tmux::capture_history(&name, 10000, target.as_deref())
        .await
        .map_err(AppError::bad_request)?;
    Ok(history)
}

#[derive(Deserialize)]
struct ConversationHistoryQuery {
    cursor: Option<String>,
    limit: Option<usize>,
    tail: Option<usize>,
}

/// GET /api/sessions/{name}/conversation — the OSC 133-segmented
/// conversation record (issue #220), served in opaquely-cursored pages
/// (issue #233). See `session_history.rs` for the storage/segmentation
/// design.
///
/// ```text
/// GET /api/sessions/{name}/conversation
///       ?cursor=<opaque>    resume forward from a previous page (exclusive)
///       ?limit=<n>          max entries in a forward page
///       ?tail=<n>           the newest n entries
/// → 200 { "entries": [ … ], "nextCursor": "<opaque>" }
/// ```
///
/// The three modes are mutually exclusive: neither parameter gives a
/// forward page from the oldest retained entry; `cursor` (optionally with
/// `limit`) resumes forward from it, exclusive; `tail` gives the newest
/// entries. `tail` alongside `cursor` or `limit` is a 400 — `tail` carries
/// its own count, so a second one is ambiguous. `limit` defaults to 50;
/// both it and `tail` clamp to 1..500 rather than rejecting.
///
/// `output` is truncated for transport to the last
/// `MAX_WIRE_OUTPUT_BYTES`, and a truncated entry carries
/// `outputTruncatedBytes`, the count dropped from the front; the field is
/// absent otherwise. A page carries at most `MAX_PAGE_BYTES` of entry JSON
/// counted after that cap — a forward page stops early, a `tail` page drops
/// from its oldest end so the newest survive — but always at least one
/// entry, so a page can never stall.
///
/// `nextCursor` is always present and decodes to `v2:<seq>:<offset>`: the
/// last entry in the page and the byte offset just past its line, which is
/// what makes a steady-state poll a seek rather than a scan of the whole
/// history. An empty page echoes the supplied cursor; an empty or absent
/// file gives the zero cursor. `v1:<seq>` cursors still decode, with the
/// offset unknown, so no client holding one breaks.
///
/// An unparseable cursor and a malformed session name are both a 400. A
/// well-formed name with no history is an empty page with the zero cursor.
async fn api_session_conversation(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Query(q): Query<ConversationHistoryQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    validate_session_name(&state, &name)?;

    if q.tail.is_some() && q.cursor.is_some() {
        return Err(AppError::bad_request(anyhow::anyhow!(
            "tail and cursor are mutually exclusive"
        )));
    }
    if q.tail.is_some() && q.limit.is_some() {
        return Err(AppError::bad_request(anyhow::anyhow!(
            "tail carries its own count; limit is ambiguous alongside it"
        )));
    }

    let cursor = match q.cursor {
        Some(raw) => Some(
            session_history::decode_cursor(&raw)
                .ok_or_else(|| AppError::bad_request(anyhow::anyhow!("invalid cursor")))?,
        ),
        None => None,
    };

    let history = state.session_history.clone();
    let page = match q.tail {
        Some(tail) => {
            let count = tail.clamp(1, session_history::MAX_LIMIT);
            tokio::task::spawn_blocking(move || history.read_tail(&name, count)).await
        }
        None => {
            let limit = q
                .limit
                .unwrap_or(session_history::DEFAULT_LIMIT)
                .clamp(1, session_history::MAX_LIMIT);
            tokio::task::spawn_blocking(move || history.read_page(&name, cursor, limit)).await
        }
    }
    .map_err(|e| AppError::internal(anyhow::anyhow!("spawn_blocking: {e}")))?
    .map_err(AppError::internal)?;

    Ok(Json(json!({
        "entries": page.entries,
        "nextCursor": session_history::encode_cursor(page.next_seq, page.next_offset),
    })))
}

#[derive(Deserialize)]
struct CommandReq {
    command: String,
}

async fn api_tmux_command(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Query(q): Query<NodeQuery>,
    Json(payload): Json<CommandReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    validate_session_name(&state, &name)?;
    let target = resolve_node_target(&state, q.node.as_deref()).await?;
    let result = tmux::run_command(&name, &payload.command, target.as_deref())
        .await
        .map_err(AppError::bad_request)?;
    Ok(Json(json!({"ok": true, "output": result})))
}

/// Built-in client telemetry sink. A general-purpose channel for the frontend
/// to forward diagnostic lines into the server journal — always active, in
/// every build. mobux is a self-hosted single-operator tool, so there's no
/// privacy boundary to gate this behind. It stays behind the normal auth
/// middleware (the page is same-origin, so the session cookie carries fine);
/// it is NOT auth-exempt. Body is capped at 64KB by the route's
/// `DefaultBodyLimit`. Lines land in the journal via `eprintln!` (matching the
/// repo's existing logging convention) prefixed `[telemetry]`.
async fn api_telemetry(body: String) -> StatusCode {
    let ts = chrono::Local::now().format("%H:%M:%S%.3f");
    // Single line per event keeps `journalctl`/`grep` friendly; the client
    // already JSON-encodes structured payloads onto one line.
    eprintln!("[telemetry {ts}] {body}");
    StatusCode::NO_CONTENT
}

/// Strip a client-supplied filename down to Unicode alphanumerics plus
/// `.`, `-`, `_`, replacing everything else with `_` — unchanged from the
/// pre-existing local-only behavior (e.g. `naïve—file.txt` keeps its
/// letters: `naïve_file.txt`). No shell metacharacter, quote, or control
/// character survives, which is what actually matters here: it keeps the
/// upload path safe to interpolate into the remote-write shell command
/// (`tmux::write_remote_file`) as well as the local one — no character
/// survives that could break out of the single-quoted word ssh sends to
/// the remote shell.
fn sanitize_upload_filename(filename: &str) -> String {
    filename
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// POST /api/upload?node=<name> — save an attached file where the terminal
/// the user is looking at can actually reach it. `?node=` follows the same
/// contract as every other node-aware route (`resolve_node_target`): absent
/// means the hub's local `/tmp/mobux-uploads`, unchanged from before; a
/// configured node streams the bytes over the same `ssh -o BatchMode=yes`
/// pipe the rest of the node-aware handlers use and returns the path on
/// THAT host, so the pasted path resolves in the remote shell instead of
/// naming a file that only exists on the hub.
async fn api_upload(
    State(state): State<AppState>,
    Query(q): Query<NodeQuery>,
    mut multipart: axum::extract::Multipart,
) -> Result<Json<serde_json::Value>, AppError> {
    use std::fs;
    use std::path::PathBuf;

    let target = resolve_node_target(&state, q.node.as_deref()).await?;
    let upload_dir = PathBuf::from("/tmp/mobux-uploads");

    if target.is_none() {
        fs::create_dir_all(&upload_dir).map_err(|e| AppError::bad_request(e.into()))?;
    }

    if let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::bad_request(e.into()))?
    {
        let filename = field.file_name().unwrap_or("upload").to_string();
        let safe_name = sanitize_upload_filename(&filename);

        // Add timestamp to avoid collisions
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let dest_filename = format!("{ts}-{safe_name}");

        let data = field
            .bytes()
            .await
            .map_err(|e| AppError::bad_request(e.into()))?;

        let dest_display = match target.as_deref() {
            None => {
                let dest = upload_dir.join(&dest_filename);
                fs::write(&dest, &data).map_err(|e| AppError::bad_request(e.into()))?;
                dest.to_string_lossy().into_owned()
            }
            Some(ssh_target) => {
                let upload_dir_str = upload_dir
                    .to_str()
                    .ok_or_else(|| AppError::internal(anyhow::anyhow!("upload dir not utf-8")))?;
                // A failure here is the remote host/network/ssh, not a bad
                // request — the one client-facing 400 for a bad `?node=`
                // (unknown node name) is already handled upstream by
                // `resolve_node_target`.
                tmux::write_remote_file(ssh_target, upload_dir_str, &dest_filename, &data)
                    .await
                    .map_err(AppError::internal)?
            }
        };

        return Ok(Json(json!({
            "path": dest_display,
            "size": data.len(),
            "name": safe_name,
        })));
    }

    Err(AppError::bad_request(anyhow::anyhow!("no file in upload")))
}

// ── Speech-to-text: POST /transcribe ──────────────────────────────────
//
// Accepts audio as multipart/form-data (field name `audio`) and forwards it
// to the configured OpenAI-compatible STT provider. Returns `{ "text": "..." }`.
// Provider config is read from db on each request — no restart needed after change.
async fn api_transcribe(
    State(state): State<AppState>,
    mut multipart: axum::extract::Multipart,
) -> Result<Json<serde_json::Value>, AppError> {
    let mut audio_bytes: Option<Vec<u8>> = None;
    let mut filename = "speech.wav".to_string();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| anyhow::anyhow!("multipart: {e}"))
        .map_err(AppError::bad_request)?
    {
        if field.name() == Some("audio") {
            if let Some(fname) = field.file_name() {
                filename = fname.to_string();
            }
            audio_bytes = Some(
                field
                    .bytes()
                    .await
                    .map_err(|e| anyhow::anyhow!("read field: {e}"))
                    .map_err(AppError::bad_request)?
                    .to_vec(),
            );
        } else {
            let _ = field.bytes().await;
        }
    }

    let audio = audio_bytes
        .ok_or_else(|| AppError::bad_request(anyhow::anyhow!("missing 'audio' field")))?;

    // Read config per-request — no restart needed after config change.
    // Use the active kind's per-kind settings.
    let (provider_cfg, debug_ctx) = tokio::task::spawn_blocking({
        let db = state.db.clone();
        move || -> anyhow::Result<(transcribe::ProviderConfig, stt_debug::ProviderContext)> {
            let kind = db.stt_active_kind()?;
            let row = db
                .stt_provider(&kind)?
                .unwrap_or_else(|| db::SttProviderRow::default_for(&kind));
            let debug_ctx = stt_debug::ProviderContext {
                kind: row.kind.clone(),
                model: row.model.clone(),
                host: row.host.clone(),
                port: row.port.clone(),
                url: row.transcription_url(),
            };
            let provider_cfg = transcribe::ProviderConfig {
                url: row.transcription_url(),
                model: row.model,
                api_key: row.api_key,
            };
            Ok((provider_cfg, debug_ctx))
        }
    })
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!("spawn_blocking: {e}")))?
    .map_err(AppError::internal)?;

    let debug_audio = audio.clone();
    let debug_filename = filename.clone();
    let data_dir = state.data_dir.clone();
    let started = std::time::Instant::now();
    let result = transcribe::transcribe_with_provider(&provider_cfg, audio, &filename).await;
    let elapsed = started.elapsed();

    let debug_outcome = match &result {
        Ok(text) => Ok(text.clone()),
        Err(e) => Err(e.to_string()),
    };
    tokio::task::spawn_blocking(move || {
        stt_debug::store_clip(
            &data_dir,
            &debug_audio,
            &debug_filename,
            &debug_ctx,
            elapsed,
            &debug_outcome,
        );
    });

    match result {
        Ok(text) => Ok(Json(json!({ "text": text }))),
        Err(transcribe::TranscribeError::ProviderUnavailable(msg)) => Err(AppError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: msg,
        }),
        Err(e) => Err(AppError::internal(anyhow::anyhow!("{e}"))),
    }
}

// ── Web Push: VAPID public key + subscription endpoints ───────────────
//
// Browsers POST a `PushSubscription` JSON shape — `endpoint` is a URL string,
// `p256dh` and `auth` are base64url-encoded byte arrays. We decode the keys
// to raw bytes for storage so Phase 6 can hand them straight to `web-push`
// without a second decode step.

#[derive(Deserialize)]
struct PushSubscribeReq {
    endpoint: String,
    p256dh: String,
    auth: String,
    label: Option<String>,
}

#[derive(Deserialize)]
struct PushUnsubscribeReq {
    endpoint: String,
}

fn decode_b64url(field: &str, value: &str) -> Result<Vec<u8>, AppError> {
    BASE64URL
        .decode(value)
        .map_err(|e| AppError::bad_request(anyhow::anyhow!("invalid base64url in '{field}': {e}")))
}

async fn api_push_vapid_public_key(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let keys = state
        .db
        .vapid_keys()
        .map_err(|e| AppError::internal(anyhow::anyhow!("loading vapid keys: {e}")))?;
    Ok(Json(json!({ "key": BASE64URL.encode(&keys.public_key) })))
}

async fn api_push_subscribe(
    State(state): State<AppState>,
    Json(payload): Json<PushSubscribeReq>,
) -> Result<StatusCode, AppError> {
    if payload.endpoint.trim().is_empty() {
        return Err(AppError::bad_request(anyhow::anyhow!(
            "endpoint must not be empty"
        )));
    }
    let p256dh = decode_b64url("p256dh", &payload.p256dh)?;
    let auth = decode_b64url("auth", &payload.auth)?;

    let label = payload
        .label
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty());

    state
        .db
        .insert_subscription(db::NewSubscription {
            endpoint: payload.endpoint,
            p256dh,
            auth,
            label,
        })
        .map_err(|e| AppError::internal(anyhow::anyhow!("storing subscription: {e}")))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn api_push_unsubscribe(
    State(state): State<AppState>,
    Json(payload): Json<PushUnsubscribeReq>,
) -> Result<StatusCode, AppError> {
    if payload.endpoint.trim().is_empty() {
        return Err(AppError::bad_request(anyhow::anyhow!(
            "endpoint must not be empty"
        )));
    }
    state
        .db
        .remove_subscription(&payload.endpoint)
        .map_err(|e| AppError::internal(anyhow::anyhow!("removing subscription: {e}")))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn api_push_devices(
    State(state): State<AppState>,
) -> Result<Json<Vec<serde_json::Value>>, AppError> {
    let subs = state
        .db
        .list_subscriptions()
        .map_err(|e| AppError::internal(anyhow::anyhow!("listing subscriptions: {e}")))?;
    let out: Vec<serde_json::Value> = subs
        .into_iter()
        .map(|s| {
            json!({
                "id": s.id,
                "label": s.label,
                "created_at": s.created_at,
                "last_seen_at": s.last_seen_at,
            })
        })
        .collect();
    Ok(Json(out))
}

#[derive(Deserialize)]
struct PushNotifyRequest {
    /// Defaults to "mobux" if absent.
    title: Option<String>,
    body: String,
    /// Optional. Same tag from the same origin replaces an existing
    /// notification rather than stacking.
    tag: Option<String>,
    /// Optional. Where to deep-link on click. Defaults to "/".
    url: Option<String>,
}

/// Fire a Web Push notification to every subscribed device. Used by anything
/// that wants to ping the user — Claude, a tmux pipe-pane watcher, build
/// scripts, cron. Returns 204 on success regardless of how many devices
/// received it (delivery is best-effort and logged).
async fn api_push_notify(
    State(state): State<AppState>,
    Json(req): Json<PushNotifyRequest>,
) -> Result<StatusCode, AppError> {
    if req.body.trim().is_empty() {
        return Err(AppError::bad_request(anyhow::anyhow!("body is required")));
    }
    let payload = push::Payload {
        title: req.title.unwrap_or_else(|| "mobux".to_string()),
        body: req.body,
        tag: req.tag,
        url: req.url,
    };
    // Spawn so this returns immediately — push delivery to N devices can take
    // hundreds of ms each, and the caller doesn't need to wait.
    tokio::spawn(push::notify(
        state.db.clone(),
        state.config.push.vapid_contact.clone(),
        payload,
    ));
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct InternalTriggerQuery {
    kind: String,
    session: String,
    window: Option<String>,
}

#[derive(serde::Deserialize)]
struct SttModelsQuery {
    kind: Option<String>,
    host: Option<String>,
    port: Option<String>,
}

/// Internal endpoint hit by the `tmux alert-bell` hook. Bound to 127.0.0.1
/// only and authenticated by `state.internal_token`, so an attacker who
/// can't already run code on the host can't push fake notifications.
/// tmux is the source of truth for whether a bell happened — this handler
/// just routes the event to the push pipeline.
async fn api_internal_trigger(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<InternalTriggerQuery>,
) -> StatusCode {
    let token = headers
        .get("X-Mobux-Token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if token != state.internal_token.as_str() {
        return StatusCode::UNAUTHORIZED;
    }
    if !state.session_name_re.is_match(&q.session) {
        return StatusCode::BAD_REQUEST;
    }
    match q.kind.as_str() {
        "bell" => {
            let prefs = state.db.notification_prefs().unwrap_or_default();
            if prefs.bell {
                push::fire_bell(
                    state.db.clone(),
                    state.config.push.vapid_contact.clone(),
                    &q.session,
                    q.window.as_deref(),
                );
            }
        }
        _ => return StatusCode::BAD_REQUEST,
    }
    StatusCode::NO_CONTENT
}

#[derive(serde::Serialize, Deserialize)]
struct NotifPrefsJson {
    bell: bool,
    bell_emoji: bool,
    program_exit: bool,
    program_exit_nonzero: bool,
}

impl From<db::NotificationPrefs> for NotifPrefsJson {
    fn from(p: db::NotificationPrefs) -> Self {
        Self {
            bell: p.bell,
            bell_emoji: p.bell_emoji,
            program_exit: p.program_exit,
            program_exit_nonzero: p.program_exit_nonzero,
        }
    }
}

impl From<NotifPrefsJson> for db::NotificationPrefs {
    fn from(j: NotifPrefsJson) -> Self {
        Self {
            bell: j.bell,
            bell_emoji: j.bell_emoji,
            program_exit: j.program_exit,
            program_exit_nonzero: j.program_exit_nonzero,
        }
    }
}

async fn api_get_notification_prefs(
    State(state): State<AppState>,
) -> Result<Json<NotifPrefsJson>, AppError> {
    let prefs = state
        .db
        .notification_prefs()
        .map_err(|e| AppError::internal(anyhow::anyhow!("reading prefs: {e}")))?;
    Ok(Json(prefs.into()))
}

async fn api_set_notification_prefs(
    State(state): State<AppState>,
    Json(req): Json<NotifPrefsJson>,
) -> Result<StatusCode, AppError> {
    state
        .db
        .set_notification_prefs(req.into())
        .map_err(|e| AppError::internal(anyhow::anyhow!("writing prefs: {e}")))?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Serialize, Deserialize)]
struct UiPrefsJson {
    renderer: String,
    theme: String,
    default_view: String,
    osc133_hint_dismissed: bool,
    listen_voice: String,
    listen_rate: f64,
    listen_pitch: f64,
    #[serde(default)]
    selected_node: String,
}

impl From<db::UiPreferences> for UiPrefsJson {
    fn from(p: db::UiPreferences) -> Self {
        // Tolerant on read: a row written before validation existed (or
        // hand-edited in the sqlite file) must never brick a client's boot.
        // Normalize the two enum-shaped fields and clamp the numeric ranges
        // rather than serving garbage the client doesn't expect. Free-text
        // fields (theme id, voice name) are served verbatim.
        let renderer = if p.renderer == "sterk" {
            "sterk"
        } else {
            "xterm"
        }
        .to_string();
        let default_view = match p.default_view.as_str() {
            "reader" => "reader",
            "read" => "read",
            _ => "xterm",
        }
        .to_string();
        Self {
            renderer,
            theme: p.theme,
            default_view,
            osc133_hint_dismissed: p.osc133_hint_dismissed,
            listen_voice: p.listen_voice,
            listen_rate: p.listen_rate.clamp(0.5, 2.0),
            listen_pitch: p.listen_pitch.clamp(0.5, 2.0),
            selected_node: p.selected_node,
        }
    }
}

impl UiPrefsJson {
    /// Validate a client-submitted blob before it's written. Unlike the read
    /// path, a write is rejected outright on a bad enum value instead of
    /// silently clamped — a client sending garbage should see a 400, not have
    /// its mistake quietly rewritten to a default it didn't ask for. Numeric
    /// ranges are still clamped: a slider that overshoots isn't a client bug.
    fn validate(self) -> Result<db::UiPreferences, String> {
        if self.renderer != "xterm" && self.renderer != "sterk" {
            return Err(format!(
                "invalid renderer {:?}: must be \"xterm\" or \"sterk\"",
                self.renderer
            ));
        }
        if !matches!(self.default_view.as_str(), "xterm" | "reader" | "read") {
            return Err(format!(
                "invalid default_view {:?}: must be \"xterm\", \"reader\" or \"read\"",
                self.default_view
            ));
        }
        Ok(db::UiPreferences {
            renderer: self.renderer,
            theme: self.theme,
            default_view: self.default_view,
            osc133_hint_dismissed: self.osc133_hint_dismissed,
            listen_voice: self.listen_voice,
            listen_rate: self.listen_rate.clamp(0.5, 2.0),
            listen_pitch: self.listen_pitch.clamp(0.5, 2.0),
            selected_node: self.selected_node,
        })
    }
}

async fn api_get_ui_preferences(
    State(state): State<AppState>,
) -> Result<Json<UiPrefsJson>, AppError> {
    let prefs = state
        .db
        .ui_preferences()
        .map_err(|e| AppError::internal(anyhow::anyhow!("reading ui preferences: {e}")))?;
    Ok(Json(prefs.into()))
}

async fn api_set_ui_preferences(
    State(state): State<AppState>,
    Json(req): Json<UiPrefsJson>,
) -> Result<StatusCode, AppError> {
    let prefs = req
        .validate()
        .map_err(|e| AppError::bad_request(anyhow::anyhow!(e)))?;
    state
        .db
        .set_ui_preferences(prefs)
        .map_err(|e| AppError::internal(anyhow::anyhow!("writing ui preferences: {e}")))?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ShellIntegrationReq {
    shell: shell_integration::Shell,
}

async fn api_shell_integration_status() -> Result<Json<shell_integration::Status>, AppError> {
    let s = shell_integration::status().map_err(AppError::internal)?;
    Ok(Json(s))
}

async fn api_shell_integration_install(
    Json(req): Json<ShellIntegrationReq>,
) -> Result<Json<shell_integration::Status>, AppError> {
    let s = shell_integration::install(req.shell).map_err(AppError::internal)?;
    Ok(Json(s))
}

async fn api_shell_integration_uninstall(
    Json(req): Json<ShellIntegrationReq>,
) -> Result<Json<shell_integration::Status>, AppError> {
    let s = shell_integration::uninstall(req.shell).map_err(AppError::internal)?;
    Ok(Json(s))
}

const PKG_VERSION: &str = env!("CARGO_PKG_VERSION");

async fn settings_page() -> impl IntoResponse {
    (
        axum::http::StatusCode::TEMPORARY_REDIRECT,
        [
            (axum::http::header::LOCATION, "/app#/settings"),
            (axum::http::header::CACHE_CONTROL, "no-store"),
        ],
    )
}

/// Where a bare session name (no node segment) is currently found.
#[derive(Debug, Clone, PartialEq, Eq)]
enum SessionLocation {
    Local,
    Node(String),
}

/// Pure decision, no I/O: given what's currently at each location, is `name`
/// findable at exactly one? A same-named session can exist locally AND on a
/// node, or on two different nodes — that's ambiguous, not a tie-break, so it
/// (like a zero-location miss) returns `None`. Kept separate from
/// `locate_session` (the tmux/ssh-probing wrapper) so the decision itself is
/// unit-testable without any process spawning.
fn resolve_session_location(
    name: &str,
    local: &[tmux::Session],
    nodes: &[(&str, &[tmux::Session])],
) -> Option<SessionLocation> {
    let mut found = Vec::new();
    if local.iter().any(|s| s.name == name) {
        found.push(SessionLocation::Local);
    }
    for (node_name, sessions) in nodes {
        if sessions.iter().any(|s| s.name == name) {
            found.push(SessionLocation::Node((*node_name).to_string()));
        }
    }
    let mut it = found.into_iter();
    let first = it.next()?;
    if it.next().is_some() {
        return None; // ambiguous
    }
    Some(first)
}

/// Wall-clock bound on a single `locate_session` probe. `tmux::tmux_command`'s
/// `ConnectTimeout=3` bounds SSH's own connection/handshake setup, but not
/// what happens once a session is established and the remote command is
/// actually running — a node whose sshd accepts fine but whose shell startup
/// or tmux then hangs (a wedged `$HOME`, a dead NFS mount) would otherwise
/// block `tmux list-sessions` forever, and every `/s/{name}` request with it.
/// This wraps each probe in its own hard timeout so worst-case page load
/// stays bounded regardless of what's wrong on the far side; timing out
/// counts as "not there", exactly like any other probe failure.
const SESSION_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Race `fut` against `SESSION_PROBE_TIMEOUT`; a timeout collapses to `None`,
/// same as the future's own error case — split out from
/// `probe_sessions_or_absent` so the timeout behavior itself is testable with
/// a synthetic future, no real tmux/ssh process involved.
async fn with_probe_timeout<T, Fut>(fut: Fut) -> Option<T>
where
    Fut: std::future::Future<Output = Result<T>>,
{
    tokio::time::timeout(SESSION_PROBE_TIMEOUT, fut)
        .await
        .ok()
        .and_then(Result::ok)
}

async fn probe_sessions_or_absent(target: Option<&str>) -> Vec<tmux::Session> {
    with_probe_timeout(tmux::list_sessions(target))
        .await
        .unwrap_or_default()
}

/// Probe local + every configured node concurrently for a session named
/// `name` (mirrors `api_nodes_status`'s `join_all` reachability pattern). A
/// probe that times out or errors (unreachable node, no local tmux server
/// yet) counts as "not there" rather than failing the whole lookup — worst
/// case that lands the caller on Home instead of a specific tmux, never the
/// wrong one. A failure to even READ the node inventory is different — that's
/// not "no nodes configured", so it propagates as a hard error instead of
/// silently narrowing the search (which could turn a real ambiguity into a
/// false unique match).
async fn locate_session(state: &AppState, name: &str) -> Result<Option<SessionLocation>, AppError> {
    let db_nodes = tokio::task::spawn_blocking({
        let db = state.db.clone();
        move || db.list_nodes()
    })
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!("spawn_blocking: {e}")))?
    .map_err(AppError::internal)?;

    let local_probe = probe_sessions_or_absent(None);
    let node_probes = db_nodes
        .iter()
        .map(|n| probe_sessions_or_absent(Some(n.target.as_str())));
    let (local_sessions, node_session_lists) =
        tokio::join!(local_probe, future::join_all(node_probes));

    let node_sessions: Vec<(String, Vec<tmux::Session>)> = db_nodes
        .into_iter()
        .zip(node_session_lists)
        .map(|(n, sessions)| (n.name, sessions))
        .collect();
    let node_refs: Vec<(&str, &[tmux::Session])> = node_sessions
        .iter()
        .map(|(name, sessions)| (name.as_str(), sessions.as_slice()))
        .collect();

    Ok(resolve_session_location(name, &local_sessions, &node_refs))
}

/// A bare session-name link, either a push-notification click (`push.rs`
/// builds `/s/{session}` — always the hub's own local tmux, since the
/// `alert-bell` hook only ever runs there, see `push::session_url`) or a
/// hand-typed / bookmarked one, which carries no such guarantee. A same-named
/// session can exist on a node too, so this resolves rather than assuming
/// local (issue #210: the previous behavior — always redirecting to the
/// hub-local hash route regardless of where the session actually lived —
/// silently attached the wrong tmux whenever the two disagreed).
async fn terminal_page(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    validate_session_name(&state, &name)?;
    // Name is already validated to [a-zA-Z0-9_-], so no percent-encoding
    // is needed in any of these hash routes.
    let location = match locate_session(&state, &name).await? {
        Some(SessionLocation::Local) => format!("/app#/s/{name}"),
        Some(SessionLocation::Node(node)) => format!("/app#/s/{node}/{name}"),
        // Not found anywhere, or found in more than one place — never guess;
        // land on Home so the user picks explicitly instead of silently
        // attaching to the wrong tmux.
        None => "/app#/".to_string(),
    };
    Ok((
        axum::http::StatusCode::TEMPORARY_REDIRECT,
        [
            (axum::http::header::LOCATION, location),
            (axum::http::header::CACHE_CONTROL, "no-store".to_string()),
        ],
    ))
}

// Serve sw.js with the per-restart cache_bust appended as a comment.
// Chrome considers a service worker "updated" when its bytes differ
// from the cached copy; without this, a release that only changes JS
// bundles (not sw.js itself) leaves the old SW installed indefinitely.
// Appending cache_bust forces a fresh install on every restart so the
// SW's lifecycle (skipWaiting + clients.claim) runs and any stale state
// is cleared.
async fn serve_sw(State(state): State<AppState>) -> impl axum::response::IntoResponse {
    use axum::http::header;
    let body = format!(
        "{}\n// sw-version: {}\n",
        include_str!("../web/static/sw.js"),
        state.cache_bust,
    );
    (
        [
            (header::CONTENT_TYPE, "text/javascript"),
            (header::CACHE_CONTROL, "no-store, must-revalidate"),
        ],
        body,
    )
}

// Serve a frontend asset embedded in the binary (see `StaticAssets`).
//
// mobux is a single-user app served over a tailnet — bandwidth is irrelevant
// and caching buys nothing. It actively broke us: assets used to be served
// `immutable` for a year, and the only cache-busting was the `?v=<cache_bust>`
// query param the HTML appends to `<script src>`/`<link href>` tags. But ES
// module `import` statements use bare specifiers with no `?v=`, so every
// import-only module (input-bar.js, reader.js, …) was frozen in the
// browser cache forever and never picked up new deploys.
//
// Fix: `no-store`, same as the HTML pages and sw.js — nothing is ever cached,
// every load fetches the current bytes. The `?v=` query is harmless and left
// in place; it's ignored here (the wildcard match is on the path, not the
// query).
async fn serve_static(Path(path): Path<String>) -> Response {
    use axum::http::header;
    match StaticAssets::get(&path) {
        Some(file) => {
            let mime = file.metadata.mimetype();
            let mut resp = (StatusCode::OK, file.data).into_response();
            let h = resp.headers_mut();
            if let Ok(v) = HeaderValue::from_str(mime) {
                h.insert(header::CONTENT_TYPE, v);
            }
            h.insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-store, must-revalidate"),
            );
            resp
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

/// Serve the client SPA's `index.html` for `/app` and any `/app/*` sub-path
/// (SPA history fallback). The SPA's own assets (JS/CSS, referenced from
/// index.html at `/static/spa/...`) are served by `serve_static`, so this
/// handler only ever returns the entry document. Behind the global auth layer
/// and `no-store`, exactly like the inline HTML pages.
///
/// `spa/index.html` is emitted by `web/spa`'s Vite build into `web/static/spa/`
/// and embedded by RustEmbed. If the SPA wasn't built (asset missing), return a
/// clear 404 hint rather than a blank page.
async fn serve_spa_index() -> Response {
    use axum::http::header;
    match StaticAssets::get("spa/index.html") {
        Some(file) => {
            let mut resp = (StatusCode::OK, file.data).into_response();
            let h = resp.headers_mut();
            h.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            );
            h.insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-store, must-revalidate"),
            );
            resp
        }
        None => (
            StatusCode::NOT_FOUND,
            "SPA not built — run `node web/build.js` (or `make build`).",
        )
            .into_response(),
    }
}

// ── /install: redirect to the SPA Install page ────────────────────────
// APK and CA downloads (/install/mobux.apk, /install/mobux-ca.crt) are
// preserved as-is. The install UI itself lives in the SPA at /app#/install.

async fn install_page() -> impl IntoResponse {
    (
        axum::http::StatusCode::TEMPORARY_REDIRECT,
        [
            (axum::http::header::LOCATION, "/app#/install"),
            (axum::http::header::CACHE_CONTROL, "no-store"),
        ],
    )
}

async fn serve_install_apk(State(state): State<AppState>) -> Response {
    let path = twa::resolve_artifact(twa::apk_path(&state.data_dir), twa::CHECKOUT_APK_PATH);
    serve_file_or_404(
        path.to_string_lossy().as_ref(),
        "application/vnd.android.package-archive",
        Some("mobux.apk"),
    )
    .await
}

async fn serve_install_ca(State(state): State<AppState>) -> Response {
    if ssl::acme_mode_enabled(&state.config.tls) {
        return (StatusCode::NOT_FOUND, "ACME mode: no local CA to install").into_response();
    }
    let path = ssl::ca_cert_path(&state.config_dir);
    serve_file_or_404(
        path.to_string_lossy().as_ref(),
        "application/x-x509-ca-cert",
        Some("mobux-ca.crt"),
    )
    .await
}

async fn serve_assetlinks(State(state): State<AppState>) -> Response {
    let path = twa::resolve_artifact(
        twa::assetlinks_path(&state.data_dir),
        twa::CHECKOUT_ASSETLINKS_PATH,
    );
    serve_file_or_404(path.to_string_lossy().as_ref(), "application/json", None).await
}

/// Read a file from disk and return it as a Response with the given
/// Content-Type. 404 if the file is absent. Optionally sets a
/// `Content-Disposition: attachment; filename=...` header so browsers
/// download instead of trying to render.
async fn serve_file_or_404(
    path: &str,
    content_type: &'static str,
    download_name: Option<&'static str>,
) -> Response {
    use axum::http::header;
    let bytes = match tokio::fs::read(path).await {
        Ok(b) => b,
        Err(_) => return (StatusCode::NOT_FOUND, "not found").into_response(),
    };

    let mut resp = (
        StatusCode::OK,
        [(header::CONTENT_TYPE, content_type)],
        bytes,
    )
        .into_response();

    if let Some(name) = download_name {
        let disp = format!("attachment; filename=\"{name}\"");
        if let Ok(v) = HeaderValue::from_str(&disp) {
            resp.headers_mut().insert(header::CONTENT_DISPOSITION, v);
        }
    }
    resp
}

/// Optional `?node=<name>` accepted by the terminal WS and every
/// `/api/sessions*` route. Absent means today's behavior (local tmux);
/// naming a node that isn't configured is a hard error — never a silent
/// fall-back to local.
#[derive(Deserialize)]
struct NodeQuery {
    node: Option<String>,
}

/// Resolve a `?node=` query value to the node's ssh target. `None` in ->
/// `None` out (local). `Some(name)` that isn't a configured node is a 400 —
/// callers must never silently fall back to local for a typo'd node name.
async fn resolve_node_target(
    state: &AppState,
    node: Option<&str>,
) -> Result<Option<String>, AppError> {
    let Some(name) = node else { return Ok(None) };
    let name = name.to_string();
    let found = tokio::task::spawn_blocking({
        let db = state.db.clone();
        let name = name.clone();
        move || db.get_node(&name)
    })
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!("spawn_blocking: {e}")))?
    .map_err(AppError::internal)?;
    let target = found.map(|n| n.target).ok_or_else(|| {
        AppError::bad_request(anyhow::anyhow!(
            "unknown node {name:?} — check Settings › Nodes"
        ))
    })?;
    // A target starting with `-` would be read by ssh's own getopt as an
    // option rather than a host argument (e.g. `-oProxyCommand=...`),
    // running on the HUB instead of failing to connect. `ssh_exec_command`
    // (tmux.rs) always passes the target as a bare argv element before
    // `--`, so this is the one choke point every node-aware route already
    // goes through to reject it.
    if target.starts_with('-') {
        return Err(AppError::bad_request(anyhow::anyhow!(
            "node {name:?} has an invalid target {target:?} — check Settings › Nodes"
        )));
    }
    Ok(Some(target))
}

/// The terminal WS query: the shared `?node=<name>` (see `resolve_node_target`)
/// plus `&build=<hash>` — the SPA's own loaded-bundle hash, set by the engine
/// (TerminalIsland). It rides along so a stale tab still running old code
/// identifies itself in the attach log even though it fetches a fresh
/// `/static/build-info.json`; the hash is baked into the loaded bundle's
/// filename, so it describes the code actually running in that tab.
#[derive(Deserialize)]
struct TerminalWsQuery {
    node: Option<String>,
    build: Option<String>,
}

/// Cap on how much of the client-supplied `build` param lands in a log line.
/// `build` is an arbitrary query string with no server-side format check (it's
/// diagnostic only), so without a cap a malicious/broken client can emit an
/// unbounded line into the journal. The real values are short content hashes
/// (8-20 chars), so this is generous headroom, not a real limit in practice.
const MAX_LOGGED_BUILD_LEN: usize = 64;

/// Truncate `s` to at most `max_chars` *characters* (not bytes), so the cut
/// always lands on a UTF-8 char boundary.
fn truncate_for_log(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        Some((byte_idx, _)) => &s[..byte_idx],
        None => s,
    }
}

/// Formats one `[ws attach]` journal line — split from `log_ws_attach` as a
/// pure function so the escaping/truncation behavior is unit-testable
/// without constructing an `AppState`.
///
/// `node` and `build` are client-controlled query params — logged with
/// `{:?}` (like `session`/`user_agent`) so a value containing `\n` or `"`
/// can't forge fake-looking lines in the journal instead of just describing
/// itself. `build` is additionally length-capped (see `MAX_LOGGED_BUILD_LEN`)
/// since, unlike `session` (already bounded by `session_name_re`), nothing
/// else constrains its size.
fn format_ws_attach_line(
    outcome: &str,
    session: &str,
    node: Option<&str>,
    target: &str,
    build: Option<&str>,
    server_build: &str,
    user_agent: &str,
) -> String {
    let build = build.map(|b| truncate_for_log(b, MAX_LOGGED_BUILD_LEN));
    format!(
        "[ws attach] {outcome} session={session:?} node={node:?} target={target} build={build:?} server_build={server_build} ua={user_agent:?}"
    )
}

/// Every PTY attach and every rejected upgrade logs one line to the journal —
/// the only ground truth for "which host did this tab actually attach to?".
/// A session error rendered inside the terminal (`can't find session: X`)
/// means the attach hit the wrong tmux because `node` arrived absent or wrong;
/// this line makes that visible instead of silent. Loud like the "PUT emptied
/// the node list" warning: mobux is a single-operator tool, so per-attach
/// journal lines are affordable and worth it.
fn log_ws_attach(
    state: &AppState,
    outcome: &str,
    session: &str,
    node: Option<&str>,
    target: &str,
    build: Option<&str>,
    user_agent: &str,
) {
    eprintln!(
        "{}",
        format_ws_attach_line(
            outcome,
            session,
            node,
            target,
            build,
            &state.build_hash,
            user_agent,
        )
    );
}

async fn terminal_ws(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Query(q): Query<TerminalWsQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, AppError> {
    let user_agent = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("<none>")
        .to_string();
    let node = q.node.as_deref();
    let build = q.build.as_deref();

    if let Err(err) = validate_session_name(&state, &name) {
        let outcome = format!("REJECTED[{}: {}]", err.status.as_u16(), err.message);
        log_ws_attach(&state, &outcome, &name, node, "-", build, &user_agent);
        return Err(err);
    }

    let ssh_target = match resolve_node_target(&state, node).await {
        Ok(target) => target,
        Err(err) => {
            let outcome = format!("REJECTED[{}: {}]", err.status.as_u16(), err.message);
            log_ws_attach(&state, &outcome, &name, node, "-", build, &user_agent);
            return Err(err);
        }
    };

    log_ws_attach(
        &state,
        "ok",
        &name,
        node,
        ssh_target.as_deref().unwrap_or("local"),
        build,
        &user_agent,
    );

    let session_history = state.session_history.clone();
    Ok(ws.on_upgrade(move |socket| async move {
        if let Err(err) = handle_ws(socket, name, ssh_target, session_history).await {
            eprintln!("ws error: {err:#}");
        }
    }))
}

#[derive(Deserialize)]
struct ResizeMsg {
    #[serde(rename = "type")]
    kind: String,
    cols: u16,
    rows: u16,
}

async fn handle_ws(
    socket: axum::extract::ws::WebSocket,
    session_name: String,
    ssh_target: Option<String>,
    session_history: Arc<session_history::SessionHistoryStore>,
) -> Result<()> {
    // Only one attach at a time feeds the conversation-history segmenter for
    // a given session — tmux mirrors the same output to every attached
    // client, so a second concurrent tab must not double-segment and
    // double-append (see `FeederGuard`'s doc comment). Held until this
    // connection ends; released automatically (RAII) on any return path,
    // including an early `?` below. A connection that loses the race retries
    // in the PTY-read branch below, so the slot the departing feeder frees is
    // picked up by whoever is still attached.
    let mut feeder_guard = session_history.try_acquire_feeder(&session_name);
    let mut segmenter = feeder_guard
        .as_ref()
        .map(|_| session_history::Segmenter::new());

    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: 35,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    // MOBUX_TMUX_SOCKET is hub-local test isolation (a dedicated tmux server
    // for the test suite) — meaningless on a remote node, so it only applies
    // to the local path.
    let tmux_bin = match (&ssh_target, std::env::var("MOBUX_TMUX_SOCKET")) {
        (None, Ok(s)) if !s.is_empty() => format!("tmux -L {}", s),
        _ => "tmux".to_string(),
    };
    // Local sessions prefer a dedicated `tmux pipe-pane` tap over this
    // connection's own attach-relay bytes below — see `tmux::PanePipeTap`'s
    // doc comment. `history_rx.is_none()` (checked at every use below) is
    // what actually gates the attach-relay fallback, so a tap that never
    // started, or dies mid-session, degrades to the old behavior instead of
    // going dark.
    let (mut history_tap, mut history_rx) = start_history_feed(
        &ssh_target,
        &tmux_bin,
        &session_name,
        feeder_guard.is_some(),
    )
    .await;
    // Force a real terminfo entry on the spawned PTY. The host's TERM
    // can be unset, "dumb" (non-interactive shells), or something tmux
    // doesn't have terminfo for — in any of those cases tmux's first
    // act on attach is `open terminal failed: terminal does not support
    // clear`, the bash subprocess exits 1, and the WS gets nothing past
    // the 57-byte init handshake. The browser-side renderer (aceterm /
    // libterm) is xterm-256color compatible, so use that unconditionally.
    // `allow-passthrough on` is required for the OSC 133 shell-integration
    // snippet's tmux DCS-passthrough wrap (\ePtmux;\e<seq>\e\\) to reach
    // the outer terminal. tmux 3.4 defaults this off, and silently drops
    // OSC 133 entirely without it; tmux 3.5+ also honours the option.
    //
    // Local vs. remote (node) is the ONLY difference: same PTY, same tmux
    // setup commands, same resize path — just `bash -c "..."` vs.
    // `ssh -tt <target> "..."` (see nodes::build_attach_command). A failed
    // ssh connect prints its own diagnostic to the pty and exits, which
    // flows through unchanged — the same "command exited, here's why" path
    // a dead local tmux server already takes.
    let cmd = nodes::build_attach_command(ssh_target.as_deref(), &tmux_bin, &session_name);
    let mut child = pair.slave.spawn_command(cmd)?;

    let mut reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;
    let master = pair.master;

    let writer = Arc::new(Mutex::new(writer));
    let master = Arc::new(Mutex::new(master));

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();

    std::thread::spawn(move || {
        let mut buf = vec![0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let (mut ws_sender, mut ws_receiver) = socket.split();

    loop {
        tokio::select! {
            // Only armed while a local pipe-pane tap is live — disarmed
            // (`if history_rx.is_some()`) the instant it isn't, which is
            // also what un-gates the attach-relay branch's own feed below.
            maybe_hist = async { history_rx.as_mut().unwrap().recv().await }, if history_rx.is_some() => {
                match maybe_hist {
                    Some(chunk) => {
                        if let Some(seg) = segmenter.as_mut() {
                            let produced = seg.feed(&chunk, session_history::now_ms());
                            if !produced.is_empty() {
                                let history = session_history.clone();
                                let name = session_name.clone();
                                let _ = tokio::task::spawn_blocking(move || {
                                    for entry in produced {
                                        let _ = history.append(&name, entry);
                                    }
                                })
                                .await;
                            }
                        }
                    }
                    None => {
                        history_rx = None;
                        history_tap = None;
                    }
                }
            }
            maybe_out = rx.recv() => {
                match maybe_out {
                    Some(chunk) => {
                        // Notification triggers no longer come from this
                        // path — bells flow through the tmux `alert-bell`
                        // hook (see `tmux::install_bell_hook`), which
                        // tmux fires exactly once per real bell. Repaint
                        // chunks here are just rendering, never events.
                        //
                        // A connection that lost the feeder race keeps
                        // retrying here every chunk (see `FeederGuard`'s
                        // doc comment) — this is also where a live pipe-pane
                        // tap gets (re)started once the slot is acquired.
                        if feeder_guard.is_none() {
                            feeder_guard = session_history.try_acquire_feeder(&session_name);
                            if feeder_guard.is_some() {
                                segmenter = Some(session_history::Segmenter::new());
                                let (tap, rx) =
                                    start_history_feed(&ssh_target, &tmux_bin, &session_name, true)
                                        .await;
                                history_tap = tap;
                                history_rx = rx;
                            }
                        }
                        // The pipe-pane branch above feeds the segmenter
                        // whenever it's live; feeding it here too would
                        // double-segment.
                        if history_rx.is_none() {
                            if let Some(seg) = segmenter.as_mut() {
                                let produced = seg.feed(&chunk, session_history::now_ms());
                                if !produced.is_empty() {
                                    let history = session_history.clone();
                                    let name = session_name.clone();
                                    let _ = tokio::task::spawn_blocking(move || {
                                        for entry in produced {
                                            let _ = history.append(&name, entry);
                                        }
                                    })
                                    .await;
                                }
                            }
                        }
                        let text = String::from_utf8_lossy(&chunk).to_string();
                        if ws_sender.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            maybe_in = ws_receiver.next() => {
                match maybe_in {
                    Some(Ok(msg)) => {
                        match msg {
                            Message::Text(t) => {
                                if let Ok(rz) = serde_json::from_str::<ResizeMsg>(&t) {
                                    if rz.kind == "resize" && rz.cols > 0 && rz.rows > 0 {
                                        if let Ok(m) = master.lock() {
                                            let _ = m.resize(PtySize { rows: rz.rows, cols: rz.cols, pixel_width: 0, pixel_height: 0});
                                        }
                                        continue;
                                    }
                                }
                                if let Ok(mut w) = writer.lock() {
                                    let _ = w.write_all(t.as_bytes());
                                    let _ = w.flush();
                                }
                            }
                            Message::Binary(b) => {
                                if let Ok(mut w) = writer.lock() {
                                    let _ = w.write_all(&b);
                                    let _ = w.flush();
                                }
                            }
                            Message::Close(_) => break,
                            Message::Ping(_) | Message::Pong(_) => {}
                        }
                    }
                    Some(Err(_)) | None => break,
                }
            }
        }
    }

    if let Some(mut seg) = segmenter.take() {
        if let Some(entry) = seg.flush(session_history::now_ms()) {
            let history = session_history.clone();
            let name = session_name.clone();
            let _ = tokio::task::spawn_blocking(move || history.append(&name, entry)).await;
        }
    }

    // `PanePipeTap::drop` stops its tmux-side target and removes its fifo —
    // dropping it here is belt-and-suspenders (every earlier return in this
    // function drops it too, since it's a plain local variable).
    drop(history_tap);

    let _ = child.kill();
    let _ = child.wait();
    Ok(())
}

/// Starts (or, on re-acquire, restarts) the `tmux pipe-pane`-backed history
/// tap for a session that just became this connection's responsibility to
/// segment — `active` mirrors `feeder_guard.is_some()` at the call site. A
/// no-op (returns `(None, None)`) when `active` is false, when the session
/// lives on a remote node (unbuilt — see `tmux::PanePipeTap`'s doc comment),
/// or when the tap fails to start; the caller falls back to its own
/// attach-relay feed in all three cases, gating on `history_rx.is_none()`.
async fn start_history_feed(
    ssh_target: &Option<String>,
    tmux_bin: &str,
    session_name: &str,
    active: bool,
) -> (
    Option<tmux::PanePipeTap>,
    Option<tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>>,
) {
    if !active || ssh_target.is_some() {
        return (None, None);
    }
    match tmux::PanePipeTap::start(tmux_bin, session_name).await {
        Some((tap, rx)) => (Some(tap), Some(rx)),
        None => (None, None),
    }
}

fn validate_session_name(state: &AppState, name: &str) -> Result<(), AppError> {
    if name.is_empty() || !state.session_name_re.is_match(name) {
        return Err(AppError::bad_request(anyhow::anyhow!(
            "invalid session name"
        )));
    }
    Ok(())
}

// ── Node inventory (issue #176 phase 2) ───────────────────────────────

#[derive(serde::Serialize, Deserialize)]
struct NodeJson {
    name: String,
    target: String,
}

#[derive(serde::Serialize)]
struct NodesGetJson {
    nodes: Vec<NodeJson>,
}

#[derive(Deserialize)]
struct NodesPutJson {
    nodes: Vec<NodeJson>,
}

/// GET /api/settings/nodes — the configured node list, name + ssh target.
/// Mirrors GET /api/settings/stt: read-only reflection of what's stored.
async fn api_get_settings_nodes(
    State(state): State<AppState>,
) -> Result<Json<NodesGetJson>, AppError> {
    let nodes = tokio::task::spawn_blocking({
        let db = state.db.clone();
        move || db.list_nodes()
    })
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!("spawn_blocking: {e}")))?
    .map_err(AppError::internal)?;

    Ok(Json(NodesGetJson {
        nodes: nodes
            .into_iter()
            .map(|n| NodeJson {
                name: n.name,
                target: n.target,
            })
            .collect(),
    }))
}

/// PUT /api/settings/nodes — replaces the whole node list (not a patch),
/// mirroring how the rest of the settings surface treats a PUT as "this is
/// now the full config". "No nodes configured" (an empty list) is the
/// default and behaves exactly like today's single-host mobux.
async fn api_set_settings_nodes(
    State(state): State<AppState>,
    Json(req): Json<NodesPutJson>,
) -> Result<StatusCode, AppError> {
    let mut seen = std::collections::HashSet::new();
    for n in &req.nodes {
        if n.name.trim().is_empty() || n.target.trim().is_empty() {
            return Err(AppError::bad_request(anyhow::anyhow!(
                "node name and target must not be empty"
            )));
        }
        if !seen.insert(n.name.clone()) {
            return Err(AppError::bad_request(anyhow::anyhow!(
                "duplicate node name: {}",
                n.name
            )));
        }
    }

    let new_count = req.nodes.len();
    tokio::task::spawn_blocking({
        let db = state.db.clone();
        let pairs = req.nodes.into_iter().map(|n| (n.name, n.target)).collect();
        move || -> anyhow::Result<usize> {
            let previous_count = db.list_nodes()?.len();
            db.replace_nodes(pairs)?;
            Ok(previous_count)
        }
    })
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!("spawn_blocking: {e}")))?
    .map_err(AppError::internal)
    .map(|previous_count| {
        // A full-list replace from N configured nodes down to zero is the
        // shape of a client-side bug (a load failure mistaken for a real
        // empty list, then saved — see web/spa/src/components/settings/
        // Nodes.jsx) rather than a deliberate "remove every node" action, so
        // it's loud in the log even though it's still honored as requested.
        if previous_count > 0 && new_count == 0 {
            eprintln!(
                "warning: PUT /api/settings/nodes emptied the node list (was {previous_count}, now 0) — was this intentional?"
            );
        }
    })?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Serialize)]
struct NodeStatusJson {
    name: String,
    target: String,
    reachable: bool,
}

#[derive(serde::Serialize)]
struct NodesStatusJson {
    nodes: Vec<NodeStatusJson>,
}

/// GET /api/nodes — configured nodes plus a live reachability flag, probed
/// concurrently (`ConnectTimeout=3` per node, see `nodes::probe_reachable`)
/// so one dead node never delays the others or blocks the response.
async fn api_nodes_status(
    State(state): State<AppState>,
) -> Result<Json<NodesStatusJson>, AppError> {
    let db_nodes = tokio::task::spawn_blocking({
        let db = state.db.clone();
        move || db.list_nodes()
    })
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!("spawn_blocking: {e}")))?
    .map_err(AppError::internal)?;

    let probes = db_nodes
        .iter()
        .map(|n| nodes::probe_reachable(&n.target, std::time::Duration::from_secs(3)));
    let reachable = future::join_all(probes).await;

    let out = db_nodes
        .into_iter()
        .zip(reachable)
        .map(|(n, reachable)| NodeStatusJson {
            name: n.name,
            target: n.target,
            reachable,
        })
        .collect();
    Ok(Json(NodesStatusJson { nodes: out }))
}

#[derive(serde::Serialize)]
struct HostSuggestionsJson {
    hosts: Vec<host_suggestions::HostSuggestion>,
}

/// GET /api/host-suggestions — best-effort host candidates for the "add
/// remote node" host field (issue #193). Each provider (ssh-config,
/// tailscale, avahi/mDNS) is independently optional: a missing tool, a
/// parse failure, or a timeout contributes nothing, never an error. The two
/// subprocess-backed providers run concurrently and are individually
/// time-boxed, so the endpoint's total latency is bounded by the slower of
/// the two (~2s), not their sum.
async fn api_host_suggestions() -> Json<HostSuggestionsJson> {
    let ssh = host_suggestions::ssh_config_hosts();
    let (tailscale, mdns) = tokio::join!(
        host_suggestions::tailscale_hosts(std::time::Duration::from_millis(1500)),
        host_suggestions::avahi_hosts(std::time::Duration::from_millis(2000)),
    );
    Json(HostSuggestionsJson {
        hosts: host_suggestions::merge([ssh, tailscale, mdns]),
    })
}

// ── STT provider settings + lifecycle endpoints ───────────────────────

/// Per-kind provider info returned by GET /api/settings/stt.
/// api_key is NEVER returned; has_key is a boolean indicator.
#[derive(serde::Serialize)]
struct SttProviderJson {
    host: String,
    port: String,
    model: String,
    has_key: bool,
}

/// Shape returned by GET /api/settings/stt.
#[derive(serde::Serialize)]
struct SttConfigGetJson {
    #[serde(rename = "activeKind")]
    active_kind: String,
    providers: std::collections::HashMap<String, SttProviderJson>,
    // Legacy/install fields still forwarded for local kind only.
    #[serde(skip_serializing_if = "Option::is_none")]
    install_cmd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_cmd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop_cmd: Option<String>,
}

/// Shape accepted by PUT /api/settings/stt.
/// Saves settings for the given kind and makes it the active kind.
/// api_key is optional; if absent or empty the existing stored key is preserved.
#[derive(serde::Deserialize)]
struct SttConfigPutJson {
    kind: String,
    host: String,
    port: String,
    model: String,
    #[serde(default)]
    api_key: Option<String>,
}

async fn api_get_stt_config(
    State(state): State<AppState>,
) -> Result<Json<SttConfigGetJson>, AppError> {
    let (active_kind, providers, legacy) = tokio::task::spawn_blocking({
        let db = state.db.clone();
        move || -> anyhow::Result<_> {
            let active_kind = db.stt_active_kind()?;
            let rows = db.stt_all_providers()?;
            let legacy = db.stt_config()?;
            Ok((active_kind, rows, legacy))
        }
    })
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!("spawn_blocking: {e}")))?
    .map_err(AppError::internal)?;

    let mut map = std::collections::HashMap::new();
    for row in &providers {
        map.insert(
            row.kind.clone(),
            SttProviderJson {
                host: row.host.clone(),
                port: row.port.clone(),
                model: row.model.clone(),
                has_key: row.api_key.as_deref().is_some_and(|k| !k.is_empty()),
            },
        );
    }

    Ok(Json(SttConfigGetJson {
        active_kind,
        providers: map,
        install_cmd: legacy.install_cmd,
        start_cmd: legacy.start_cmd,
        stop_cmd: legacy.stop_cmd,
    }))
}

async fn api_set_stt_config(
    State(state): State<AppState>,
    Json(req): Json<SttConfigPutJson>,
) -> Result<StatusCode, AppError> {
    let row = db::SttProviderRow {
        kind: req.kind.clone(),
        host: req.host,
        port: req.port,
        model: req.model,
        // Empty string means "keep existing" — set_stt_provider handles this.
        api_key: req.api_key,
    };
    tokio::task::spawn_blocking({
        let db = state.db.clone();
        let kind = req.kind.clone();
        move || -> anyhow::Result<()> {
            db.set_stt_provider(row)?;
            db.set_stt_active_kind(&kind)?;
            // Also update the legacy stt_config row so install/start/stop handlers
            // continue to work without migration.
            let provider = db
                .stt_provider(&kind)?
                .unwrap_or_else(|| db::SttProviderRow::default_for(&kind));
            let legacy = db.stt_config()?;
            db.set_stt_config(db::SttConfig {
                kind: kind.clone(),
                url: provider.transcription_url(),
                model: provider.model,
                api_key: provider.api_key,
                install_cmd: legacy.install_cmd,
                start_cmd: legacy.start_cmd,
                stop_cmd: legacy.stop_cmd,
            })?;
            Ok(())
        }
    })
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!("spawn_blocking: {e}")))?
    .map_err(AppError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn api_stt_status(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let (cfg, provider_cfg, active_kind_str) = tokio::task::spawn_blocking({
        let db = state.db.clone();
        move || -> anyhow::Result<_> {
            let cfg = db.stt_config()?;
            let kind = db.stt_active_kind()?;
            let row = db
                .stt_provider(&kind)?
                .unwrap_or_else(|| db::SttProviderRow::default_for(&kind));
            let provider_cfg = transcribe::ProviderConfig {
                url: row.transcription_url(),
                model: row.model,
                api_key: row.api_key,
            };
            Ok((cfg, provider_cfg, kind))
        }
    })
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!("spawn_blocking: {e}")))?
    .map_err(AppError::internal)?;

    // Probes the real transcribe endpoint, not just /health — see
    // transcribe::probe_transcribe for why a health ping alone is a false
    // green.
    let reachable = transcribe::probe_transcribe(&provider_cfg).await;
    let active_url = provider_cfg.url;

    // Check whether the mobux-stt podman container is running.
    let local_process_running = tokio::process::Command::new("podman")
        .args([
            "ps",
            "--filter",
            "name=^mobux-stt$",
            "--filter",
            "status=running",
            "--format",
            "{{.Names}}",
        ])
        .output()
        .await
        .map(|o| !o.stdout.trim_ascii().is_empty())
        .unwrap_or(false);

    let installed = state.data_dir.join("stt").join(".installed").exists();

    let (install_phase, install_error, install_output) = {
        let guard = state.stt_install.lock().await;
        let (phase_str, error) = phase_parts(&guard.phase);
        (phase_str, error, guard.output_tail.clone())
    };

    let mut body = json!({
        "kind": active_kind_str,
        "url": active_url,
        "reachable": reachable,
        "local_process_running": local_process_running,
        "installed": installed,
        "install_phase": install_phase,
        "install_output": install_output,
    });
    let _ = cfg; // kept for install_cmd/start_cmd/stop_cmd indirectly; suppress unused
    if let Some(err) = install_error {
        body["install_error"] = serde_json::Value::String(err);
    }
    Ok(Json(body))
}

async fn api_stt_install(State(state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    {
        let mut guard = state.stt_install.lock().await;
        if guard.phase.is_active() {
            return Ok((
                StatusCode::CONFLICT,
                Json(json!({"status": "already_running"})),
            ));
        }
        guard.phase = InstallPhase::Running;
        guard.output_tail.clear();
    }

    let install_state = state.stt_install.clone();
    let db = state.db.clone();

    tokio::spawn(async move {
        // Read install_cmd from db.
        let cfg = tokio::task::spawn_blocking({
            let db = db.clone();
            move || db.stt_config()
        })
        .await;

        let cmd_str = match cfg {
            Ok(Ok(c)) => match c.install_cmd {
                Some(s) => stt_scripts::resolve(&s, stt_scripts::INSTALL_SCRIPT),
                None => {
                    let mut guard = install_state.lock().await;
                    guard.phase = InstallPhase::Failed("no install_cmd configured".to_string());
                    return;
                }
            },
            Ok(Err(e)) => {
                let mut guard = install_state.lock().await;
                guard.phase = InstallPhase::Failed(format!("db error: {e}"));
                return;
            }
            Err(e) => {
                let mut guard = install_state.lock().await;
                guard.phase = InstallPhase::Failed(format!("spawn_blocking error: {e}"));
                return;
            }
        };

        let mut command = tokio::process::Command::new("sh");
        command.arg("-c").arg(&cmd_str);
        run_streaming_job(install_state, command).await;
    });

    Ok((StatusCode::ACCEPTED, Json(json!({"status": "started"}))))
}

async fn api_stt_install_status(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let guard = state.stt_install.lock().await;
    let (phase_str, error) = phase_parts(&guard.phase);
    Ok(Json(json!({
        "phase": phase_str,
        "output": guard.output_tail,
        "error": error,
    })))
}

// ── /api/install/apk: build the Android package from the UI ───────────
//
// `make twa` only exists in a source checkout, and the installed binary runs
// with the user's home as its working directory, so the install page can't
// send anyone to a terminal. These two endpoints mirror the STT install pair:
// one build at a time, phase plus rolling output tail polled by the SPA.
//
// The toolchain the build needs is installed by the build itself when it is
// absent, as a pre-phase with its own phase name. The exception is the handful
// of OS packages that pre-phase shells out to: nothing user-local can supply
// those, so the button checks for them up front and hands back the one command
// that installs them rather than dying minutes into a download.

async fn api_install_apk_build(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|h| h.to_str().ok());
    let domain = match twa::resolve_domain(Some(state.config.app.domain.as_str()), host) {
        Ok(d) => d,
        Err(e) => {
            return Ok((
                StatusCode::BAD_REQUEST,
                Json(json!({"status": "invalid_domain", "error": e})),
            )
                .into_response())
        }
    };

    // Claiming the job and rejecting a concurrent start happen under one lock
    // hold: releasing it between the two lets two simultaneous POSTs both pass
    // the check and start a build over the same working directory.
    {
        let mut guard = state.twa_build.lock().await;
        if guard.phase.is_active() {
            return Ok((
                StatusCode::CONFLICT,
                Json(json!({"status": "already_running", "domain": domain})),
            )
                .into_response());
        }
        guard.phase = InstallPhase::Running;
        guard.output_tail = vec![format!("Preparing the Android package for {domain}")];
        guard.missing_host_packages = None;
    }

    // Nothing may await between the claim above and this spawn: axum drops a
    // handler future when the client disconnects, and a drop mid-await would
    // strand the claim on a job that never started. Everything the build needs
    // to work out — materialising the scripts, detecting the toolchain — the
    // job does for itself and reports through the status endpoint.
    let job = state.twa_build.clone();
    let work_dir = twa::work_dir(&state.data_dir);
    let data_dir = state.data_dir.clone();
    let install_dir = state.data_dir.join("install");
    let wellknown_dir = state.data_dir.join(".well-known");
    let build_domain = domain.clone();
    tokio::spawn(async move {
        let scripts = match twa::materialize(&data_dir) {
            Ok(s) => s,
            Err(e) => {
                let mut guard = job.lock().await;
                guard.phase = InstallPhase::Failed(format!("{e:#}"));
                return;
            }
        };

        let toolchain_present = {
            let build = scripts.build.clone();
            tokio::task::spawn_blocking(move || twa::toolchain_present(&build))
                .await
                .unwrap_or(false)
        };

        if !toolchain_present {
            let missing = twa::missing_host_packages_on_path();
            if !missing.is_empty() {
                record_host_package_gap(&job, twa::host_package_gap(&missing)).await;
                return;
            }
        }

        let setup = (!toolchain_present).then(|| {
            let mut command = tokio::process::Command::new("bash");
            command
                .arg(&scripts.setup)
                .current_dir(&work_dir)
                .stdin(std::process::Stdio::null());
            command
        });
        let mut build = tokio::process::Command::new("bash");
        build
            .arg(&scripts.build)
            .current_dir(&work_dir)
            .stdin(std::process::Stdio::null())
            .env("MOBUX_DOMAIN", &build_domain)
            .env("TWA_WORK_DIR", &work_dir)
            .env("TWA_INSTALL_DIR", &install_dir)
            .env("TWA_WELLKNOWN_DIR", &wellknown_dir);
        run_twa_build_job(job, setup, build).await;
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({"status": "started", "domain": domain})),
    )
        .into_response())
}

async fn api_install_apk_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|h| h.to_str().ok());
    let domain = twa::resolve_domain(Some(state.config.app.domain.as_str()), host);

    let guard = state.twa_build.lock().await;
    let (phase_str, error) = phase_parts(&guard.phase);
    let gap = guard.missing_host_packages.as_ref();
    Ok(Json(json!({
        "phase": phase_str,
        "output": guard.output_tail,
        "error": error,
        "missing_host_packages": gap.map(|g| g.packages.clone()),
        "install_command": gap.map(|g| g.install_command.clone()),
        "apk_available": twa::resolve_artifact(
            twa::apk_path(&state.data_dir),
            twa::CHECKOUT_APK_PATH,
        )
        .is_file(),
        "domain": domain.as_deref().ok(),
        "domain_error": domain.err(),
    })))
}

async fn api_stt_start(State(state): State<AppState>) -> Result<StatusCode, AppError> {
    let cfg = tokio::task::spawn_blocking({
        let db = state.db.clone();
        move || db.stt_config()
    })
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!("spawn_blocking: {e}")))?
    .map_err(AppError::internal)?;

    let cmd_str = cfg
        .start_cmd
        .ok_or_else(|| AppError::bad_request(anyhow::anyhow!("no start_cmd configured")))?;
    let cmd_str = stt_scripts::resolve(&cmd_str, stt_scripts::SERVE_SCRIPT);

    tokio::process::Command::new("sh")
        .arg("-c")
        .arg(&cmd_str)
        .spawn()
        .map_err(|e| AppError::internal(anyhow::anyhow!("spawn start: {e}")))?
        .wait()
        .await
        .map_err(|e| AppError::internal(anyhow::anyhow!("start cmd failed: {e}")))?;

    Ok(StatusCode::NO_CONTENT)
}

async fn api_stt_stop(State(state): State<AppState>) -> Result<StatusCode, AppError> {
    let cfg = tokio::task::spawn_blocking({
        let db = state.db.clone();
        move || db.stt_config()
    })
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!("spawn_blocking: {e}")))?
    .map_err(AppError::internal)?;

    let cmd_str = cfg
        .stop_cmd
        .ok_or_else(|| AppError::bad_request(anyhow::anyhow!("no stop_cmd configured")))?;
    let cmd_str = stt_scripts::resolve(&cmd_str, stt_scripts::STOP_SCRIPT);

    tokio::process::Command::new("sh")
        .arg("-c")
        .arg(&cmd_str)
        .spawn()
        .map_err(|e| AppError::internal(anyhow::anyhow!("spawn stop: {e}")))?
        .wait()
        .await
        .map_err(|e| AppError::internal(anyhow::anyhow!("stop cmd failed: {e}")))?;

    Ok(StatusCode::NO_CONTENT)
}

async fn api_stt_models(
    State(state): State<AppState>,
    Query(q): Query<SttModelsQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    use std::time::Duration;

    let fallback_for_kind = |kind: &str| -> Vec<String> {
        if kind == "openai" {
            vec![
                "whisper-1".to_string(),
                "gpt-4o-transcribe".to_string(),
                "gpt-4o-mini-transcribe".to_string(),
            ]
        } else {
            vec![
                "Systran/faster-whisper-small".to_string(),
                "Systran/faster-whisper-small.en".to_string(),
                "Systran/faster-whisper-medium.en".to_string(),
            ]
        }
    };

    let (base_url, api_key, kind) = if q.host.as_deref().map(|h| !h.is_empty()).unwrap_or(false) {
        // Front-end supplied explicit host+port — use them.  The api_key comes
        // from the per-kind stored row so the frontend doesn't need to round-trip it.
        let raw_host = q.host.as_deref().unwrap_or("").trim_end_matches('/');
        // Normalize: add http:// if no scheme so reqwest gets a valid URL.
        let host = if raw_host.contains("://") {
            raw_host.to_string()
        } else {
            format!("http://{}", raw_host)
        };
        let port = q.port.as_deref().unwrap_or("");
        let base = if port.is_empty() {
            host
        } else {
            format!("{}:{}", host, port)
        };
        let k = q.kind.clone().unwrap_or_default();
        let api_key = if k == "openai" {
            let kc = k.clone();
            tokio::task::spawn_blocking({
                let db = state.db.clone();
                move || db.stt_provider(&kc)
            })
            .await
            .map_err(|e| AppError::internal(anyhow::anyhow!("spawn_blocking: {e}")))?
            .map_err(AppError::internal)?
            .and_then(|r| r.api_key)
            .filter(|k| !k.is_empty())
        } else {
            None
        };
        (base, api_key, k)
    } else {
        // No explicit host — use the active kind's stored settings.
        tokio::task::spawn_blocking({
            let db = state.db.clone();
            move || -> anyhow::Result<_> {
                let kind = db.stt_active_kind()?;
                let row = db
                    .stt_provider(&kind)?
                    .unwrap_or_else(|| db::SttProviderRow::default_for(&kind));
                let base = {
                    let raw = row.host.trim_end_matches('/');
                    // Normalize: add http:// if no scheme so reqwest gets a valid URL.
                    let h = if raw.contains("://") {
                        raw.to_string()
                    } else {
                        format!("http://{}", raw)
                    };
                    if row.port.is_empty() {
                        h
                    } else {
                        format!("{}:{}", h, row.port)
                    }
                };
                let key = row.api_key.filter(|k| !k.is_empty());
                Ok((base, key, kind))
            }
        })
        .await
        .map_err(|e| AppError::internal(anyhow::anyhow!("spawn_blocking: {e}")))?
        .map_err(AppError::internal)?
    };

    if base_url.is_empty() {
        return Ok(Json(serde_json::json!({
            "models": fallback_for_kind(&kind)
        })));
    }

    let models_url = format!("{}/v1/models", base_url.trim_end_matches('/'));
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            return Ok(Json(
                serde_json::json!({ "models": fallback_for_kind(&kind) }),
            ));
        }
    };

    let mut req = client.get(&models_url);
    if let Some(key) = &api_key {
        req = req.bearer_auth(key);
    }

    let ids: Vec<String> = match req.send().await {
        Ok(resp) if resp.status().is_success() => resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("data").cloned())
            .and_then(|d| d.as_array().cloned())
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m.get("id").and_then(|id| id.as_str()).map(String::from))
                    .collect()
            })
            .filter(|v: &Vec<String>| !v.is_empty())
            .unwrap_or_else(|| fallback_for_kind(&kind)),
        _ => fallback_for_kind(&kind),
    };

    Ok(Json(serde_json::json!({ "models": ids })))
}

#[derive(Debug)]
struct AppError {
    status: StatusCode,
    message: String,
}

impl AppError {
    fn bad_request(err: anyhow::Error) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: err.to_string(),
        }
    }

    fn internal(err: anyhow::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: err.to_string(),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.status, self.message).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── ws attach log line: client-controlled fields are escaped/bounded ────
    //
    // `node` and `build` come straight off the query string, so a value
    // containing `\n` or `"` must not be able to inject fake-looking journal
    // lines — `{:?}` escaping (matching session/user_agent) turns it back
    // into a single, clearly-quoted line. `build` also has no format
    // constraint (unlike session, bounded by session_name_re), so it's
    // length-capped separately.
    #[test]
    fn ws_attach_log_line_escapes_newlines_in_node_and_build() {
        let line = format_ws_attach_line(
            "ok",
            "mysession",
            Some("devbox\n[ws attach] ok session=\"forged\""),
            "local",
            Some("abcd\nEVIL"),
            "serverhash",
            "curl/8.0",
        );
        // Exactly one line — nothing after the escaped node/build value
        // reintroduces a real newline into the journal.
        assert_eq!(line.lines().count(), 1);
        assert!(line.contains(r#"node=Some("devbox\n[ws attach]"#));
        assert!(line.contains(r#"build=Some("abcd\nEVIL")"#));
    }

    #[test]
    fn ws_attach_log_line_absent_node_and_build_render_none() {
        let line = format_ws_attach_line(
            "ok",
            "mysession",
            None,
            "local",
            None,
            "serverhash",
            "curl/8.0",
        );
        assert!(line.contains("node=None"));
        assert!(line.contains("build=None"));
    }

    #[test]
    fn ws_attach_log_line_truncates_oversized_build() {
        let huge = "x".repeat(10_000);
        let line = format_ws_attach_line(
            "ok",
            "mysession",
            None,
            "local",
            Some(&huge),
            "serverhash",
            "curl/8.0",
        );
        assert!(
            line.len() < 500,
            "an oversized build param must not produce an unbounded log line: {} bytes",
            line.len()
        );
    }

    #[test]
    fn truncate_for_log_cuts_on_char_boundary() {
        // Each "é" is 2 UTF-8 bytes; a byte-index cut here would panic or
        // split a codepoint. Truncating to 3 *characters* must land cleanly.
        let s = "éééé";
        assert_eq!(truncate_for_log(s, 3), "ééé");
    }

    // ── UI preferences validation (write) vs normalization (read) ───────────
    //
    // A PUT with a garbage enum value must 400, not silently clamp — the
    // client made a mistake and should see it. A row read back (including one
    // written before validation existed, or hand-edited) must never brick
    // boot, so the read path stays tolerant.
    #[test]
    fn set_ui_preferences_rejects_invalid_renderer() {
        let bad = UiPrefsJson {
            renderer: "bogus".to_string(),
            theme: "nord".to_string(),
            default_view: "xterm".to_string(),
            osc133_hint_dismissed: false,
            listen_voice: String::new(),
            listen_rate: 1.0,
            listen_pitch: 1.0,
            selected_node: String::new(),
        };
        let err = bad.validate().expect_err("bogus renderer must be rejected");
        assert!(
            err.contains("renderer"),
            "error should name the field: {err}"
        );
    }

    #[test]
    fn set_ui_preferences_rejects_invalid_default_view() {
        let bad = UiPrefsJson {
            renderer: "xterm".to_string(),
            theme: "nord".to_string(),
            default_view: "bogus".to_string(),
            osc133_hint_dismissed: false,
            listen_voice: String::new(),
            listen_rate: 1.0,
            listen_pitch: 1.0,
            selected_node: String::new(),
        };
        let err = bad
            .validate()
            .expect_err("bogus default_view must be rejected");
        assert!(
            err.contains("default_view"),
            "error should name the field: {err}"
        );
    }

    #[test]
    fn set_ui_preferences_accepts_valid_enums_and_clamps_numerics() {
        let ok = UiPrefsJson {
            renderer: "sterk".to_string(),
            theme: "nord".to_string(),
            default_view: "reader".to_string(),
            osc133_hint_dismissed: true,
            listen_voice: "Daniel".to_string(),
            listen_rate: 99.0,  // out of range: clamped, not rejected
            listen_pitch: -5.0, // out of range: clamped, not rejected
            selected_node: "gpu-box".to_string(),
        }
        .validate()
        .expect("valid enums must be accepted");
        assert_eq!(ok.renderer, "sterk");
        assert_eq!(ok.default_view, "reader");
        assert_eq!(ok.listen_rate, 2.0);
        assert_eq!(ok.listen_pitch, 0.5);
        assert_eq!(ok.selected_node, "gpu-box");
    }

    #[test]
    fn set_ui_preferences_accepts_read_as_a_default_view() {
        let ok = UiPrefsJson {
            renderer: "xterm".to_string(),
            theme: "nord".to_string(),
            default_view: "read".to_string(),
            osc133_hint_dismissed: false,
            listen_voice: String::new(),
            listen_rate: 1.0,
            listen_pitch: 1.0,
            selected_node: String::new(),
        }
        .validate()
        .expect("read must be accepted as a default_view");
        assert_eq!(ok.default_view, "read");

        // The read path normalises, so it has to know the value too.
        let round_tripped: UiPrefsJson = ok.into();
        assert_eq!(round_tripped.default_view, "read");
    }

    #[test]
    fn get_ui_preferences_normalizes_a_corrupt_row_instead_of_erroring() {
        // Simulates a row that predates validation (or was hand-edited) —
        // the read path must produce something the client can safely render,
        // never propagate the garbage or fail the request.
        let corrupt = db::UiPreferences {
            renderer: "not-a-real-renderer".to_string(),
            theme: "nord".to_string(),
            default_view: "not-a-real-view".to_string(),
            osc133_hint_dismissed: false,
            listen_voice: String::new(),
            listen_rate: 500.0,
            listen_pitch: -500.0,
            selected_node: String::new(),
        };
        let json: UiPrefsJson = corrupt.into();
        assert_eq!(json.renderer, "xterm");
        assert_eq!(json.default_view, "xterm");
        assert_eq!(json.listen_rate, 2.0);
        assert_eq!(json.listen_pitch, 0.5);
    }

    // ── serve_static cache headers (regression guard for the frozen-module
    // bug) ────────────────────────────────────────────────────────────────
    //
    // Static assets must be `no-store`: ES-module `import` statements use
    // bare specifiers with no `?v=` cache-buster, so any browser caching
    // (a year of `immutable` in the worst historical case) leaves stale
    // modules running after a deploy. mobux runs over a tailnet — bandwidth
    // is irrelevant, nothing should ever be cached.
    #[tokio::test]
    async fn serve_static_is_no_store() {
        use axum::http::header;
        let resp = serve_static(Path("style.css".to_string())).await;
        assert_eq!(resp.status(), StatusCode::OK);

        let cc = resp
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        assert!(
            cc.contains("no-store"),
            "static assets must be no-store, got Cache-Control: {cc:?}"
        );
        assert!(
            !cc.contains("immutable"),
            "static assets must never be immutable, got Cache-Control: {cc:?}"
        );
    }

    // Guard: if any web/static JS calls getUserMedia (mic access), the TWA
    // must declare RECORD_AUDIO, otherwise Chrome (which delegates the OS
    // permission prompt to the host app in a TWA) denies it. The committed
    // source of truth for the generated AndroidManifest.xml is twa/init.js,
    // which injects the permission on every `make twa`.
    #[test]
    fn twa_declares_record_audio_when_web_uses_getusermedia() {
        use std::fs;
        let static_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("web/static");
        let mut uses_mic = false;
        let mut stack = vec![static_dir];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().and_then(|e| e.to_str()) == Some("js") {
                    if let Ok(src) = fs::read_to_string(&path) {
                        if src.contains("getUserMedia") {
                            uses_mic = true;
                        }
                    }
                }
            }
        }

        if uses_mic {
            let init_js = fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("twa/init.js"),
            )
            .expect("twa/init.js must exist");
            assert!(
                init_js.contains("android.permission.RECORD_AUDIO"),
                "web/static uses getUserMedia but twa/init.js does not inject \
                 android.permission.RECORD_AUDIO — the TWA mic prompt will be \
                 denied at the OS layer"
            );
        }
    }

    // Guard: mobux keeps ZERO client-side persistent storage. No frontend
    // source may read or write `localStorage` or `sessionStorage`. Durable
    // state lives on the server (/api/settings/preferences); everything else is
    // plain in-memory module state for the tab's lifetime. Device-resident
    // state drifts out of sync with code changes in ways that are impossible to
    // reproduce across devices, so the ban is total.
    //
    // A blanket substring scan over first-party web sources, comments included:
    // even a mention has to be reworded, which keeps the ban obvious in the
    // source. Third-party vendor bundles (web/static/vendor) and the generated
    // SPA build output (web/static/spa) are not our source and are skipped;
    // nothing else is allowlisted.
    #[test]
    fn no_client_storage_in_web_sources() {
        use std::fs;
        const FORBIDDEN: &[&str] = &["localStorage", "sessionStorage"];

        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("web");

        let mut offenders: Vec<String> = Vec::new();
        let mut stack: Vec<std::path::PathBuf> = vec![root];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    // Skip dependencies, committed third-party bundles, and the
                    // generated SPA build output — none of it is our source.
                    // web/spa (the SPA source tree) is still scanned; only the
                    // build output at web/static/spa is dropped.
                    if name == "node_modules"
                        || path.ends_with("static/vendor")
                        || path.ends_with("static/spa")
                    {
                        continue;
                    }
                    stack.push(path);
                    continue;
                }
                let ext = path.extension().and_then(|e| e.to_str());
                if !matches!(ext, Some("js") | Some("jsx") | Some("mjs") | Some("cjs")) {
                    continue;
                }
                let Ok(src) = fs::read_to_string(&path) else {
                    continue;
                };
                for line in src.lines() {
                    for token in FORBIDDEN {
                        if line.contains(token) {
                            offenders.push(format!("{}: {}", path.display(), line.trim()));
                        }
                    }
                }
            }
        }

        assert!(
            offenders.is_empty(),
            "web sources must not use localStorage/sessionStorage — mobux keeps \
             no client-side persistent storage (durable state is server-synced \
             via /api/settings/preferences, the rest is in-memory):\n{}",
            offenders.join("\n")
        );
    }

    #[test]
    fn base64url_round_trip_p256_point() {
        // Real-world payload shape: 65-byte uncompressed P-256 point.
        let bytes: Vec<u8> = (0..65u8).collect();
        let encoded = BASE64URL.encode(&bytes);
        assert!(
            !encoded.contains('='),
            "URL_SAFE_NO_PAD must not emit padding"
        );
        assert!(
            !encoded.contains('+') && !encoded.contains('/'),
            "URL_SAFE_NO_PAD must use URL-safe alphabet"
        );
        let decoded = BASE64URL.decode(encoded).expect("round-trip decode");
        assert_eq!(decoded, bytes);
    }

    #[test]
    fn base64url_decode_rejects_bad_input() {
        // Padded input is wrong for URL_SAFE_NO_PAD: must reject.
        assert!(BASE64URL.decode("AAAA=").is_err());
        // Standard-base64 chars are also wrong here.
        assert!(BASE64URL.decode("AA+/").is_err());
    }

    #[test]
    fn decode_b64url_helper_returns_400_on_garbage() {
        let err = decode_b64url("p256dh", "!!not-valid!!").expect_err("must error");
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert!(
            err.message.contains("p256dh"),
            "error mentions field name: {}",
            err.message
        );
    }

    #[test]
    fn session_name_regex_rejects_tmux_unsafe_chars() {
        let re = Regex::new(r"^[a-zA-Z0-9_-]+$").unwrap();
        // Accepted: plain names, underscores, hyphens, digits.
        for ok in ["foo", "my_app", "build-2", "ABC", "0"] {
            assert!(re.is_match(ok), "should accept {ok:?}");
        }
        // Rejected: '.' and ':' are tmux target-spec separators (tmux
        // rewrites '.' to '_', which previously caused "can't find session"),
        // plus whitespace and empty.
        for bad in ["my.app", "a:b", "with space", ""] {
            assert!(!re.is_match(bad), "should reject {bad:?}");
        }
    }

    /// Minimal AppState backed by a throwaway temp db, with `dev_mode`
    /// configurable.
    fn test_state(dev_mode: bool) -> (AppState, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Arc::new(db::Db::open(&dir.path().join("mobux.db")).expect("open db"));
        let mut settings = config::Config::default();
        settings.tls.enabled = false;
        settings.app.dev = dev_mode;
        let state = AppState {
            session_name_re: Arc::new(Regex::new(r"^[a-zA-Z0-9_-]+$").unwrap()),
            auth: None,
            cache_bust: "test".to_string(),
            db,
            internal_token: Arc::new("test-token".to_string()),
            config: Arc::new(settings),
            data_dir: dir.path().to_path_buf(),
            config_dir: dir.path().to_path_buf(),
            update: update::UpdateState::new(String::new()),
            build_hash: "test".to_string(),
            stt_install: BackgroundJobState::idle(),
            twa_build: BackgroundJobState::idle(),
            session_history: Arc::new(session_history::SessionHistoryStore::new(dir.path())),
        };
        (state, dir)
    }

    // /api/telemetry accepts the body (204) regardless of dev mode — it's an
    // always-on diagnostic channel, not gated behind MOBUX_DEV.
    #[tokio::test]
    async fn telemetry_endpoint_active_without_dev_mode() {
        let status = api_telemetry("hello".to_string()).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }

    // ── session cookie Secure attribute ──────────────────────────────────────
    //
    // Regression test for the recurring home-login prompt: on a plain-HTTP
    // bind, `Secure` cookies are never stored by the browser, so every
    // subsequent request fell back to Basic-auth. `Secure` must be omitted on
    // HTTP and present only when TLS is actually serving.

    #[test]
    fn session_cookie_no_secure_on_plain_http() {
        let cookie = build_session_cookie("mobux_session", "abc123", false);
        assert!(
            !cookie.contains("Secure"),
            "plain-HTTP bind must not set Secure: {cookie}"
        );
        assert!(
            cookie.contains("HttpOnly"),
            "HttpOnly must always be present: {cookie}"
        );
        assert!(
            cookie.contains("SameSite=Lax"),
            "SameSite=Lax must always be present: {cookie}"
        );
    }

    #[test]
    fn session_cookie_has_secure_on_tls() {
        let cookie = build_session_cookie("mobux_session", "abc123", true);
        assert!(
            cookie.contains("Secure"),
            "TLS bind must set Secure: {cookie}"
        );
        assert!(
            cookie.contains("HttpOnly"),
            "HttpOnly must always be present: {cookie}"
        );
    }

    #[tokio::test]
    async fn stt_install_returns_409_when_already_running() {
        let (state, _dir) = test_state(false);
        {
            let mut guard = state.stt_install.lock().await;
            guard.phase = InstallPhase::Running;
        }
        let result = api_stt_install(State(state)).await;
        match result {
            Ok(resp) => {
                let resp = resp.into_response();
                assert_eq!(resp.status(), StatusCode::CONFLICT);
            }
            Err(_) => panic!("expected Ok with 409"),
        }
    }

    // ── /api/install/apk state machine ───────────────────────────────────
    //
    // The install page used to tell the user to run `make twa` in a terminal,
    // which is unreachable on the deployed instance. These cover the contract
    // the SPA drives: a start that is idempotent while a build runs, a status
    // shape it can render a phase, an output tail and a failure from, and a
    // refusal to guess a domain it can't derive.

    fn apk_build_request(host: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::HOST,
            HeaderValue::from_str(host).unwrap(),
        );
        headers
    }

    #[tokio::test]
    async fn apk_build_returns_409_while_a_build_is_running() {
        let (state, _dir) = test_state(false);
        {
            let mut guard = state.twa_build.lock().await;
            guard.phase = InstallPhase::Running;
            guard.output_tail = vec!["Building the Android package".to_string()];
        }
        let resp =
            api_install_apk_build(State(state.clone()), apk_build_request("box.example.com"))
                .await
                .expect("handler must not error");
        assert_eq!(resp.status(), StatusCode::CONFLICT);

        // The running job is left alone — its tail must survive the rejection.
        let guard = state.twa_build.lock().await;
        assert_eq!(guard.phase, InstallPhase::Running);
        assert_eq!(guard.output_tail.len(), 1);
    }

    #[tokio::test]
    async fn apk_build_rejects_a_host_it_cannot_turn_into_a_domain() {
        let (state, _dir) = test_state(false);
        let resp = api_install_apk_build(State(state.clone()), HeaderMap::new())
            .await
            .expect("handler must not error");
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            state.twa_build.lock().await.phase,
            InstallPhase::Idle,
            "a rejected request must not move the job out of idle"
        );
    }

    #[tokio::test]
    async fn apk_status_reports_phase_output_and_availability() {
        let (state, dir) = test_state(false);
        let resp = api_install_apk_status(State(state.clone()), apk_build_request("box:5151"))
            .await
            .unwrap();
        assert_eq!(resp.0["phase"], "idle");
        assert_eq!(resp.0["output"], json!([]));
        assert_eq!(resp.0["error"], serde_json::Value::Null);
        assert_eq!(resp.0["apk_available"], false);
        assert_eq!(resp.0["domain"], "box:5151");

        {
            let mut guard = state.twa_build.lock().await;
            guard.phase = InstallPhase::Failed("exit 1: bubblewrap not found".to_string());
            guard.output_tail = vec!["Building signed APK".to_string()];
        }
        let apk = twa::apk_path(dir.path());
        std::fs::create_dir_all(apk.parent().unwrap()).unwrap();
        std::fs::write(&apk, b"apk").unwrap();

        let resp = api_install_apk_status(State(state), apk_build_request("box:5151"))
            .await
            .unwrap();
        assert_eq!(resp.0["phase"], "failed");
        assert_eq!(resp.0["error"], "exit 1: bubblewrap not found");
        assert_eq!(resp.0["output"], json!(["Building signed APK"]));
        assert_eq!(resp.0["apk_available"], true);
    }

    #[tokio::test]
    async fn stt_status_installed_reflects_sentinel() {
        let (state, dir) = test_state(false);
        let resp = api_stt_status(State(state.clone())).await.unwrap();
        assert_eq!(resp.0["installed"], false);

        let stt_dir = dir.path().join("stt");
        std::fs::create_dir_all(&stt_dir).unwrap();
        std::fs::File::create(stt_dir.join(".installed")).unwrap();
        let resp2 = api_stt_status(State(state)).await.unwrap();
        assert_eq!(resp2.0["installed"], true);
    }

    // Regression: a node's stored ssh target starting with `-` (e.g.
    // `-oProxyCommand=...`) would be read by ssh's own getopt as an option
    // rather than a host argument once handed to `ssh_exec_command`
    // (tmux.rs) — executing on the HUB instead of failing to reach the
    // node. `resolve_node_target` is the one choke point every node-aware
    // route goes through, so rejecting it there covers all of them,
    // including the upload path this PR added.
    #[tokio::test]
    async fn resolve_node_target_rejects_a_target_starting_with_a_dash() {
        let (state, _dir) = test_state(false);
        state
            .db
            .replace_nodes(vec![("evil".to_string(), "-oProxyCommand=pwn".to_string())])
            .expect("seed node");

        let err = resolve_node_target(&state, Some("evil"))
            .await
            .expect_err("a leading-dash target must be rejected");
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert!(
            err.message.contains("invalid target"),
            "error names the problem: {}",
            err.message
        );
    }

    #[tokio::test]
    async fn resolve_node_target_accepts_a_normal_target() {
        let (state, _dir) = test_state(false);
        state
            .db
            .replace_nodes(vec![("devbox".to_string(), "user@devbox".to_string())])
            .expect("seed node");

        let target = resolve_node_target(&state, Some("devbox"))
            .await
            .expect("a well-formed target resolves");
        assert_eq!(target.as_deref(), Some("user@devbox"));
    }

    // sanitize_upload_filename's contract (main.rs, used by api_upload) is
    // what actually matters for the ssh path in tmux.rs::write_remote_file:
    // no shell metacharacter, quote, or control character survives, even
    // though it keeps Unicode letters (it is NOT ASCII-only [A-Za-z0-9._-]).
    #[test]
    fn sanitize_upload_filename_keeps_unicode_letters_strips_shell_metacharacters() {
        assert_eq!(sanitize_upload_filename("naïve—file.txt"), "naïve_file.txt");

        let adversarial = "$(touch PWNED);`x`\n'.txt";
        let safe = sanitize_upload_filename(adversarial);
        for dangerous in ['$', '(', ')', ';', '`', '\n', '\''] {
            assert!(
                !safe.contains(dangerous),
                "{safe:?} must not contain {dangerous:?}"
            );
        }
        assert!(safe.ends_with(".txt"));
        assert!(safe.contains("touch"));
        assert!(safe.contains("PWNED"));
    }

    #[tokio::test]
    async fn stt_models_returns_fallback_when_no_config() {
        let (state, _dir) = test_state(false);
        let q = SttModelsQuery {
            kind: None,
            host: None,
            port: None,
        };
        let result = api_stt_models(State(state), Query(q)).await;
        let Json(val) = result.expect("handler should not error");
        let models = val["models"].as_array().expect("models array");
        assert!(!models.is_empty(), "fallback models must not be empty");
    }

    #[tokio::test]
    async fn stt_models_returns_openai_fallback_for_openai_kind() {
        let (state, _dir) = test_state(false);
        let q = SttModelsQuery {
            kind: Some("openai".to_string()),
            host: Some("https://api.openai.com".to_string()),
            port: Some("443".to_string()),
        };
        let result = api_stt_models(State(state), Query(q)).await;
        let Json(val) = result.expect("handler should not error");
        let models: Vec<String> = val["models"]
            .as_array()
            .expect("models array")
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();
        assert!(!models.is_empty());
        for m in &models {
            assert!(!m.is_empty(), "model id must not be empty");
        }
    }

    // ── bare session-name resolution (issue #210) ────────────────────────────
    //
    // `resolve_session_location` is the pure decision behind `terminal_page`'s
    // `/s/{name}` redirect: given what's currently at each location, is `name`
    // findable at exactly one? Exercised directly with synthetic session
    // lists — no tmux process, no ssh — so every combination is deterministic
    // and fast. The I/O wrapper (`locate_session`, real tmux/ssh probing) is
    // covered by the fleet e2e (test/fleet/hub-proxy.spec.cjs), the only place
    // that can stand up a real second tmux server.

    fn session(name: &str) -> tmux::Session {
        tmux::Session {
            name: name.to_string(),
            windows: 1,
            attached: 0,
            created_unix: 0,
        }
    }

    #[test]
    fn resolve_session_location_unique_local_match() {
        let local = [session("mobux")];
        assert_eq!(
            resolve_session_location("mobux", &local, &[]),
            Some(SessionLocation::Local)
        );
    }

    #[test]
    fn resolve_session_location_unique_node_match() {
        let local = [session("other")];
        let devbox = [session("mobux")];
        let nodes: [(&str, &[tmux::Session]); 1] = [("devbox", &devbox)];
        assert_eq!(
            resolve_session_location("mobux", &local, &nodes),
            Some(SessionLocation::Node("devbox".to_string()))
        );
    }

    #[test]
    fn resolve_session_location_no_match_anywhere() {
        let local = [session("other")];
        let devbox = [session("also-other")];
        let nodes: [(&str, &[tmux::Session]); 1] = [("devbox", &devbox)];
        assert_eq!(resolve_session_location("mobux", &local, &nodes), None);
    }

    #[test]
    fn resolve_session_location_ambiguous_local_and_node_is_not_a_tiebreak() {
        // Same name local AND on a node — must not default to local.
        let local = [session("mobux")];
        let devbox = [session("mobux")];
        let nodes: [(&str, &[tmux::Session]); 1] = [("devbox", &devbox)];
        assert_eq!(resolve_session_location("mobux", &local, &nodes), None);
    }

    #[test]
    fn resolve_session_location_ambiguous_across_two_nodes() {
        let local: [tmux::Session; 0] = [];
        let alpha = [session("mobux")];
        let beta = [session("mobux")];
        let nodes: [(&str, &[tmux::Session]); 2] = [("alpha", &alpha), ("beta", &beta)];
        assert_eq!(resolve_session_location("mobux", &local, &nodes), None);
    }

    #[test]
    fn resolve_session_location_ignores_other_names_on_other_locations() {
        // A node having ITS OWN unrelated session named differently must not
        // affect resolving a distinct name that's only local.
        let local = [session("mobux")];
        let devbox = [session("unrelated")];
        let nodes: [(&str, &[tmux::Session]); 1] = [("devbox", &devbox)];
        assert_eq!(
            resolve_session_location("mobux", &local, &nodes),
            Some(SessionLocation::Local)
        );
    }

    // Regression for the "wedged node" hang: `ConnectTimeout=3` bounds SSH's
    // own connection/handshake setup, but NOT what happens once a remote
    // command is actually running — a node whose sshd accepts fine but whose
    // shell startup or tmux then hangs (a wedged `$HOME`, a dead NFS mount)
    // would otherwise block `tmux list-sessions` — and every `/s/{name}`
    // request with it — indefinitely. Exercised against a synthetic
    // never-resolving future (via `with_probe_timeout`, the seam
    // `probe_sessions_or_absent` is built on) rather than a real hung
    // ssh/tmux process, which isn't reliably reproducible in a unit test.
    #[tokio::test]
    async fn probe_timeout_cuts_off_a_future_that_never_resolves() {
        let start = std::time::Instant::now();
        let result: Option<()> = with_probe_timeout(async {
            tokio::time::sleep(SESSION_PROBE_TIMEOUT * 10).await;
            Ok(())
        })
        .await;
        let elapsed = start.elapsed();

        assert_eq!(result, None, "a hung future must count as absent");
        assert!(
            elapsed < SESSION_PROBE_TIMEOUT + std::time::Duration::from_millis(500),
            "must not wait past its own timeout: took {elapsed:?}",
        );
    }

    // A DB read failure is NOT "no nodes configured" — degrading to that
    // (via an `unwrap_or_default()`-style swallow) would silently narrow an
    // ambiguous local+node session down to a false unique-local match,
    // exactly the bug this route exists to prevent. It must propagate as a
    // hard error instead.
    #[tokio::test]
    async fn terminal_page_errors_when_the_node_inventory_cannot_be_read() {
        let (state, dir) = test_state(false);
        {
            let conn = rusqlite::Connection::open(dir.path().join("mobux.db"))
                .expect("raw open of the same sqlite file");
            conn.execute("DROP TABLE nodes", [])
                .expect("drop nodes table to force list_nodes() to fail");
        }
        let result = terminal_page(State(state), Path("whatever".to_string())).await;
        match result {
            Err(e) => assert_eq!(e.status, StatusCode::INTERNAL_SERVER_ERROR),
            Ok(_) => panic!("expected an error when the node inventory can't be read"),
        }
    }

    // The dev flag is exposed via /api/build-info for any other dev-only
    // behavior the SPA needs (it no longer gates client telemetry, which is
    // always on).
    #[tokio::test]
    async fn build_info_reflects_dev_mode() {
        let (state, _dir) = test_state(true);
        let Json(val) = api_build_info(State(state)).await;
        assert_eq!(val["dev_mode"], true);

        let (state, _dir) = test_state(false);
        let Json(val) = api_build_info(State(state)).await;
        assert_eq!(val["dev_mode"], false);
    }

    // ── TWA build: the toolchain pre-phase ────────────────────────────────
    //
    // The install page's button has to work on a host that never had the
    // Android toolchain, so the build runs the toolchain install first and
    // continues into the package build without a second press. These drive
    // the sequencing with stub scripts — no SDK, no downloads.

    #[cfg(unix)]
    fn stub_script(dir: &std::path::Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/bash\nset -eu\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    fn stub_command(script: &std::path::Path, log: &std::path::Path) -> tokio::process::Command {
        let mut command = tokio::process::Command::new("bash");
        command.arg(script).env("STUB_LOG", log);
        command
    }

    #[cfg(unix)]
    async fn await_phase(job: &Arc<tokio::sync::Mutex<BackgroundJobState>>, want: &InstallPhase) {
        for _ in 0..500 {
            if job.lock().await.phase == *want {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("job never reached {want:?}");
    }

    #[cfg(unix)]
    fn stub_log(path: &std::path::Path) -> String {
        std::fs::read_to_string(path).unwrap_or_default()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_missing_toolchain_is_installed_before_the_build_runs() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("log");
        let release = dir.path().join("release");
        let setup = stub_script(
            dir.path(),
            "setup",
            &format!(
                "echo setup >> \"$STUB_LOG\"\nwhile [ ! -f '{}' ]; do sleep 0.01; done",
                release.display()
            ),
        );
        let build = stub_script(dir.path(), "build", "echo build >> \"$STUB_LOG\"");

        let job = BackgroundJobState::idle();
        let handle = tokio::spawn(run_twa_build_job(
            job.clone(),
            Some(stub_command(&setup, &log)),
            stub_command(&build, &log),
        ));

        await_phase(&job, &InstallPhase::InstallingTools).await;
        assert_eq!(stub_log(&log), "setup\n", "the build must wait for setup");
        assert!(InstallPhase::InstallingTools.is_active());
        assert_eq!(
            phase_parts(&InstallPhase::InstallingTools).0,
            "installing_tools"
        );

        std::fs::write(&release, b"go").unwrap();
        handle.await.unwrap();

        let guard = job.lock().await;
        assert_eq!(guard.phase, InstallPhase::Success);
        assert_eq!(stub_log(&log), "setup\nbuild\n");
        assert!(
            guard
                .output_tail
                .iter()
                .any(|l| l.contains("Installing the Android build tools")),
            "the tail must name the wait: {:?}",
            guard.output_tail
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_installed_toolchain_skips_the_install_phase() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("log");
        let build = stub_script(dir.path(), "build", "echo build >> \"$STUB_LOG\"");

        let job = BackgroundJobState::idle();
        run_twa_build_job(job.clone(), None, stub_command(&build, &log)).await;

        let guard = job.lock().await;
        assert_eq!(guard.phase, InstallPhase::Success);
        assert_eq!(stub_log(&log), "build\n");
        assert!(
            !guard
                .output_tail
                .iter()
                .any(|l| l.contains("Installing the Android build tools")),
            "nothing to install, so nothing to announce: {:?}",
            guard.output_tail
        );
    }

    #[test]
    fn job_output_drops_the_colour_the_scripts_log_with() {
        assert_eq!(
            strip_ansi("\u{1b}[1;34m[setup-twa]\u{1b}[0m Installing SDKMAN"),
            "[setup-twa] Installing SDKMAN"
        );
        assert_eq!(
            strip_ansi("\u{1b}]0;a title\u{7}plain"),
            "plain",
            "window-title sequences must not leak into the log pane"
        );
        assert_eq!(strip_ansi("no escapes here"), "no escapes here");
    }

    /// The install page reads the packages and the command off the status
    /// endpoint, so a stopped build has to carry both.
    #[tokio::test]
    async fn a_host_package_gap_is_reported_through_the_status_endpoint() {
        let (state, _dir) = test_state(false);
        record_host_package_gap(
            &state.twa_build,
            twa::host_package_gap_with(Some(twa::PackageManager::Apt), &["unzip", "zip"]),
        )
        .await;

        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::HOST,
            "box.example.com".parse().expect("host header"),
        );
        let Json(body) = api_install_apk_status(State(state), headers)
            .await
            .expect("status");

        assert_eq!(body["phase"], "failed");
        assert_eq!(body["missing_host_packages"], json!(["unzip", "zip"]));
        assert_eq!(body["install_command"], "sudo apt-get install -y unzip zip");
        assert!(body["error"]
            .as_str()
            .expect("an error message")
            .contains("unzip and zip"));
    }

    /// One build at a time, and the toolchain pre-phase holds the claim too —
    /// a second press during a ten-minute SDK download must not start a
    /// second install over the same directories.
    #[tokio::test]
    async fn a_press_during_the_toolchain_install_gets_the_running_state() {
        let (state, _dir) = test_state(false);
        state.twa_build.lock().await.phase = InstallPhase::InstallingTools;

        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::HOST,
            "box.example.com".parse().expect("host header"),
        );
        let response = api_install_apk_build(State(state.clone()), headers)
            .await
            .expect("build response");

        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            state.twa_build.lock().await.phase,
            InstallPhase::InstallingTools,
            "the refused press must not disturb the running job"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_toolchain_install_stops_before_the_build() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("log");
        let setup = stub_script(dir.path(), "setup", "echo 'no unzip' >&2\nexit 3");
        let build = stub_script(dir.path(), "build", "echo build >> \"$STUB_LOG\"");

        let job = BackgroundJobState::idle();
        run_twa_build_job(
            job.clone(),
            Some(stub_command(&setup, &log)),
            stub_command(&build, &log),
        )
        .await;

        let guard = job.lock().await;
        match &guard.phase {
            InstallPhase::Failed(e) => {
                assert!(e.contains("installing the build tools failed"), "{e}");
                assert!(e.contains("no unzip"), "{e}");
            }
            other => panic!("expected a failure, got {other:?}"),
        }
        assert_eq!(stub_log(&log), "", "the build must not run");
    }
}
