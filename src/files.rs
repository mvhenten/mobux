//! `/files/<name>/…`: host directories served behind the same auth as the UI.
//!
//! Files go through `ServeFile`, the single-file mode of `ServeDir`, for MIME
//! types and byte ranges. `ServeDir`'s own directory redirect is root-absolute,
//! which would drop the mount and any proxy prefix, so directories never reach it.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use axum::{
    body::Body,
    extract::{Path as RoutePath, State},
    http::{header, HeaderValue, Request, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};
use tower_http::services::ServeFile;

use crate::config::{self, FilesConfig};

const MOUNT: &str = "/files/";

/// Characters a listing link cannot carry raw inside one path segment.
const SEGMENT: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'/')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}');

/// The configured roots, each already canonicalized.
#[derive(Debug, Clone, Default)]
pub struct FileRoots {
    roots: BTreeMap<String, PathBuf>,
    listing: bool,
}

impl FileRoots {
    /// Resolve every root once at startup. A root that is missing, not a
    /// directory, or badly named stops the server with the reason.
    pub fn from_config(files: &FilesConfig) -> Result<FileRoots> {
        config::file_roots_value(&files.roots, &())
            .map_err(|err| anyhow::anyhow!("files.roots: {err}"))?;
        let mut roots = BTreeMap::new();
        for (name, path) in &files.roots {
            let canonical = std::fs::canonicalize(path)
                .with_context(|| format!("files.roots.{name}: {path}"))?;
            if !canonical.is_dir() {
                bail!("files.roots.{name}: {path} is not a directory");
            }
            roots.insert(name.clone(), canonical);
        }
        Ok(FileRoots {
            roots,
            listing: files.listing,
        })
    }

    pub fn is_empty(&self) -> bool {
        self.roots.is_empty()
    }

    pub fn len(&self) -> usize {
        self.roots.len()
    }
}

pub fn router<S>(roots: Arc<FileRoots>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/files/{name}", get(redirect_to_root))
        .route("/files/{name}/", get(serve))
        .route("/files/{name}/{*path}", get(serve))
        .with_state(roots)
}

/// `/files/<name>` → `./<name>/`. Relative, so the browser keeps whatever
/// prefix a proxy put in front, and relative assets resolve inside the root.
async fn redirect_to_root(
    State(roots): State<Arc<FileRoots>>,
    RoutePath(name): RoutePath<String>,
    uri: Uri,
) -> Response {
    if !roots.roots.contains_key(&name) {
        return unknown_root(&roots);
    }
    relative_redirect(&encode_segment(&name), uri.query())
}

async fn serve(State(roots): State<Arc<FileRoots>>, req: Request<Body>) -> Response {
    let Some((name, rest)) = split_request_path(req.uri().path()) else {
        return not_found();
    };
    let Some(root) = roots.roots.get(&name) else {
        return unknown_root(&roots);
    };
    let Some(target) = resolve(root, rest) else {
        return not_found();
    };

    let Ok(metadata) = std::fs::metadata(&target) else {
        return not_found();
    };
    if metadata.is_file() {
        return serve_file(&target, req).await;
    }
    if !metadata.is_dir() {
        return not_found();
    }
    if !rest.is_empty() && !rest.ends_with('/') {
        let last = rest.rsplit('/').next().unwrap_or_default();
        return relative_redirect(last, req.uri().query());
    }
    if let Some(index) = resolve_inside(root, &target.join("index.html")) {
        if index.is_file() {
            return serve_file(&index, req).await;
        }
    }
    if !roots.listing {
        return not_found();
    }
    listing(root, &target)
}

/// `/files/<name>/<rest>` with `rest` still percent-encoded, as it arrived.
fn split_request_path(path: &str) -> Option<(String, &str)> {
    let after = path.strip_prefix(MOUNT)?;
    let (name, rest) = after.split_once('/')?;
    let name = percent_decode_str(name).decode_utf8().ok()?.into_owned();
    Some((name, rest))
}

/// The canonical file `rest` names under `root`, or `None` for anything that
/// does not exist or resolves outside it.
fn resolve(root: &Path, rest: &str) -> Option<PathBuf> {
    let decoded = percent_decode_str(rest).decode_utf8().ok()?;
    if decoded.contains('\0') {
        return None;
    }
    let relative = Path::new(decoded.as_ref());
    let plain = relative
        .components()
        .all(|component| matches!(component, Component::Normal(_) | Component::CurDir));
    if !plain {
        return None;
    }
    resolve_inside(root, &root.join(relative))
}

