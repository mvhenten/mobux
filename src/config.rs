//! The typed configuration tree, its defaults, its JSON schema and the loader
//! that reads `config.json` out of the config directory.
//!
//! Nothing wires this into the server yet — the module lands first so the
//! schema, the defaults and the error messages can be reviewed on their own.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};

use garde::Validate;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const CONFIG_FILE_NAME: &str = "config.json";
pub const SCHEMA_PATH: &str = "docs/mobux.schema.json";

/// The committed schema, embedded so an installed binary can print it without
/// the repository beside it. A test holds it equal to `schema()`.
pub const SCHEMA_JSON: &str = include_str!("../docs/mobux.schema.json");

const DEFAULT_PORT: u16 = 8080;
const DEFAULT_ACME_DIRECTORY: &str = "https://acme-v02.api.letsencrypt.org/directory";
const DEFAULT_ACME_HTTP_PORT: u16 = 80;
const DEFAULT_SERVICE_NAME: &str = "mobux";
const DEFAULT_VAPID_CONTACT: &str = "mailto:admin@example.com";
const DEFAULT_UPDATE_CHECK_URL: &str = "https://index.crates.io/mo/bu/mobux";

/// The username a bare PIN unlocks the web UI as.
pub const DEFAULT_AUTH_USER: &str = "mobux";

/// What the caller prints when the port came from the deprecated bare `PORT`.
pub const PORT_DEPRECATION: &str = "PORT is deprecated; rename it to MOBUX_PORT";

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

/// Every setting mobux reads from a file. Absent state is a sentinel — an empty
/// string or an empty list — never a missing attribute, so a merged config is
/// always fully populated.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Validate)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    #[garde(dive)]
    pub server: ServerConfig,
    #[serde(default)]
    #[garde(dive)]
    pub auth: AuthConfig,
    #[serde(default)]
    #[garde(dive)]
    pub tls: TlsConfig,
    #[serde(default)]
    #[garde(dive)]
    pub paths: PathsConfig,
    #[serde(default)]
    #[garde(dive)]
    pub session: SessionConfig,
    #[serde(default)]
    #[garde(dive)]
    pub app: AppConfig,
    #[serde(default)]
    #[garde(dive)]
    pub push: PushConfig,
    #[serde(default)]
    #[garde(dive)]
    pub update: UpdateConfig,
}

/// Where the server listens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Validate)]
#[serde(deny_unknown_fields)]
pub struct ServerConfig {
    /// TCP port to listen on. Env: `MOBUX_PORT`. Flag: `--port`.
    #[serde(default = "default_port")]
    #[garde(range(min = 1))]
    pub port: u16,
    /// Path prefix a reverse proxy publishes mobux under, e.g. `/mobux`. Empty
    /// means the site root. The proxy strips the prefix before mobux sees the
    /// request, so routing never reads this — it exists so the session cookie
    /// carries the `Path` the browser is actually on.
    /// Env: `MOBUX_BASE_PATH`. Flag: `--base-path`.
    #[serde(default)]
    #[garde(custom(base_path_value))]
    pub base_path: String,
    /// Trust a reverse proxy to terminate TLS. The bind stays plain HTTP, but
    /// the session cookie keeps its `Secure` flag because the browser reaches
    /// mobux over HTTPS. Env: `MOBUX_BEHIND_TLS_PROXY`. Flag:
    /// `--behind-tls-proxy`.
    #[serde(default)]
    #[garde(skip)]
    pub behind_tls_proxy: bool,
}

/// The credentials that unlock the web UI.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Validate)]
#[serde(deny_unknown_fields)]
pub struct AuthConfig {
    /// Username. Empty means unset. Env: `MOBUX_AUTH_USER`. Flag: `--user`.
    #[serde(default)]
    #[garde(custom(plain_value))]
    pub user: String,
    /// Password. Empty means unset; `pin` is the usual way to set it.
    /// Env: `MOBUX_AUTH_PASS`.
    #[serde(default)]
    #[garde(custom(plain_value))]
    pub pass: String,
    /// Numeric PIN, 4-64 characters. Empty means unset. Env: `MOBUX_PIN`.
    /// Flag: `--pin`.
    #[serde(default)]
    #[garde(custom(pin_value))]
    pub pin: String,
}

/// HTTPS: the built-in CA, a supplied key pair, or ACME.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Validate)]
#[serde(deny_unknown_fields)]
pub struct TlsConfig {
    /// Serve HTTPS. Off by default; plain HTTP is the safe assumption behind a
    /// proxy and the only one that works without a trusted certificate.
    /// Env: `MOBUX_TLS`.
    #[serde(default = "default_tls_enabled")]
    #[garde(skip)]
    pub enabled: bool,
    /// Extra hostnames to add to the generated certificate.
    /// Env: `MOBUX_TLS_HOSTS` (comma separated).
    #[serde(default)]
    #[garde(inner(custom(host_value)))]
    pub hosts: Vec<String>,
    /// Path to a certificate PEM. Set both this and `key_file` to skip
    /// certificate generation. Env: `MOBUX_CERT_FILE`.
    #[serde(default)]
    #[garde(skip)]
    pub cert_file: String,
    /// Path to the private key PEM matching `cert_file`. Env: `MOBUX_KEY_FILE`.
    #[serde(default)]
    #[garde(skip)]
    pub key_file: String,
    /// Domains to obtain an ACME certificate for. A non-empty list switches
    /// TLS into ACME mode. Env: `MOBUX_ACME_DOMAINS` (comma separated).
    #[serde(default)]
    #[garde(inner(custom(host_value)))]
    pub acme_domains: Vec<String>,
    /// Account contact for the ACME directory. Required in ACME mode.
    /// Env: `MOBUX_ACME_EMAIL`.
    #[serde(default)]
    #[garde(custom(email_value))]
    pub acme_email: String,
    /// ACME directory URL. Env: `MOBUX_ACME_DIRECTORY`.
    #[serde(default = "default_acme_directory")]
    #[garde(custom(https_url_value))]
    pub acme_directory: String,
    /// Port the HTTP-01 challenge responder binds. Env: `MOBUX_ACME_HTTP_PORT`.
    #[serde(default = "default_acme_http_port")]
    #[garde(range(min = 1))]
    pub acme_http_port: u16,
}

/// Where mobux keeps its state.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Validate)]
#[serde(deny_unknown_fields)]
pub struct PathsConfig {
    /// Directory for the database and other state. Empty means the platform
    /// data directory. Env: `MOBUX_DATA_DIR`.
    #[serde(default)]
    #[garde(skip)]
    pub data_dir: String,
}

/// How a terminal session starts.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Validate)]
#[serde(deny_unknown_fields)]
pub struct SessionConfig {
    /// Shell to launch inside tmux. Empty means `$SHELL`.
    /// Env: `MOBUX_SESSION_SHELL`.
    #[serde(default)]
    #[garde(skip)]
    pub shell: String,
}

/// Identity of this instance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Validate)]
#[serde(deny_unknown_fields)]
pub struct AppConfig {
    /// Public `host` or `host:port` the Android app is pinned to. Empty means
    /// unset. Env: `MOBUX_DOMAIN`.
    #[serde(default)]
    #[garde(custom(authority_value))]
    pub domain: String,
    /// Dev mode, reported through `/api/build-info`. Env: `MOBUX_DEV`.
    #[serde(default)]
    #[garde(skip)]
    pub dev: bool,
    /// systemd unit the self-updater restarts. Env: `MOBUX_SERVICE_NAME`.
    #[serde(default = "default_service_name")]
    #[garde(custom(service_name_value))]
    pub service_name: String,
}

/// Web push.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Validate)]
#[serde(deny_unknown_fields)]
pub struct PushConfig {
    /// VAPID contact, a `mailto:` or `https:` URL. Env: `MOBUX_VAPID_CONTACT`.
    #[serde(default = "default_vapid_contact")]
    #[garde(custom(vapid_contact_value))]
    pub vapid_contact: String,
}

