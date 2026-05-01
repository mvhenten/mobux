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
        HeaderValue, Request, StatusCode,
    },
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
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
use tower_http::services::ServeDir;

mod db;
mod push;
mod ssl;
mod tmux;

#[derive(Clone)]
struct AppState {
    session_name_re: Arc<Regex>,
    auth: Option<AuthConfig>,
    cache_bust: String,
    db: Arc<db::Db>,
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

    let state = AppState {
        session_name_re: Arc::new(Regex::new(r"^[a-zA-Z0-9._-]+$")?),
        auth,
        cache_bust: format!(
            "{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs()
        ),
        db,
    };

    let state_for_mw = state.clone();
    let app = Router::new()
        .route("/", get(index))
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
        .route("/api/debug", post(api_debug_log))
        .route("/api/upload", post(api_upload))
        .route("/api/push/vapid-public-key", get(api_push_vapid_public_key))
        .route(
            "/api/push/subscribe",
            post(api_push_subscribe).delete(api_push_unsubscribe),
        )
        .route("/api/push/devices", get(api_push_devices))
        .route("/s/{name}", get(terminal_page))
        .route("/ws/{name}", get(terminal_ws))
        .route("/sw.js", get(serve_sw))
        .nest_service("/static", ServeDir::new("web/static"))
        .fallback(get(|| async { axum::response::Redirect::temporary("/") }))
        .with_state(state.clone())
        .layer(middleware::from_fn_with_state(
            state_for_mw,
            auth_middleware,
        ));

    let port = env::var("PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(8080);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    if state.auth.is_some() {
        println!("auth: enabled (HTTP Basic)");
    } else {
        println!("auth: disabled (set MOBUX_AUTH_USER/MOBUX_AUTH_PASS or MOBUX_PIN)");
    }

