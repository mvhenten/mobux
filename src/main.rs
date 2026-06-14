use std::{
    env,
    io::{Read, Write},
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result};
use axum::{
    extract::{ws::Message, Path, State, WebSocketUpgrade},
    http::{
        header::{AUTHORIZATION, WWW_AUTHENTICATE},
        HeaderMap, HeaderValue, Request, StatusCode,
    },
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{any, delete, get, post},
    Extension, Json, Router,
};
use base64::{
    engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD as BASE64URL},
    Engine,
};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
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

mod db;
mod mesh;
mod push;
mod relay;
mod shell_integration;
mod ssl;
mod tmux;
mod transcribe;
mod update;

#[derive(Clone, Debug, PartialEq)]
enum InstallPhase {
    Idle,
    Running,
    Success,
    Failed(String),
}

struct SttInstallState {
    phase: InstallPhase,
    output_tail: Vec<String>,
}

#[derive(Clone)]
struct AppState {
    session_name_re: Arc<Regex>,
    auth: Option<AuthConfig>,
    cache_bust: String,
    db: Arc<db::Db>,
    /// Handle to a locally-spawned STT server process (local provider only).
    stt_child: Arc<tokio::sync::Mutex<Option<tokio::process::Child>>>,
    /// Bearer-equivalent secret that the tmux `alert-bell` hook posts back
    /// with on the internal trigger endpoint. Generated fresh on every
    /// startup; the hook is reinstalled with the new value.
    internal_token: Arc<String>,
    /// The TCP port this instance serves on. Mesh peer probing dials peers on
    /// the same port (the EDD assumes a homogeneous mobux port across nodes).
    port: u16,
    /// Where mobux persists state — used to write/spawn the detached updater.
    data_dir: PathBuf,
    /// Whether this instance serves over TLS — the updater health-checks
    /// `/api/identify` on the matching scheme.
    use_tls: bool,
    /// In-memory cache of the latest crates.io version (self-update, #130).
    update: update::UpdateState,
    /// Dev-mode flag (set via `MOBUX_DEV=1`). OFF in production. Gates the
    /// dev-only client telemetry channel: when false, `/api/telemetry` is a
    /// no-op 404 and the frontend is told (`window.MOBUX_DEV=false`) not to
    /// post or render its overlay.
    dev_mode: bool,
    /// Tracks background STT install state (phase + rolling output tail).
    stt_install: Arc<tokio::sync::Mutex<SttInstallState>>,
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
    // Multiple deps now pull rustls (axum-server tls, instant-acme, reqwest);
    // each enables its own crypto backend feature, so rustls cannot pick one
    // automatically. Install aws-lc-rs explicitly to match axum-server's
    // TLS path that actually serves traffic.
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .map_err(|_| anyhow::anyhow!("failed to install rustls crypto provider"))?;

    let auth = load_auth_config();
    let data_dir = resolve_data_dir()?;
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

