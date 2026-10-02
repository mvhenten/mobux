//! The MCP switch on the Settings page. The `mcp` block of `config.json` is
//! the one source of truth: a change rewrites that block and then starts,
//! stops or rebinds the loopback listener to match. A bind that fails puts
//! the file back, so the file and the running listener never disagree.

use std::io::Write;
use std::net::Ipv4Addr;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::{config, mcp};

/// The port the switch offers when the file names none.
pub const DEFAULT_PORT: u16 = 8415;

/// How long a stopped listener gets to close its connections before its
/// task is aborted.
const STOP_GRACE: Duration = Duration::from_secs(2);

/// Which layer above the file sets the port, if any. The Settings switch only
/// writes the file, so it is read-only while one of these wins.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ManagedBy {
    Env,
    Flag,
}

impl ManagedBy {
    pub fn detect(env: &config::EnvSnapshot, flags: &config::PartialConfig) -> Option<Self> {
        let stated = |partial: &config::PartialConfig| {
            partial.mcp.as_ref().and_then(|mcp| mcp.port).is_some()
        };
        if stated(flags) {
            return Some(ManagedBy::Flag);
        }
        if stated(&config::env_partial(env)) {
            return Some(ManagedBy::Env);
        }
        None
    }

    pub fn reason(self) -> &'static str {
        match self {
            ManagedBy::Env => "MOBUX_MCP_PORT sets the port; unset it to use this switch.",
            ManagedBy::Flag => "--mcp-port sets the port; drop it to use this switch.",
        }
    }
}

/// What `GET /api/settings/mcp` answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Status {
    /// `mcp.port` as config.json states it; 0 is off. While `managed_by` is
    /// set this is still the file's value, not the port in use.
    pub port: u16,
    pub listening: bool,
    /// The port the listener is bound to right now, whichever layer set it.
    pub listening_port: Option<u16>,
    pub managed_by: Option<ManagedBy>,
    /// Why the switch is read-only, when `managed_by` is set.
    pub managed_note: Option<String>,
    /// Why the listener is not running although it should be: a port that
    /// would not bind at startup.
    pub error: Option<String>,
    pub default_port: u16,
    pub command: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SetError {
    Invalid(String),
    Managed(String),
    Bind(String),
    Io(String),
}

struct Running {
    port: u16,
    shutdown: CancellationToken,
    task: JoinHandle<()>,
}

impl Running {
    /// Ends the MCP sessions and the open connections, not only the accept
    /// loop, and returns once the port is free.
    async fn stop(self) {
        self.shutdown.cancel();
        let abort = self.task.abort_handle();
        if tokio::time::timeout(STOP_GRACE, self.task).await.is_err() {
            abort.abort();
        }
    }
}

#[derive(Default)]
struct Listener {
    running: Option<Running>,
    error: Option<String>,
}

pub struct McpServer {
    context: mcp::Context,
    config: Arc<config::Config>,
    path: PathBuf,
    managed_by: Option<ManagedBy>,
    listener: Mutex<Listener>,
}

impl McpServer {
    pub fn new(
        context: mcp::Context,
        config: Arc<config::Config>,
        path: PathBuf,
        managed_by: Option<ManagedBy>,
    ) -> Self {
        McpServer {
            context,
            config,
            path,
            managed_by,
            listener: Mutex::new(Listener::default()),
        }
    }

    /// Start on the port the instance resolved at startup. A port that will
    /// not bind leaves MCP off and the rest of mobux running; the Settings
    /// page shows why.
    pub async fn start_configured(&self) {
        let port = self.config.mcp.port;
        if port == 0 {
            return;
        }
        let mut listener = self.listener.lock().await;
        match bind(port).await {
            Ok(bound) => listener.running = Some(self.serve(port, bound)),
            Err(reason) => {
                eprintln!("mcp: NOT STARTED — {reason}");
                listener.error = Some(reason);
            }
        }
    }

    pub async fn status(&self) -> Result<Status, String> {
        let listener = self.listener.lock().await;
        self.status_of(&listener)
    }