/// The self-updater.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Validate)]
#[serde(deny_unknown_fields)]
pub struct UpdateConfig {
    /// Where the version list is fetched from. Env: `MOBUX_UPDATE_CHECK_URL`.
    #[serde(default = "default_update_check_url")]
    #[garde(custom(https_url_value))]
    pub check_url: String,
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

fn default_tls_enabled() -> bool {
    false
}

fn default_acme_directory() -> String {
    DEFAULT_ACME_DIRECTORY.to_string()
}

fn default_acme_http_port() -> u16 {
    DEFAULT_ACME_HTTP_PORT
}

fn default_service_name() -> String {
    DEFAULT_SERVICE_NAME.to_string()
}

fn default_vapid_contact() -> String {
    DEFAULT_VAPID_CONTACT.to_string()
}

fn default_update_check_url() -> String {
    DEFAULT_UPDATE_CHECK_URL.to_string()
}

impl Default for ServerConfig {
    fn default() -> Self {
        ServerConfig {
            port: default_port(),
            base_path: String::new(),
            behind_tls_proxy: false,
        }
    }
}

impl Default for TlsConfig {
    fn default() -> Self {
        TlsConfig {
            enabled: default_tls_enabled(),
            hosts: Vec::new(),
            cert_file: String::new(),
            key_file: String::new(),
            acme_domains: Vec::new(),
            acme_email: String::new(),
            acme_directory: default_acme_directory(),
            acme_http_port: default_acme_http_port(),
        }
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            domain: String::new(),
            dev: false,
            service_name: default_service_name(),
        }
    }
}

impl Default for PushConfig {
    fn default() -> Self {
        PushConfig {
            vapid_contact: default_vapid_contact(),
        }
    }
}

impl Default for UpdateConfig {
    fn default() -> Self {
        UpdateConfig {
            check_url: default_update_check_url(),
        }
    }
}

// ---------------------------------------------------------------------------
// The partial mirror
// ---------------------------------------------------------------------------

/// The same tree with every leaf optional. A config file only states what it
/// overrides, so this is what the loader deserializes before merging onto the
/// defaults.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartialConfig {
    #[serde(default)]
    pub server: Option<PartialServerConfig>,
    #[serde(default)]
    pub auth: Option<PartialAuthConfig>,
    #[serde(default)]
    pub tls: Option<PartialTlsConfig>,
    #[serde(default)]
    pub paths: Option<PartialPathsConfig>,
    #[serde(default)]
    pub session: Option<PartialSessionConfig>,
    #[serde(default)]
    pub app: Option<PartialAppConfig>,
    #[serde(default)]
    pub push: Option<PartialPushConfig>,
    #[serde(default)]
    pub update: Option<PartialUpdateConfig>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartialServerConfig {
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub base_path: Option<String>,
    #[serde(default)]
    pub behind_tls_proxy: Option<bool>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartialAuthConfig {
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub pass: Option<String>,
    #[serde(default)]
    pub pin: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartialTlsConfig {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub hosts: Option<Vec<String>>,
    #[serde(default)]
    pub cert_file: Option<String>,
    #[serde(default)]
    pub key_file: Option<String>,
    #[serde(default)]
    pub acme_domains: Option<Vec<String>>,
    #[serde(default)]
    pub acme_email: Option<String>,
    #[serde(default)]
    pub acme_directory: Option<String>,
    #[serde(default)]
    pub acme_http_port: Option<u16>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartialPathsConfig {
    #[serde(default)]
    pub data_dir: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartialSessionConfig {
    #[serde(default)]
    pub shell: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartialAppConfig {
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub dev: Option<bool>,
    #[serde(default)]
    pub service_name: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartialPushConfig {
    #[serde(default)]
    pub vapid_contact: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartialUpdateConfig {
    #[serde(default)]
    pub check_url: Option<String>,
}

impl PartialConfig {
    pub fn server_port(&self) -> Option<u16> {
        self.server.as_ref().and_then(|server| server.port)
    }

    pub fn auth_user(&self) -> Option<String> {
        self.auth.as_ref().and_then(|auth| auth.user.clone())
    }

    pub fn auth_pin(&self) -> Option<String> {
        self.auth.as_ref().and_then(|auth| auth.pin.clone())
    }
}

impl Config {
    /// Overlay a partial onto this config. A stated leaf wins; anything absent
    /// keeps the value it already had.
    pub fn merged(mut self, partial: PartialConfig) -> Config {
        if let Some(server) = partial.server {
            overlay(&mut self.server.port, server.port);
            overlay(&mut self.server.base_path, server.base_path);
            overlay(&mut self.server.behind_tls_proxy, server.behind_tls_proxy);
        }
        if let Some(auth) = partial.auth {
            overlay(&mut self.auth.user, auth.user);
            overlay(&mut self.auth.pass, auth.pass);
            overlay(&mut self.auth.pin, auth.pin);
        }
        if let Some(tls) = partial.tls {
            overlay(&mut self.tls.enabled, tls.enabled);
            overlay(&mut self.tls.hosts, tls.hosts);
            overlay(&mut self.tls.cert_file, tls.cert_file);
            overlay(&mut self.tls.key_file, tls.key_file);
            overlay(&mut self.tls.acme_domains, tls.acme_domains);
            overlay(&mut self.tls.acme_email, tls.acme_email);
            overlay(&mut self.tls.acme_directory, tls.acme_directory);
            overlay(&mut self.tls.acme_http_port, tls.acme_http_port);
        }
        if let Some(paths) = partial.paths {
            overlay(&mut self.paths.data_dir, paths.data_dir);
        }
        if let Some(session) = partial.session {
            overlay(&mut self.session.shell, session.shell);
        }
        if let Some(app) = partial.app {
            overlay(&mut self.app.domain, app.domain);
            overlay(&mut self.app.dev, app.dev);
            overlay(&mut self.app.service_name, app.service_name);
        }
        if let Some(push) = partial.push {
            overlay(&mut self.push.vapid_contact, push.vapid_contact);
        }
        if let Some(update) = partial.update {
            overlay(&mut self.update.check_url, update.check_url);
        }
        self
    }
}

fn overlay<T>(target: &mut T, value: Option<T>) {
    if let Some(value) = value {
        *target = value;
    }
}

// ---------------------------------------------------------------------------
// Field metadata
// ---------------------------------------------------------------------------

/// What a field carries, and so how a command line spells it: a bare `--flag`
/// and `--no-flag` pair for a toggle, a repeatable comma-separated value for a
/// list, one value for the rest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldKind {
    Number,
    Text,
    Toggle,
    List,
}

/// One field's value, already parsed out of whatever spelled it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FieldValue {
    Number(u16),
    Text(String),
    Toggle(bool),
    List(Vec<String>),
}

/// A file key and the environment variable and flag that override it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FieldSpec {
    /// Dotted path into the config tree, e.g. `server.port`.
    pub key: &'static str,
    pub env: &'static str,
    pub flag: Option<&'static str>,
    pub kind: FieldKind,
    /// One line, as it reads in `--help`.
    pub help: &'static str,
}

/// Every settable field, with the environment variable and flag beside it.
pub const FIELDS: &[FieldSpec] = &[
    FieldSpec {
        key: "server.port",
        env: "MOBUX_PORT",
        flag: Some("--port"),
        kind: FieldKind::Number,
        help: "Port to listen on (default 8080)",
    },
    FieldSpec {
        key: "server.base_path",
        env: "MOBUX_BASE_PATH",
        flag: Some("--base-path"),
        kind: FieldKind::Text,
        help: "Path prefix a reverse proxy publishes mobux under, e.g. /mobux",
    },
    FieldSpec {
        key: "server.behind_tls_proxy",
        env: "MOBUX_BEHIND_TLS_PROXY",
        flag: Some("--behind-tls-proxy"),
        kind: FieldKind::Toggle,
        help: "Trust a reverse proxy to terminate TLS (default off)",
    },
    FieldSpec {
        key: "auth.user",
        env: "MOBUX_AUTH_USER",
        flag: Some("--user"),
        kind: FieldKind::Text,
        help: "Username to unlock the web UI (default mobux)",
    },
    FieldSpec {
        key: "auth.pass",
        env: "MOBUX_AUTH_PASS",
        flag: Some("--pass"),
        kind: FieldKind::Text,
        help: "Password to unlock the web UI",
    },
    FieldSpec {
        key: "auth.pin",
        env: "MOBUX_PIN",
        flag: Some("--pin"),
        kind: FieldKind::Text,
        help: "PIN to unlock the web UI",
    },
    FieldSpec {
        key: "tls.enabled",
        env: "MOBUX_TLS",
        flag: Some("--tls"),
        kind: FieldKind::Toggle,
        help: "Serve HTTPS with a generated certificate (default off)",
    },
    FieldSpec {
        key: "tls.hosts",
        env: "MOBUX_TLS_HOSTS",
        flag: Some("--tls-host"),
        kind: FieldKind::List,
        help: "Extra hostname on the generated certificate",
    },
    FieldSpec {
        key: "tls.cert_file",
        env: "MOBUX_CERT_FILE",
        flag: Some("--cert-file"),
        kind: FieldKind::Text,
        help: "Certificate PEM to serve instead of a generated one",
    },
    FieldSpec {
        key: "tls.key_file",
        env: "MOBUX_KEY_FILE",
        flag: Some("--key-file"),
        kind: FieldKind::Text,
        help: "Private key PEM matching the certificate",
    },
    FieldSpec {
        key: "tls.acme_domains",
        env: "MOBUX_ACME_DOMAINS",
        flag: Some("--acme-domain"),
        kind: FieldKind::List,
        help: "Domain to obtain an ACME certificate for",
    },
    FieldSpec {
        key: "tls.acme_email",
        env: "MOBUX_ACME_EMAIL",
        flag: Some("--acme-email"),
        kind: FieldKind::Text,
        help: "Account contact for the ACME directory",
    },
    FieldSpec {
        key: "tls.acme_directory",
        env: "MOBUX_ACME_DIRECTORY",
        flag: Some("--acme-directory"),
        kind: FieldKind::Text,
        help: "ACME directory URL",
    },
    FieldSpec {
        key: "tls.acme_http_port",
        env: "MOBUX_ACME_HTTP_PORT",
        flag: Some("--acme-http-port"),
        kind: FieldKind::Number,
        help: "Port the HTTP-01 challenge responder binds (default 80)",
    },
    FieldSpec {
        key: "paths.data_dir",
        env: "MOBUX_DATA_DIR",
        flag: Some("--data-dir"),
        kind: FieldKind::Text,
        help: "Directory for the database and other state",
    },
    FieldSpec {
        key: "session.shell",
        env: "MOBUX_SESSION_SHELL",
        flag: Some("--shell"),
        kind: FieldKind::Text,
        help: "Shell to launch inside tmux (default $SHELL)",
    },
    FieldSpec {
        key: "app.domain",
        env: "MOBUX_DOMAIN",
        flag: Some("--domain"),
        kind: FieldKind::Text,
        help: "Public host:port the Android app is pinned to",
    },
    FieldSpec {
        key: "app.dev",
        env: "MOBUX_DEV",
        flag: Some("--dev"),
        kind: FieldKind::Toggle,
        help: "Dev mode, reported through /api/build-info",
    },
    FieldSpec {
        key: "app.service_name",
        env: "MOBUX_SERVICE_NAME",
        flag: Some("--service-name"),
        kind: FieldKind::Text,
        help: "systemd unit the self-updater restarts (default mobux)",
    },
    FieldSpec {
        key: "push.vapid_contact",
        env: "MOBUX_VAPID_CONTACT",
        flag: Some("--vapid-contact"),
        kind: FieldKind::Text,
        help: "VAPID contact, a mailto: address or an https:// URL",
    },
    FieldSpec {
        key: "update.check_url",
        env: "MOBUX_UPDATE_CHECK_URL",
        flag: Some("--update-check-url"),
        kind: FieldKind::Text,
        help: "Where the version list is fetched from",
    },
];

/// Build a partial out of the fields a caller collected, keyed by
/// `FieldSpec::key`. The document the file format already describes is the only
/// definition of the tree, so the keys are routed through it rather than
/// through a second copy of the structure. A list extends what is already
/// there, so a repeated flag accumulates.
pub fn partial_from_fields(fields: &[(&str, FieldValue)]) -> PartialConfig {
    let mut root = serde_json::Map::new();
    for (key, value) in fields {
        insert_field(&mut root, key, value);
    }
    serde_json::from_value(serde_json::Value::Object(root))
        .expect("every field key names a leaf of the partial tree")
}

fn insert_field(
    root: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    value: &FieldValue,
) {
    let (section, leaf) = key.split_once('.').expect("a dotted field key");
    let section = root
        .entry(section)
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()))
        .as_object_mut()
        .expect("a section object");
    match value {
        FieldValue::Number(number) => {
            section.insert(leaf.to_string(), serde_json::Value::from(*number));
        }
        FieldValue::Text(text) => {
            section.insert(leaf.to_string(), serde_json::Value::from(text.clone()));
        }
        FieldValue::Toggle(on) => {
            section.insert(leaf.to_string(), serde_json::Value::from(*on));
        }
        FieldValue::List(items) => {
            let list = section
                .entry(leaf)
                .or_insert_with(|| serde_json::Value::Array(Vec::new()))
                .as_array_mut()
                .expect("a list");
            list.extend(items.iter().cloned().map(serde_json::Value::from));
        }
    }
}

/// Environment variables that deliberately have no file key: they locate the
/// file itself, name a deprecated alias, or exist only for tests and the
/// installer.
pub const ENV_ONLY: &[&str] = &[
    "PORT",
    "MOBUX_CONFIG_DIR",
    "MOBUX_TMUX_SOCKET",
    "MOBUX_UPDATE_TEST_INDEX",
    "MOBUX_UPDATE_DISABLE_RUN",
    "MOBUX_DEV_CERT",
    "MOBUX_DEV_KEY",
];

// ---------------------------------------------------------------------------
// Config directory
// ---------------------------------------------------------------------------

/// The environment the config directory is resolved from — passed in so the
/// resolution is a pure function the tests can drive.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DirEnv {
    pub mobux_config_dir: Option<String>,
    pub xdg_config_home: Option<String>,
    pub home: Option<String>,
}

impl DirEnv {
    pub fn from_env() -> Self {
        let read = |key: &str| std::env::var(key).ok();
        DirEnv {
            mobux_config_dir: read("MOBUX_CONFIG_DIR"),
            xdg_config_home: read("XDG_CONFIG_HOME"),
            home: read("HOME"),
        }
    }
}

/// `MOBUX_CONFIG_DIR`, then `$XDG_CONFIG_HOME/mobux`, then `~/.config/mobux`.
/// The single answer for every caller that used to resolve this itself.
pub fn resolve_config_dir(env: &DirEnv) -> PathBuf {
    if let Some(dir) = non_empty(&env.mobux_config_dir) {
        return PathBuf::from(dir);
    }
    if let Some(dir) = non_empty(&env.xdg_config_home) {
        return PathBuf::from(dir).join("mobux");
    }
    let home = non_empty(&env.home).unwrap_or(".");
    PathBuf::from(home).join(".config").join("mobux")
}

pub fn config_dir() -> PathBuf {
    resolve_config_dir(&DirEnv::from_env())
}

pub fn config_file_path() -> PathBuf {
    config_dir().join(CONFIG_FILE_NAME)
}

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|v| !v.is_empty())
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum LoadError {
    /// The file could not be read.
    Read { path: PathBuf, message: String },
    /// The bytes are not JSON.
    Syntax { path: PathBuf, message: String },
    /// The JSON is not this shape: an unknown key, or a value of the wrong type.
    Shape {
        path: PathBuf,
        key: String,
        message: String,
        suggestion: Option<String>,
    },
    /// The shape is right but a value is out of range.
    Invalid { path: PathBuf, message: String },
}

