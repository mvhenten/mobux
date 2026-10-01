//! The MCP switch on the Settings page. The `mcp` block of `config.json` is
//! the one source of truth: a change rewrites that block and then starts,
//! stops or rebinds the loopback listener to match. A bind that fails puts
//! the file back, so the file and the running listener never disagree.

use std::io::Write;
use std::net::Ipv4Addr;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use indexmap::IndexMap;
use serde::Serialize;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::{config, mcp};

/// The port the switch offers when the file names none.
pub const DEFAULT_PORT: u16 = 8415;

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

    fn reason(self) -> &'static str {
        match self {
            ManagedBy::Env => "MOBUX_MCP_PORT sets the MCP port; unset it to use this switch",
            ManagedBy::Flag => "--mcp-port sets the MCP port; drop it to use this switch",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Status {
    /// `mcp.port` as the file states it; 0 is off.
    pub port: u16,
    pub listening: bool,
    pub listening_port: Option<u16>,
    pub managed_by: Option<ManagedBy>,
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
    task: JoinHandle<()>,
}

impl Running {
    async fn stop(self) {
        self.task.abort();
        // The task ends cancelled; awaiting it is what guarantees the listener
        // is dropped and its port free before the caller moves on.
        let _ = self.task.await;
    }
}

pub struct McpServer {
    context: mcp::Context,
    config: Arc<config::Config>,
    path: PathBuf,
    managed_by: Option<ManagedBy>,
    running: Mutex<Option<Running>>,
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
            running: Mutex::new(None),
        }
    }

    /// Start on the port the instance resolved at startup. A port that cannot
    /// be bound stops startup, as it always has.
    pub async fn start_configured(&self) -> anyhow::Result<()> {
        let mut running = self.running.lock().await;
        self.apply(&mut running, self.config.mcp.port)
            .await
            .map_err(|reason| anyhow::anyhow!("binding the MCP server: {reason}"))
    }

    pub async fn status(&self) -> Result<Status, String> {
        let running = self.running.lock().await;
        self.status_of(running.as_ref().map(|r| r.port))
    }

    /// Write `port` (0 is off) to the file, then make the listener match it.
    pub async fn set(&self, port: u16) -> Result<Status, SetError> {
        let mut running = self.running.lock().await;
        if let Some(managed) = self.managed_by {
            return Err(SetError::Managed(managed.reason().to_string()));
        }

        let previous = read_optional(&self.path).map_err(SetError::Io)?;
        let next = with_mcp_port(previous.as_deref(), port).map_err(SetError::Invalid)?;
        config::parse(&self.path, &next).map_err(|e| SetError::Invalid(e.to_string()))?;
        let mut effective = (*self.config).clone();
        effective.mcp.port = port;
        config::check_mcp(&effective).map_err(SetError::Invalid)?;

        write_atomic(&self.path, &next).map_err(|e| SetError::Io(e.to_string()))?;
        if let Err(reason) = self.apply(&mut running, port).await {
            restore(&self.path, previous.as_deref()).map_err(|e| SetError::Io(e.to_string()))?;
            return Err(SetError::Bind(reason));
        }
        self.status_of(running.as_ref().map(|r| r.port))
            .map_err(SetError::Io)
    }

    fn status_of(&self, listening_port: Option<u16>) -> Result<Status, String> {
        let port = config::load_partial_from(&self.path)
            .map_err(|e| e.to_string())?
            .and_then(|partial| partial.mcp)
            .and_then(|mcp| mcp.port)
            .unwrap_or(0);
        let shown = listening_port
            .or(Some(port).filter(|p| *p != 0))
            .unwrap_or(DEFAULT_PORT);
        Ok(Status {
            port,
            listening: listening_port.is_some(),
            listening_port,
            managed_by: self.managed_by,
            default_port: DEFAULT_PORT,
            command: registration_command(shown),
        })
    }

    /// Bind the new port before the old listener goes, so a failed bind
    /// leaves the running one alone.
    async fn apply(&self, running: &mut Option<Running>, port: u16) -> Result<(), String> {
        if port == 0 {
            if let Some(old) = running.take() {
                old.stop().await;
            }
            return Ok(());
        }
        if running.as_ref().map(|r| r.port) == Some(port) {
            return Ok(());
        }
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port))
            .await
            .map_err(|e| format!("cannot listen on 127.0.0.1:{port}: {e}"))?;
        let app = mcp::router(self.context.clone());
        let task = tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                eprintln!("mcp listener error: {e:#}");
            }
        });
        println!("mcp: http://127.0.0.1:{port}{}", mcp::PATH);
        if let Some(old) = running.replace(Running { port, task }) {
            old.stop().await;
        }
        Ok(())
    }
}

pub fn registration_command(port: u16) -> String {
    format!(
        "claude mcp add --scope user --transport http mobux http://127.0.0.1:{port}{}",
        mcp::PATH
    )
}

/// The file's top two levels in their written order; serde_json's own map
/// would sort every key.
type Document = IndexMap<String, Option<IndexMap<String, serde_json::Value>>>;

fn with_mcp_port(raw: Option<&str>, port: u16) -> Result<String, String> {
    let mut document: Document = match raw {
        Some(raw) => serde_json::from_str(raw).map_err(|e| format!("config.json: {e}"))?,
        None => IndexMap::new(),
    };
    document
        .entry("mcp".to_string())
        .or_insert(None)
        .get_or_insert_with(IndexMap::new)
        .insert("port".to_string(), port.into());
    let text = serde_json::to_string_pretty(&document).map_err(|e| e.to_string())?;
    Ok(format!("{text}\n"))
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => Ok(Some(raw)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Replace the file in one rename, through a symlink to the file it names.
fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if let Some(parent) = target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }
    let mut staging = target.clone().into_os_string();
    staging.push(".tmp");
    let staging = PathBuf::from(staging);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&staging)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    std::fs::rename(&staging, &target)
}

fn restore(path: &Path, previous: Option<&str>) -> std::io::Result<()> {
    match previous {
        Some(text) => write_atomic(path, text),
        None => std::fs::remove_file(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use regex::Regex;

    const INITIALIZE: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}"#;

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
        let fx = fixture(Some(
            "{\n  \"server\": {\n    \"port\": 7000\n  },\n  \"auth\": {\n    \"user\": \"me\",\n    \"pin\": \"12345\"\n  }\n}\n",
        ));
        let port = free_port();
        fx.server.set(port).await.unwrap();
        assert_eq!(
            fx.file().unwrap(),
            format!(
                "{{\n  \"server\": {{\n    \"port\": 7000\n  }},\n  \"auth\": {{\n    \"user\": \"me\",\n    \"pin\": \"12345\"\n  }},\n  \"mcp\": {{\n    \"port\": {port}\n  }}\n}}\n"
            )
        );
        fx.server.set(0).await.unwrap();
        assert!(fx.file().unwrap().contains("\"port\": 0"));
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
    async fn a_port_in_use_is_refused_and_the_file_is_put_back() {
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