    /// Bind the new port, write `port` (0 is off) to the file, then swap the
    /// listener. The file only ever names a port that was just bound, so a
    /// crash part way never leaves one mobux cannot start with.
    pub async fn set(&self, port: u16) -> Result<Status, SetError> {
        let mut listener = self.listener.lock().await;
        if let Some(managed) = self.managed_by {
            return Err(SetError::Managed(managed.reason().to_string()));
        }

        let previous = read_optional(&self.path).map_err(SetError::Io)?;
        let next = with_mcp_port(previous.as_deref(), port).map_err(SetError::Invalid)?;
        config::parse(&self.path, &next).map_err(|e| SetError::Invalid(e.to_string()))?;
        let mut effective = (*self.config).clone();
        effective.mcp.port = port;
        config::check_mcp(&effective).map_err(SetError::Invalid)?;

        let current = listener.running.as_ref().map(|r| r.port);
        let bound = match port {
            0 => None,
            port if current == Some(port) => None,
            port => Some(bind(port).await.map_err(SetError::Bind)?),
        };
        write_atomic(&self.path, &next).map_err(|e| SetError::Io(e.to_string()))?;

        listener.error = None;
        let replaced = match bound {
            Some(bound) => listener.running.replace(self.serve(port, bound)),
            None if port == 0 => listener.running.take(),
            None => None,
        };
        if let Some(old) = replaced {
            old.stop().await;
        }
        self.status_of(&listener).map_err(SetError::Io)
    }

    fn status_of(&self, listener: &Listener) -> Result<Status, String> {
        let port = config::load_partial_from(&self.path)
            .map_err(|e| e.to_string())?
            .and_then(|partial| partial.mcp)
            .and_then(|mcp| mcp.port)
            .unwrap_or(0);
        let listening_port = listener.running.as_ref().map(|r| r.port);
        let shown = listening_port
            .or(Some(port).filter(|p| *p != 0))
            .unwrap_or(DEFAULT_PORT);
        Ok(Status {
            port,
            listening: listening_port.is_some(),
            listening_port,
            managed_by: self.managed_by,
            managed_note: self.managed_by.map(|m| m.reason().to_string()),
            error: listener.error.clone(),
            default_port: DEFAULT_PORT,
            command: registration_command(shown),
        })
    }

    fn serve(&self, port: u16, bound: tokio::net::TcpListener) -> Running {
        let shutdown = CancellationToken::new();
        let app = mcp::router(self.context.clone(), shutdown.clone());
        let signal = shutdown.clone().cancelled_owned();
        let task = tokio::spawn(async move {
            if let Err(e) = axum::serve(bound, app).with_graceful_shutdown(signal).await {
                eprintln!("mcp listener error: {e:#}");
            }
        });
        println!("mcp: http://127.0.0.1:{port}{}", mcp::PATH);
        Running {
            port,
            shutdown,
            task,
        }
    }
}

async fn bind(port: u16) -> Result<tokio::net::TcpListener, String> {
    tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(|e| format!("cannot listen on 127.0.0.1:{port}: {e}"))
}

pub fn registration_command(port: u16) -> String {
    format!(
        "claude mcp add --scope user --transport http mobux http://127.0.0.1:{port}{}",
        mcp::PATH
    )
}

fn with_mcp_port(raw: Option<&str>, port: u16) -> Result<String, String> {
    with_keys(raw, &[("mcp", "port", port.into())])
}

/// Set each `block.key` and leave every other key where it was; serde_json
/// keeps insertion order (`preserve_order`).
pub(crate) fn with_keys(
    raw: Option<&str>,
    keys: &[(&str, &str, serde_json::Value)],
) -> Result<String, String> {
    let mut document: serde_json::Value = match raw {
        Some(raw) => serde_json::from_str(raw).map_err(|e| format!("config.json: {e}"))?,
        None => serde_json::json!({}),
    };
    let root = document
        .as_object_mut()
        .ok_or("config.json: the top level must be an object")?;
    for (block, key, value) in keys {
        let block = root
            .entry(block.to_string())
            .or_insert_with(|| serde_json::json!({}));
        if !block.is_object() {
            *block = serde_json::json!({});
        }
        block
            .as_object_mut()
            .expect("just made an object")
            .insert(key.to_string(), value.clone());
    }
    let text = serde_json::to_string_pretty(&document).map_err(|e| e.to_string())?;
    Ok(format!("{text}\n"))
}

