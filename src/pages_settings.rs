//! Settings → Pages. The `files.roots` and `proxy.targets` blocks of
//! `config.json` are the one source of truth: a change is checked in full,
//! written to that file, then swapped into the live `/files/` and `/proxy/`
//! routes, so a removed page answers 404 and an added one serves at once.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::config;
use crate::files::{self, FileRoots};
use crate::mcp_settings::{read_optional, with_keys, write_atomic, ManagedBy};
use crate::proxy::ProxyTargets;

const FILES_NOTE: &str = "MOBUX_FILES sets the file roots; unset it to edit them here.";
const PROXY_NOTE: &str = "MOBUX_PROXY sets the proxy targets; unset it to edit them here.";

/// Which sections the environment sets. A set variable replaces the file's
/// block, so editing the file would change nothing that is served.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Managed {
    pub files: Option<ManagedBy>,
    pub proxies: Option<ManagedBy>,
}

impl Managed {
    pub fn detect(env: &config::EnvSnapshot) -> Self {
        let by_env = |key: &str| env.get(key).map(|_| ManagedBy::Env);
        Managed {
            files: by_env(config::FILES_ENV),
            proxies: by_env(config::PROXY_ENV),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProxyEntry {
    pub name: String,
    pub port: u16,
}

/// A proxy target as the request states it. The port is read wide so an
/// out-of-range number is refused with the rule, not as a shape error.
#[derive(Debug, Clone, Deserialize)]
pub struct ProxyRequest {
    pub name: String,
    pub port: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Sections<T> {
    pub files: T,
    pub proxies: T,
}

/// What `GET /api/settings/pages` answers: what is served right now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Status {
    pub files: Vec<FileEntry>,
    pub proxies: Vec<ProxyEntry>,
    pub managed_by: Sections<Option<ManagedBy>>,
    pub managed_note: Sections<Option<String>>,
}

/// `PUT /api/settings/pages`: the full desired list per section. A section
/// left out stays as it is.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    #[serde(default)]
    pub files: Option<Vec<FileEntry>>,
    #[serde(default)]
    pub proxies: Option<Vec<ProxyRequest>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SetError {
    Invalid(String),
    Managed(String),
    Io(String),
}

pub struct PagesSettings {
    files: Arc<FileRoots>,
    proxies: Arc<ProxyTargets>,
    path: PathBuf,
    managed: Managed,
    write: Mutex<()>,
}

impl PagesSettings {
    pub fn new(
        files: Arc<FileRoots>,
        proxies: Arc<ProxyTargets>,
        path: PathBuf,
        managed: Managed,
    ) -> Self {
        PagesSettings {
            files,
            proxies,
            path,
            managed,
            write: Mutex::new(()),
        }
    }

    pub fn files(&self) -> &Arc<FileRoots> {
        &self.files
    }

    pub fn proxies(&self) -> &Arc<ProxyTargets> {
        &self.proxies
    }

    pub fn status(&self) -> Status {
        let note = |managed: Option<ManagedBy>, text: &str| managed.map(|_| text.to_string());
        Status {
            files: self
                .files
                .entries()
                .into_iter()
                .map(|(name, path)| FileEntry { name, path })
                .collect(),
            proxies: self
                .proxies
                .entries()
                .into_iter()
                .map(|(name, port)| ProxyEntry { name, port })
                .collect(),
            managed_by: Sections {
                files: self.managed.files,
                proxies: self.managed.proxies,
            },
            managed_note: Sections {
                files: note(self.managed.files, FILES_NOTE),
                proxies: note(self.managed.proxies, PROXY_NOTE),
            },
        }
    }

    /// Check everything, write the file, then swap the live routes. Nothing
    /// binds here, so the write goes last and a refused change leaves both
    /// the file and the routes as they were.
    pub async fn set(&self, change: Change) -> Result<Status, SetError> {
        let _write = self.write.lock().await;
        if change.files.is_some() && self.managed.files.is_some() {
            return Err(SetError::Managed(FILES_NOTE.to_string()));
        }
        if change.proxies.is_some() && self.managed.proxies.is_some() {
            return Err(SetError::Managed(PROXY_NOTE.to_string()));
        }

        let roots = change.files.map(file_map).transpose()?;
        let targets = change.proxies.map(proxy_map).transpose()?;
        let resolved = roots
            .as_ref()
            .map(|roots| {
                files::resolve_roots(roots).map_err(|e| SetError::Invalid(format!("{e:#}")))
            })
            .transpose()?;

        let mut keys = Vec::new();
        if let Some(roots) = &roots {
            keys.push(("files", "roots", serde_json::json!(roots)));
        }
        if let Some(targets) = &targets {
            keys.push(("proxy", "targets", serde_json::json!(targets)));
        }
        if keys.is_empty() {
            return Ok(self.status());
        }

        let previous = read_optional(&self.path).map_err(SetError::Io)?;
        let next = with_keys(previous.as_deref(), &keys).map_err(SetError::Invalid)?;
        config::parse(&self.path, &next).map_err(|e| SetError::Invalid(e.to_string()))?;
        write_atomic(&self.path, &next).map_err(|e| SetError::Io(e.to_string()))?;

        if let Some(resolved) = resolved {
            self.files.replace(resolved);
        }
        if let Some(targets) = targets {
            self.proxies.replace(targets);
        }
        Ok(self.status())
    }
}

fn file_map(entries: Vec<FileEntry>) -> Result<BTreeMap<String, String>, SetError> {
    let mut roots = BTreeMap::new();
    for FileEntry { name, path } in entries {
        if roots.contains_key(&name) {
            return Err(twice("files.roots", &name));
        }
        roots.insert(name, path);
    }
    config::file_roots_value(&roots, &())
        .map_err(|e| SetError::Invalid(format!("files.roots: {e}")))?;
    Ok(roots)
}

fn proxy_map(entries: Vec<ProxyRequest>) -> Result<BTreeMap<String, u16>, SetError> {
    let mut targets = BTreeMap::new();
    for ProxyRequest { name, port } in entries {
        if targets.contains_key(&name) {
            return Err(twice("proxy.targets", &name));
        }
        let port = u16::try_from(port).unwrap_or(0);
        targets.insert(name, port);
    }
    config::proxy_targets_value(&targets, &())
        .map_err(|e| SetError::Invalid(format!("proxy.targets: {e}")))?;
    Ok(targets)
}

fn twice(section: &str, name: &str) -> SetError {
    SetError::Invalid(format!("{section}: `{name}` is listed twice"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::Router;
    use tower::ServiceExt;

    struct Fixture {
        dir: tempfile::TempDir,
        pages: PagesSettings,
    }

    impl Fixture {
        fn path(&self) -> PathBuf {
            self.dir.path().join(config::CONFIG_FILE_NAME)
        }

        fn file(&self) -> Option<String> {
            read_optional(&self.path()).unwrap()
        }

        fn site(&self, name: &str) -> String {
            let dir = self.dir.path().join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("index.html"), format!("<p>{name}</p>")).unwrap();
            dir.display().to_string()
        }

        fn app(&self) -> Router {
            Router::new()
                .merge(files::router(self.pages.files().clone()))
                .merge(crate::proxy::router(self.pages.proxies().clone()))
        }
    }

    fn fixture_with(file: Option<&str>, managed: Managed) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(config::CONFIG_FILE_NAME);
        if let Some(text) = file {
            std::fs::write(&path, text).unwrap();
        }
        let settings = config::load_from(&path).unwrap();
        let files = Arc::new(FileRoots::from_config(&settings.files).unwrap());
        let proxies = Arc::new(ProxyTargets::from_config(&settings, "mobux_session").unwrap());
        let pages = PagesSettings::new(files, proxies, path, managed);
        Fixture { dir, pages }
    }

    fn fixture(file: Option<&str>) -> Fixture {
        fixture_with(file, Managed::default())
    }

    fn file_entry(name: &str, path: &str) -> FileEntry {
        FileEntry {
            name: name.to_string(),
            path: path.to_string(),
        }
    }

    fn proxy_entry(name: &str, port: i64) -> ProxyRequest {
        ProxyRequest {
            name: name.to_string(),
            port,
        }
    }

    fn files_change(entries: Vec<FileEntry>) -> Change {
        Change {
            files: Some(entries),
            proxies: None,
        }
    }

    fn proxies_change(entries: Vec<ProxyRequest>) -> Change {
        Change {
            files: None,
            proxies: Some(entries),
        }
    }

    async fn get(app: Router, uri: &str) -> (StatusCode, String) {
        let response = app
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    async fn upstream(text: &'static str) -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().route("/", axum::routing::get(move || async move { text }));
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        port
    }

    #[tokio::test]
    async fn a_change_round_trips_through_the_file_and_the_status() {
        let fx = fixture(None);
        let site = fx.site("site");
        let status = fx
            .pages
            .set(Change {
                files: Some(vec![file_entry("site", &site)]),
                proxies: Some(vec![proxy_entry("vite", 5173)]),
            })
            .await
            .unwrap();
        assert_eq!(status.files, vec![file_entry("site", &site)]);
        assert_eq!(
            status.proxies,
            vec![ProxyEntry {
                name: "vite".to_string(),
                port: 5173
            }]
        );
        assert_eq!(status.managed_by.files, None);

        let written = config::load_from(&fx.path()).unwrap();
        assert_eq!(written.files.roots["site"], site);
        assert_eq!(written.proxy.targets["vite"], 5173);

        let restarted = fixture_with(Some(&fx.file().unwrap()), Managed::default());
        assert_eq!(restarted.pages.status().files, status.files);
        assert_eq!(restarted.pages.status().proxies, status.proxies);
    }

    #[tokio::test]
    async fn every_other_key_stays_where_it_was() {
        let original = r#"{
  "server": {
    "port": 7000
  },
  "files": {
    "listing": true
  },
  "auth": {
    "user": "me",
    "pin": "12345"
  },
  "mcp": {
    "port": 9100
  }
}
"#;
        let fx = fixture(Some(original));
        let site = fx.site("site");
        fx.pages
            .set(files_change(vec![file_entry("site", &site)]))
            .await
            .unwrap();
        let expected = original.replace(
            "    \"listing\": true\n",
            &format!(
                "    \"listing\": true,\n    \"roots\": {{\n      \"site\": {site:?}\n    }}\n"
            ),
        );
        assert_eq!(fx.file().unwrap(), expected);
        assert!(crate::configure::check_report(&fx.path(), true).is_ok());
    }

    #[tokio::test]
    async fn a_bad_file_root_is_refused_with_the_rule_and_writes_nothing() {
        let original = "{\"server\": {\"port\": 7000}}";
        let fx = fixture(Some(original));
        let site = fx.site("site");
        let plain = fx.dir.path().join("plain.txt");
        std::fs::write(&plain, "x").unwrap();
        let missing = fx.dir.path().join("missing").display().to_string();
        let cases = [
            (
                vec![file_entry("site", "relative/dir")],
                "must be an absolute path",
            ),
            (vec![file_entry("site", &missing)], "files.roots.site"),
            (
                vec![file_entry("site", plain.to_str().unwrap())],
                "is not a directory",
            ),
            (vec![file_entry("a/b", &site)], "letters, digits"),
            (vec![file_entry("", &site)], "letters, digits"),
            (
                vec![file_entry("site", &site), file_entry("site", &site)],
                "`site` is listed twice",
            ),
        ];
        for (entries, message) in cases {
            let err = fx.pages.set(files_change(entries)).await.unwrap_err();
            assert!(
                matches!(err, SetError::Invalid(ref m) if m.contains(message)),
                "{message}: {err:?}"
            );
        }
        assert_eq!(fx.file().as_deref(), Some(original));
        assert!(fx.pages.status().files.is_empty());
    }

    #[tokio::test]
    async fn a_bad_proxy_target_is_refused_with_the_rule_and_writes_nothing() {
        let fx = fixture(None);
        let cases = [
            (vec![proxy_entry("vite", 0)], "port from 1 to 65535"),
            (vec![proxy_entry("vite", 70000)], "port from 1 to 65535"),
            (vec![proxy_entry("vite", -1)], "port from 1 to 65535"),
            (vec![proxy_entry("a b", 5173)], "letters, digits"),
            (
                vec![proxy_entry("vite", 5173), proxy_entry("vite", 5174)],
                "`vite` is listed twice",
            ),
        ];
        for (entries, message) in cases {
            let err = fx.pages.set(proxies_change(entries)).await.unwrap_err();
            assert!(
                matches!(err, SetError::Invalid(ref m) if m.contains(message)),
                "{message}: {err:?}"
            );
        }
        assert_eq!(fx.file(), None);
    }

    #[tokio::test]
    async fn the_same_name_may_be_a_file_root_and_a_proxy_target() {
        let fx = fixture(None);
        let site = fx.site("docs");
        fx.pages
            .set(Change {
                files: Some(vec![file_entry("docs", &site)]),
                proxies: Some(vec![proxy_entry("docs", 8000)]),
            })
            .await
            .unwrap();
        let written = config::load_from(&fx.path()).unwrap();
        assert!(written.files.roots.contains_key("docs"));
        assert!(written.proxy.targets.contains_key("docs"));
    }

    #[tokio::test]
    async fn an_added_root_serves_at_once_and_a_removed_one_is_gone() {
        let fx = fixture(None);
        let app = fx.app();
        assert_eq!(
            get(app.clone(), "/files/new/index.html").await.0,
            StatusCode::NOT_FOUND
        );

        let site = fx.site("new");
        fx.pages
            .set(files_change(vec![file_entry("new", &site)]))
            .await
            .unwrap();
        let (status, body) = get(app.clone(), "/files/new/index.html").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "<p>new</p>");

        fx.pages.set(files_change(vec![])).await.unwrap();
        let (status, body) = get(app, "/files/new/index.html").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body, "no file root by that name; 0 configured\n");
    }

    #[tokio::test]
    async fn an_added_target_proxies_at_once_and_a_removed_one_is_gone() {
        let port = upstream("from upstream").await;
        let fx = fixture(None);
        let app = fx.app();
        assert_eq!(
            get(app.clone(), "/proxy/up/").await.0,
            StatusCode::NOT_FOUND
        );

        fx.pages
            .set(proxies_change(vec![proxy_entry("up", i64::from(port))]))
            .await
            .unwrap();
        let (status, body) = get(app.clone(), "/proxy/up/").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "from upstream");

        fx.pages.set(proxies_change(vec![])).await.unwrap();
        let (status, body) = get(app, "/proxy/up/").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body, "no proxy target by that name; 0 configured\n");
    }

    #[tokio::test]
    async fn a_refused_change_leaves_the_live_routes_alone() {
        let fx = fixture(None);
        let site = fx.site("site");
        fx.pages
            .set(files_change(vec![file_entry("site", &site)]))
            .await
            .unwrap();
        let err = fx
            .pages
            .set(files_change(vec![file_entry("other", "relative")]))
            .await
            .unwrap_err();
        assert!(matches!(err, SetError::Invalid(_)));
        assert_eq!(
            get(fx.app(), "/files/site/index.html").await.0,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn a_section_the_environment_sets_is_read_only_with_its_note() {
        let managed = Managed {
            files: Some(ManagedBy::Env),
            proxies: None,
        };
        let fx = fixture_with(None, managed);
        let status = fx.pages.status();
        assert_eq!(status.managed_by.files, Some(ManagedBy::Env));
        assert_eq!(status.managed_note.files.as_deref(), Some(FILES_NOTE));
        assert_eq!(status.managed_by.proxies, None);

        let site = fx.site("site");
        let err = fx
            .pages
            .set(files_change(vec![file_entry("site", &site)]))
            .await
            .unwrap_err();
        assert_eq!(err, SetError::Managed(FILES_NOTE.to_string()));
        assert_eq!(fx.file(), None);

        fx.pages
            .set(proxies_change(vec![proxy_entry("vite", 5173)]))
            .await
            .unwrap();
        assert!(fx.file().unwrap().contains("\"vite\": 5173"));
        assert!(!fx.file().unwrap().contains("files"));
    }

    #[test]
    fn the_environment_variables_mark_their_sections() {
        let env = config::EnvSnapshot::new([("MOBUX_PROXY", "vite=5173")]);
        assert_eq!(
            Managed::detect(&env),
            Managed {
                files: None,
                proxies: Some(ManagedBy::Env)
            }
        );
        let env = config::EnvSnapshot::new([("MOBUX_FILES", " ")]);
        assert_eq!(Managed::detect(&env), Managed::default());
    }
}