    let port = env::var("PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(8080);

    let use_tls = env::var("MOBUX_TLS")
        .map(|v| v != "0" && v.to_lowercase() != "false")
        .unwrap_or(true);

    // Dev-mode toggle. OFF unless MOBUX_DEV is set to a truthy value (the
    // `mobux-dev.service` unit sets `MOBUX_DEV=1`). Gates the dev-only client
    // telemetry channel; absent/inert in production.
    let dev_mode = env::var("MOBUX_DEV")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    let update_state = update::UpdateState::new();
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
        stt_child: Arc::new(tokio::sync::Mutex::new(None)),
        internal_token: Arc::new(internal_token),
        port,
        data_dir: data_dir.clone(),
        use_tls,
        update: update_state,
        dev_mode,
        stt_install: Arc::new(tokio::sync::Mutex::new(SttInstallState {
            phase: InstallPhase::Idle,
            output_tail: vec![],
        })),
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
        .route("/", get(index))
        .route("/api/identify", get(api_identify))
        .route("/api/peers", get(api_peers))
        .route("/api/sessions", get(api_sessions).post(api_create_session))
        .route("/api/sessions/{name}/kill", post(api_kill_session))
        .route("/api/sessions/{name}/rename", post(api_rename_session))
        .route("/api/sessions/{name}/panes", get(api_list_panes))
        .route(
            "/api/sessions/{name}/panes/{pane}/select",
            post(api_select_pane),
        )
        .route("/api/sessions/{name}/history", get(api_session_history))
        .route("/api/sessions/{name}/command", post(api_tmux_command))
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
            "/api/settings/stt",
            get(api_get_stt_config).put(api_set_stt_config),
        )
        .route("/api/stt/status", get(api_stt_status))
        .route(
            "/api/stt/install",
            post(api_stt_install).layer(axum::extract::DefaultBodyLimit::max(1024)),
        )
        .route("/api/stt/install/status", get(api_stt_install_status))
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
        // Self-update (#130). Plain /api routes so they ride the mesh relay —
        // any node is updatable from one UI.
        .route("/api/update/status", get(api_update_status))
        .route("/api/update/check", post(api_update_check))
        .route("/api/update/run", post(api_update_run))
        // Mesh relay (EDD phase 2). The WS route is more specific than the
        // catch-all HTTP relay so the upgrade lands on the right handler.
        .route("/r/{peer}/ws/{*rest}", get(relay::relay_ws))
        .route("/r/{peer}/{*rest}", any(relay::relay_http))
        .route("/api/peers/{peer}/pin", delete(relay::delete_peer_pin))
        .route("/settings", get(settings_page))
        .route("/s/{name}", get(terminal_page))
        // Host-pinned terminal page (issue #123): the peer the session lives
        // on is canonical in the path so the page binds to the right host
        // regardless of the global host-picker selection. The server does NOT
        // route by host (the relay still does) — it only surfaces the host to
        // the client so it can pin the peer. One- vs two-segment patterns
        // disambiguate cleanly in axum.
        .route("/s/{host}/{name}", get(terminal_page_pinned))
        .route("/ws/{name}", get(terminal_ws))
        .route("/sw.js", get(serve_sw))
        .route("/install", get(install_page))
        .route("/install/mobux.apk", get(serve_install_apk))
        .route("/install/mobux-ca.crt", get(serve_install_ca))
        .route("/.well-known/assetlinks.json", get(serve_assetlinks))
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
        println!("auth: disabled (set MOBUX_AUTH_USER/MOBUX_AUTH_PASS or MOBUX_PIN)");
    }

    if state.dev_mode {
        println!("dev mode: ON (MOBUX_DEV) — /api/telemetry active, logs to stderr");
    }

    if use_tls {
        let extra_hosts: Vec<String> = env::var("MOBUX_TLS_HOSTS")
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        let (cert_path, key_path) = match (env::var("MOBUX_CERT_FILE"), env::var("MOBUX_KEY_FILE"))
        {
            (Ok(c), Ok(k)) => {
                eprintln!("[ssl] Using provided cert: {c}, key: {k}");
                (std::path::PathBuf::from(c), std::path::PathBuf::from(k))
            }
            _ => {
                // ACME mode needs the HTTP-01 route reachable BEFORE the order
                // runs, so spin up a tiny HTTP-only server first. Same server
                // stays up for renewals.
                let challenges = if ssl::acme_mode_enabled() {
                    let c = ssl::new_acme_challenges();
                    spawn_acme_http_server(c.clone()).await?;
                    Some(c)
                } else {
                    None
                };
                let paths = ssl::ensure_certs(&extra_hosts, challenges).await?;
                (paths.cert, paths.key)
            }
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

fn resolve_data_dir() -> Result<PathBuf> {
    if let Some(override_dir) = env::var_os("MOBUX_DATA_DIR") {
        let path = PathBuf::from(override_dir);
        if path.as_os_str().is_empty() {
            return Err(anyhow::anyhow!("MOBUX_DATA_DIR is set but empty"));
        }
        return Ok(path);
    }
    let dirs = directories::ProjectDirs::from("", "", "mobux")
        .ok_or_else(|| anyhow::anyhow!("could not resolve user home directory for data dir"))?;
    Ok(dirs.data_dir().to_path_buf())
}

/// Bind a tiny HTTP-only axum server that serves
/// `/.well-known/acme-challenge/{token}`. Only used in ACME mode. Port comes
/// from `MOBUX_ACME_HTTP_PORT` (default 80).
async fn spawn_acme_http_server(challenges: ssl::AcmeChallenges) -> Result<()> {
    let port: u16 = env::var("MOBUX_ACME_HTTP_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(80);
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
fn ensure_session_cookie_value() -> String {
    let path = ssl::config_dir().join("session-cookie");
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

fn load_auth_config() -> Option<AuthConfig> {
    let user_env = env::var("MOBUX_AUTH_USER")
        .ok()
        .map(|v| v.trim().to_string());
    let pass_env = env::var("MOBUX_AUTH_PASS")
        .ok()
        .map(|v| v.trim().to_string());
    let pin_env = env::var("MOBUX_PIN").ok().map(|v| v.trim().to_string());

    let session_cookie_name = "mobux_session".to_string();
    let session_cookie_value = ensure_session_cookie_value();

    match (user_env, pass_env, pin_env) {
        (Some(user), Some(pass), _) if !user.is_empty() && !pass.is_empty() => Some(AuthConfig {
            user,
            pass,
            session_cookie_name,
            session_cookie_value,
        }),
        (user_opt, None, Some(pin)) if !pin.is_empty() => Some(AuthConfig {
            user: user_opt
                .filter(|u| !u.is_empty())
                .unwrap_or_else(|| "mobux".to_string()),
            pass: pin,
            session_cookie_name,
            session_cookie_value,
        }),
        _ => None,
    }
}

/// Routes that bypass auth so first-contact device enrollment works:
/// the install page must be reachable to download the APK + CA, the
/// digital-asset-links file must be reachable for the TWA verification,
/// the icon assets are needed by the bubblewrap build (which fetches
/// them over HTTPS from the running server), and the service worker
/// must be reachable for the SW registration request — some Android
/// browsers fetch /sw.js without page credentials.
///
/// `/api/identify` is intentionally unauthenticated (mesh EDD): peers probe
/// it for app+version discovery before any credentials exist. It leaks
/// nothing beyond "this is mobux, version X".
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
        let set_cookie = format!(
            "{}={}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000",
            auth.session_cookie_name, auth.session_cookie_value
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

async fn index(State(state): State<AppState>) -> Result<axum::response::Response, AppError> {
    let sessions = tmux::list_sessions().await.map_err(AppError::bad_request)?;
    Ok(html_no_store(render_index(
        &sessions,
        None,
        &state.cache_bust,
        state.dev_mode,
    )))
}

async fn api_sessions() -> Result<Json<Vec<tmux::Session>>, AppError> {
    let sessions = tmux::list_sessions().await.map_err(AppError::bad_request)?;
    Ok(Json(sessions))
}

/// Unauthenticated mesh discovery probe. Returns only the app name and crate
/// version — nothing else leaks. Bypasses auth via `is_public_path`.
async fn api_identify() -> Json<mesh::Identify> {
    Json(mesh::Identify {
        app: "mobux".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

/// Authenticated tailnet peer enumeration. On tailscale failure, returns a
/// structured error (HTTP 502) the UI can show — never a silent empty list.
/// An empty `peers` array means "tailscale fine, nothing found"; the error
/// path means "tailscale unavailable".
async fn api_peers(State(state): State<AppState>) -> Response {
    match mesh::enumerate(state.port).await {
        Ok(peers) => Json(json!({ "peers": peers })).into_response(),
        Err(err) => {
            // 502: this node is up, but the upstream dependency (tailscaled)
            // it relies on to enumerate peers is not cooperating.
            (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response()
        }
    }
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

    match update::spawn_updater(&state.data_dir, &latest, state.port, state.use_tls) {
        Ok(log_path) => {
            // Keep the flag set: a successful update restarts the process, and
            // until then no second run should start.
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
    Json(payload): Json<CreateReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    let name = payload.name.trim();
    validate_session_name(&state, name)?;
    tmux::new_session(name)
        .await
        .map_err(AppError::bad_request)?;
    Ok(Json(json!({"ok": true, "name": name})))
}

async fn api_kill_session(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    validate_session_name(&state, &name)?;
    tmux::kill_session(&name)
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
    Json(payload): Json<RenameReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    validate_session_name(&state, &old_name)?;
    validate_session_name(&state, &payload.name)?;
    tmux::rename_session(&old_name, &payload.name)
        .await
        .map_err(AppError::bad_request)?;
    Ok(Json(json!({"ok": true})))
}

async fn api_list_panes(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<Vec<tmux::Pane>>, AppError> {
    validate_session_name(&state, &name)?;
    let panes = tmux::list_panes(&name)
        .await
        .map_err(AppError::bad_request)?;
    Ok(Json(panes))
}

async fn api_select_pane(
    State(state): State<AppState>,
    Path((name, pane)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    validate_session_name(&state, &name)?;
    tmux::select_pane(&name, &pane)
        .await
        .map_err(AppError::bad_request)?;
    Ok(Json(json!({"ok": true})))
}

async fn api_session_history(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<String, AppError> {
    validate_session_name(&state, &name)?;
    let history = tmux::capture_history(&name, 10000)
        .await
        .map_err(AppError::bad_request)?;
    Ok(history)
}

#[derive(Deserialize)]
struct CommandReq {
    command: String,
}

async fn api_tmux_command(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(payload): Json<CommandReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    validate_session_name(&state, &name)?;
    let result = tmux::run_command(&name, &payload.command)
        .await
        .map_err(AppError::bad_request)?;
    Ok(Json(json!({"ok": true, "output": result})))
}

/// Dev-only client telemetry sink. A general-purpose channel for the frontend
/// to forward diagnostic lines into the server journal during development.
///
/// Gated on `state.dev_mode` (`MOBUX_DEV=1`): when dev mode is OFF — i.e. in
/// production — this returns 404 and logs nothing, so the route is inert.
/// It stays behind the normal auth middleware (the page is same-origin, so the
/// session cookie carries fine); it is NOT auth-exempt. Body is capped at 64KB
/// by the route's `DefaultBodyLimit`. Lines land in the journal via `eprintln!`
/// (matching the repo's existing logging convention) prefixed `[telemetry]`.
async fn api_telemetry(State(state): State<AppState>, body: String) -> StatusCode {
    if !state.dev_mode {
        return StatusCode::NOT_FOUND;
    }
    let ts = chrono::Local::now().format("%H:%M:%S%.3f");
    // Single line per event keeps `journalctl`/`grep` friendly; the client
    // already JSON-encodes structured payloads onto one line.
    eprintln!("[telemetry {ts}] {body}");
    StatusCode::NO_CONTENT
}

async fn api_upload(
    mut multipart: axum::extract::Multipart,
) -> Result<Json<serde_json::Value>, AppError> {
    use std::fs;
    use std::path::PathBuf;

    let upload_dir = PathBuf::from("/tmp/mobux-uploads");
    fs::create_dir_all(&upload_dir).map_err(|e| AppError::bad_request(e.into()))?;

    if let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::bad_request(e.into()))?
    {
        let filename = field.file_name().unwrap_or("upload").to_string();

        // Sanitize filename
        let safe_name = filename
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect::<String>();

        // Add timestamp to avoid collisions
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let dest = upload_dir.join(format!("{ts}-{safe_name}"));

        let data = field
            .bytes()
            .await
            .map_err(|e| AppError::bad_request(e.into()))?;
        fs::write(&dest, &data).map_err(|e| AppError::bad_request(e.into()))?;

        return Ok(Json(json!({
            "path": dest.to_string_lossy(),
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

    // Read config per-request — no restart needed after config change
    let db_cfg = tokio::task::spawn_blocking({
        let db = state.db.clone();
        move || db.stt_config()
    })
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!("spawn_blocking: {e}")))?
    .map_err(AppError::internal)?;

    let provider_cfg = transcribe::ProviderConfig {
        url: db_cfg.url,
        model: db_cfg.model,
        api_key: db_cfg.api_key,
    };

    match transcribe::transcribe_with_provider(&provider_cfg, audio, &filename).await {
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
    tokio::spawn(push::notify(state.db.clone(), payload));
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct InternalTriggerQuery {
    kind: String,
    session: String,
    window: Option<String>,
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
                push::fire_bell(state.db.clone(), &q.session, q.window.as_deref());
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

async fn settings_page(State(state): State<AppState>) -> Response {
    let v = &state.cache_bust;
    html_no_store(format!(
        r##"<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <title>Mobux · Settings</title>
  <link rel="icon" href='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🤖</text></svg>' />
  <meta name="theme-color" content="#0f1115" />
  <link rel="stylesheet" href="/static/style.css?v={v}" />
</head>
<body>
  <header class="app-header">
    <a href="/" class="header-back" aria-label="Back">‹</a>
    <h1>settings</h1>
  </header>

  <main class="settings-page">
    <section class="settings-card" id="update">
      <h2>Software update</h2>
      <p class="settings-lede">mobux checks crates.io for newer published versions. Updating installs the new version with <code>cargo install</code>, restarts the systemd service, health-checks it, and rolls back automatically if the new version doesn't come up. This acts on <strong>this host only</strong> — to update a peer, open its own settings page.</p>
      <div class="settings-row">
        <span class="settings-label">
          <strong>Current version</strong>
          <small id="updateHost">This running binary.</small>
        </span>
        <span id="updateCurrent" class="settings-value">…</span>
      </div>
      <div class="settings-row">
        <span class="settings-label">
          <strong>Latest version</strong>
          <small id="updateCheckedAt">Checking crates.io…</small>
        </span>
        <span id="updateLatest" class="settings-value">…</span>
      </div>
      <div class="shell-card-actions">
        <button type="button" id="updateCheckBtn">Check for updates</button>
        <button type="button" id="updateRunBtn" hidden>Update now</button>
      </div>
      <div class="settings-status" id="updateStatus" hidden></div>
    </section>

    <section class="settings-card" id="install-app">
      <h2>Install app</h2>
      <p class="settings-lede">Add Mobux to your home screen as a standalone Android app. The install page has the CA certificate and APK with step-by-step instructions.</p>
      <a href="/install" class="settings-link-btn">Open install page →</a>
    </section>

    <section class="settings-card">
      <h2>Notifications</h2>
      <p class="settings-lede">Pick what fires a push to subscribed devices. Everything is detected by parsing the PTY stream — no shell hooks needed except the OSC-133 prompt for the exit toggles.</p>

      <label class="settings-row">
        <input type="checkbox" name="bell" />
        <span class="settings-label">
          <strong>Terminal bell (\x07)</strong>
          <small>Standard ASCII BEL byte. Most apps fire this on tab-complete failures, vim errors, irc highlights.</small>
        </span>
      </label>

      <label class="settings-row">
        <input type="checkbox" name="bell_emoji" />
        <span class="settings-label">
          <strong>🔔 emoji in output</strong>
          <small>Used for intentional pings — Claude, scripts, anything that prints the bell glyph.</small>
        </span>
      </label>

      <label class="settings-row">
        <input type="checkbox" name="program_exit" />
        <span class="settings-label">
          <strong>Program exit (any code)</strong>
          <small>Detected via OSC 133;D semantic prompt. Requires Starship, Powerlevel10k, or a PS1 that emits <code>\e]133;D;$?\a</code>.</small>
        </span>
      </label>

      <label class="settings-row">
        <input type="checkbox" name="program_exit_nonzero" />
        <span class="settings-label">
          <strong>Program exit (non-zero only)</strong>
          <small>Same OSC 133;D detection, fires only on failures.</small>
        </span>
      </label>

      <div class="settings-status" id="settingsStatus" hidden>Saved.</div>
    </section>

    <section class="settings-card" id="renderer-picker">
      <h2>Terminal renderer</h2>
      <p class="settings-lede">The browser-side terminal emulator. <strong>xterm.js</strong> is the stable default. <strong>sterk</strong> is an experimental renderer (libterm + Ace) that is still catching up to xterm parity — switch back to xterm if the experimental lane breaks. The setting is per-device; reload the terminal tab after changing it.</p>
      <label class="settings-row">
        <span class="settings-label">
          <strong>Renderer</strong>
          <small>Stored locally as <code>mobux:renderer</code>. Per-device. Reload the terminal page after switching.</small>
        </span>
        <select id="rendererSelect" class="settings-select">
          <option value="xterm">xterm.js (stable, default)</option>
          <option value="sterk">sterk (experimental)</option>
        </select>
      </label>
      <div class="settings-status" id="rendererStatus" hidden></div>
    </section>

    <section class="settings-card" id="theme-picker">
      <h2>Theme</h2>
      <p class="settings-lede">Sets the editor theme, terminal palette and reader palette together. All bundles are muted, low-contrast — picked for a phone screen at night. Switching applies live to any open terminal tab.</p>
      <label class="settings-row">
        <span class="settings-label">
          <strong>Colour theme</strong>
          <small>Stored locally as <code>mobux:theme</code>. Per-device.</small>
        </span>
        <select id="themeSelect" class="settings-select"></select>
      </label>
    </section>

    <section class="settings-card" id="shell-integration">
      <h2>Shell integration</h2>
      <p class="settings-lede">The reader view classifies prompts and command output deterministically when your shell emits <a href="https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md" target="_blank" rel="noopener">OSC 133</a> (FinalTerm) markers. Without it, mobux falls back to heuristics. Click install — mobux appends a managed, fenced block to your rc file and keeps a timestamped backup. Nothing outside the fence is touched. The snippet detects <code>$TMUX</code> and wraps OSC 133 in tmux's DCS passthrough envelope so tmux 3.4's default <code>allow-passthrough off</code> doesn't drop the marker; mobux turns the option on for sessions it attaches.</p>

      <div class="shell-card" data-shell="bash">
        <div class="shell-card-head">
          <strong>bash</strong> <code>~/.bashrc</code>
          <span class="shell-state" data-role="state">…</span>
        </div>
        <div class="shell-card-actions">
          <button type="button" data-action="install">Install</button>
          <button type="button" data-action="uninstall">Uninstall</button>
        </div>
        <details class="settings-detail">
          <summary>Show snippet</summary>
<pre class="settings-snippet"><code>if [ -n "$TMUX" ]; then
    PS0='\ePtmux;\e\e]133;C\a\e\\'
    PS1='\[\ePtmux;\e\e]133;D;$?\a\e]133;A\a\e\\\]'"$PS1"'\[\ePtmux;\e\e]133;B\a\e\\\]'
else
    PS0='\e]133;C\a'
    PS1='\[\e]133;D;$?\a\e]133;A\a\]'"$PS1"'\[\e]133;B\a\]'
fi</code></pre>
        </details>
      </div>

      <div class="shell-card" data-shell="zsh">
        <div class="shell-card-head">
          <strong>zsh</strong> <code>~/.zshrc</code>
          <span class="shell-state" data-role="state">…</span>
        </div>
        <div class="shell-card-actions">
          <button type="button" data-action="install">Install</button>
          <button type="button" data-action="uninstall">Uninstall</button>
        </div>
        <details class="settings-detail">
          <summary>Show snippet</summary>
<pre class="settings-snippet"><code>if [ -n "$TMUX" ]; then
    preexec() {{ print -Pn '\ePtmux;\e\e]133;C\a\e\\' }}
    precmd()  {{ print -Pn '\ePtmux;\e\e]133;D;'$?'\a\e]133;A\a\e\\' }}
else
    preexec() {{ print -Pn '\e]133;C\a' }}
    precmd()  {{ print -Pn '\e]133;D;'$?'\a\e]133;A\a' }}
fi</code></pre>
        </details>
      </div>

      <div class="shell-card" data-shell="fish">
        <div class="shell-card-head">
          <strong>fish</strong> <code>~/.config/fish/config.fish</code>
          <span class="shell-state" data-role="state">…</span>
        </div>
        <div class="shell-card-actions">
          <button type="button" data-action="install">Install</button>
          <button type="button" data-action="uninstall">Uninstall</button>
        </div>
        <details class="settings-detail">
          <summary>Show snippet</summary>
<pre class="settings-snippet"><code>if test -n "$TMUX"
    function __mobux_osc133_preexec --on-event fish_preexec
        printf '\ePtmux;\e\e]133;C\a\e\\'
    end
    function __mobux_osc133_postexec --on-event fish_postexec
        printf '\ePtmux;\e\e]133;D;%s\a\e\\' $status
    end
    function __mobux_osc133_prompt --on-event fish_prompt
        printf '\ePtmux;\e\e]133;A\a\e\\'
    end
else
    function __mobux_osc133_preexec --on-event fish_preexec
        printf '\e]133;C\a'
    end
    function __mobux_osc133_postexec --on-event fish_postexec
        printf '\e]133;D;%s\a' $status
    end
    function __mobux_osc133_prompt --on-event fish_prompt
        printf '\e]133;A\a'
    end
end</code></pre>
        </details>
      </div>

      <div class="settings-status" id="shellIntegrationStatus" hidden></div>
      <p class="settings-foot">Reload the shell after installing. The fenced block is the contract — mobux only ever modifies what's between the fences. A timestamped <code>.mobux.bak.&lt;ts&gt;</code> is written next to the rc file before any change.</p>
    </section>

    <section class="settings-card" id="stt-provider">
      <h2>Speech provider</h2>
      <p class="settings-lede">Dictation forwards audio to an OpenAI-compatible <code>/v1/audio/transcriptions</code> endpoint. Use Local to run a <a href="https://github.com/speaches-ai/speaches" target="_blank" rel="noopener">speaches</a> server on port 5200, Network for a self-hosted instance, or OpenAI for the cloud API.</p>

      <label class="settings-row">
        <span class="settings-label"><strong>Provider</strong></span>
        <select id="sttKind" class="settings-select">
          <option value="local">Local (port 5200)</option>
          <option value="network">Network (self-hosted)</option>
          <option value="openai">OpenAI</option>
        </select>
      </label>

      <label class="settings-row">
        <span class="settings-label"><strong>Endpoint URL</strong></span>
        <input type="url" id="sttUrl" class="settings-input" placeholder="http://127.0.0.1:5200/v1/audio/transcriptions" />
      </label>

      <label class="settings-row">
        <span class="settings-label"><strong>Model</strong></span>
        <input type="text" id="sttModel" class="settings-input" placeholder="Systran/faster-whisper-base.en" />
      </label>

      <label class="settings-row" id="sttApiKeyRow">
        <span class="settings-label"><strong>API key</strong></span>
        <input type="password" id="sttApiKey" class="settings-input" placeholder="sk-…" autocomplete="off" />
      </label>

      <div id="sttStatus" class="settings-status" hidden></div>

      <div class="shell-card-actions">
        <button type="button" id="sttSaveBtn">Save</button>
        <button type="button" id="sttProbeBtn">Check status</button>
        <button type="button" id="sttInstallBtn">Install local server</button>
        <button type="button" id="sttStartBtn">Start</button>
        <button type="button" id="sttStopBtn">Stop</button>
      </div>
      <div class="settings-status" id="sttActionStatus" hidden></div>
    </section>

    <section class="settings-card" id="listen-settings">
      <h2>Listen</h2>
      <p class="settings-lede">Make reader-view bubbles tappable to be spoken aloud via the Web Speech API. Settings are stored locally and apply to all sessions.</p>

      <div id="listenCapable">
        <div class="listen-range-group">
          <label>
            <strong>Voice</strong>
            <select id="listenVoice" class="settings-select" style="flex: 1;"></select>
          </label>
        </div>

        <div class="listen-range-group" style="margin-top: 12px;">
          <label>
            <strong>Rate</strong>
            <input type="range" id="listenRate" min="0.5" max="2" step="0.1" value="1.0" />
            <span class="listen-value" id="listenRateValue">1.0</span>
          </label>
        </div>

        <div class="listen-range-group" style="margin-top: 8px;">
          <label>
            <strong>Pitch</strong>
            <input type="range" id="listenPitch" min="0.5" max="2" step="0.1" value="1.0" />
            <span class="listen-value" id="listenPitchValue">1.0</span>
          </label>
        </div>

        <button type="button" id="listenTest" class="listen-test-btn">Test</button>
      </div>

      <div id="listenUnavailable" class="listen-unavailable" hidden>
        Web Speech API not available in this browser.
      </div>
    </section>
  </main>

  <script>
    // Capability gate only — all slider/value wiring lives in listen-settings.js
    // (single source of truth for prefs + DOM behaviour).
    if (!('speechSynthesis' in window)) {{
      document.getElementById('listenCapable').hidden = true;
      document.getElementById('listenUnavailable').hidden = false;
    }}
  </script>
  <script>
  (function() {{
    const kindEl    = document.getElementById('sttKind');
    const urlEl     = document.getElementById('sttUrl');
    const modelEl   = document.getElementById('sttModel');
    const keyEl     = document.getElementById('sttApiKey');
    const keyRow    = document.getElementById('sttApiKeyRow');
    const statusEl  = document.getElementById('sttStatus');
    const actionEl  = document.getElementById('sttActionStatus');

    function showStatus(el, msg, ok) {{
      el.textContent = msg;
      el.hidden = false;
      el.style.color = ok ? '#7ec87e' : '#c87e7e';
    }}

    function updateVisibility() {{
      const isLocal  = kindEl.value === 'local';
      const isOpenai = kindEl.value === 'openai';
      keyRow.hidden  = !isOpenai;
      document.getElementById('sttInstallBtn').hidden = !isLocal;
      document.getElementById('sttStartBtn').hidden   = !isLocal;
      document.getElementById('sttStopBtn').hidden    = !isLocal;
    }}
    kindEl.addEventListener('change', updateVisibility);

    // Load current config on page open
    fetch('/api/settings/stt').then(r => r.json()).then(cfg => {{
      kindEl.value  = cfg.kind  || 'local';
      urlEl.value   = cfg.url   || '';
      modelEl.value = cfg.model || '';
      // Never populate the key field — the server does not return the secret.
      // Show a placeholder so the user knows a key is already stored.
      keyEl.value = '';
      keyEl.placeholder = cfg.has_key ? '•••• stored' : 'sk-…';
      updateVisibility();
    }}).catch(() => updateVisibility());

    document.getElementById('sttSaveBtn').addEventListener('click', () => {{
      const body = {{ kind: kindEl.value, url: urlEl.value, model: modelEl.value }};
      if (kindEl.value === 'openai' && keyEl.value) body.api_key = keyEl.value;
      fetch('/api/settings/stt', {{
        method: 'PUT',
        headers: {{ 'Content-Type': 'application/json' }},
        body: JSON.stringify(body),
      }}).then(r => showStatus(statusEl, r.ok ? 'Saved.' : 'Save failed.', r.ok))
        .catch(() => showStatus(statusEl, 'Save failed.', false));
    }});

    document.getElementById('sttProbeBtn').addEventListener('click', () => {{
      fetch('/api/stt/status').then(r => r.json()).then(s => {{
        const msg = s.reachable
          ? `Provider reachable (kind: ${{s.kind}})`
          : `Provider NOT reachable (${{s.url}})`;
        showStatus(statusEl, msg, s.reachable);
      }}).catch(() => showStatus(statusEl, 'Status check failed.', false));
    }});

    document.getElementById('sttInstallBtn').addEventListener('click', () => {{
      showStatus(actionEl, 'Installing… (this may take a minute)', true);
      fetch('/api/stt/install', {{ method: 'POST' }})
        .then(r => r.text()).then(t => showStatus(actionEl, t || 'Done.', true))
        .catch(() => showStatus(actionEl, 'Install failed.', false));
    }});

    document.getElementById('sttStartBtn').addEventListener('click', () => {{
      fetch('/api/stt/start', {{ method: 'POST' }})
        .then(r => showStatus(actionEl, r.ok ? 'Server started.' : 'Start failed.', r.ok))
        .catch(() => showStatus(actionEl, 'Start failed.', false));
    }});

    document.getElementById('sttStopBtn').addEventListener('click', () => {{
      fetch('/api/stt/stop', {{ method: 'POST' }})
        .then(r => showStatus(actionEl, r.ok ? 'Server stopped.' : 'Stop failed.', r.ok))
        .catch(() => showStatus(actionEl, 'Stop failed.', false));
    }});
  }})();
  </script>
  <script src="/static/settings.js?v={v}"></script>
  <!-- mesh-client first so update.js can relay update calls to a selected peer. -->
  <script src="/static/mesh-client.js?v={v}"></script>
  <script src="/static/update.js?v={v}"></script>
  <script type="module" src="/static/settings-theme.js?v={v}"></script>
  <script src="/static/settings-renderer.js?v={v}"></script>
  <script src="/static/shell-integration.js?v={v}"></script>
  <script type="module" src="/static/listen-settings.js?v={v}"></script>
</body>
</html>
"##,
    ))
}

async fn terminal_page(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<axum::response::Response, AppError> {
    validate_session_name(&state, &name)?;
    // No host segment → current node / same-origin, no peer pinned.
    Ok(html_no_store(render_terminal_page(
        &name,
        "",
        &state.cache_bust,
        state.dev_mode,
    )))
}

// Host-pinned variant: `/s/{host}/{name}`. Renders the SAME terminal page but
// surfaces the host so the client pins that peer for the page's lifetime. The
// server itself does not route by host — the relay does — so `host` is only
// echoed back to the client, never used to resolve the session here.
async fn terminal_page_pinned(
    State(state): State<AppState>,
    Path((host, name)): Path<(String, String)>,
) -> Result<axum::response::Response, AppError> {
    validate_session_name(&state, &name)?;
    // `host` is reflected into an inline <script> as window.MOBUX_PEER, and
    // serde_json does NOT escape `<`/`>`/`</script>` — an unvalidated host is a
    // reflected-XSS breakout. Gate it to the legal peer shape (canonical_peer
    // rejects slashes/spaces/bad ports) AND a strict charset so no markup
    // metacharacter can survive. Reject anything else as 400, mirroring
    // validate_session_name.
    let peer = validate_pinned_host(&host)?;
    Ok(html_no_store(render_terminal_page(
        &name,
        &peer,
        &state.cache_bust,
        state.dev_mode,
    )))
}

/// Validate + canonicalize a `host` path segment for the pinned terminal route.
///
/// Reuses the relay's `canonical_peer` (legal `host[:port]` shape) and then
/// enforces the conservative peer charset `[A-Za-z0-9.:_-]`. `canonical_peer`
/// alone rejects slashes and spaces but still admits markup metacharacters
/// (e.g. `<img>` → `<img>:8080`), which would break out of the inline
/// `window.MOBUX_PEER` script — so the charset gate is the load-bearing
/// defence here. Returns the canonical `host:port`, or a 400 on reject.
fn validate_pinned_host(host: &str) -> Result<String, AppError> {
    let peer = relay::canonical_peer(host)
        .map_err(|e| AppError::bad_request(anyhow::anyhow!("invalid host: {e}")))?;
    if !peer
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '_' | '-'))
    {
        return Err(AppError::bad_request(anyhow::anyhow!("invalid host")));
    }
    Ok(peer)
}

// Same payload as Html<String> but with Cache-Control: no-store.
// The HTML embeds the per-restart cache_bust query param on every
// /static asset URL; if the HTML itself is cached the embedded
// version IDs go stale and the page ends up loading a mismatched
// mix of old→new JS. no-store guarantees the browser always sees a
// fresh document and therefore a fresh set of asset version pins.
fn html_no_store(body: String) -> axum::response::Response {
    use axum::http::{header, HeaderValue};
    let mut resp = Html(body).into_response();
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, must-revalidate"),
    );
    resp
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
// import-only module (input-bar.js, reader-view.js, …) was frozen in the
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

// ── /install: TWA install page (APK + CA download, with QR codes) ────
//
// Pure server-rendered, no client JS. The QR codes encode absolute URLs
// (built from the request `Host` header) so a desktop browser visitor can
// scan from a phone and land on the right asset on the right host.

const INSTALL_APK_PATH: &str = "web/static/install/mobux.apk";
const INSTALL_ASSETLINKS_PATH: &str = "web/static/.well-known/assetlinks.json";

fn host_from_headers(headers: &HeaderMap) -> String {
    headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("localhost")
        .to_string()
}

/// Render a QR code as inline SVG. Returns the SVG document text. Falls back
/// to a short error string baked into the page if encoding fails — QR
/// generation should never abort the install page render.
fn qr_svg(data: &str) -> String {
    use qrcode::render::svg;
    use qrcode::{EcLevel, QrCode};

    match QrCode::with_error_correction_level(data.as_bytes(), EcLevel::M) {
        Ok(code) => code
            .render::<svg::Color<'_>>()
            .min_dimensions(220, 220)
            .dark_color(svg::Color("#0f1115"))
            .light_color(svg::Color("#ffffff"))
            .quiet_zone(true)
            .build(),
        Err(_) => "<!-- qr encode failed -->".to_string(),
    }
}

async fn install_page(headers: HeaderMap, State(state): State<AppState>) -> Response {
    let host = host_from_headers(&headers);
    let host_esc = html_escape::encode_text(&host);

    let apk_url = format!("https://{host}/install/mobux.apk");
    let ca_url = format!("https://{host}/install/mobux-ca.crt");
    let apk_present = std::path::Path::new(INSTALL_APK_PATH).exists();

    let acme = ssl::acme_mode_enabled();
    let app_heading = if acme {
        "Install the app"
    } else {
        "2. Install the app"
    };
    let app_section = if apk_present {
        format!(
            r##"<section class="install-card">
  <h2>{app_heading}</h2>
  <p class="install-lede">Download the Android APK, or scan the QR with your phone.</p>
  <div class="install-grid">
    <a class="install-btn" href="/install/mobux.apk" download>Download APK</a>
    <div class="install-qr">{qr}</div>
  </div>
</section>"##,
            qr = qr_svg(&apk_url),
        )
    } else {
        format!(
            r##"<section class="install-card">
  <h2>{app_heading}</h2>
  <p class="install-lede">APK not built yet.</p>
  <p class="install-hint">Run <code>make twa MOBUX_DOMAIN={host_esc}</code> on the server to build the APK.</p>
</section>"##,
        )
    };

    let ca_section = if acme {
        String::new()
    } else {
        format!(
            r##"<section class="install-card">
  <h2>1. Install the CA certificate</h2>
  <p class="install-lede">Do this <strong>first</strong>. Without the CA, Android won't trust this server, the APK download will be blocked, and the installed app won't connect.</p>
  <div class="install-grid">
    <a class="install-btn" href="/install/mobux-ca.crt" download>Download CA certificate</a>
    <div class="install-qr">{qr}</div>
  </div>
  <p class="install-hint">After downloading, install it through Android Settings:</p>
  <ol class="install-steps">
    <li>Settings &rarr; Security &amp; privacy (or just Security)</li>
    <li>More security settings &rarr; Encryption &amp; credentials</li>
    <li>Install a certificate &rarr; CA certificate</li>
    <li>Acknowledge the warning, pick <code>mobux-ca.crt</code> from your Downloads</li>
  </ol>
</section>"##,
            qr = qr_svg(&ca_url),
        )
    };

    let v = &state.cache_bust;
    html_no_store(format!(
        r##"<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Mobux · Install</title>
  <link rel="icon" href='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🤖</text></svg>' />
  <link rel="manifest" href="/static/manifest.json" />
  <meta name="theme-color" content="#0f1115" />
  <link rel="apple-touch-icon" href="/static/icon-192.png" />
  <link rel="stylesheet" href="/static/style.css?v={v}" />
</head>
<body>
  <header class="app-header">
    <h1>mobux · install</h1>
  </header>
  <main class="install-page">
    {ca_section}
    {app_section}
  </main>
</body>
</html>
"##,
    ))
}

async fn serve_install_apk() -> Response {
    serve_file_or_404(
        INSTALL_APK_PATH,
        "application/vnd.android.package-archive",
        Some("mobux.apk"),
    )
    .await
}

async fn serve_install_ca() -> Response {
    if ssl::acme_mode_enabled() {
        return (StatusCode::NOT_FOUND, "ACME mode: no local CA to install").into_response();
    }
    let path = ssl::ca_cert_path();
    serve_file_or_404(
        path.to_string_lossy().as_ref(),
        "application/x-x509-ca-cert",
        Some("mobux-ca.crt"),
    )
    .await
}

async fn serve_assetlinks() -> Response {
    serve_file_or_404(INSTALL_ASSETLINKS_PATH, "application/json", None).await
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

async fn terminal_ws(
    State(state): State<AppState>,
    Path(name): Path<String>,
    ws: WebSocketUpgrade,
) -> Result<Response, AppError> {
    validate_session_name(&state, &name)?;
    Ok(ws.on_upgrade(move |socket| async move {
        if let Err(err) = handle_ws(socket, name).await {
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

async fn handle_ws(socket: axum::extract::ws::WebSocket, session_name: String) -> Result<()> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: 35,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut cmd = CommandBuilder::new("bash");
    let tmux_bin = match std::env::var("MOBUX_TMUX_SOCKET") {
        Ok(s) if !s.is_empty() => format!("tmux -L {}", s),
        _ => "tmux".to_string(),
    };
    // Force a real terminfo entry on the spawned PTY. The host's TERM
    // can be unset, "dumb" (non-interactive shells), or something tmux
    // doesn't have terminfo for — in any of those cases tmux's first
    // act on attach is `open terminal failed: terminal does not support
    // clear`, the bash subprocess exits 1, and the WS gets nothing past
    // the 57-byte init handshake. The browser-side renderer (aceterm /
    // libterm) is xterm-256color compatible, so use that unconditionally.
    cmd.env("TERM", "xterm-256color");
    // `allow-passthrough on` is required for the OSC 133 shell-integration
    // snippet's tmux DCS-passthrough wrap (\ePtmux;\e<seq>\e\\) to reach
    // the outer terminal. tmux 3.4 defaults this off, and silently drops
    // OSC 133 entirely without it; tmux 3.5+ also honours the option.
    cmd.args([
        "-c",
        &format!(
            "{tmux} set-option -g mouse on 2>/dev/null; {tmux} set-option -g allow-passthrough on 2>/dev/null; {tmux} set-window-option -g aggressive-resize on 2>/dev/null; {tmux} attach-session -t {session}",
            tmux = tmux_bin,
            session = session_name,
        ),
    ]);
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
            maybe_out = rx.recv() => {
                match maybe_out {
                    Some(chunk) => {
                        // Notification triggers no longer come from this
                        // path — bells flow through the tmux `alert-bell`
                        // hook (see `tmux::install_bell_hook`), which
                        // tmux fires exactly once per real bell. Repaint
                        // chunks here are just rendering, never events.
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

    let _ = child.kill();
    let _ = child.wait();
    Ok(())
}

fn validate_session_name(state: &AppState, name: &str) -> Result<(), AppError> {
    if name.is_empty() || !state.session_name_re.is_match(name) {
        return Err(AppError::bad_request(anyhow::anyhow!(
            "invalid session name"
        )));
    }
    Ok(())
}

fn render_index(sessions: &[tmux::Session], error: Option<&str>, v: &str, dev: bool) -> String {
    let mut cards = String::new();
    if sessions.is_empty() {
        cards.push_str(r#"<p class="hint">No tmux sessions. Tap + to create one.</p>"#);
    } else {
        for s in sessions {
            let name = html_escape::encode_text(&s.name);
            cards.push_str(&format!(
                r#"<div class="swipe-row" data-name="{name}">
  <div class="swipe-action swipe-left"><button class="swipe-btn rename-btn">Rename</button></div>
  <a class="session-item" href="/s/{name}">
    <div class="session-info">
      <span class="session-name">{name}</span>
      <span class="session-meta">{} win · {} attached</span>
    </div>
    <span class="session-arrow">›</span>
  </a>
  <div class="swipe-action swipe-right"><button class="swipe-btn kill-btn" data-kill="{name}">Kill</button></div>
</div>"#,
                s.windows, s.attached
            ));
        }
    }

    let error_html = error
        .map(|e| {
            format!(
                r#"<section class="panel error">{}</section>"#,
                html_escape::encode_text(e)
            )
        })
        .unwrap_or_default();

    format!(
        r##"<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no" />
  <title>Mobux</title>
  <link rel="icon" href='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🤖</text></svg>' />
  <link rel="manifest" href="/static/manifest.json" />
  <meta name="theme-color" content="#0f1115" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <link rel="apple-touch-icon" href="/static/icon-192.png" />
  <link rel="stylesheet" href="/static/style.css?v={v}" />
</head>
<body>
  <header class="app-header">
    <h1>mobux</h1>
    <a href="/settings" class="header-icon" aria-label="Settings">⚙</a>
  </header>

  {error_html}

  <div id="sessionList" class="session-list">
    {cards}
  </div>

  <button id="fabNew" class="fab" aria-label="New session">+</button>

  <dialog id="newSessionDialog" class="session-dialog">
    <form id="newSessionForm" method="dialog">
      <h3>New session</h3>
      <input id="sessionName" placeholder="session-name" autocomplete="off" required />
      <div class="dialog-actions">
        <button type="button" class="btn-cancel" id="cancelNew">Cancel</button>
        <button type="submit" class="btn-create">Create</button>
      </div>
    </form>
  </dialog>

  <script>window.MOBUX_DEV = {dev};</script>
  <script src="/static/mesh-client.js?v={v}"></script>
  <script src="/static/host-picker.js?v={v}"></script>
  <script src="/static/index.js?v={v}"></script>
  <script src="/static/chime.js?v={v}"></script>
  <script src="/static/install-hint.js?v={v}"></script>
  <script type="module" src="/static/telemetry.js?v={v}"></script>
  <script>if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');</script>
</body>
</html>
"##
    )
}

fn render_terminal_page(session: &str, peer: &str, v: &str, dev: bool) -> String {
    let session_json = serde_json::to_string(session).unwrap_or_else(|_| "\"\"".to_string());
    // Peer the page is pinned to ("" for the same-origin/current-node route).
    // JSON-encoded so the client can read it verbatim and decide whether to
    // override the global host-picker selection for this page.
    let peer_json = serde_json::to_string(peer).unwrap_or_else(|_| "\"\"".to_string());
    let session_title = html_escape::encode_text(session);

    format!(
        r##"<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no" />
  <title>Mobux · {session_title}</title>
  <link rel="icon" href='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🤖</text></svg>' />
  <link rel="manifest" href="/static/manifest.json" />
  <meta name="theme-color" content="#0f1115" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <link rel="apple-touch-icon" href="/static/icon-192.png" />
  <link rel="stylesheet" href="/static/style.css?v={v}" />
</head>
<body class="term-body">
  <div id="terminal"></div>
  <div id="reader" class="hidden"></div>
  <div id="loadquote"><q id="quote"></q><br><cite id="qauthor"></cite></div>
  <div id="touchOverlay"></div>
  <div id="paneIndicator"></div>
  <div id="cmdOverlayBg"></div>
  <div id="cmdPickList">
    <div class="cmd-header">
      <h3>tmux</h3>
      <button class="cmd-close" id="cmdCloseBtn" aria-label="Close">Close</button>
    </div>
    <button class="cmd-item" data-cmd="new-window">New window</button>
    <button class="cmd-item" data-cmd="kill-window">Close window</button>
    <div class="cmd-separator"></div>
    <button class="cmd-item" data-cmd="split-h">Split horizontal</button>
    <button class="cmd-item" data-cmd="split-v">Split vertical</button>
    <button class="cmd-item" data-cmd="kill-pane">Close pane</button>
    <div class="cmd-separator"></div>
    <button class="cmd-item" data-cmd="next-window">Next window</button>
    <button class="cmd-item" data-cmd="prev-window">Previous window</button>
    <button class="cmd-item" data-cmd="next-pane">Next pane</button>
    <button class="cmd-item" data-cmd="prev-pane">Previous pane</button>
    <div class="cmd-separator"></div>
    <button class="cmd-item" data-cmd="zoom-pane">Zoom pane</button>
  </div>

  <div id="inputBar" class="input-bar hidden">
    <div id="inputRibbon" class="input-ribbon">
      <button id="viewToggleBtn" title="Toggle reader/terminal view">📖</button>
      <button id="uploadBtn" title="Attach file">📎</button>
      <button id="micBtn" title="Dictate (speech to text)">🎤</button>
      <button data-key="\x7f">⌫</button>
      <button data-key="\r">⏎</button>
      <button data-key="\x1b[D">←</button>
      <button data-key="\x1b[C">→</button>
      <button data-key="\x1b[A">↑</button>
      <button data-key="\x1b[B">↓</button>
      <button data-key="\x03">^C</button>
      <button data-key="\x04">^D</button>
      <button data-key="\x1b">Esc</button>
      <button data-key="\t">Tab</button>
      <button data-key="\x1a">^Z</button>
      <button data-key="\x1b[3~">Del</button>
      <button data-key="\x1b[H">Home</button>
      <button data-key="\x1b[F">End</button>
      <button data-key="\x15">^U</button>
      <button data-key="\x0c">^L</button>
      <button data-key="/clear\r">/clear</button>
      <button data-key="/quit\r">/quit</button>
    </div>
    <div id="inputToast" class="input-toast hidden" role="status" aria-live="polite"></div>
    <div class="input-row">
      <input id="inputText" type="text" enterkeyhint="send" placeholder="Type here…" autocomplete="off" autocorrect="on" autocapitalize="off" spellcheck="false" />
      <button id="inputSend" class="input-send" title="Send without Enter">▶</button>
    </div>
  </div>

  <script>
    window.MOBUX_SESSION = {session_json};
    // Host this page is pinned to (issue #123). Empty string = current node
    // (no override); terminal.js binds MobuxMesh to this peer before connect.
    window.MOBUX_PEER = {peer_json};
    // Dev-mode flag (MOBUX_DEV). Gates the dev-only telemetry module below.
    window.MOBUX_DEV = {dev};
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
  </script>
  <!-- Renderer picker: reads `mobux:renderer` from localStorage and
       synchronously injects the matching bundle script (xterm.bundle.js
       or sterk.bundle.js) via document.write so its globals
       (`window.Terminal` / `window.Sterk`) are guaranteed to be present
       by the time terminal.js (the module below) evaluates.
       Default: xterm (stable). User toggles on /settings. -->
  <script>
    (function () {{
      var r = 'xterm';
      try {{
        var s = localStorage.getItem('mobux:renderer');
        if (s === 'sterk' || s === 'xterm') r = s;
      }} catch (_) {{}}
      window.__mobuxRenderer = r;
      var bundle = (r === 'sterk') ? 'sterk.bundle.js' : 'xterm.bundle.js';
      document.write('<script src="/static/vendor/' + bundle + '?v={v}"><\/script>');
      if (r === 'xterm') {{
        document.write('<link rel="stylesheet" href="/static/vendor/xterm.css?v={v}">');
      }}
    }})();
  </script>
  <!-- mesh-client (global) must be present before the terminal module so the
       renderer cores can resolve relayed API/WS paths for a selected peer.
       host-picker supplies the cred prompt the page reuses when it's pinned to
       a peer (?MOBUX_PEER) whose creds aren't stored yet; its mount() no-ops
       here since the terminal page has no .app-header. -->
  <script src="/static/mesh-client.js?v={v}"></script>
  <script src="/static/host-picker.js?v={v}"></script>
  <script type="module" src="/static/terminal.js?v={v}"></script>
  <script type="module" src="/static/telemetry.js?v={v}"></script>
  <script src="/static/chime.js?v={v}"></script>
</body>
</html>
"##
    )
}

// ── STT provider settings + lifecycle endpoints ───────────────────────

/// Shape returned by GET /api/settings/stt.
/// The api_key is never returned; instead `has_key` indicates whether one is stored.
#[derive(serde::Serialize)]
struct SttConfigGetJson {
    kind: String,
    url: String,
    model: String,
    has_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    install_cmd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_cmd: Option<String>,
}

/// Shape accepted by PUT /api/settings/stt.
/// api_key is optional; if absent or empty the existing stored key is preserved.
#[derive(serde::Deserialize)]
struct SttConfigPutJson {
    kind: String,
    url: String,
    model: String,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    install_cmd: Option<String>,
    #[serde(default)]
    start_cmd: Option<String>,
}

async fn api_get_stt_config(
    State(state): State<AppState>,
) -> Result<Json<SttConfigGetJson>, AppError> {
    let cfg = tokio::task::spawn_blocking({
        let db = state.db.clone();
        move || db.stt_config()
    })
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!("spawn_blocking: {e}")))?
    .map_err(AppError::internal)?;
    Ok(Json(SttConfigGetJson {
        kind: cfg.kind,
        url: cfg.url,
        model: cfg.model,
        has_key: cfg.api_key.as_deref().is_some_and(|k| !k.is_empty()),
        install_cmd: cfg.install_cmd,
        start_cmd: cfg.start_cmd,
    }))
}

async fn api_set_stt_config(
    State(state): State<AppState>,
    Json(req): Json<SttConfigPutJson>,
) -> Result<StatusCode, AppError> {
    // Read the existing config so we can preserve the stored api_key when
    // the request doesn't supply a new one.
    let existing = tokio::task::spawn_blocking({
        let db = state.db.clone();
        move || db.stt_config()
    })
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!("spawn_blocking: {e}")))?
    .map_err(AppError::internal)?;

    let api_key = match req.api_key.as_deref() {
        Some(k) if !k.is_empty() => Some(k.to_string()),
        _ => existing.api_key,
    };

    let cfg = db::SttConfig {
        kind: req.kind,
        url: req.url,
        model: req.model,
        api_key,
        install_cmd: req.install_cmd,
        start_cmd: req.start_cmd,
    };
    tokio::task::spawn_blocking({
        let db = state.db.clone();
        move || db.set_stt_config(cfg)
    })
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!("spawn_blocking: {e}")))?
    .map_err(AppError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn api_stt_status(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let cfg = tokio::task::spawn_blocking({
        let db = state.db.clone();
        move || db.stt_config()
    })
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!("spawn_blocking: {e}")))?
    .map_err(AppError::internal)?;

    let reachable = transcribe::probe_provider(&cfg.url).await;

    let child_running = {
        let guard = state.stt_child.lock().await;
        guard.is_some()
    };

    let installed = state.data_dir.join("stt").join(".venv").exists();

    let (install_phase, install_error, install_output) = {
        let guard = state.stt_install.lock().await;
        let (phase_str, error) = match &guard.phase {
            InstallPhase::Idle => ("idle", None),
            InstallPhase::Running => ("running", None),
            InstallPhase::Success => ("success", None),
            InstallPhase::Failed(e) => ("failed", Some(e.clone())),
        };
        (phase_str, error, guard.output_tail.clone())
    };

    let mut body = json!({
        "kind": cfg.kind,
        "url": cfg.url,
        "reachable": reachable,
        "local_process_running": child_running,
        "installed": installed,
        "install_phase": install_phase,
        "install_output": install_output,
    });
    if let Some(err) = install_error {
        body["install_error"] = serde_json::Value::String(err);
    }
    Ok(Json(body))
}

async fn api_stt_install(State(state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    {
        let guard = state.stt_install.lock().await;
        if guard.phase == InstallPhase::Running {
            return Ok((
                StatusCode::CONFLICT,
                Json(json!({"status": "already_running"})),
            ));
        }
    }

    {
        let mut guard = state.stt_install.lock().await;
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
                Some(s) => s,
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

        use std::process::Stdio;
        use tokio::io::{AsyncBufReadExt, BufReader};

        let mut child = match tokio::process::Command::new("sh")
            .arg("-c")
            .arg(&cmd_str)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                let mut guard = install_state.lock().await;
                guard.phase = InstallPhase::Failed(format!("spawn error: {e}"));
                return;
            }
        };

        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");

        let state_for_stdout = install_state.clone();
        let state_for_stderr = install_state.clone();

        let stdout_task = tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let mut guard = state_for_stdout.lock().await;
                if guard.output_tail.len() >= 200 {
                    guard.output_tail.remove(0);
                }
                guard.output_tail.push(line);
            }
        });

        let stderr_task = tokio::spawn(async move {
            let mut last_line = String::new();
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let mut guard = state_for_stderr.lock().await;
                if guard.output_tail.len() >= 200 {
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

        let exit_status = child.wait().await;
        let mut guard = install_state.lock().await;
        match exit_status {
            Ok(s) if s.success() => {
                guard.phase = InstallPhase::Success;
            }
            Ok(s) => {
                guard.phase = InstallPhase::Failed(format!(
                    "exit {}: {}",
                    s.code().unwrap_or(-1),
                    stderr_summary
                ));
            }
            Err(e) => {
                guard.phase = InstallPhase::Failed(format!("wait error: {e}"));
            }
        }
    });

    Ok((StatusCode::ACCEPTED, Json(json!({"status": "started"}))))
}

async fn api_stt_install_status(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let guard = state.stt_install.lock().await;
    let (phase_str, error) = match &guard.phase {
        InstallPhase::Idle => ("idle", None),
        InstallPhase::Running => ("running", None),
        InstallPhase::Success => ("success", None),
        InstallPhase::Failed(e) => ("failed", Some(e.clone())),
    };
    Ok(Json(json!({
        "phase": phase_str,
        "output": guard.output_tail,
        "error": error,
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

    let mut guard = state.stt_child.lock().await;
    if guard.is_some() {
        return Ok(StatusCode::NO_CONTENT); // already running
    }

    let child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(&cmd_str)
        .spawn()
        .map_err(|e| AppError::internal(anyhow::anyhow!("spawn start: {e}")))?;

    *guard = Some(child);
    Ok(StatusCode::NO_CONTENT)
}

async fn api_stt_stop(State(state): State<AppState>) -> Result<StatusCode, AppError> {
    let mut guard = state.stt_child.lock().await;
    if let Some(mut child) = guard.take() {
        let _ = child.kill().await;
    }
    Ok(StatusCode::NO_CONTENT)
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
        let resp = serve_static(Path("index.js".to_string())).await;
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

    #[test]
    fn pinned_host_rejects_script_breakout() {
        // Reflected-XSS guard for /s/{host}/{name}: the host is echoed into an
        // inline <script> as window.MOBUX_PEER, and serde_json does not escape
        // markup metacharacters. A host carrying </script>, '<' or '>' (or
        // quotes) must be rejected as 400, never rendered.
        for bad in [
            "</script><script>alert(1)</script>",
            "<img src=x onerror=alert(1)>",
            "<svg",
            "a>b",
            "a\"b",
            "a'b",
            "",
        ] {
            let err = validate_pinned_host(bad).expect_err(&format!("should reject {bad:?}"));
            assert_eq!(err.status, StatusCode::BAD_REQUEST, "for {bad:?}");
        }
        // Legal peers still pass and canonicalize to host:port.
        assert_eq!(validate_pinned_host("box:8443").unwrap(), "box:8443");
        assert_eq!(
            validate_pinned_host("host-1.tailnet.ts.net").unwrap(),
            "host-1.tailnet.ts.net:8080"
        );
    }

    /// Minimal AppState backed by a throwaway temp db, with `dev_mode`
    /// configurable. Only the fields the telemetry handler touches matter.
    fn test_state(dev_mode: bool) -> (AppState, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Arc::new(db::Db::open(&dir.path().join("mobux.db")).expect("open db"));
        let state = AppState {
            session_name_re: Arc::new(Regex::new(r"^[a-zA-Z0-9_-]+$").unwrap()),
            auth: None,
            cache_bust: "test".to_string(),
            db,
            stt_child: Arc::new(tokio::sync::Mutex::new(None)),
            internal_token: Arc::new("test-token".to_string()),
            port: 8080,
            data_dir: dir.path().to_path_buf(),
            use_tls: false,
            update: update::UpdateState::new(),
            dev_mode,
            stt_install: Arc::new(tokio::sync::Mutex::new(SttInstallState {
                phase: InstallPhase::Idle,
                output_tail: vec![],
            })),
        };
        (state, dir)
    }

    // /api/telemetry is inert (404, logs nothing) when dev mode is OFF — the
    // production default. Holding the TempDir alive for the call's duration.
    #[tokio::test]
    async fn telemetry_endpoint_inert_when_dev_off() {
        let (state, _dir) = test_state(false);
        let status = api_telemetry(State(state), "hello".to_string()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    // /api/telemetry accepts the body (204) when dev mode is ON (MOBUX_DEV=1).
    #[tokio::test]
    async fn telemetry_endpoint_active_when_dev_on() {
        let (state, _dir) = test_state(true);
        let status = api_telemetry(State(state), "hello".to_string()).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }

    // The dev flag is reflected verbatim into the page so the client can gate
    // itself on `window.MOBUX_DEV`.
    #[test]
    fn render_index_injects_dev_flag() {
        let on = render_index(&[], None, "v1", true);
        assert!(on.contains("window.MOBUX_DEV = true"));
        assert!(on.contains("/static/telemetry.js"));
        let off = render_index(&[], None, "v1", false);
        assert!(off.contains("window.MOBUX_DEV = false"));
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

    #[tokio::test]
    async fn stt_status_installed_reflects_venv_path() {
        let (state, dir) = test_state(false);
        let resp = api_stt_status(State(state.clone())).await.unwrap();
        assert_eq!(resp.0["installed"], false);

        let venv_path = dir.path().join("stt").join(".venv");
        std::fs::create_dir_all(&venv_path).unwrap();
        let resp2 = api_stt_status(State(state)).await.unwrap();
        assert_eq!(resp2.0["installed"], true);
    }
}
