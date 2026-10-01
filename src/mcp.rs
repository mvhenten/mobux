//! The MCP server agents on the host reach at `http://127.0.0.1:<port>/mcp`
//! (issue #334, stage 4).
//!
//! It takes no credentials: the loopback bind is the gate, and the router is
//! only ever served on its own loopback listener, never on the public or the
//! Access listener. rmcp refuses a `Host` or `Origin` that is not loopback
//! with a 403, which is what keeps a web page from reaching it through DNS
//! rebinding. Every tool calls the functions the HTTP handlers call.

use std::sync::Arc;

use axum::{http::StatusCode, Router};
use regex::Regex;
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{Implementation, ServerCapabilities, ServerConfig},
    schemars, tool, tool_handler, tool_router,
    transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    },
    ServerHandler,
};
use serde::Deserialize;

use crate::{config, db::Db, push, tmux};

pub const PATH: &str = "/mcp";

const LOOPBACK_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

const LOOPBACK_ORIGINS: [&str; 6] = [
    "http://localhost:*",
    "http://127.0.0.1:*",
    "http://[::1]:*",
    "https://localhost:*",
    "https://127.0.0.1:*",
    "https://[::1]:*",
];

/// What the tools need from the running instance.
#[derive(Clone)]
pub struct Context {
    pub session_name: Arc<Regex>,
    pub db: Arc<Db>,
    pub vapid_contact: String,
    /// Where a relative `show_on_phone` URL resolves, from the configured
    /// public hostname. `None` leaves it relative, and the phone's service
    /// worker resolves it against the origin it was installed from.
    pub public_origin: Option<String>,
}

impl Context {
    pub fn new(session_name: Arc<Regex>, db: Arc<Db>, config: &config::Config) -> Self {
        Context {
            session_name,
            db,
            vapid_contact: config.push.vapid_contact.clone(),
            public_origin: public_origin(config),
        }
    }
}

/// The router serving MCP at [`PATH`]. Mount it on a loopback listener only.
pub fn router(context: Context) -> Router {
    let config = StreamableHttpServerConfig::default()
        .with_allowed_hosts(LOOPBACK_HOSTS)
        .with_allowed_origins(LOOPBACK_ORIGINS)
        .enforce_origin_validation();
    let service = StreamableHttpService::new(
        move || Ok(Mobux::new(context.clone())),
        Arc::new(LocalSessionManager::default()),
        config,
    );
    Router::new().nest_service(PATH, service)
}

/// A 404 at [`PATH`] for every listener that is not the loopback MCP one, so
/// the public fallback never answers there.
pub fn absent<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new().route(
        PATH,
        axum::routing::any(|| async { (StatusCode::NOT_FOUND, "MCP is served on 127.0.0.1 only") }),
    )
}

/// The origin the phone reaches this instance on, with the base path and a
/// trailing slash. The Access hostname is always https; `app.domain` is https
/// when mobux or the proxy in front of it terminates TLS.
pub fn public_origin(config: &config::Config) -> Option<String> {
    let base = config.server.base_path.trim_end_matches('/');
    let access_host = config.access.hostname.trim();
    if !access_host.is_empty() {
        return Some(format!("https://{access_host}{base}/"));
    }
    let domain = config.app.domain.trim();
    if domain.is_empty() {
        return None;
    }
    let scheme = if config.tls.enabled || config.server.behind_tls_proxy {
        "https"
    } else {
        "http"
    };
    Some(format!("{scheme}://{domain}{base}/"))
}

/// The URL a notification opens. An http(s) URL stays as it is; a path is
/// taken from the instance root, so `/files/site/` and `files/site/` are the
/// same page.
pub fn link_target(url: &str, public_origin: Option<&str>) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("url is required".to_string());
    }
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Ok(url.to_string());
    }
    if has_scheme(url) {
        return Err(format!("{url}: only http and https URLs open on the phone"));
    }
    let path = url.trim_start_matches('/');
    Ok(match public_origin {
        Some(origin) => format!("{origin}{path}"),
        None => path.to_string(),
    })
}

