//! `/proxy/<name>/…`: loopback ports reverse-proxied behind the same auth as
//! the UI.
//!
//! Bodies stream both ways; nothing is buffered. The session cookie and
//! `Authorization` stay with mobux. A WebSocket upgrade is answered upstream
//! first, then both upgraded connections are spliced together.

use std::collections::BTreeMap;
use std::error::Error as _;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use anyhow::Result;
use axum::{
    body::Body,
    extract::{ConnectInfo, Path as RoutePath, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Request, StatusCode, Uri, Version},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use hyper::body::{Body as _, Frame, SizeHint};
use hyper_util::client::legacy::{connect::HttpConnector, Client};
use hyper_util::rt::{TokioExecutor, TokioIo};
use percent_encoding::percent_decode_str;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::oneshot;

use crate::config::{self, Config};

const MOUNT: &str = "/proxy/";
const FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(30);
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

const CLIENT_ADDRESS: [HeaderName; 3] = [
    HeaderName::from_static("x-forwarded-for"),
    HeaderName::from_static("x-real-ip"),
    header::FORWARDED,
];

const HOP_BY_HOP: [HeaderName; 9] = [
    header::CONNECTION,
    HeaderName::from_static("keep-alive"),
    header::PROXY_AUTHENTICATE,
    header::PROXY_AUTHORIZATION,
    HeaderName::from_static("proxy-connection"),
    header::TE,
    header::TRAILER,
    header::TRANSFER_ENCODING,
    header::UPGRADE,
];

/// The configured targets plus what every forwarded request needs to say
/// about the outside: the mount prefix, the scheme, and the cookie to keep.
#[derive(Debug, Clone)]
pub struct ProxyTargets {
    targets: BTreeMap<String, u16>,
    base_path: String,
    proto: &'static str,
    session_cookie: String,
    first_byte_timeout: Duration,
    idle_timeout: Duration,
    client: Client<HttpConnector, EndSignal>,
}

impl ProxyTargets {
    /// Check every target once at startup. A bad name or port stops the
    /// server with the reason.
    pub fn from_config(settings: &Config, session_cookie: &str) -> Result<ProxyTargets> {
        config::proxy_targets_value(&settings.proxy.targets, &())
            .map_err(|err| anyhow::anyhow!("proxy.targets: {err}"))?;
        let secure = settings.tls.enabled || settings.server.behind_tls_proxy;
        let mut connector = HttpConnector::new();
        connector.set_nodelay(true);
        connector.set_connect_timeout(Some(FIRST_BYTE_TIMEOUT));
        Ok(ProxyTargets {
            targets: settings.proxy.targets.clone(),
            base_path: settings
                .server
                .base_path
                .trim()
                .trim_end_matches('/')
                .to_string(),
            proto: if secure { "https" } else { "http" },
            session_cookie: session_cookie.to_string(),
            first_byte_timeout: FIRST_BYTE_TIMEOUT,
            idle_timeout: IDLE_TIMEOUT,
            client: Client::builder(TokioExecutor::new()).build(connector),
        })
    }

    pub fn is_empty(&self) -> bool {
        self.targets.is_empty()
    }

    pub fn len(&self) -> usize {
        self.targets.len()
    }

    /// `X-Forwarded-Prefix` for one target: where the browser sees its root.
    fn prefix(&self, name: &str) -> String {
        format!("{}{MOUNT}{name}", self.base_path)
    }
}

pub fn router<S>(targets: Arc<ProxyTargets>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/proxy/{name}", any(redirect_to_root))
        .route("/proxy/{name}/", any(forward))
        .route("/proxy/{name}/{*rest}", any(forward))
        .with_state(targets)
}

/// `/proxy/<name>` → `./<name>/`, relative so any outer prefix survives.
async fn redirect_to_root(
    State(targets): State<Arc<ProxyTargets>>,
    RoutePath(name): RoutePath<String>,
    uri: Uri,
) -> Response {
    if !targets.targets.contains_key(&name) {
        return unknown_target(&targets);
    }
    let location = match uri.query() {
        Some(query) => format!("./{name}/?{query}"),
        None => format!("./{name}/"),
    };
    let mut response = StatusCode::TEMPORARY_REDIRECT.into_response();
    if let Ok(value) = HeaderValue::from_str(&location) {
        response.headers_mut().insert(header::LOCATION, value);
    }
    response
}

async fn forward(State(targets): State<Arc<ProxyTargets>>, mut req: Request<Body>) -> Response {
    let Some((name, rest)) = split_request_path(req.uri().path()) else {
        return (StatusCode::NOT_FOUND, "not found\n").into_response();
    };
    let Some(&port) = targets.targets.get(&name) else {
        return unknown_target(&targets);
    };
    let rest = rest.to_string();
    let upstream_uri = match req.uri().query() {
        Some(query) => format!("http://127.0.0.1:{port}/{rest}?{query}"),
        None => format!("http://127.0.0.1:{port}/{rest}"),
    };
    let Ok(upstream_uri) = upstream_uri.parse::<Uri>() else {
        return (StatusCode::BAD_REQUEST, "bad request path\n").into_response();
    };

    let upgrade = upgrade_protocol(req.headers());
    let client_upgrade = upgrade.as_ref().map(|_| hyper::upgrade::on(&mut req));

    let forwarded_host = req.headers().get(header::HOST).cloned().or_else(|| {
        req.uri()
            .authority()
            .and_then(|authority| HeaderValue::from_str(authority.as_str()).ok())
    });
    let peer = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(addr)| addr.ip());
    let (mut parts, body) = req.into_parts();
    let mut headers = std::mem::take(&mut parts.headers);
    drop_length_under_chunking(&mut headers);
    strip_hop_by_hop(&mut headers);
    headers.remove(header::HOST);
    headers.remove(header::AUTHORIZATION);
    for name in &CLIENT_ADDRESS {
        headers.remove(name);
    }
    strip_cookie(&mut headers, &targets.session_cookie);
    if let Some(peer) = peer {
        if let Ok(value) = HeaderValue::from_str(&peer.to_string()) {
            headers.insert("x-forwarded-for", value);
        }
    }
    if let Ok(prefix) = HeaderValue::from_str(&targets.prefix(&name)) {
        headers.insert("x-forwarded-prefix", prefix);
    }
    if let Some(host) = forwarded_host {
        headers.insert("x-forwarded-host", host);
    }
    headers.insert("x-forwarded-proto", HeaderValue::from_static(targets.proto));
    if let Some(protocol) = &upgrade {
        headers.insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
        headers.insert(header::UPGRADE, protocol.clone());
    }

    let (body, body_ended) = EndSignal::new(body);
    let mut upstream_req = Request::new(body);
    *upstream_req.method_mut() = parts.method;
    *upstream_req.uri_mut() = upstream_uri;
    *upstream_req.version_mut() = Version::HTTP_11;
    *upstream_req.headers_mut() = headers;

    // The wait for a response starts once the request body has gone out, so
    // a slow upload is never cut off by it.
    let sent = targets.client.request(upstream_req);
    let deadline = async {
        let _ = body_ended.await;
        tokio::time::sleep(targets.first_byte_timeout).await;
    };
    let sent = tokio::select! {
        sent = sent => Some(sent),
        () = deadline => None,
    };
    let mut upstream = match sent {
        Some(Ok(response)) => response,
        Some(Err(err)) => return bad_gateway(&name, port, &err),
        None => {
            return (
                StatusCode::GATEWAY_TIMEOUT,
                format!(
                    "proxy target `{name}` on 127.0.0.1:{port} sent no response within {}s\n",
                    targets.first_byte_timeout.as_secs_f32()
                ),
            )
                .into_response()
        }
    };

    if upstream.status() == StatusCode::SWITCHING_PROTOCOLS {
        if let (Some(client_upgrade), Some(protocol)) = (client_upgrade, upgrade) {
            let upstream_upgrade = hyper::upgrade::on(&mut upstream);
            tokio::spawn(splice(
                client_upgrade,
                upstream_upgrade,
                targets.idle_timeout,
            ));
            let (mut parts, _) = upstream.into_parts();
            strip_hop_by_hop(&mut parts.headers);
            parts
                .headers
                .insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
            parts.headers.insert(header::UPGRADE, protocol);
            return Response::from_parts(parts, Body::empty());
        }
    }

    let (mut parts, body) = upstream.into_parts();
    drop_length_under_chunking(&mut parts.headers);
    strip_hop_by_hop(&mut parts.headers);
    strip_set_cookie(&mut parts.headers, &targets.session_cookie);
    rewrite_location(&mut parts.headers, &targets.prefix(&name), &rest);
    Response::from_parts(parts, Body::new(body))
}