impl fmt::Display for LoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LoadError::Read { path, message } => {
                write!(f, "{}: {message}", path.display())
            }
            LoadError::Syntax { path, message } => {
                write!(f, "{}: not valid JSON: {message}", path.display())
            }
            LoadError::Shape {
                path,
                key,
                message,
                suggestion,
            } => {
                write!(f, "{}: at `{key}`: {message}", path.display())?;
                match suggestion {
                    Some(word) => write!(f, " — did you mean `{word}`?"),
                    None => Ok(()),
                }
            }
            LoadError::Invalid { path, message } => {
                write!(f, "{}: {message}", path.display())
            }
        }
    }
}

impl std::error::Error for LoadError {}

/// Read and validate the config file as the layer it states, ready to hand to
/// [`resolve`]. `None` means no file at `path` — mobux runs without one, so
/// the caller decides whether its absence is an error.
pub fn load_partial_from(path: &Path) -> Result<Option<PartialConfig>, LoadError> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(LoadError::Read {
                path: path.to_path_buf(),
                message: err.to_string(),
            })
        }
    };
    let partial = parse_partial(path, &raw)?;
    validate(path, &Config::default().merged(partial.clone()))?;
    Ok(Some(partial))
}

/// Read, merge and validate the config file. A missing file is the default
/// config — mobux runs without one.
pub fn load_from(path: &Path) -> Result<Config, LoadError> {
    Ok(Config::default().merged(load_partial_from(path)?.unwrap_or_default()))
}

pub fn load() -> Result<Config, LoadError> {
    load_from(&config_file_path())
}

/// Parse one config document. `path` only names the source in error messages.
pub fn parse(path: &Path, raw: &str) -> Result<Config, LoadError> {
    let partial = parse_partial(path, raw)?;
    let config = Config::default().merged(partial);
    validate(path, &config)?;
    Ok(config)
}

fn parse_partial(path: &Path, raw: &str) -> Result<PartialConfig, LoadError> {
    let mut deserializer = serde_json::Deserializer::from_str(raw);
    serde_path_to_error::deserialize(&mut deserializer).map_err(|err| shape_error(path, err))
}