fn has_scheme(url: &str) -> bool {
    let Some((scheme, _)) = url.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ReadScreenArgs {
    /// The tmux session name.
    pub session: String,
    /// How many scrollback lines above the screen to include, up to 10000.
    /// Absent or 0 reads the visible screen only.
    pub lines: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct RunCommandArgs {
    /// The tmux session name.
    pub session: String,
    /// One of new-window, kill-window, split-h, split-v, next-window,
    /// prev-window, next-pane, prev-pane, kill-pane, zoom-pane.
    pub command: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SendKeysArgs {
    /// The tmux session name.
    pub session: String,
    /// Text typed into the active pane as literal keystrokes.
    pub text: String,
    /// Press Enter after the text.
    pub enter: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct NotifyArgs {
    /// Notification title.
    pub title: String,
    /// Notification text.
    pub body: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ShowOnPhoneArgs {
    /// The page to open: an http(s) URL, or a path on this mobux such as
    /// /files/site/ or /proxy/vite/.
    pub url: String,
    /// Notification title.
    pub title: String,
}

#[derive(Clone)]
pub struct Mobux {
    context: Context,
    tool_router: ToolRouter<Self>,
}

impl Mobux {
    fn new(context: Context) -> Self {
        Mobux {
            context,
            tool_router: Self::tool_router(),
        }
    }

    fn session(&self, name: &str) -> Result<(), String> {
        if name.is_empty() || !self.context.session_name.is_match(name) {
            return Err(format!("invalid session name: {name:?}"));
        }
        Ok(())
    }

    fn push(&self, payload: push::Payload) -> Result<usize, String> {
        push::send_to_devices(
            self.context.db.clone(),
            self.context.vapid_contact.clone(),
            payload,
        )
        .map_err(|e| format!("{e:#}"))
    }
}

fn one_line(error: anyhow::Error) -> String {
    format!("{error:#}").replace('\n', " ")
}

#[tool_router]
impl Mobux {
    #[tool(
        description = "List the tmux sessions: name, window count, the active window and whether it is on the alternate screen (a full-screen app such as vim or less)."
    )]
    async fn list_sessions(&self) -> Result<String, String> {
        let sessions = tmux::list_sessions(None).await.map_err(one_line)?;
        if sessions.is_empty() {
            return Ok("no tmux sessions".to_string());
        }
        let mut lines = Vec::with_capacity(sessions.len());
        for session in sessions {
            let windows = tmux::list_panes(&session.name, None)
                .await
                .map_err(one_line)?;
            let line = match windows.iter().find(|window| window.active) {
                Some(active) => format!(
                    "{}\twindows={}\tactive={}:{}\talternate_screen={}",
                    session.name,
                    session.windows,
                    active.index,
                    active.title,
                    if active.alternate_on { "yes" } else { "no" }
                ),
                None => format!("{}\twindows={}", session.name, session.windows),
            };
            lines.push(line);
        }
        Ok(lines.join("\n"))
    }

    #[tool(
        description = "Read the active pane of a session as plain text: the visible screen, plus up to `lines` scrollback lines above it."
    )]
    async fn read_screen(
        &self,
        Parameters(args): Parameters<ReadScreenArgs>,
    ) -> Result<String, String> {
        self.session(&args.session)?;
        let lines = args.lines.unwrap_or(0).min(crate::HISTORY_MAX_LINES);
        let capture = tmux::capture_history(&args.session, lines, tmux::HistoryScope::All, None)
            .await
            .map_err(one_line)?;
        Ok(crate::strip_ansi(&capture.text).trim_end().to_string())
    }

    #[tool(
        description = "Run a tmux command on a session: new-window, kill-window, split-h, split-v, next-window, prev-window, next-pane, prev-pane, kill-pane or zoom-pane."
    )]
    async fn run_tmux_command(
        &self,
        Parameters(args): Parameters<RunCommandArgs>,
    ) -> Result<String, String> {
        self.session(&args.session)?;
        if !tmux::COMMANDS.contains(&args.command.as_str()) {
            return Err(format!(
                "unknown command {:?}; use one of {}",
                args.command,
                tmux::COMMANDS.join(", ")
            ));
        }
        tmux::list_panes(&args.session, None)
            .await
            .map_err(one_line)?;
        let output = tmux::run_command(&args.session, &args.command, None)
            .await
            .map_err(one_line)?;
        let output = output.trim();
        if output.is_empty() {
            return Ok(format!("{} on {}: done", args.command, args.session));
        }
        Ok(format!("{} on {}: {output}", args.command, args.session))
    }

    #[tool(
        description = "Type text into the active pane of a session as literal keystrokes, optionally followed by Enter."
    )]
    async fn send_keys(
        &self,
        Parameters(args): Parameters<SendKeysArgs>,
    ) -> Result<String, String> {
        self.session(&args.session)?;
        let enter = args.enter.unwrap_or(false);
        tmux::send_text(&args.session, &args.text, enter, None)
            .await
            .map_err(one_line)?;
        let typed = args.text.chars().count();
        Ok(match enter {
            true => format!("typed {typed} characters and Enter into {}", args.session),
            false => format!("typed {typed} characters into {}", args.session),
        })
    }

    #[tool(description = "Send a push notification to every phone subscribed to this mobux.")]
    async fn notify(&self, Parameters(args): Parameters<NotifyArgs>) -> Result<String, String> {
        if args.body.trim().is_empty() {
            return Err("body is required".to_string());
        }
        let devices = self.push(push::Payload {
            title: args.title,
            body: args.body,
            tag: None,
            url: None,
        })?;
        Ok(format!("notification sent to {devices} device(s)"))
    }

    #[tool(
        description = "Push a notification that opens a page on the phone when tapped: an http(s) URL, or a path on this mobux such as /files/site/ or /proxy/vite/."
    )]
    async fn show_on_phone(
        &self,
        Parameters(args): Parameters<ShowOnPhoneArgs>,
    ) -> Result<String, String> {
        let target = link_target(&args.url, self.context.public_origin.as_deref())?;
        let devices = self.push(push::Payload {
            title: args.title,
            body: target.clone(),
            tag: None,
            url: Some(target.clone()),
        })?;
        Ok(format!("sent {target} to {devices} device(s)"))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for Mobux {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("mobux", env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "mobux runs the tmux sessions on this host and shows them on the user's phone. \
                 Read and drive those sessions, and push a notification or a page to the phone.",
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    const INITIALIZE: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}"#;

    fn test_router() -> (Router, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open(&dir.path().join("mobux.db")).unwrap());
        let context = Context::new(
            Arc::new(Regex::new(r"^[a-zA-Z0-9_-]+$").unwrap()),
            db,
            &config::Config::default(),
        );
        (router(context), dir)
    }

    async fn post(host: &str, origin: Option<&str>) -> (StatusCode, String) {
        let (router, _dir) = test_router();
        let mut request = Request::post(PATH)
            .header("host", host)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream");
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        let response = router
            .oneshot(request.body(Body::from(INITIALIZE)).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    #[tokio::test]
    async fn a_loopback_host_without_an_origin_is_served() {
        for host in ["127.0.0.1:8415", "localhost:8415", "[::1]:8415"] {
            let (status, _) = post(host, None).await;
            assert_eq!(status, StatusCode::OK, "{host}");
        }
    }

    #[tokio::test]
    async fn a_loopback_origin_is_served() {
        let (status, _) = post("127.0.0.1:8415", Some("http://localhost:3000")).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn a_non_loopback_host_is_refused_with_one_line() {
        for host in ["evil.example", "evil.example:8415", "192.168.1.5:8415"] {
            let (status, body) = post(host, None).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{host}");
            assert_eq!(body, "Forbidden: Host header is not allowed");
        }
    }

    #[tokio::test]
    async fn a_non_loopback_origin_is_refused_with_one_line() {
        for origin in [
            "http://evil.example",
            "https://127.0.0.1.evil.example",
            "null",
        ] {
            let (status, body) = post("127.0.0.1:8415", Some(origin)).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{origin}");
            assert_eq!(body, "Forbidden: Origin header is not allowed");
        }
    }

    #[tokio::test]
    async fn the_other_listeners_answer_404_at_the_mcp_path() {
        let response = absent::<()>()
            .oneshot(
                Request::post(PATH)
                    .header("host", "127.0.0.1")
                    .body(Body::from(INITIALIZE))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn a_path_resolves_against_the_public_origin() {
        let origin = Some("https://phone.example/mobux/");
        assert_eq!(
            link_target("/files/site/", origin).unwrap(),
            "https://phone.example/mobux/files/site/"
        );
        assert_eq!(
            link_target("proxy/vite/", origin).unwrap(),
            "https://phone.example/mobux/proxy/vite/"
        );
        assert_eq!(link_target("/files/site/", None).unwrap(), "files/site/");
    }

    #[test]
    fn an_http_url_is_kept_and_other_schemes_are_refused() {
        assert_eq!(
            link_target("https://example.com/a", None).unwrap(),
            "https://example.com/a"
        );
        assert!(link_target("javascript:alert(1)", None).is_err());
        assert!(link_target("  ", None).is_err());
    }

    #[test]
    fn the_public_origin_comes_from_the_configured_hostname() {
        let mut config = config::Config::default();
        assert_eq!(public_origin(&config), None);
        config.app.domain = "box:5151".to_string();
        assert_eq!(public_origin(&config).as_deref(), Some("http://box:5151/"));
        config.tls.enabled = true;
        config.server.base_path = "/mobux".to_string();
        assert_eq!(
            public_origin(&config).as_deref(),
            Some("https://box:5151/mobux/")
        );
        config.access.hostname = "mobux.example.com".to_string();
        assert_eq!(
            public_origin(&config).as_deref(),
            Some("https://mobux.example.com/mobux/")
        );
    }
}