async fn splice(
    client: hyper::upgrade::OnUpgrade,
    upstream: hyper::upgrade::OnUpgrade,
    idle: Duration,
) {
    let (Ok(client), Ok(upstream)) = tokio::join!(client, upstream) else {
        return;
    };
    copy_until_idle(TokioIo::new(client), TokioIo::new(upstream), idle).await;
}

/// Copy both ways until either side ends or no byte moves for `idle`, then
/// close both, so a phone that vanished never pins the task and its sockets.
async fn copy_until_idle<A, B>(a: A, b: B, idle: Duration)
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    let (mut a_read, mut a_write) = tokio::io::split(a);
    let (mut b_read, mut b_write) = tokio::io::split(b);
    let mut a_buf = vec![0u8; 16 * 1024];
    let mut b_buf = vec![0u8; 16 * 1024];
    loop {
        let moved = tokio::select! {
            read = a_read.read(&mut a_buf) => match read {
                Ok(n) if n > 0 => b_write.write_all(&a_buf[..n]).await.is_ok(),
                _ => false,
            },
            read = b_read.read(&mut b_buf) => match read {
                Ok(n) if n > 0 => a_write.write_all(&b_buf[..n]).await.is_ok(),
                _ => false,
            },
            () = tokio::time::sleep(idle) => false,
        };
        if !moved {
            break;
        }
    }
    let _ = a_write.shutdown().await;
    let _ = b_write.shutdown().await;
}