fn shape_error(path: &Path, err: serde_path_to_error::Error<serde_json::Error>) -> LoadError {
    let key = pointer_of(&err);
    let inner = err.into_inner();
    if matches!(
        inner.classify(),
        serde_json::error::Category::Syntax | serde_json::error::Category::Eof
    ) {
        return LoadError::Syntax {
            path: path.to_path_buf(),
            message: inner.to_string(),
        };
    }
    let message = inner.to_string();
    let suggestion = unknown_field_suggestion(&message);
    LoadError::Shape {
        path: path.to_path_buf(),
        key,
        message,
        suggestion,
    }
}

fn pointer_of(err: &serde_path_to_error::Error<serde_json::Error>) -> String {
    let path = err.path().to_string();
    if path.is_empty() || path == "." {
        return "(root)".to_string();
    }
    path
}

/// serde names the unknown key and lists the ones it expected. Pick the closest
/// expected key so a typo reads as a typo rather than a rejection.
fn unknown_field_suggestion(message: &str) -> Option<String> {
    let rest = message.strip_prefix("unknown field `")?;
    let (unknown, rest) = rest.split_once('`')?;
    let candidates = backticked(rest);
    let best = candidates
        .into_iter()
        .map(|candidate| (edit_distance(unknown, candidate), candidate))
        .min_by_key(|(distance, _)| *distance)?;
    let (distance, candidate) = best;
    if distance == 0 || distance > 3 || distance >= candidate.chars().count() {
        return None;
    }
    Some(candidate.to_string())
}

fn backticked(text: &str) -> Vec<&str> {
    text.split('`').skip(1).step_by(2).collect()
}

fn edit_distance(left: &str, right: &str) -> usize {
    let right_chars: Vec<char> = right.chars().collect();
    let mut previous: Vec<usize> = (0..=right_chars.len()).collect();
    let mut current = vec![0usize; right_chars.len() + 1];
    for (row, left_char) in left.chars().enumerate() {
        current[0] = row + 1;
        for (column, right_char) in right_chars.iter().enumerate() {
            let substitution = previous[column] + usize::from(left_char != *right_char);
            current[column + 1] = substitution
                .min(previous[column + 1] + 1)
                .min(current[column] + 1);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[right_chars.len()]
}

/// The per-field rules on their own, reported the way the loader reports them.
///
/// `mobux configure` checks one answer at a time, so the cross-field rules stay
/// out of here: a domain list typed before the contact beside it is a valid
/// answer, not a rejection.
pub fn check_fields(config: &Config) -> Result<(), String> {
    config
        .validate()
        .map_err(|report| report.to_string().trim().to_string())
}

/// Every rule, per-field and cross-field, on an assembled tree.
pub fn check(config: &Config) -> Result<(), String> {
    check_fields(config)?;
    if !config.tls.acme_domains.is_empty() && config.tls.acme_email.trim().is_empty() {
        return Err("tls.acme_email: required when tls.acme_domains is set".to_string());
    }
    Ok(())
}

fn validate(path: &Path, config: &Config) -> Result<(), LoadError> {
    check(config).map_err(|message| LoadError::Invalid {
        path: path.to_path_buf(),
        message,
    })
}

// ---------------------------------------------------------------------------
// Layering
// ---------------------------------------------------------------------------

/// The environment the layering reads — passed in so the resolution is a pure
/// function the tests can drive, the same shape as `service::resolve_unit_spec`.
///
/// Only the variables mobux knows about are kept, so a snapshot never carries
/// the rest of the process environment around.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct EnvSnapshot {
    values: BTreeMap<String, String>,
}

impl EnvSnapshot {
    pub fn from_env() -> Self {
        EnvSnapshot::new(std::env::vars())
    }

    pub fn new<K, V, I>(pairs: I) -> Self
    where
        K: AsRef<str>,
        V: Into<String>,
        I: IntoIterator<Item = (K, V)>,
    {
        let values = pairs
            .into_iter()
            .filter(|(key, _)| is_known_env(key.as_ref()))
            .map(|(key, value)| (key.as_ref().to_string(), value.into()))
            .collect();
        EnvSnapshot { values }
    }

    /// The trimmed value, or `None` when the variable is unset or blank. A
    /// blank variable states nothing, so the next layer down answers.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.values
            .get(key)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
    }
}

fn is_known_env(key: &str) -> bool {
    FIELDS.iter().any(|field| field.env == key) || ENV_ONLY.contains(&key)
}

/// The credentials that unlock the web UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credentials {
    pub user: String,
    pub pass: String,
}

/// Layer the four sources into one config: a flag beats the environment, which
/// beats the file, which beats the defaults.
///
/// Two rules survive from the flag-only resolution. An unparseable numeric
/// value states nothing and falls through to the next layer, and a PIN given on
/// the command line clears any password the lower layers set — otherwise
/// `MOBUX_AUTH_PASS` would silently win over the PIN the user just typed.
pub fn resolve(
    defaults: Config,
    file: PartialConfig,
    env: &EnvSnapshot,
    flags: PartialConfig,
) -> Config {
    let flags = without_blank_credentials(flags);
    let mut file = file;
    let mut environment = env_partial(env);

    if stated_pin(&flags).is_some() {
        clear_pass(&mut file);
        clear_pass(&mut environment);
    }

    defaults.merged(file).merged(environment).merged(flags)
}

/// The layer the environment states. `MOBUX_PORT` outranks the deprecated bare
/// `PORT`, and either falling through leaves the port to the layers below.
pub fn env_partial(env: &EnvSnapshot) -> PartialConfig {
    let text = |key: &str| env.get(key).map(str::to_string);
    let list = |key: &str| env.get(key).map(split_list);

    PartialConfig {
        server: Some(PartialServerConfig {
            port: env_port(env),
            base_path: text("MOBUX_BASE_PATH"),
            behind_tls_proxy: env.get("MOBUX_BEHIND_TLS_PROXY").map(truthy_toggle),
        }),
        auth: Some(PartialAuthConfig {
            user: text("MOBUX_AUTH_USER"),
            pass: text("MOBUX_AUTH_PASS"),
            pin: text("MOBUX_PIN"),
        }),
        tls: Some(PartialTlsConfig {
            enabled: env.get("MOBUX_TLS").map(truthy_tls),
            hosts: list("MOBUX_TLS_HOSTS"),
            cert_file: text("MOBUX_CERT_FILE"),
            key_file: text("MOBUX_KEY_FILE"),
            acme_domains: list("MOBUX_ACME_DOMAINS"),
            acme_email: text("MOBUX_ACME_EMAIL"),
            acme_directory: text("MOBUX_ACME_DIRECTORY"),
            acme_http_port: env.get("MOBUX_ACME_HTTP_PORT").and_then(parse_u16),
        }),
        paths: Some(PartialPathsConfig {
            data_dir: text("MOBUX_DATA_DIR"),
        }),
        session: Some(PartialSessionConfig {
            shell: text("MOBUX_SESSION_SHELL"),
        }),
        app: Some(PartialAppConfig {
            domain: text("MOBUX_DOMAIN"),
            dev: env.get("MOBUX_DEV").map(truthy_toggle),
            service_name: text("MOBUX_SERVICE_NAME"),
        }),
        push: Some(PartialPushConfig {
            vapid_contact: text("MOBUX_VAPID_CONTACT"),
        }),
        update: Some(PartialUpdateConfig {
            check_url: text("MOBUX_UPDATE_CHECK_URL"),
        }),
    }
}

/// The command-line layer, built from the three flags mobux takes.
pub fn flags_partial(
    port: Option<u16>,
    user: Option<String>,
    pin: Option<String>,
) -> PartialConfig {
    PartialConfig {
        server: Some(PartialServerConfig {
            port,
            ..Default::default()
        }),
        auth: Some(PartialAuthConfig {
            user,
            pass: None,
            pin,
        }),
        ..PartialConfig::default()
    }
}

/// `Some` when the resolved port came from the deprecated bare `PORT`, so the
/// caller can warn once at startup.
pub fn port_deprecation(env: &EnvSnapshot, flags: &PartialConfig) -> Option<&'static str> {
    if flags.server_port().is_some() {
        return None;
    }
    if env.get("MOBUX_PORT").and_then(parse_u16).is_some() {
        return None;
    }
    env.get("PORT")
        .and_then(parse_u16)
        .map(|_| PORT_DEPRECATION)
}

