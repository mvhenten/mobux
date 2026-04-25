use std::{
    env,
    io::{Read, Write},
    net::SocketAddr,
    sync::{Arc, Mutex},
};

use anyhow::Result;
use axum::{
    extract::{ws::Message, Path, State, WebSocketUpgrade},
    http::{
        header::{AUTHORIZATION, WWW_AUTHENTICATE},
        HeaderValue, Request, StatusCode,
    },
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use rand::{distr::Alphanumeric, Rng};
use regex::Regex;
use serde::Deserialize;
use serde_json::json;
use tower_http::services::ServeDir;

mod ssl;
mod tmux;

#[derive(Clone)]
struct AppState {
    session_name_re: Arc<Regex>,
    auth: Option<AuthConfig>,
    cache_bust: String,
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
    let state = AppState {
        session_name_re: Arc::new(Regex::new(r"^[a-zA-Z0-9._-]+$")?),
        auth,
        cache_bust: format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()),
    };

    let state_for_mw = state.clone();
    let app = Router::new()
        .route("/", get(index))
        .route("/api/sessions", get(api_sessions).post(api_create_session))
        .route("/api/sessions/{name}/kill", post(api_kill_session))
        .route("/api/sessions/{name}/panes", get(api_list_panes))
        .route("/api/sessions/{name}/panes/{pane}/select", post(api_select_pane))
        .route("/api/sessions/{name}/send", post(api_send_to_session))
        .route("/api/sessions/{name}/history", get(api_session_history))
        .route("/api/sessions/{name}/command", post(api_tmux_command))
        .route("/s/{name}", get(terminal_page))
        .route("/ws/{name}", get(terminal_ws))
        .nest_service("/static", ServeDir::new("web/static"))
        .fallback(get(|| async { axum::response::Redirect::temporary("/") }))
        .with_state(state.clone())
        .layer(middleware::from_fn_with_state(state_for_mw, auth_middleware));

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

    let use_tls = env::var("MOBUX_TLS").map(|v| v != "0" && v.to_lowercase() != "false").unwrap_or(true);

    if use_tls {
        let extra_hosts: Vec<String> = env::var("MOBUX_TLS_HOSTS")
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        let (cert_path, key_path) = ssl::ensure_dev_cert(&extra_hosts)?;
        let tls_config = ssl::load_rustls_config(&cert_path, &key_path)?;
        let rustls_config = axum_server::tls_rustls::RustlsConfig::from_config(std::sync::Arc::new(tls_config));

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

fn load_auth_config() -> Option<AuthConfig> {
    let user_env = env::var("MOBUX_AUTH_USER").ok().map(|v| v.trim().to_string());
    let pass_env = env::var("MOBUX_AUTH_PASS").ok().map(|v| v.trim().to_string());
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
            user: user_opt.filter(|u| !u.is_empty()).unwrap_or_else(|| "mobux".to_string()),
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
    resp.headers_mut()
        .insert(WWW_AUTHENTICATE, HeaderValue::from_static("Basic realm=\"mobux\""));
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
    tmux::new_session(name).await.map_err(AppError::bad_request)?;
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

async fn api_list_panes(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<Vec<tmux::Pane>>, AppError> {
    validate_session_name(&state, &name)?;
    let panes = tmux::list_panes(&name).await.map_err(AppError::bad_request)?;
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

#[derive(Deserialize)]
struct SendReq {
    text: String,
}

async fn api_send_to_session(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(payload): Json<SendReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    validate_session_name(&state, &name)?;
    let text = payload.text.trim();
    if text.is_empty() {
        return Err(AppError::bad_request(anyhow::anyhow!("text is required")));
    }
    if text.len() > 800 {
        return Err(AppError::bad_request(anyhow::anyhow!("text too long")));
    }
    tmux::send_line(&name, text)
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

async fn terminal_page(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Html<String>, AppError> {
    validate_session_name(&state, &name)?;
    Ok(Html(render_terminal_page(&name, &state.cache_bust)))
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
        cards.push_str(r#"<p class="hint">No tmux sessions found.</p>"#);
    } else {
        for s in sessions {
            let name = html_escape::encode_text(&s.name);
            cards.push_str(&format!(
                r#"<article class="session-card" data-name="{name}">
  <div class="session-head">
    <h3>{name}</h3>
    <div class="meta">{} windows · {} attached</div>
  </div>
  <div class="actions">
    <a class="btn btn-primary" href="/s/{name}">Open</a>
    <button class="btn danger" data-kill="{name}">Kill</button>
  </div>
</article>"#,
                s.windows, s.attached
            ));
        }
    }

    let error_html = error
        .map(|e| format!(r#"<section class="panel error">{}</section>"#, html_escape::encode_text(e)))
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
  <link rel="apple-touch-icon" href="/static/icon-192.svg" />
  <link rel="stylesheet" href="/static/style.css?v={v}" />
</head>
<body>
  <main class="container">
    <header class="header">
      <h1>mobux</h1>
      <span class="tagline">tmux on your phone</span>
    </header>

    <section class="panel">
      <h2>New session</h2>
      <form id="newSessionForm">
        <input id="sessionName" placeholder="session-name" autocomplete="off" required />
        <button class="btn btn-create" type="submit">Create</button>
      </form>
    </section>

    {error_html}

    <section class="panel">
      <h2>Sessions</h2>
      <div id="sessionList" class="session-list">
        {cards}
      </div>
    </section>

    <footer class="footer">mobux v{v} · ctrl-c to exit</footer>
  </main>

  <script src="/static/index.js?v={v}"></script>
  <script>if ('serviceWorker' in navigator) navigator.serviceWorker.register('/static/sw.js');</script>
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
  <link rel="apple-touch-icon" href="/static/icon-192.svg" />
  <link rel="stylesheet" href="/static/style.css?v={v}" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm/css/xterm.css" />
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

  <script>
    window.MOBUX_SESSION = {session_json};
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/static/sw.js');
  </script>
  <script src="https://cdn.jsdelivr.net/npm/xterm/lib/xterm.js"></script>
  <script type="module" src="/static/terminal.js?v={v}"></script>
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
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.status, self.message).into_response()
    }
}