pub(crate) fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => Ok(Some(raw)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Replace the file in one rename, through a symlink to the file it names,
/// at mode 600 because it can hold the PIN.
pub(crate) fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let parent = target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
        .to_path_buf();
    std::fs::create_dir_all(&parent)?;
    let mut staging = target.clone().into_os_string();
    staging.push(".tmp");
    let staging = PathBuf::from(staging);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&staging)?;
    std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o600))?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    std::fs::rename(&staging, &target)?;
    std::fs::File::open(&parent)?.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use regex::Regex;

    const INITIALIZE: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}"#;
    const INITIALIZED: &str = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
    const LIST_TOOLS: &str = r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#;

    struct Fixture {
        dir: tempfile::TempDir,
        server: McpServer,
    }

    impl Fixture {
        fn path(&self) -> PathBuf {
            self.dir.path().join(config::CONFIG_FILE_NAME)
        }

        fn file(&self) -> Option<String> {
            read_optional(&self.path()).unwrap()
        }
    }

    fn fixture_with(file: Option<&str>, managed_by: Option<ManagedBy>) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(config::CONFIG_FILE_NAME);
        if let Some(text) = file {
            std::fs::write(&path, text).unwrap();
        }
        let config = Arc::new(config::load_from(&path).unwrap());
        let db = Arc::new(Db::open(&dir.path().join("mobux.db")).unwrap());
        let context = mcp::Context::new(
            Arc::new(Regex::new(r"^[a-zA-Z0-9_-]+$").unwrap()),
            db,
            &config,
        );
        let server = McpServer::new(context, config, path, managed_by);
        Fixture { dir, server }
    }

    fn fixture(file: Option<&str>) -> Fixture {
        fixture_with(file, None)
    }

    fn free_port() -> u16 {
        std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    async fn initialize(port: u16) -> Result<reqwest::StatusCode, reqwest::Error> {
        reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}{}", mcp::PATH))
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .body(INITIALIZE)
            .send()
            .await
            .map(|response| response.status())
    }

    async fn refused(port: u16) -> bool {
        tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port))
            .await
            .is_err()
    }

    #[tokio::test]
    async fn the_switch_writes_the_mcp_block_and_keeps_every_other_key_in_order() {
        let original = r#"{
  "server": {
    "port": 7000
  },
  "auth": {
    "user": "me",
    "pin": "12345"
  },
  "proxy": {
    "targets": {
      "zeta": 5173,
      "alpha": 3000
    }
  }
}
"#;
        let fx = fixture(Some(original));
        let port = free_port();
        fx.server.set(port).await.unwrap();
        let expected = format!(
            "{}{}",
            original.trim_end().trim_end_matches('}'),
            format_args!("  ,\n  \"mcp\": {{\n    \"port\": {port}\n  }}\n}}\n")
        )
        .replace("  }\n  ,\n", "  },\n");
        assert_eq!(fx.file().unwrap(), expected);
        fx.server.set(0).await.unwrap();
        assert!(fx.file().unwrap().contains("\"port\": 0"));
    }

    #[tokio::test]
    async fn turning_it_off_ends_a_connected_session() {
        let fx = fixture(None);
        let port = free_port();
        fx.server.set(port).await.unwrap();
        let url = format!("http://127.0.0.1:{port}{}", mcp::PATH);
        let client = reqwest::Client::new();
        let post = |body: &'static str, session: Option<&str>| {
            let mut request = client
                .post(&url)
                .header("content-type", "application/json")
                .header("accept", "application/json, text/event-stream")
                .body(body);
            if let Some(session) = session {
                request = request.header("mcp-session-id", session.to_string());
            }
            request.send()
        };

        let init = post(INITIALIZE, None).await.unwrap();
        let session = init.headers()["mcp-session-id"]
            .to_str()
            .unwrap()
            .to_string();
        init.text().await.unwrap();
        let ack = post(INITIALIZED, Some(&session)).await.unwrap();
        assert!(ack.status().is_success(), "{}", ack.status());
        let stream = client
            .get(&url)
            .header("accept", "text/event-stream")
            .header("mcp-session-id", &session)
            .send()
            .await
            .unwrap();
        assert_eq!(stream.status(), reqwest::StatusCode::OK);

        fx.server.set(0).await.unwrap();
        let ended = tokio::time::timeout(Duration::from_secs(5), stream.text()).await;
        assert!(ended.is_ok(), "the open stream outlived the switch");
        let next = post(LIST_TOOLS, Some(&session)).await;
        assert!(next.is_err(), "a request after off was answered: {next:?}");
    }

    #[tokio::test]
    async fn a_port_that_will_not_bind_at_startup_leaves_mcp_off_and_says_why() {
        let taken = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = taken.local_addr().unwrap().port();
        let fx = fixture(Some(&format!("{{\"mcp\": {{\"port\": {port}}}}}")));
        fx.server.start_configured().await;

        let status = fx.server.status().await.unwrap();
        assert!(!status.listening);
        assert_eq!(status.port, port);
        let error = status.error.unwrap();
        assert!(
            error.contains(&format!("cannot listen on 127.0.0.1:{port}")),
            "{error}"
        );

        let free = free_port();
        let status = fx.server.set(free).await.unwrap();
        assert!(status.listening);
        assert_eq!(status.error, None);
    }

    #[tokio::test]
    async fn an_env_managed_port_reports_the_running_port_apart_from_the_file() {
        let fx = fixture_with(Some("{\"mcp\": {\"port\": 9200}}"), Some(ManagedBy::Env));
        let running = free_port();
        {
            let mut listener = fx.server.listener.lock().await;
            let bound = bind(running).await.unwrap();
            listener.running = Some(fx.server.serve(running, bound));
        }
        let status = fx.server.status().await.unwrap();
        assert_eq!(status.port, 9200);
        assert_eq!(status.listening_port, Some(running));
        assert_eq!(
            status.managed_note.as_deref(),
            Some("MOBUX_MCP_PORT sets the port; unset it to use this switch.")
        );
    }

    #[tokio::test]
    async fn configure_check_passes_after_a_change() {
        let fx = fixture(None);
        fx.server.set(free_port()).await.unwrap();
        assert!(crate::configure::check_report(&fx.path(), true).is_ok());
        fx.server.set(0).await.unwrap();
        assert!(crate::configure::check_report(&fx.path(), true).is_ok());
    }

    #[tokio::test]
    async fn a_hand_edit_of_the_file_shows_after_a_restart() {
        let fx = fixture(None);
        std::fs::write(fx.path(), "{\"mcp\": {\"port\": 9123}}").unwrap();
        let restarted = fixture_with(Some(&fx.file().unwrap()), None);
        let status = restarted.server.status().await.unwrap();
        assert_eq!(status.port, 9123);
        assert!(!status.listening);
        assert_eq!(
            status.command,
            "claude mcp add --scope user --transport http mobux http://127.0.0.1:9123/mcp"
        );
    }

    #[tokio::test]
    async fn off_by_default_offers_the_default_port() {
        let status = fixture(None).server.status().await.unwrap();
        assert_eq!(status.port, 0);
        assert!(!status.listening);
        assert_eq!(status.managed_by, None);
        assert!(status.command.ends_with("http://127.0.0.1:8415/mcp"));
    }

    #[tokio::test]
    async fn turning_it_on_serves_mcp_and_off_closes_the_port() {
        let fx = fixture(None);
        let port = free_port();
        let status = fx.server.set(port).await.unwrap();
        assert!(status.listening);
        assert_eq!(status.listening_port, Some(port));
        assert_eq!(initialize(port).await.unwrap(), reqwest::StatusCode::OK);

        let status = fx.server.set(0).await.unwrap();
        assert!(!status.listening);
        assert!(refused(port).await);
    }

    #[tokio::test]
    async fn a_port_change_closes_the_old_port_and_opens_the_new_one() {
        let fx = fixture(None);
        let old = free_port();
        fx.server.set(old).await.unwrap();
        let new = free_port();
        fx.server.set(new).await.unwrap();
        assert!(refused(old).await);
        assert_eq!(initialize(new).await.unwrap(), reqwest::StatusCode::OK);
    }

    #[tokio::test]
    async fn a_port_in_use_is_refused_and_the_file_is_left_alone() {
        let original = "{\"server\": {\"port\": 7000}}";
        let fx = fixture(Some(original));
        let taken = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = taken.local_addr().unwrap().port();

        let err = fx.server.set(port).await.unwrap_err();
        assert!(matches!(err, SetError::Bind(ref reason) if reason.contains(&port.to_string())));
        assert_eq!(fx.file().as_deref(), Some(original));
        assert!(!fx.server.status().await.unwrap().listening);
    }

    #[tokio::test]
    async fn a_port_in_use_with_no_file_leaves_no_file() {
        let fx = fixture(None);
        let taken = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = taken.local_addr().unwrap().port();
        assert!(matches!(fx.server.set(port).await, Err(SetError::Bind(_))));
        assert_eq!(fx.file(), None);
    }

    #[tokio::test]
    async fn a_failed_rebind_keeps_the_running_listener() {
        let fx = fixture(None);
        let running = free_port();
        fx.server.set(running).await.unwrap();
        let taken = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let busy = taken.local_addr().unwrap().port();

        assert!(matches!(fx.server.set(busy).await, Err(SetError::Bind(_))));
        assert_eq!(initialize(running).await.unwrap(), reqwest::StatusCode::OK);
        assert!(fx.file().unwrap().contains(&format!("\"port\": {running}")));
    }

    #[tokio::test]
    async fn the_loader_rules_reject_a_bad_port_and_write_nothing() {
        let fx = fixture(Some("{\"server\": {\"port\": 7000}}"));
        for (port, message) in [
            (80, "from 1024 to 65535"),
            (7000, "must differ from server.port (7000)"),
        ] {
            let err = fx.server.set(port).await.unwrap_err();
            assert!(
                matches!(err, SetError::Invalid(ref m) if m.contains(message)),
                "{port}: {err:?}"
            );
        }
        assert!(!fx.file().unwrap().contains("mcp"));
    }

    #[tokio::test]
    async fn the_running_main_port_is_checked_even_when_the_file_does_not_name_it() {
        let fx = fixture(None);
        let main_port = fx.server.config.server.port;
        let err = fx.server.set(main_port).await.unwrap_err();
        assert!(matches!(err, SetError::Invalid(ref m) if m.contains("server.port")));
        assert_eq!(fx.file(), None);
    }

    #[tokio::test]
    async fn a_port_set_by_the_environment_makes_the_switch_read_only() {
        let fx = fixture_with(Some("{\"mcp\": {\"port\": 9200}}"), Some(ManagedBy::Env));
        let status = fx.server.status().await.unwrap();
        assert_eq!(status.managed_by, Some(ManagedBy::Env));
        assert_eq!(status.port, 9200);
        assert!(matches!(
            fx.server.set(0).await,
            Err(SetError::Managed(ref m)) if m.contains("MOBUX_MCP_PORT")
        ));
        assert!(fx.file().unwrap().contains("9200"));
    }

    #[test]
    fn the_environment_and_the_flag_both_take_the_port() {
        let none = config::PartialConfig::default();
        let env = config::EnvSnapshot::new([("MOBUX_MCP_PORT", "8415")]);
        assert_eq!(ManagedBy::detect(&env, &none), Some(ManagedBy::Env));
        let flags = config::PartialConfig {
            mcp: Some(config::PartialMcpConfig { port: Some(8415) }),
            ..Default::default()
        };
        assert_eq!(
            ManagedBy::detect(&config::EnvSnapshot::default(), &flags),
            Some(ManagedBy::Flag)
        );
        assert_eq!(
            ManagedBy::detect(&config::EnvSnapshot::default(), &none),
            None
        );
    }
}