impl Config {
    /// The credentials that unlock the web UI, or `None` when auth is off.
    ///
    /// A user and password pair beats a PIN; a PIN on its own logs in as
    /// `mobux` unless a username is set.
    pub fn credentials(&self) -> Option<Credentials> {
        let user = non_blank(&self.auth.user);
        let pass = non_blank(&self.auth.pass);
        let pin = non_blank(&self.auth.pin);

        if let (Some(user), Some(pass)) = (user, pass) {
            return Some(Credentials {
                user: user.to_string(),
                pass: pass.to_string(),
            });
        }

        pin.map(|pin| Credentials {
            user: user.unwrap_or(DEFAULT_AUTH_USER).to_string(),
            pass: pin.to_string(),
        })
    }
}

fn env_port(env: &EnvSnapshot) -> Option<u16> {
    env.get("MOBUX_PORT")
        .and_then(parse_u16)
        .or_else(|| env.get("PORT").and_then(parse_u16))
}

fn parse_u16(value: &str) -> Option<u16> {
    value.trim().parse::<u16>().ok()
}

/// A comma-separated list, the spelling both the environment and a list flag
/// use.
pub fn split_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

fn truthy_tls(value: &str) -> bool {
    value != "0" && !value.eq_ignore_ascii_case("false")
}

/// Every toggle but `MOBUX_TLS`, which predates the table and reads any value
/// other than `0`/`false` as on.
fn truthy_toggle(value: &str) -> bool {
    value == "1" || value.eq_ignore_ascii_case("true")
}

fn non_blank(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

fn stated_pin(partial: &PartialConfig) -> Option<&str> {
    partial
        .auth
        .as_ref()
        .and_then(|auth| auth.pin.as_deref())
        .and_then(non_blank)
}

/// A blank flag states nothing: `--user ""` leaves the environment to answer.
fn without_blank_credentials(mut partial: PartialConfig) -> PartialConfig {
    if let Some(auth) = partial.auth.as_mut() {
        drop_blank(&mut auth.user);
        drop_blank(&mut auth.pass);
        drop_blank(&mut auth.pin);
    }
    partial
}

fn drop_blank(value: &mut Option<String>) {
    if value.as_deref().is_some_and(|v| v.trim().is_empty()) {
        *value = None;
    }
}

fn clear_pass(partial: &mut PartialConfig) {
    if let Some(auth) = partial.auth.as_mut() {
        auth.pass = Some(String::new());
    }
}

// ---------------------------------------------------------------------------
// Value rules
// ---------------------------------------------------------------------------

/// systemd splits an unquoted `Environment=` value on whitespace and eats
/// quotes and backslashes, so a credential carrying any of those reaches the
/// server mangled. Same rule as `service::render_unit` writes against.
fn plain_value(value: &str, _: &()) -> garde::Result {
    let offender = value
        .chars()
        .find(|c| c.is_whitespace() || c.is_control() || matches!(c, '"' | '\'' | '\\' | '$'));
    match offender {
        None => Ok(()),
        Some(c) => Err(garde::Error::new(format!(
            "contains {c:?}; whitespace, quotes, backslashes and $ cannot survive a systemd unit"
        ))),
    }
}

fn pin_value(value: &str, ctx: &()) -> garde::Result {
    plain_value(value, ctx)?;
    if value.is_empty() {
        return Ok(());
    }
    let length = value.chars().count();
    if !(4..=64).contains(&length) {
        return Err(garde::Error::new(
            "must be between 4 and 64 characters, or empty to leave the PIN unset",
        ));
    }
    Ok(())
}

/// A mount prefix as the browser spells it: absolute, and free of the
/// characters a systemd unit or a cookie attribute cannot carry. A trailing
/// slash is accepted and normalised away where the value is used.
fn base_path_value(value: &str, ctx: &()) -> garde::Result {
    if value.is_empty() {
        return Ok(());
    }
    plain_value(value, ctx)?;
    if !value.starts_with('/') {
        return Err(garde::Error::new("must start with `/`, e.g. `/mobux`"));
    }
    if value.contains("..") {
        return Err(garde::Error::new("must not contain `..`"));
    }
    if value.contains(';') {
        return Err(garde::Error::new(
            "must not contain `;`; it would split the Set-Cookie header",
        ));
    }
    Ok(())
}

fn host_value(value: &str, _: &()) -> garde::Result {
    if value.trim().is_empty() {
        return Err(garde::Error::new("must not be blank"));
    }
    let ok = value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '*' | '_'));
    if !ok {
        return Err(garde::Error::new(
            "must be a hostname: letters, digits, dots, dashes",
        ));
    }
    Ok(())
}

fn authority_value(value: &str, ctx: &()) -> garde::Result {
    if value.is_empty() {
        return Ok(());
    }
    let (host, port) = match value.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (value, None),
    };
    host_value(host, ctx)?;
    match port {
        None => Ok(()),
        Some(port) if port.parse::<u16>().is_ok_and(|p| p > 0) => Ok(()),
        Some(_) => Err(garde::Error::new(
            "port must be a number between 1 and 65535",
        )),
    }
}

fn email_value(value: &str, _: &()) -> garde::Result {
    if value.is_empty() {
        return Ok(());
    }
    let Some((local, domain)) = value.split_once('@') else {
        return Err(garde::Error::new("must be an email address"));
    };
    if local.is_empty() || !domain.contains('.') || domain.starts_with('.') {
        return Err(garde::Error::new("must be an email address"));
    }
    Ok(())
}

fn https_url_value(value: &str, _: &()) -> garde::Result {
    if value.starts_with("https://") && value.len() > "https://".len() {
        return Ok(());
    }
    Err(garde::Error::new("must be an https:// URL"))
}

fn service_name_value(value: &str, ctx: &()) -> garde::Result {
    if value.is_empty() {
        return Err(garde::Error::new("must name a systemd unit"));
    }
    plain_value(value, ctx)
}