/// The request body, reporting when it has been sent in full or abandoned.
pub struct EndSignal {
    inner: Body,
    ended: Option<oneshot::Sender<()>>,
}

impl EndSignal {
    fn new(inner: Body) -> (EndSignal, oneshot::Receiver<()>) {
        let (tx, rx) = oneshot::channel();
        let mut body = EndSignal {
            inner,
            ended: Some(tx),
        };
        if body.inner.is_end_stream() {
            body.signal();
        }
        (body, rx)
    }

    fn signal(&mut self) {
        if let Some(ended) = self.ended.take() {
            let _ = ended.send(());
        }
    }
}

impl hyper::body::Body for EndSignal {
    type Data = axum::body::Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let poll = Pin::new(&mut self.inner).poll_frame(cx);
        if matches!(poll, Poll::Ready(None) | Poll::Ready(Some(Err(_)))) {
            self.signal();
        }
        poll
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// A message framed as chunked has no length; a `Content-Length` left beside
/// it would outlive the `Transfer-Encoding` the hop-by-hop strip drops and
/// truncate the body.
fn drop_length_under_chunking(headers: &mut HeaderMap) {
    if headers.contains_key(header::TRANSFER_ENCODING) {
        headers.remove(header::CONTENT_LENGTH);
    }
}

/// `/proxy/<name>/<rest>` with `rest` still percent-encoded, as it arrived.
fn split_request_path(path: &str) -> Option<(String, &str)> {
    let after = path.strip_prefix(MOUNT)?;
    let (name, rest) = after.split_once('/')?;
    let name = percent_decode_str(name).decode_utf8().ok()?.into_owned();
    Some((name, rest))
}

/// The `Upgrade` value when the request asks to switch protocols.
fn upgrade_protocol(headers: &HeaderMap) -> Option<HeaderValue> {
    let wants_upgrade = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|token| token.trim().eq_ignore_ascii_case("upgrade"));
    if !wants_upgrade {
        return None;
    }
    headers.get(header::UPGRADE).cloned()
}

/// Drop the fixed hop-by-hop set and every header `Connection` names.
fn strip_hop_by_hop(headers: &mut HeaderMap) {
    let named: Vec<HeaderName> = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|token| HeaderName::from_bytes(token.trim().as_bytes()).ok())
        .collect();
    for name in named.iter().chain(HOP_BY_HOP.iter()) {
        headers.remove(name);
    }
}