fn resolve_inside(root: &Path, candidate: &Path) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(candidate).ok()?;
    canonical.starts_with(root).then_some(canonical)
}

async fn serve_file(path: &Path, req: Request<Body>) -> Response {
    match ServeFile::new(path).try_call(req).await {
        Ok(response) => nosniff(response.map(Body::new)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => not_found(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not read the file: {err}"),
        )
            .into_response(),
    }
}

fn listing(root: &Path, dir: &Path) -> Response {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("could not list the directory: {err}"),
            )
                .into_response()
        }
    };
    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let target = resolve_inside(root, &entry.path())?;
            let name = entry.file_name().into_string().ok()?;
            let metadata = std::fs::metadata(&target).ok()?;
            if metadata.is_dir() {
                return Some(format!("{name}/"));
            }
            metadata.is_file().then_some(name)
        })
        .collect();
    names.sort();

    let title = html_escape::encode_text(
        dir.strip_prefix(root)
            .ok()
            .and_then(Path::to_str)
            .unwrap_or_default(),
    )
    .into_owned();
    let mut body = format!(
        "<!doctype html>\n<meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <title>/{title}</title>\n<ul>\n"
    );
    for name in names {
        let (bare, slash) = match name.strip_suffix('/') {
            Some(bare) => (bare, "/"),
            None => (name.as_str(), ""),
        };
        let href = format!("./{}{slash}", encode_segment(bare));
        let text = html_escape::encode_text(&name);
        body.push_str(&format!(
            "<li><a href=\"{}\">{text}</a></li>\n",
            html_escape::encode_double_quoted_attribute(&href)
        ));
    }
    body.push_str("</ul>\n");
    nosniff(([(header::CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response())
}

fn nosniff(mut response: Response) -> Response {
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn encode_segment(segment: &str) -> String {
    utf8_percent_encode(segment, SEGMENT).to_string()
}

/// `./<segment>/`, so a segment like `a:b` never reads as a URL scheme, with
/// the query carried over.
fn relative_redirect(segment: &str, query: Option<&str>) -> Response {
    let location = match query {
        Some(query) => format!("./{segment}/?{query}"),
        None => format!("./{segment}/"),
    };
    let mut response = StatusCode::TEMPORARY_REDIRECT.into_response();
    if let Ok(value) = HeaderValue::from_str(&location) {
        response.headers_mut().insert(header::LOCATION, value);
    }
    response
}

fn unknown_root(roots: &FileRoots) -> Response {
    (
        StatusCode::NOT_FOUND,
        format!("no file root by that name; {} configured\n", roots.len()),
    )
        .into_response()
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found\n").into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    const PNG: &[u8] = &[
        0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, b'I', b'H', b'D', b'R',
    ];

    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        outside: PathBuf,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("site");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(root.join("css")).unwrap();
        std::fs::create_dir_all(root.join("bare")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("index.html"), "<!doctype html><p>home</p>").unwrap();
        std::fs::write(root.join("css/site.css"), "body { color: red; }").unwrap();
        std::fs::write(root.join("app.js"), "console.log(1);").unwrap();
        std::fs::write(root.join("logo.png"), PNG).unwrap();
        std::fs::write(root.join("font.woff2"), b"wOF2").unwrap();
        std::fs::write(root.join("bare/note.txt"), "inside").unwrap();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("leak.txt")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("leakdir")).unwrap();
        std::os::unix::fs::symlink(root.join("css/site.css"), root.join("alias.css")).unwrap();
        Fixture {
            _dir: dir,
            root,
            outside,
        }
    }

    fn app(fixture: &Fixture, listing: bool) -> Router {
        let mut files = FilesConfig {
            listing,
            ..FilesConfig::default()
        };
        files
            .roots
            .insert("site".to_string(), fixture.root.display().to_string());
        let roots = FileRoots::from_config(&files).expect("roots resolve");
        router(Arc::new(roots))
    }

    async fn get_with(app: Router, uri: &str, range: Option<&str>) -> Response {
        let mut req = Request::builder().uri(uri);
        if let Some(range) = range {
            req = req.header(header::RANGE, range);
        }
        app.oneshot(req.body(Body::empty()).unwrap()).await.unwrap()
    }

    async fn get(app: Router, uri: &str) -> Response {
        get_with(app, uri, None).await
    }

    async fn body_text(response: Response) -> String {
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    fn header_of(response: &Response, name: header::HeaderName) -> String {
        response
            .headers()
            .get(name)
            .map(|value| value.to_str().unwrap().to_string())
            .unwrap_or_default()
    }

    #[tokio::test]
    async fn dot_dot_and_its_encodings_never_leave_the_root() {
        let fixture = fixture();
        for uri in [
            "/files/site/../outside/secret.txt",
            "/files/site/%2e%2e/outside/secret.txt",
            "/files/site/%2E%2E/outside/secret.txt",
            "/files/site/css/%2e%2e/%2e%2e/outside/secret.txt",
            "/files/site/%2e%2e%2foutside%2fsecret.txt",
            "/files/site/%2Fetc%2Fpasswd",
        ] {
            let response = get(app(&fixture, true), uri).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
        }
        assert!(fixture.outside.join("secret.txt").exists());
    }

    #[tokio::test]
    async fn a_symlink_out_of_the_root_is_not_found() {
        let fixture = fixture();
        let response = get(app(&fixture, true), "/files/site/leak.txt").await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let response = get(app(&fixture, true), "/files/site/leakdir/secret.txt").await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn a_symlink_inside_the_root_is_served() {
        let fixture = fixture();
        let response = get(app(&fixture, false), "/files/site/alias.css").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body_text(response).await, "body { color: red; }");
    }

    #[tokio::test]
    async fn files_carry_the_mime_type_of_their_extension() {
        let fixture = fixture();
        for (uri, expected) in [
            ("/files/site/index.html", "text/html"),
            ("/files/site/css/site.css", "text/css"),
            ("/files/site/app.js", "javascript"),
            ("/files/site/logo.png", "image/png"),
            ("/files/site/font.woff2", "font/woff2"),
        ] {
            let response = get(app(&fixture, false), uri).await;
            assert_eq!(response.status(), StatusCode::OK, "{uri}");
            let content_type = header_of(&response, header::CONTENT_TYPE);
            assert!(content_type.contains(expected), "{uri}: {content_type}");
        }
    }

    #[tokio::test]
    async fn a_range_request_gets_a_partial_response() {
        let fixture = fixture();
        let response = get_with(
            app(&fixture, false),
            "/files/site/logo.png",
            Some("bytes=1-3"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            header_of(&response, header::CONTENT_RANGE),
            format!("bytes 1-3/{}", PNG.len())
        );
        assert_eq!(body_text(response).await, "PNG");
    }

    #[tokio::test]
    async fn an_unknown_name_is_not_found_without_naming_any_path() {
        let fixture = fixture();
        for uri in ["/files/nope/index.html", "/files/nope/", "/files/nope"] {
            let response = get(app(&fixture, true), uri).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
            let body = body_text(response).await;
            assert_eq!(body, "no file root by that name; 1 configured\n");
            assert!(!body.contains(fixture.root.to_str().unwrap()));
        }
    }

    #[tokio::test]
    async fn the_root_serves_its_index() {
        let fixture = fixture();
        let response = get(app(&fixture, false), "/files/site/").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body_text(response).await, "<!doctype html><p>home</p>");
    }

    #[tokio::test]
    async fn a_directory_without_an_index_is_listed_only_when_listing_is_on() {
        let fixture = fixture();
        let response = get(app(&fixture, false), "/files/site/bare/").await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        let response = get(app(&fixture, true), "/files/site/bare/").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(header_of(&response, header::CONTENT_TYPE).starts_with("text/html"));
        let body = body_text(response).await;
        assert!(
            body.contains("<a href=\"./note.txt\">note.txt</a>"),
            "{body}"
        );
    }

    #[tokio::test]
    async fn a_listing_links_relatively_and_hides_symlinks_out() {
        let fixture = fixture();
        std::fs::remove_file(fixture.root.join("index.html")).unwrap();
        let response = get(app(&fixture, true), "/files/site/").await;
        let body = body_text(response).await;
        assert!(body.contains("<a href=\"./css/\">css/</a>"), "{body}");
        assert!(body.contains("<a href=\"./alias.css\">"), "{body}");
        assert!(!body.contains("leak"), "{body}");
        assert!(!body.contains("href=\"/"), "{body}");
    }

    #[tokio::test]
    async fn the_bare_mount_redirects_relatively_into_the_root() {
        let fixture = fixture();
        let response = get(app(&fixture, false), "/files/site").await;
        assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
        let location = header_of(&response, header::LOCATION);
        assert_eq!(location, "./site/");

        // A proxy strips its prefix before mobux sees the request; the browser
        // resolves the relative Location against the URL it asked for.
        let base = url_join("https://host/proxy/workspace/8080/files/site", &location);
        assert_eq!(base, "https://host/proxy/workspace/8080/files/site/");
    }

    #[tokio::test]
    async fn a_subdirectory_without_a_slash_redirects_relatively() {
        let fixture = fixture();
        let response = get(app(&fixture, true), "/files/site/css").await;
        assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
        let location = header_of(&response, header::LOCATION);
        assert_eq!(location, "./css/");
        assert_eq!(
            url_join(
                "https://host/proxy/workspace/8080/files/site/css",
                &location
            ),
            "https://host/proxy/workspace/8080/files/site/css/"
        );
    }

    #[tokio::test]
    async fn a_listing_href_never_reads_as_a_scheme() {
        let fixture = fixture();
        std::fs::write(fixture.root.join("bare/javascript:alert(1)"), "x").unwrap();
        let response = get(app(&fixture, true), "/files/site/bare/").await;
        let body = body_text(response).await;
        let hrefs: Vec<&str> = body
            .split("href=\"")
            .skip(1)
            .map(|rest| rest.split('"').next().unwrap())
            .collect();
        assert_eq!(hrefs.len(), 2, "{body}");
        for href in hrefs {
            assert!(href.starts_with("./"), "{href}");
        }
        assert!(body.contains("href=\"./javascript:alert(1)\""), "{body}");
    }

    #[tokio::test]
    async fn a_directory_named_like_a_scheme_redirects_below_the_page() {
        let fixture = fixture();
        std::fs::create_dir_all(fixture.root.join("a:b")).unwrap();
        let response = get(app(&fixture, true), "/files/site/a:b").await;
        assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
        assert_eq!(header_of(&response, header::LOCATION), "./a:b/");
    }

    #[tokio::test]
    async fn both_redirects_keep_the_query() {
        let fixture = fixture();
        let response = get(app(&fixture, true), "/files/site?v=2&x=y").await;
        assert_eq!(header_of(&response, header::LOCATION), "./site/?v=2&x=y");
        let response = get(app(&fixture, true), "/files/site/css?v=2").await;
        assert_eq!(header_of(&response, header::LOCATION), "./css/?v=2");
    }

    #[tokio::test]
    async fn a_named_pipe_is_not_found_rather_than_read() {
        let fixture = fixture();
        let fifo = fixture.root.join("pipe");
        let status = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .expect("mkfifo runs");
        assert!(status.success());
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            get(app(&fixture, true), "/files/site/pipe"),
        )
        .await
        .expect("a named pipe must not block the request");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        std::fs::remove_file(fixture.root.join("index.html")).unwrap();
        let body = body_text(get(app(&fixture, true), "/files/site/").await).await;
        assert!(!body.contains("pipe"), "{body}");
    }

    #[tokio::test]
    async fn files_and_listings_forbid_content_sniffing() {
        let fixture = fixture();
        for uri in ["/files/site/app.js", "/files/site/bare/"] {
            let response = get(app(&fixture, true), uri).await;
            assert_eq!(response.status(), StatusCode::OK, "{uri}");
            assert_eq!(
                header_of(&response, header::X_CONTENT_TYPE_OPTIONS),
                "nosniff",
                "{uri}"
            );
        }
    }

    #[test]
    fn a_missing_root_stops_the_server() {
        let mut files = FilesConfig::default();
        files
            .roots
            .insert("gone".to_string(), "/no/such/mobux/root".to_string());
        let err = FileRoots::from_config(&files).unwrap_err().to_string();
        assert!(err.contains("files.roots.gone"), "{err}");
    }

    /// RFC 3986 reference resolution for the one shape a redirect here takes:
    /// a relative path with no dot segments, merged onto the base's directory.
    fn url_join(base: &str, relative: &str) -> String {
        let directory = &base[..=base.rfind('/').unwrap()];
        format!("{directory}{}", relative.trim_start_matches("./"))
    }
}