    let use_tls = env::var("MOBUX_TLS")
        .map(|v| v != "0" && v.to_lowercase() != "false")
        .unwrap_or(true);

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

fn load_auth_config() -> Option<AuthConfig> {
    let user_env = env::var("MOBUX_AUTH_USER")
        .ok()
        .map(|v| v.trim().to_string());
    let pass_env = env::var("MOBUX_AUTH_PASS")
        .ok()
        .map(|v| v.trim().to_string());
    let pin_env = env::var("MOBUX_PIN").ok().map(|v| v.trim().to_string());

    let session_cookie_name = "mobux_session".to_string();
    let session_cookie_value: String = rand::rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect();

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

async fn auth_middleware(
    State(state): State<AppState>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let Some(auth) = &state.auth else {
        return next.run(req).await;
    };

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

async fn index(State(state): State<AppState>) -> Result<Html<String>, AppError> {
    let sessions = tmux::list_sessions().await.map_err(AppError::bad_request)?;
    Ok(Html(render_index(&sessions, None, &state.cache_bust)))
}

async fn api_sessions() -> Result<Json<Vec<tmux::Session>>, AppError> {
    let sessions = tmux::list_sessions().await.map_err(AppError::bad_request)?;
    Ok(Json(sessions))
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

async fn api_debug_log(body: String) -> StatusCode {
    use std::fs::OpenOptions;
    use std::io::Write as _;
    let path = "debug-input.log";
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let ts = chrono::Local::now().format("%H:%M:%S%.3f");
        let _ = writeln!(f, "--- {ts} ---");
        let _ = writeln!(f, "{body}");
    }
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

async fn terminal_page(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Html<String>, AppError> {
    validate_session_name(&state, &name)?;
    Ok(Html(render_terminal_page(&name, &state.cache_bust)))
}

async fn serve_sw() -> impl axum::response::IntoResponse {
    use axum::http::header;
    (
        [(header::CONTENT_TYPE, "text/javascript")],
        include_str!("../web/static/sw.js"),
    )
}

async fn terminal_ws(
    State(state): State<AppState>,
    Path(name): Path<String>,
    ws: WebSocketUpgrade,
) -> Result<Response, AppError> {
    validate_session_name(&state, &name)?;
    let db = state.db.clone();
    Ok(ws.on_upgrade(move |socket| async move {
        if let Err(err) = handle_ws(socket, name, db).await {
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
    db: Arc<db::Db>,
) -> Result<()> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: 35,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut cmd = CommandBuilder::new("bash");
    cmd.args([
        "-c",
        &format!(
            "tmux set-option -g mouse on 2>/dev/null; tmux set-window-option -g aggressive-resize on 2>/dev/null; tmux attach-session -t {}",
            &session_name
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
                        // BEL (\x07) → Web Push notification. Multiple BELs in
                        // one chunk fire one notification (per-chunk debounce);
                        // OS-side coalescing via the per-session `tag` handles
                        // bursts across chunks.
                        if chunk.contains(&0x07) {
                            eprintln!("push: BEL detected on session {session_name}");
                            let db_for_push = db.clone();
                            let session_for_push = session_name.clone();
                            tokio::spawn(push::notify_bell(db_for_push, session_for_push));
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

fn render_index(sessions: &[tmux::Session], error: Option<&str>, v: &str) -> String {
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

  <script src="/static/index.js?v={v}"></script>
  <script>if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');</script>
</body>
</html>
"##
    )
}

fn render_terminal_page(session: &str, v: &str) -> String {
    let session_json = serde_json::to_string(session).unwrap_or_else(|_| "\"\"".to_string());
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
  <link rel="stylesheet" href="/static/vendor/xterm.css?v={v}" />
</head>
<body class="term-body">
  <div id="terminal"></div>
  <div id="loadquote"><q id="quote"></q><br><cite id="qauthor"></cite></div>
  <div id="touchOverlay"></div>
  <div id="paneIndicator"></div>
  <div id="cmdOverlayBg"></div>
  <div id="cmdPickList">
    <div class="cmd-header">
      <h3>tmux</h3>
      <button class="cmd-close" id="cmdCloseBtn">✕</button>
    </div>
    <button class="cmd-item" data-cmd="new-window"><span class="cmd-icon">➕</span><span class="cmd-label">New Window</span></button>
    <button class="cmd-item" data-cmd="kill-window"><span class="cmd-icon">❌</span><span class="cmd-label">Close Window</span></button>
    <div class="cmd-separator"></div>
    <button class="cmd-item" data-cmd="split-h"><span class="cmd-icon">│</span><span class="cmd-label">Split Horizontal</span></button>
    <button class="cmd-item" data-cmd="split-v"><span class="cmd-icon">─</span><span class="cmd-label">Split Vertical</span></button>
    <button class="cmd-item" data-cmd="kill-pane"><span class="cmd-icon">🗑</span><span class="cmd-label">Close Pane</span></button>
    <div class="cmd-separator"></div>
    <button class="cmd-item" data-cmd="next-window"><span class="cmd-icon">▶</span><span class="cmd-label">Next Window</span></button>
    <button class="cmd-item" data-cmd="prev-window"><span class="cmd-icon">◀</span><span class="cmd-label">Previous Window</span></button>
    <button class="cmd-item" data-cmd="next-pane"><span class="cmd-icon">↻</span><span class="cmd-label">Next Pane</span></button>
    <button class="cmd-item" data-cmd="prev-pane"><span class="cmd-icon">↺</span><span class="cmd-label">Previous Pane</span></button>
    <button class="cmd-item" data-cmd="zoom-pane"><span class="cmd-icon">🔍</span><span class="cmd-label">Zoom Pane</span></button>
  </div>

  <div id="inputBar" class="input-bar hidden">
    <div id="inputRibbon" class="input-ribbon">
      <button id="pushToggleBtn" hidden title="Notifications">🔔</button>
      <button id="uploadBtn">📷</button>
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
    </div>
    <div class="input-row">
      <input id="inputText" type="text" enterkeyhint="send" placeholder="Type here…" autocomplete="off" autocorrect="on" autocapitalize="off" spellcheck="false" />
      <button id="inputSend" class="input-send" title="Send without Enter">▶</button>
    </div>
  </div>

  <script>
    window.MOBUX_SESSION = {session_json};
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
  </script>
  <script src="/static/vendor/xterm.bundle.js?v={v}"></script>
  <script type="module" src="/static/terminal.js?v={v}"></script>
  <script src="/static/push.js?v={v}"></script>
</body>
</html>
"##
    )
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
}