/// Remove every cookie called `name` and keep every other cookie byte for
/// byte, whether or not it is valid UTF-8.
pub(crate) fn strip_cookie(headers: &mut HeaderMap, name: &str) {
    let kept: Vec<&[u8]> = headers
        .get_all(header::COOKIE)
        .iter()
        .flat_map(|value| value.as_bytes().split(|byte| *byte == b';'))
        .map(<[u8]>::trim_ascii)
        .filter(|pair| !pair.is_empty())
        .filter(|pair| cookie_name(pair) != name.as_bytes())
        .collect();
    let joined = kept.join(&b"; "[..]);
    headers.remove(header::COOKIE);
    if joined.is_empty() {
        return;
    }
    if let Ok(value) = HeaderValue::from_bytes(&joined) {
        headers.insert(header::COOKIE, value);
    }
}

/// An upstream must not overwrite or clear the mobux session.
fn strip_set_cookie(headers: &mut HeaderMap, session_cookie: &str) {
    let kept: Vec<HeaderValue> = headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter(|value| cookie_name(value.as_bytes()) != session_cookie.as_bytes())
        .cloned()
        .collect();
    headers.remove(header::SET_COOKIE);
    for value in kept {
        headers.append(header::SET_COOKIE, value);
    }
}

fn cookie_name(pair: &[u8]) -> &[u8] {
    let end = pair
        .iter()
        .position(|byte| matches!(byte, b'=' | b';'))
        .unwrap_or(pair.len());
    pair[..end].trim_ascii()
}

/// A root-absolute `Location` points at the upstream's own root, which the
/// browser sees at the mount. It becomes relative to the request, so any outer
/// prefix survives too. One already under the forwarded prefix, and anything
/// not starting with a single `/`, passes through.
fn rewrite_location(headers: &mut HeaderMap, prefix: &str, rest: &str) {
    let Some(location) = headers
        .get(header::LOCATION)
        .and_then(|value| value.to_str().ok())
    else {
        return;
    };
    if !location.starts_with('/') || location.starts_with("//") {
        return;
    }
    let under_prefix = location
        .strip_prefix(prefix)
        .is_some_and(|tail| tail.is_empty() || tail.starts_with(['/', '?', '#']));
    if under_prefix {
        return;
    }
    let depth = rest.matches('/').count();
    let up = if depth == 0 {
        "./".to_string()
    } else {
        "../".repeat(depth)
    };
    if let Ok(value) = HeaderValue::from_str(&format!("{up}{}", &location[1..])) {
        headers.insert(header::LOCATION, value);
    }
}

fn bad_gateway(name: &str, port: u16, err: &hyper_util::client::legacy::Error) -> Response {
    let mut reason = err.to_string();
    let mut source = err.source();
    while let Some(inner) = source {
        reason = inner.to_string();
        source = inner.source();
    }
    (
        StatusCode::BAD_GATEWAY,
        format!("proxy target `{name}` on 127.0.0.1:{port} is not answering: {reason}\n"),
    )
        .into_response()
}