fn vapid_contact_value(value: &str, _: &()) -> garde::Result {
    let mailto = value
        .strip_prefix("mailto:")
        .is_some_and(|rest| rest.contains('@'));
    if mailto || value.starts_with("https://") {
        return Ok(());
    }
    Err(garde::Error::new(
        "must be a mailto: address or an https:// URL",
    ))
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/// The JSON schema for `config.json`, generated from the types.
pub fn schema() -> serde_json::Value {
    serde_json::to_value(schemars::schema_for!(Config)).expect("schema serializes")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = "config.json";

    fn parse_str(raw: &str) -> Result<Config, LoadError> {
        parse(Path::new(SOURCE), raw)
    }

    fn message(raw: &str) -> String {
        parse_str(raw)
            .expect_err("expected a load error")
            .to_string()
    }

    /// Set `MOBUX_WRITE_SCHEMA=1` and run this test to rewrite the committed
    /// schema after changing the types.
    #[test]
    fn schema_file_matches_the_types() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(SCHEMA_PATH);
        let generated = format!("{}\n", serde_json::to_string_pretty(&schema()).unwrap());
        if std::env::var_os("MOBUX_WRITE_SCHEMA").is_some() {
            std::fs::write(&path, &generated).expect("writing the schema");
            return;
        }
        let committed = std::fs::read_to_string(&path).expect("docs/mobux.schema.json exists");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&committed).expect("valid JSON"),
            schema(),
            "docs/mobux.schema.json is stale — rerun this test with MOBUX_WRITE_SCHEMA=1"
        );
    }

    /// Sections are `$ref`s into `$defs`, so a dotted key is two hops.
    fn schema_node(schema: &serde_json::Value, key: &str) -> serde_json::Value {
        let (section, leaf) = key.split_once('.').expect("dotted key");
        let reference = schema["properties"][section]["$ref"]
            .as_str()
            .unwrap_or_else(|| panic!("no section `{section}` in the schema"))
            .rsplit('/')
            .next()
            .expect("a $defs pointer")
            .to_string();
        schema["$defs"][reference]["properties"][leaf].clone()
    }

    #[test]
    fn schema_marks_every_field_optional_and_rejects_unknown_keys() {
        let schema = schema();
        assert_eq!(schema["additionalProperties"], serde_json::json!(false));
        assert!(schema.get("required").is_none());
        assert_eq!(
            schema["$defs"]["ServerConfig"]["additionalProperties"],
            serde_json::json!(false)
        );
        assert_eq!(
            schema_node(&schema, "server.port")["default"],
            serde_json::json!(8080)
        );
    }

    #[test]
    fn an_empty_document_is_the_default_config() {
        assert_eq!(parse_str("{}").unwrap(), Config::default());
    }

    #[test]
    fn defaults_mirror_the_values_the_server_uses_today() {
        let config = Config::default();
        assert_eq!(config.server.port, 8080);
        assert!(!config.tls.enabled);
        assert_eq!(config.tls.acme_http_port, 80);
        assert_eq!(config.app.service_name, "mobux");
        assert_eq!(config.push.vapid_contact, "mailto:admin@example.com");
        assert!(!config.app.dev);
        assert_eq!(config.server.base_path, "");
        assert!(!config.server.behind_tls_proxy);
    }

    #[test]
    fn a_base_path_is_absolute_or_empty() {
        assert_eq!(
            parse_str(r#"{"server": {"base_path": "/mobux"}}"#)
                .unwrap()
                .server
                .base_path,
            "/mobux"
        );
        assert!(
            message(r#"{"server": {"base_path": "mobux"}}"#).contains("must start with `/`"),
            "a relative prefix is not a mount point"
        );
        assert!(
            message(r#"{"server": {"base_path": "/a/../b"}}"#).contains("`..`"),
            "a traversal is not a mount point"
        );
        assert!(
            message(r#"{"server": {"base_path": "/a;Secure"}}"#).contains("`;`"),
            "a semicolon would split the Set-Cookie header"
        );
    }

    #[test]
    fn a_stated_leaf_wins_and_the_rest_keeps_its_default() {
        let config = parse_str(r#"{"server": {"port": 5151}}"#).unwrap();
        assert_eq!(config.server.port, 5151);
        assert!(!config.tls.enabled);
        assert_eq!(config.update.check_url, Config::default().update.check_url);
    }

    #[test]
    fn every_section_round_trips_through_the_partial_mirror() {
        let raw = serde_json::to_string(&Config::default()).unwrap();
        assert_eq!(parse_str(&raw).unwrap(), Config::default());
    }

    #[test]
    fn malformed_json_names_the_position() {
        let error = message(r#"{"server": }"#);
        assert!(error.starts_with("config.json: not valid JSON:"), "{error}");
        assert!(error.contains("line 1"), "{error}");
    }

    #[test]
    fn an_unknown_key_suggests_the_nearest_spelling() {
        let error = message(r#"{"server": {"prot": 8080}}"#);
        assert!(error.contains("at `server.prot`"), "{error}");
        assert!(error.contains("did you mean `port`?"), "{error}");
    }

    #[test]
    fn an_unknown_section_suggests_the_nearest_section() {
        let error = message(r#"{"serve": {}}"#);
        assert!(error.contains("did you mean `server`?"), "{error}");
    }

    #[test]
    fn an_unrecognisable_key_is_reported_without_a_guess() {
        let error = message(r#"{"telemetry": {}}"#);
        assert!(error.contains("unknown field `telemetry`"), "{error}");
        assert!(!error.contains("did you mean"), "{error}");
    }

    #[test]
    fn a_wrong_type_names_the_key_and_the_expected_type() {
        let error = message(r#"{"server": {"port": "8080"}}"#);
        assert!(error.contains("at `server.port`"), "{error}");
        assert!(error.contains("invalid type: string"), "{error}");
    }

    #[test]
    fn a_number_outside_the_port_range_is_rejected_by_serde() {
        let error = message(r#"{"server": {"port": 70000}}"#);
        assert!(error.contains("at `server.port`"), "{error}");
    }

    #[test]
    fn port_zero_is_rejected_by_the_range_rule() {
        let error = message(r#"{"server": {"port": 0}}"#);
        assert!(error.contains("server.port"), "{error}");
    }

    #[test]
    fn a_short_pin_is_rejected() {
        let error = message(r#"{"auth": {"pin": "12"}}"#);
        assert!(error.contains("auth.pin"), "{error}");
        assert!(error.contains("between 4 and 64"), "{error}");
    }

    #[test]
    fn an_empty_pin_leaves_the_pin_unset() {
        assert_eq!(parse_str(r#"{"auth": {"pin": ""}}"#).unwrap().auth.pin, "");
    }

    #[test]
    fn a_credential_systemd_would_mangle_is_rejected() {
        let error = message(r#"{"auth": {"pass": "hunter 2"}}"#);
        assert!(error.contains("auth.pass"), "{error}");
    }

    #[test]
    fn a_blank_tls_host_is_rejected() {
        let error = message(r#"{"tls": {"hosts": ["ok.example", "  "]}}"#);
        assert!(error.contains("tls.hosts[1]"), "{error}");
    }

    #[test]
    fn acme_domains_without_an_email_are_rejected() {
        let error = message(r#"{"tls": {"acme_domains": ["mobux.example"]}}"#);
        assert!(error.contains("tls.acme_email"), "{error}");
        assert!(error.contains("required"), "{error}");
    }

    #[test]
    fn acme_domains_with_an_email_are_accepted() {
        let config = parse_str(
            r#"{"tls": {"acme_domains": ["a.example"], "acme_email": "me@example.com"}}"#,
        )
        .unwrap();
        assert_eq!(config.tls.acme_domains, vec!["a.example".to_string()]);
    }

    #[test]
    fn a_plain_http_acme_directory_is_rejected() {
        let error = message(r#"{"tls": {"acme_directory": "http://acme.example/dir"}}"#);
        assert!(error.contains("tls.acme_directory"), "{error}");
        assert!(error.contains("https://"), "{error}");
    }

    #[test]
    fn a_domain_may_carry_a_port() {
        let config = parse_str(r#"{"app": {"domain": "mobux.example:5151"}}"#).unwrap();
        assert_eq!(config.app.domain, "mobux.example:5151");
    }

    #[test]
    fn a_domain_with_a_junk_port_is_rejected() {
        let error = message(r#"{"app": {"domain": "mobux.example:https"}}"#);
        assert!(error.contains("app.domain"), "{error}");
    }

    #[test]
    fn an_empty_service_name_is_rejected() {
        let error = message(r#"{"app": {"service_name": ""}}"#);
        assert!(error.contains("app.service_name"), "{error}");
    }

    #[test]
    fn a_vapid_contact_must_be_mailto_or_https() {
        let error = message(r#"{"push": {"vapid_contact": "admin@example.com"}}"#);
        assert!(error.contains("push.vapid_contact"), "{error}");
    }

    #[test]
    fn a_missing_file_is_the_default_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG_FILE_NAME);
        assert_eq!(load_from(&path).unwrap(), Config::default());
    }

    #[test]
    fn a_file_on_disk_is_read_and_merged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG_FILE_NAME);
        std::fs::write(&path, r#"{"session": {"shell": "/bin/zsh"}}"#).unwrap();
        assert_eq!(load_from(&path).unwrap().session.shell, "/bin/zsh");
    }

    #[test]
    fn a_missing_file_states_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG_FILE_NAME);
        assert_eq!(load_partial_from(&path).unwrap(), None);
    }

    #[test]
    fn a_file_that_cannot_be_read_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let error = load_partial_from(dir.path()).unwrap_err();
        assert!(matches!(error, LoadError::Read { .. }), "{error}");
    }

    /// What startup does: read the file, then let the environment override it.
    #[test]
    fn startup_reads_the_file_and_lets_the_environment_override_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG_FILE_NAME);
        std::fs::write(
            &path,
            r#"{"server": {"port": 5151}, "session": {"shell": "/bin/zsh"}}"#,
        )
        .unwrap();

        let file = load_partial_from(&path).unwrap().expect("a file on disk");
        let resolved = resolve(
            Config::default(),
            file,
            &env(&[("MOBUX_PORT", "5152")]),
            PartialConfig::default(),
        );

        assert_eq!(resolved.server.port, 5152);
        assert_eq!(resolved.session.shell, "/bin/zsh");
        assert!(!resolved.tls.enabled);
    }

    #[test]
    fn config_dir_prefers_the_explicit_override() {
        let env = DirEnv {
            mobux_config_dir: Some("/srv/mobux".to_string()),
            xdg_config_home: Some("/home/me/.xdg".to_string()),
            home: Some("/home/me".to_string()),
        };
        assert_eq!(resolve_config_dir(&env), PathBuf::from("/srv/mobux"));
    }

    #[test]
    fn config_dir_falls_back_to_xdg_config_home() {
        let env = DirEnv {
            mobux_config_dir: None,
            xdg_config_home: Some("/home/me/.xdg".to_string()),
            home: Some("/home/me".to_string()),
        };
        assert_eq!(
            resolve_config_dir(&env),
            PathBuf::from("/home/me/.xdg/mobux")
        );
    }

    #[test]
    fn config_dir_falls_back_to_home() {
        let env = DirEnv {
            mobux_config_dir: None,
            xdg_config_home: None,
            home: Some("/home/me".to_string()),
        };
        assert_eq!(
            resolve_config_dir(&env),
            PathBuf::from("/home/me/.config/mobux")
        );
    }

    #[test]
    fn an_empty_override_is_ignored() {
        let env = DirEnv {
            mobux_config_dir: Some("  ".to_string()),
            xdg_config_home: Some(String::new()),
            home: Some("/home/me".to_string()),
        };
        assert_eq!(
            resolve_config_dir(&env),
            PathBuf::from("/home/me/.config/mobux")
        );
    }

    #[test]
    fn config_dir_without_a_home_stays_relative() {
        assert_eq!(
            resolve_config_dir(&DirEnv::default()),
            PathBuf::from("./.config/mobux")
        );
    }

    #[test]
    fn every_field_spec_names_a_key_in_the_schema() {
        let schema = schema();
        for field in FIELDS {
            let node = schema_node(&schema, field.key);
            assert!(!node.is_null(), "{} is missing from the schema", field.key);
            let description = node["description"].as_str().unwrap_or_default();
            assert!(
                description.contains(field.env),
                "{} does not document {}",
                field.key,
                field.env
            );
        }
    }

    // -----------------------------------------------------------------------
    // Layering
    // -----------------------------------------------------------------------

    fn env(pairs: &[(&str, &str)]) -> EnvSnapshot {
        EnvSnapshot::new(pairs.iter().copied())
    }

    fn flags(port: Option<u16>, user: Option<&str>, pin: Option<&str>) -> PartialConfig {
        flags_partial(port, user.map(str::to_string), pin.map(str::to_string))
    }

    fn file(raw: &str) -> PartialConfig {
        parse_partial(Path::new(SOURCE), raw).expect("a valid partial document")
    }

    fn resolved(
        file_layer: PartialConfig,
        env_layer: &EnvSnapshot,
        flag_layer: PartialConfig,
    ) -> Config {
        resolve(Config::default(), file_layer, env_layer, flag_layer)
    }

    fn credentials(env_layer: &EnvSnapshot, flag_layer: PartialConfig) -> Option<Credentials> {
        resolved(PartialConfig::default(), env_layer, flag_layer).credentials()
    }

    fn creds(user: &str, pass: &str) -> Option<Credentials> {
        Some(Credentials {
            user: user.to_string(),
            pass: pass.to_string(),
        })
    }

    #[test]
    fn nothing_stated_anywhere_is_the_default_config() {
        assert_eq!(
            resolved(
                PartialConfig::default(),
                &env(&[]),
                PartialConfig::default()
            ),
            Config::default()
        );
    }

    /// HTTPS is opt-in: nothing stated anywhere serves plain HTTP, and each of
    /// the three layers turns it back on on its own.
    #[test]
    fn tls_is_off_until_a_layer_asks_for_it() {
        assert!(
            !resolved(
                PartialConfig::default(),
                &env(&[]),
                PartialConfig::default()
            )
            .tls
            .enabled
        );

        assert!(
            resolved(
                file(r#"{"tls": {"enabled": true}}"#),
                &env(&[]),
                PartialConfig::default()
            )
            .tls
            .enabled
        );

        assert!(
            resolved(
                PartialConfig::default(),
                &env(&[("MOBUX_TLS", "1")]),
                PartialConfig::default()
            )
            .tls
            .enabled
        );

        let flag_layer = PartialConfig {
            tls: Some(PartialTlsConfig {
                enabled: Some(true),
                ..PartialTlsConfig::default()
            }),
            ..PartialConfig::default()
        };
        assert!(
            resolved(PartialConfig::default(), &env(&[]), flag_layer)
                .tls
                .enabled
        );
    }

    #[test]
    fn a_flag_beats_the_env_which_beats_the_file_which_beats_the_default() {
        let file_layer = file(r#"{"server": {"port": 5150}}"#);
        let env_layer = env(&[("MOBUX_PORT", "5152")]);

        assert_eq!(
            resolved(
                file_layer.clone(),
                &env_layer,
                flags(Some(5151), None, None)
            )
            .server
            .port,
            5151
        );
        assert_eq!(
            resolved(file_layer.clone(), &env_layer, PartialConfig::default())
                .server
                .port,
            5152
        );
        assert_eq!(
            resolved(file_layer, &env(&[]), PartialConfig::default())
                .server
                .port,
            5150
        );
        assert_eq!(
            resolved(
                PartialConfig::default(),
                &env(&[]),
                PartialConfig::default()
            )
            .server
            .port,
            8080
        );
    }

    #[test]
    fn the_user_and_pin_flags_beat_the_env_which_beats_the_file() {
        let file_layer = file(r#"{"auth": {"user": "filed", "pin": "1111"}}"#);
        let env_layer = env(&[("MOBUX_AUTH_USER", "enved"), ("MOBUX_PIN", "2222")]);

        let flagged = resolved(
            file_layer.clone(),
            &env_layer,
            flags(None, Some("flagged"), Some("3333")),
        );
        assert_eq!(flagged.auth.user, "flagged");
        assert_eq!(flagged.auth.pin, "3333");

        let enved = resolved(file_layer.clone(), &env_layer, PartialConfig::default());
        assert_eq!(enved.auth.user, "enved");
        assert_eq!(enved.auth.pin, "2222");

        let filed = resolved(file_layer, &env(&[]), PartialConfig::default());
        assert_eq!(filed.auth.user, "filed");
        assert_eq!(filed.auth.pin, "1111");
    }

    #[test]
    fn every_flagless_field_takes_the_env_over_the_file() {
        let file_layer = file(
            r#"{
                "server": {"base_path": "/filed", "behind_tls_proxy": false},
                "auth": {"pass": "filed"},
                "tls": {
                    "enabled": true,
                    "hosts": ["filed.example"],
                    "cert_file": "/filed/cert.pem",
                    "key_file": "/filed/key.pem",
                    "acme_domains": ["filed.example"],
                    "acme_email": "filed@example.com",
                    "acme_directory": "https://filed.example/dir",
                    "acme_http_port": 8081
                },
                "paths": {"data_dir": "/filed/data"},
                "session": {"shell": "/filed/sh"},
                "app": {"domain": "filed.example", "dev": false, "service_name": "filed"},
                "push": {"vapid_contact": "mailto:filed@example.com"},
                "update": {"check_url": "https://filed.example/index"}
            }"#,
        );
        let env_layer = env(&[
            ("MOBUX_BASE_PATH", "/enved"),
            ("MOBUX_BEHIND_TLS_PROXY", "1"),
            ("MOBUX_AUTH_PASS", "enved"),
            ("MOBUX_TLS", "0"),
            ("MOBUX_TLS_HOSTS", "a.example, b.example"),
            ("MOBUX_CERT_FILE", "/enved/cert.pem"),
            ("MOBUX_KEY_FILE", "/enved/key.pem"),
            ("MOBUX_ACME_DOMAINS", "acme.example"),
            ("MOBUX_ACME_EMAIL", "enved@example.com"),
            ("MOBUX_ACME_DIRECTORY", "https://enved.example/dir"),
            ("MOBUX_ACME_HTTP_PORT", "8082"),
            ("MOBUX_DATA_DIR", "/enved/data"),
            ("MOBUX_SESSION_SHELL", "/enved/sh"),
            ("MOBUX_DOMAIN", "enved.example"),
            ("MOBUX_DEV", "1"),
            ("MOBUX_SERVICE_NAME", "enved"),
            ("MOBUX_VAPID_CONTACT", "mailto:enved@example.com"),
            ("MOBUX_UPDATE_CHECK_URL", "https://enved.example/index"),
        ]);

        let config = resolved(file_layer.clone(), &env_layer, PartialConfig::default());
        assert_eq!(config.server.base_path, "/enved");
        assert!(config.server.behind_tls_proxy);
        assert_eq!(config.auth.pass, "enved");
        assert!(!config.tls.enabled);
        assert_eq!(config.tls.hosts, ["a.example", "b.example"]);
        assert_eq!(config.tls.cert_file, "/enved/cert.pem");
        assert_eq!(config.tls.key_file, "/enved/key.pem");
        assert_eq!(config.tls.acme_domains, ["acme.example"]);
        assert_eq!(config.tls.acme_email, "enved@example.com");
        assert_eq!(config.tls.acme_directory, "https://enved.example/dir");
        assert_eq!(config.tls.acme_http_port, 8082);
        assert_eq!(config.paths.data_dir, "/enved/data");
        assert_eq!(config.session.shell, "/enved/sh");
        assert_eq!(config.app.domain, "enved.example");
        assert!(config.app.dev);
        assert_eq!(config.app.service_name, "enved");
        assert_eq!(config.push.vapid_contact, "mailto:enved@example.com");
        assert_eq!(config.update.check_url, "https://enved.example/index");

        let filed = resolved(file_layer, &env(&[]), PartialConfig::default());
        assert_eq!(filed.server.base_path, "/filed");
        assert!(!filed.server.behind_tls_proxy);
        assert_eq!(filed.auth.pass, "filed");
        assert!(filed.tls.enabled);
        assert_eq!(filed.tls.acme_http_port, 8081);
        assert_eq!(filed.app.service_name, "filed");
    }

    #[test]
    fn a_blank_env_var_states_nothing() {
        let file_layer = file(r#"{"session": {"shell": "/filed/sh"}}"#);
        let env_layer = env(&[("MOBUX_SESSION_SHELL", "   "), ("MOBUX_PORT", "")]);
        let config = resolved(file_layer, &env_layer, PartialConfig::default());
        assert_eq!(config.session.shell, "/filed/sh");
        assert_eq!(config.server.port, 8080);
    }

    #[test]
    fn an_unknown_variable_is_not_kept_in_the_snapshot() {
        assert_eq!(env(&[("PATH", "/usr/bin")]), env(&[]));
        assert_eq!(env(&[("PORT", "5153")]).get("PORT"), Some("5153"));
    }

    #[test]
    fn port_falls_back_to_the_default() {
        assert_eq!(
            resolved(
                PartialConfig::default(),
                &env(&[]),
                PartialConfig::default()
            )
            .server
            .port,
            8080
        );
    }

    #[test]
    fn port_flag_beats_both_env_vars() {
        let env_layer = env(&[("MOBUX_PORT", "5152"), ("PORT", "5153")]);
        let flag_layer = flags(Some(5151), None, None);
        assert_eq!(
            resolved(PartialConfig::default(), &env_layer, flag_layer.clone())
                .server
                .port,
            5151
        );
        assert_eq!(port_deprecation(&env_layer, &flag_layer), None);
    }

    #[test]
    fn mobux_port_beats_the_deprecated_port() {
        let env_layer = env(&[("MOBUX_PORT", "5152"), ("PORT", "5153")]);
        assert_eq!(
            resolved(
                PartialConfig::default(),
                &env_layer,
                PartialConfig::default()
            )
            .server
            .port,
            5152
        );
        assert_eq!(
            port_deprecation(&env_layer, &PartialConfig::default()),
            None
        );
    }

    #[test]
    fn deprecated_port_alone_still_works_and_is_flagged() {
        let env_layer = env(&[("PORT", "5153")]);
        assert_eq!(
            resolved(
                PartialConfig::default(),
                &env_layer,
                PartialConfig::default()
            )
            .server
            .port,
            5153
        );
        assert_eq!(
            port_deprecation(&env_layer, &PartialConfig::default()),
            Some(PORT_DEPRECATION)
        );
    }

    #[test]
    fn unparseable_port_values_fall_through() {
        assert_eq!(
            resolved(
                PartialConfig::default(),
                &env(&[("MOBUX_PORT", "http"), ("PORT", "5153")]),
                PartialConfig::default()
            )
            .server
            .port,
            5153
        );
        assert_eq!(
            resolved(
                PartialConfig::default(),
                &env(&[("MOBUX_PORT", "http")]),
                PartialConfig::default()
            )
            .server
            .port,
            8080
        );
        assert_eq!(
            resolved(
                file(r#"{"server": {"port": 5150}}"#),
                &env(&[("MOBUX_PORT", "http"), ("PORT", "nope")]),
                PartialConfig::default()
            )
            .server
            .port,
            5150
        );
        assert_eq!(
            port_deprecation(&env(&[("PORT", "5153")]), &flags(Some(5151), None, None)),
            None
        );
    }

    #[test]
    fn an_unparseable_acme_http_port_falls_through() {
        assert_eq!(
            resolved(
                file(r#"{"tls": {"acme_http_port": 8081}}"#),
                &env(&[("MOBUX_ACME_HTTP_PORT", "http")]),
                PartialConfig::default()
            )
            .tls
            .acme_http_port,
            8081
        );
    }

    #[test]
    fn credentials_are_absent_without_a_pin_or_password() {
        assert_eq!(
            credentials(&env(&[("MOBUX_AUTH_USER", "me")]), PartialConfig::default()),
            None
        );
        assert_eq!(credentials(&env(&[]), PartialConfig::default()), None);
    }

    #[test]
    fn env_pin_still_works_on_its_own() {
        assert_eq!(
            credentials(&env(&[("MOBUX_PIN", "12345")]), PartialConfig::default()),
            creds("mobux", "12345")
        );
        assert_eq!(
            credentials(
                &env(&[("MOBUX_AUTH_USER", "me"), ("MOBUX_PIN", "12345")]),
                PartialConfig::default()
            ),
            creds("me", "12345")
        );
    }

    #[test]
    fn env_user_and_password_still_work() {
        assert_eq!(
            credentials(
                &env(&[("MOBUX_AUTH_USER", "me"), ("MOBUX_AUTH_PASS", "secret")]),
                PartialConfig::default()
            ),
            creds("me", "secret")
        );
    }

    #[test]
    fn a_user_and_password_beat_a_pin() {
        assert_eq!(
            credentials(
                &env(&[
                    ("MOBUX_AUTH_USER", "me"),
                    ("MOBUX_AUTH_PASS", "secret"),
                    ("MOBUX_PIN", "12345"),
                ]),
                PartialConfig::default()
            ),
            creds("me", "secret")
        );
    }

    #[test]
    fn pin_and_user_flags_beat_their_env_vars() {
        assert_eq!(
            credentials(
                &env(&[("MOBUX_AUTH_USER", "me"), ("MOBUX_PIN", "12345")]),
                flags(None, Some("walker"), Some("99999"))
            ),
            creds("walker", "99999")
        );
    }

    #[test]
    fn pin_flag_beats_an_env_password() {
        assert_eq!(
            credentials(
                &env(&[("MOBUX_AUTH_USER", "me"), ("MOBUX_AUTH_PASS", "secret")]),
                flags(None, None, Some("99999"))
            ),
            creds("me", "99999")
        );
    }

    #[test]
    fn a_pin_flag_also_beats_a_password_from_the_file() {
        let config = resolved(
            file(r#"{"auth": {"user": "me", "pass": "secret"}}"#),
            &env(&[]),
            flags(None, None, Some("99999")),
        );
        assert_eq!(config.credentials(), creds("me", "99999"));
    }

    #[test]
    fn empty_values_are_ignored() {
        assert_eq!(
            credentials(
                &env(&[
                    ("MOBUX_AUTH_USER", "me"),
                    ("MOBUX_AUTH_PASS", ""),
                    ("MOBUX_PIN", "12345"),
                ]),
                flags(None, Some(""), None)
            ),
            creds("me", "12345")
        );
    }

    #[test]
    fn a_file_password_still_beats_an_env_pin() {
        let config = resolved(
            file(r#"{"auth": {"user": "me", "pass": "secret"}}"#),
            &env(&[("MOBUX_PIN", "12345")]),
            PartialConfig::default(),
        );
        assert_eq!(config.credentials(), creds("me", "secret"));
    }

    fn sample_value(kind: FieldKind) -> FieldValue {
        match kind {
            FieldKind::Number => FieldValue::Number(8443),
            FieldKind::Text => FieldValue::Text("sample".to_string()),
            FieldKind::Toggle => FieldValue::Toggle(false),
            FieldKind::List => FieldValue::List(vec!["sample.example".to_string()]),
        }
    }

    #[test]
    fn every_field_kind_matches_the_type_in_the_schema() {
        let schema = schema();
        for field in FIELDS {
            let node = schema_node(&schema, field.key);
            let expected = match field.kind {
                FieldKind::Number => "integer",
                FieldKind::Text => "string",
                FieldKind::Toggle => "boolean",
                FieldKind::List => "array",
            };
            assert_eq!(
                node["type"],
                serde_json::json!(expected),
                "{} is a {:?} in the table",
                field.key,
                field.kind
            );
        }
    }

    #[test]
    fn every_field_key_reaches_its_leaf_of_the_partial() {
        for field in FIELDS {
            let partial = partial_from_fields(&[(field.key, sample_value(field.kind))]);
            assert_ne!(
                partial,
                PartialConfig::default(),
                "{} set nothing",
                field.key
            );
        }
    }

    #[test]
    fn a_repeated_list_field_accumulates() {
        let partial = partial_from_fields(&[
            ("tls.hosts", FieldValue::List(vec!["a.example".to_string()])),
            ("tls.hosts", FieldValue::List(vec!["b.example".to_string()])),
        ]);
        assert_eq!(
            partial.tls.and_then(|tls| tls.hosts),
            Some(vec!["a.example".to_string(), "b.example".to_string()])
        );
    }

    #[test]
    fn the_env_namespaces_do_not_overlap() {
        for field in FIELDS {
            assert!(
                !ENV_ONLY.contains(&field.env),
                "{} is listed both in the schema and as env-only",
                field.env
            );
        }
    }
}