fn unknown_target(targets: &ProxyTargets) -> Response {
    (
        StatusCode::NOT_FOUND,
        format!(
            "no proxy target by that name; {} configured\n",
            targets.len()
        ),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
    use axum::routing::get;
    use futures_util::StreamExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tower::ServiceExt;

    async fn echo_request(req: Request<Body>) -> String {
        let mut lines = vec![format!("{} {}", req.method(), req.uri())];
        for (name, value) in req.headers() {
            lines.push(format!("{name}: {}", value.to_str().unwrap_or("?")));
        }
        let body = axum::body::to_bytes(req.into_body(), 1 << 20)
            .await
            .unwrap();
        lines.push(format!("body: {}", String::from_utf8_lossy(&body)));
        lines.join("\n")
    }

    async fn ws_echo(ws: WebSocketUpgrade) -> Response {
        ws.on_upgrade(|mut socket: WebSocket| async move {
            while let Some(Ok(message)) = socket.recv().await {
                if let Message::Text(text) = message {
                    let reply = format!("echo: {}", text.as_str());
                    if socket.send(Message::Text(reply.into())).await.is_err() {
                        return;
                    }
                }
            }
        })
    }

    async fn upstream() -> u16 {
        let app = Router::new()
            .route("/echo", any(echo_request))
            .route("/deep/echo", any(echo_request))
            .route(
                "/stream",
                any(|req: Request<Body>| async move { Response::new(req.into_body()) }),
            )
            .route(
                "/status/{code}",
                get(|RoutePath(code): RoutePath<u16>| async move {
                    (
                        StatusCode::from_u16(code).unwrap(),
                        format!("status {code}"),
                    )
                }),
            )
            .route(
                "/hop",
                get(|| async {
                    (
                        [
                            ("keep-alive", "timeout=5"),
                            ("connection", "x-upstream-hop"),
                            ("x-upstream-hop", "1"),
                            ("x-kept", "1"),
                        ],
                        "hop",
                    )
                }),
            )
            .route(
                "/a/b/redirect",
                get(|| async { (StatusCode::FOUND, [(header::LOCATION, "/landing?x=1")]) }),
            )
            .route(
                "/aware",
                get(|| async { (StatusCode::FOUND, [(header::LOCATION, "/proxy/up/landing")]) }),
            )
            .route(
                "/elsewhere",
                get(|| async {
                    (
                        StatusCode::FOUND,
                        [(header::LOCATION, "https://example.com/x")],
                    )
                }),
            )
            .route(
                "/slow",
                any(|| async {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    "late"
                }),
            )
            .route(
                "/cookies",
                get(|| async {
                    let mut headers = HeaderMap::new();
                    headers.append(
                        header::SET_COOKIE,
                        HeaderValue::from_static("mobux_session=evil; Path=/"),
                    );
                    headers.append(
                        header::SET_COOKIE,
                        HeaderValue::from_static("theme=dark; Path=/"),
                    );
                    (headers, "cookies")
                }),
            )
            .route("/ws", get(ws_echo));
        serve(app).await
    }

    async fn serve(app: Router) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        port
    }

    fn targets(entries: &[(&str, u16)]) -> ProxyTargets {
        let mut settings = Config::default();
        for (name, port) in entries {
            settings.proxy.targets.insert(name.to_string(), *port);
        }
        ProxyTargets::from_config(&settings, "mobux_session").expect("targets resolve")
    }

    fn app(targets: ProxyTargets) -> Router {
        router(Arc::new(targets))
    }

    fn request(method: &str, uri: &str) -> axum::http::request::Builder {
        Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, "phone.example:5151")
    }

    async fn body_text(response: Response) -> String {
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    fn header_of(response: &Response, name: &str) -> String {
        response
            .headers()
            .get(name)
            .map(|value| value.to_str().unwrap().to_string())
            .unwrap_or_default()
    }

    #[tokio::test]
    async fn a_get_passes_its_path_query_and_headers_through() {
        let port = upstream().await;
        let response = app(targets(&[("up", port)]))
            .oneshot(
                request("GET", "/proxy/up/echo?a=1&b=two")
                    .header("x-custom", "kept")
                    .header(header::ACCEPT, "text/plain")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let seen = body_text(response).await;
        assert!(seen.starts_with("GET /echo?a=1&b=two\n"), "{seen}");
        assert!(seen.contains("\nx-custom: kept\n"), "{seen}");
        assert!(seen.contains("\naccept: text/plain\n"), "{seen}");
        assert!(
            seen.contains(&format!("\nhost: 127.0.0.1:{port}\n")),
            "{seen}"
        );
    }

    #[tokio::test]
    async fn the_forwarded_headers_name_the_mount_host_and_scheme() {
        let port = upstream().await;
        let mut settings = Config::default();
        settings.proxy.targets.insert("up".to_string(), port);
        settings.server.base_path = "/mobux/".to_string();
        settings.server.behind_tls_proxy = true;
        let targets = ProxyTargets::from_config(&settings, "mobux_session").unwrap();
        let response = app(targets)
            .oneshot(
                request("GET", "/proxy/up/echo")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let seen = body_text(response).await;
        assert!(
            seen.contains("\nx-forwarded-prefix: /mobux/proxy/up\n"),
            "{seen}"
        );
        assert!(
            seen.contains("\nx-forwarded-host: phone.example:5151\n"),
            "{seen}"
        );
        assert!(seen.contains("\nx-forwarded-proto: https\n"), "{seen}");

        let response = app(targets_for(port))
            .oneshot(
                request("GET", "/proxy/up/echo")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let seen = body_text(response).await;
        assert!(seen.contains("\nx-forwarded-prefix: /proxy/up\n"), "{seen}");
        assert!(seen.contains("\nx-forwarded-proto: http\n"), "{seen}");
    }

    fn targets_for(port: u16) -> ProxyTargets {
        targets(&[("up", port)])
    }

    #[tokio::test]
    async fn the_session_cookie_and_authorization_stay_with_mobux() {
        let port = upstream().await;
        let response = app(targets_for(port))
            .oneshot(
                request("GET", "/proxy/up/echo")
                    .header(header::COOKIE, "theme=dark; mobux_session=secret; lang=nl")
                    .header(header::AUTHORIZATION, "Basic bWU6MTIzNDU=")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let seen = body_text(response).await;
        assert!(seen.contains("\ncookie: theme=dark; lang=nl\n"), "{seen}");
        assert!(!seen.contains("secret"), "{seen}");
        assert!(!seen.contains("authorization"), "{seen}");

        let response = app(targets_for(port))
            .oneshot(
                request("GET", "/proxy/up/echo")
                    .header(header::COOKIE, "mobux_session=secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let seen = body_text(response).await;
        assert!(!seen.contains("cookie"), "{seen}");
    }

    #[tokio::test]
    async fn hop_by_hop_headers_are_dropped_both_ways() {
        let port = upstream().await;
        let response = app(targets_for(port))
            .oneshot(
                request("GET", "/proxy/up/echo")
                    .header(header::CONNECTION, "keep-alive, x-secret-hop")
                    .header("x-secret-hop", "1")
                    .header("keep-alive", "timeout=5")
                    .header(header::TE, "trailers")
                    .header(header::PROXY_AUTHORIZATION, "Basic eA==")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let seen = body_text(response).await;
        for name in ["x-secret-hop", "keep-alive", "\nte:", "proxy-authorization"] {
            assert!(!seen.contains(name), "{name} reached upstream: {seen}");
        }

        let response = app(targets_for(port))
            .oneshot(request("GET", "/proxy/up/hop").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(header_of(&response, "x-kept"), "1");
        assert_eq!(header_of(&response, "x-upstream-hop"), "");
        assert_eq!(header_of(&response, "keep-alive"), "");
        assert_eq!(header_of(&response, "connection"), "");
    }

    #[tokio::test]
    async fn a_post_body_streams_both_ways_without_buffering() {
        let port = upstream().await;
        let (tx, rx) = tokio::sync::mpsc::channel::<&'static str>(1);
        let chunks = futures_util::stream::unfold(rx, |mut rx| async move {
            let chunk = rx.recv().await?;
            Some((Ok::<_, std::convert::Infallible>(chunk), rx))
        });
        let response = app(targets_for(port))
            .oneshot(
                request("POST", "/proxy/up/stream")
                    .body(Body::from_stream(chunks))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let mut body = response.into_body().into_data_stream();

        tx.send("first").await.unwrap();
        assert_eq!(next_chunk(&mut body).await.unwrap(), "first");
        tx.send("second").await.unwrap();
        assert_eq!(next_chunk(&mut body).await.unwrap(), "second");
        drop(tx);
        assert!(next_chunk(&mut body).await.is_none());
    }

    async fn next_chunk(body: &mut axum::body::BodyDataStream) -> Option<axum::body::Bytes> {
        tokio::time::timeout(Duration::from_secs(5), body.next())
            .await
            .expect("a chunk arrives before the request body ends")
            .map(|chunk| chunk.unwrap())
    }

    #[tokio::test]
    async fn the_upstream_status_passes_through() {
        let port = upstream().await;
        for code in [404u16, 500] {
            let response = app(targets_for(port))
                .oneshot(
                    request("GET", &format!("/proxy/up/status/{code}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), code);
            assert_eq!(body_text(response).await, format!("status {code}"));
        }
    }

    #[tokio::test]
    async fn a_refused_connection_is_a_502_naming_the_target_and_port() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let response = app(targets(&[("vite", port)]))
            .oneshot(request("GET", "/proxy/vite/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = body_text(response).await;
        assert!(body.contains("`vite`"), "{body}");
        assert!(body.contains(&format!("127.0.0.1:{port}")), "{body}");
        assert!(body.to_lowercase().contains("refused"), "{body}");
    }

    #[tokio::test]
    async fn no_first_byte_in_time_is_a_504() {
        let port = upstream().await;
        let mut targets = targets_for(port);
        targets.first_byte_timeout = Duration::from_millis(200);
        let response = app(targets)
            .oneshot(
                request("POST", "/proxy/up/slow")
                    .body(Body::from("sent in full"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
        assert!(body_text(response).await.contains("`up`"));
    }

    #[tokio::test]
    async fn an_upload_slower_than_the_response_timer_still_succeeds() {
        let port = upstream().await;
        let mut targets = targets_for(port);
        targets.first_byte_timeout = Duration::from_millis(300);
        let chunks = futures_util::stream::unfold(0u8, |sent| async move {
            if sent == 4 {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
            Some((
                Ok::<_, std::convert::Infallible>(format!("part{sent};")),
                sent + 1,
            ))
        });
        let response = app(targets)
            .oneshot(
                request("POST", "/proxy/up/echo")
                    .body(Body::from_stream(chunks))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let seen = body_text(response).await;
        assert!(seen.ends_with("body: part0;part1;part2;part3;"), "{seen}");
    }

    #[tokio::test]
    async fn a_content_length_beside_chunked_does_not_truncate_the_body() {
        let port = upstream().await;
        let response = app(targets_for(port))
            .oneshot(
                request("POST", "/proxy/up/echo")
                    .header(header::CONTENT_LENGTH, "3")
                    .header(header::TRANSFER_ENCODING, "chunked")
                    .body(Body::from("hello"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let seen = body_text(response).await;
        assert!(seen.ends_with("body: hello"), "{seen}");
        assert!(!seen.contains("content-length: 3"), "{seen}");
    }

    #[tokio::test]
    async fn the_peer_address_replaces_any_client_stated_address() {
        let port = upstream().await;
        let mut req = request("GET", "/proxy/up/echo")
            .header("x-forwarded-for", "6.6.6.6")
            .header("x-real-ip", "6.6.6.6")
            .header(header::FORWARDED, "for=6.6.6.6")
            .body(Body::empty())
            .unwrap();
        req.extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([100, 64, 0, 7], 50000))));
        let response = app(targets_for(port)).oneshot(req).await.unwrap();
        let seen = body_text(response).await;
        assert!(seen.contains("\nx-forwarded-for: 100.64.0.7\n"), "{seen}");
        assert!(!seen.contains("6.6.6.6"), "{seen}");
    }

    #[tokio::test]
    async fn an_upstream_cannot_set_the_session_cookie() {
        let port = upstream().await;
        let response = app(targets_for(port))
            .oneshot(
                request("GET", "/proxy/up/cookies")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let cookies: Vec<&str> = response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap())
            .collect();
        assert_eq!(cookies, vec!["theme=dark; Path=/"]);
    }

    #[tokio::test]
    async fn a_cookie_that_is_not_utf8_still_reaches_the_upstream() {
        let port = upstream().await;
        let response = app(targets_for(port))
            .oneshot(
                request("GET", "/proxy/up/echo")
                    .header(
                        header::COOKIE,
                        HeaderValue::from_bytes(b"name=caf\xe9; mobux_session=secret").unwrap(),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let seen = body_text(response).await;
        assert!(seen.contains("\ncookie: ?\n"), "{seen}");
        assert!(!seen.contains("secret"), "{seen}");
    }

    #[tokio::test]
    async fn an_unknown_name_is_not_found() {
        let port = upstream().await;
        for uri in ["/proxy/nope/echo", "/proxy/nope/", "/proxy/nope"] {
            let response = app(targets_for(port))
                .oneshot(request("GET", uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
            assert_eq!(
                body_text(response).await,
                "no proxy target by that name; 1 configured\n"
            );
        }
    }

    #[tokio::test]
    async fn the_bare_mount_redirects_relatively_into_the_target() {
        let port = upstream().await;
        let response = app(targets_for(port))
            .oneshot(request("GET", "/proxy/up?x=1").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
        assert_eq!(header_of(&response, "location"), "./up/?x=1");
    }

    #[tokio::test]
    async fn a_root_absolute_redirect_stays_under_the_mount() {
        let port = upstream().await;
        let response = app(targets_for(port))
            .oneshot(
                request("GET", "/proxy/up/a/b/redirect")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FOUND);
        let location = header_of(&response, "location");
        assert_eq!(location, "../../landing?x=1");
        assert_eq!(
            resolve("https://host/outer/proxy/up/a/b/redirect", &location),
            "https://host/outer/proxy/up/landing?x=1"
        );

        for (path, expected) in [
            ("/proxy/up/aware", "/proxy/up/landing"),
            ("/proxy/up/elsewhere", "https://example.com/x"),
        ] {
            let response = app(targets_for(port))
                .oneshot(request("GET", path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(header_of(&response, "location"), expected, "{path}");
        }
    }

    #[tokio::test]
    async fn a_websocket_echoes_through_the_proxy() {
        let port = upstream().await;
        let front = serve(app(targets_for(port))).await;
        let mut stream = open_websocket(front).await;
        assert_eq!(echo(&mut stream, "hello").await, "echo: hello");
    }

    #[tokio::test]
    async fn an_idle_websocket_is_closed() {
        let port = upstream().await;
        let mut targets = targets_for(port);
        targets.idle_timeout = Duration::from_millis(300);
        let front = serve(app(targets)).await;
        let mut stream = open_websocket(front).await;
        assert_eq!(echo(&mut stream, "hello").await, "echo: hello");
        let mut rest = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut rest))
            .await
            .expect("the proxy closes an idle connection")
            .unwrap();
    }

    async fn open_websocket(front: u16) -> TcpStream {
        let mut stream = TcpStream::connect(("127.0.0.1", front)).await.unwrap();
        stream
            .write_all(
                format!(
                    "GET /proxy/up/ws HTTP/1.1\r\nHost: 127.0.0.1:{front}\r\n\
                     Connection: Upgrade\r\nUpgrade: websocket\r\n\
                     Sec-WebSocket-Version: 13\r\n\
                     Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let head = read_head(&mut stream).await;
        assert!(head.starts_with("HTTP/1.1 101"), "{head}");
        assert!(
            head.to_lowercase()
                .contains("sec-websocket-accept: s3pplmbitxaq9kygzzhzrbk+xoo="),
            "{head}"
        );
        stream
    }

    async fn echo(stream: &mut TcpStream, text: &str) -> String {
        let payload = text.as_bytes();
        let mask = [1u8, 2, 3, 4];
        let mut frame = vec![0x81, 0x80 | payload.len() as u8];
        frame.extend_from_slice(&mask);
        frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        stream.write_all(&frame).await.unwrap();

        let mut header = [0u8; 2];
        tokio::time::timeout(Duration::from_secs(5), stream.read_exact(&mut header))
            .await
            .expect("an echo frame arrives")
            .unwrap();
        assert_eq!(header[0], 0x81);
        let mut reply = vec![0u8; (header[1] & 0x7f) as usize];
        stream.read_exact(&mut reply).await.unwrap();
        String::from_utf8(reply).unwrap()
    }

    async fn read_head(stream: &mut TcpStream) -> String {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            tokio::time::timeout(Duration::from_secs(5), stream.read_exact(&mut byte))
                .await
                .expect("a response head arrives")
                .unwrap();
            head.push(byte[0]);
        }
        String::from_utf8(head).unwrap()
    }

    #[test]
    fn a_bad_target_stops_the_server() {
        let mut settings = Config::default();
        settings.proxy.targets.insert("vite".to_string(), 0);
        let err = ProxyTargets::from_config(&settings, "mobux_session")
            .unwrap_err()
            .to_string();
        assert!(err.contains("proxy.targets"), "{err}");
        assert!(err.contains("vite"), "{err}");
    }

    /// RFC 3986 reference resolution for a relative path made of `../`
    /// segments and a tail, merged onto the base's directory.
    fn resolve(base: &str, relative: &str) -> String {
        let mut directory = base[..base.rfind('/').unwrap()].to_string();
        let mut tail = relative;
        while let Some(rest) = tail.strip_prefix("../") {
            directory.truncate(directory.rfind('/').unwrap());
            tail = rest;
        }
        format!("{directory}/{}", tail.trim_start_matches("./"))
    }
}
