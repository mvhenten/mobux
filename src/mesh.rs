//! Mesh enumeration (EDD phase 1).
//!
//! Discovers other mobux nodes on the tailnet so the UI can offer a host
//! picker. Two pieces:
//!
//!   * [`peers`] — the `/api/peers` handler logic: list tailnet peers from
//!     `tailscale status --json`, merge in manually-configured peers from
//!     `MOBUX_PEERS`, probe each candidate's `/api/identify`, and report
//!     reachability + version.
//!   * pure parsing/merge helpers, unit-tested against a scrubbed fixture.
//!
//! No cert pinning here — this is pre-pinning discovery, so probes accept
//! self-signed certs (relay-level TOFU pinning is phase 2). Nothing here
//! trusts a peer; it only asks "are you a mobux and which version?".

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

/// How long a single `/api/identify` probe may take before it's considered
/// unreachable. Kept short so enumerating a tailnet with dead hosts stays
/// snappy; all probes run concurrently.
const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

/// What `/api/identify` returns. Authoritative shape for the whole mesh —
/// the relay (phase 2) and the UI both key off `app == "mobux"` and `version`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Identify {
    pub app: String,
    pub version: String,
}

/// One enumerated peer as returned by `/api/peers`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Peer {
    /// Display name (MagicDNS short name, hostname, or the manual host string).
    pub name: String,
    /// Dialable host (MagicDNS FQDN without trailing dot, or manual host).
    pub host: String,
    pub port: u16,
    /// Reported mobux version, present only when the probe succeeded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// True when `/api/identify` answered with `app == "mobux"`.
    pub reachable: bool,
}

/// A peer candidate before probing — name + host, no reachability yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub name: String,
    pub host: String,
    pub port: u16,
}

/// Structured failure the UI can show. The EDD is explicit: never silently
/// return an empty list when tailscale itself is unavailable — distinguish
/// "tailscale broken" from "tailscale fine, no peers".
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MeshError {
    /// `tailscale` binary not found on PATH.
    TailscaleNotInstalled { message: String },
    /// `tailscale status` ran but failed — most often missing operator
    /// permission (`tailscale set --operator=<user>`).
    TailscaleUnavailable { message: String },
    /// Output wasn't the JSON we expected.
    ParseError { message: String },
}

impl std::fmt::Display for MeshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MeshError::TailscaleNotInstalled { message }
            | MeshError::TailscaleUnavailable { message }
            | MeshError::ParseError { message } => write!(f, "{message}"),
        }
    }
}

// ── tailscale status --json parsing ──────────────────────────────────────

/// Minimal view of `tailscale status --json` — only the fields enumeration
/// needs. serde ignores everything else, so this stays robust across
/// tailscale versions that add fields.
#[derive(Debug, Deserialize)]
struct TsStatus {
    #[serde(rename = "Peer")]
    peer: Option<BTreeMap<String, TsNode>>,
}

#[derive(Debug, Deserialize)]
struct TsNode {
    #[serde(rename = "HostName")]
    host_name: Option<String>,
    #[serde(rename = "DNSName")]
    dns_name: Option<String>,
}

/// Strip the trailing dot tailscale puts on FQDNs (`host.tailnet.ts.net.`).
fn strip_trailing_dot(s: &str) -> &str {
    s.strip_suffix('.').unwrap_or(s)
}

/// Short display name from a MagicDNS FQDN: `host.tailnet.ts.net` -> `host`.
fn short_name(fqdn: &str) -> &str {
    fqdn.split('.').next().unwrap_or(fqdn)
}

/// Parse `tailscale status --json` into peer candidates on the given mobux
/// `port`. Prefers the MagicDNS name as the dialable host; falls back to the
/// hostname. Peers with neither are skipped (nothing to dial). Self is not in
/// the `Peer` map, so it's naturally excluded.
pub fn parse_tailscale_peers(json: &str, port: u16) -> Result<Vec<Candidate>, MeshError> {
    let status: TsStatus = serde_json::from_str(json).map_err(|e| MeshError::ParseError {
        message: format!("tailscale status JSON: {e}"),
    })?;

    let mut out = Vec::new();
    for node in status.peer.unwrap_or_default().into_values() {
        let dns = node
            .dns_name
            .as_deref()
            .map(strip_trailing_dot)
            .filter(|s| !s.is_empty());
        let host_name = node.host_name.as_deref().filter(|s| !s.is_empty());

        // Dial the MagicDNS FQDN when present (it's what the leaf cert is
        // issued for); otherwise the bare hostname.
        let host = match (dns, host_name) {
            (Some(d), _) => d.to_string(),
            (None, Some(h)) => h.to_string(),
            (None, None) => continue,
        };
        // Prefer a human-friendly short name; fall back to hostname.
        let name = dns
            .map(short_name)
            .or(host_name)
            .unwrap_or(host.as_str())
            .to_string();

        out.push(Candidate { name, host, port });
    }
    Ok(out)
}

// ── manual peers (MOBUX_PEERS) ───────────────────────────────────────────

/// Parse a comma-separated `MOBUX_PEERS` value into candidates. Each entry is
/// `host` or `host:port`; a bare host uses `default_port` (this node's port).
/// Whitespace and empty entries are ignored. Unparseable ports are skipped
/// rather than failing the whole list.
pub fn parse_manual_peers(raw: &str, default_port: u16) -> Vec<Candidate> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|entry| {
            let (host, port) = match entry.rsplit_once(':') {
                // Treat as host:port only when the suffix is a real port.
                // Bare IPv6 has no port; `[::1]:8080` would need brackets,
                // which we don't expect for tailnet MagicDNS names.
                Some((h, p)) => match p.parse::<u16>() {
                    Ok(port) if !h.is_empty() => (h.to_string(), port),
                    _ => (entry.to_string(), default_port),
                },
                None => (entry.to_string(), default_port),
            };
            Candidate {
                name: host.clone(),
                host,
                port,
            }
        })
        .collect()
}

/// Merge discovered candidates with manual ones. Dedup key is `(host, port)`.
/// Manual entries win on name collision so an operator-chosen label sticks,
/// and manual-only hosts are appended. Order: discovered first (stable),
/// then manual extras.
pub fn merge_candidates(discovered: Vec<Candidate>, manual: Vec<Candidate>) -> Vec<Candidate> {
    let mut out: Vec<Candidate> = Vec::new();
    let mut seen: std::collections::HashSet<(String, u16)> = std::collections::HashSet::new();

    // Manual names take precedence: index them so a discovered host with a
    // matching (host, port) adopts the manual label.
    let manual_names: BTreeMap<(String, u16), String> = manual
        .iter()
        .map(|c| ((c.host.clone(), c.port), c.name.clone()))
        .collect();

    for mut c in discovered {
        let key = (c.host.clone(), c.port);
        if let Some(name) = manual_names.get(&key) {
            c.name = name.clone();
        }
        if seen.insert(key) {
            out.push(c);
        }
    }
    for c in manual {
        let key = (c.host.clone(), c.port);
        if seen.insert(key) {
            out.push(c);
        }
    }
    out
}

// ── probing ──────────────────────────────────────────────────────────────

/// Probe one candidate's `/api/identify` over HTTPS (accepting self-signed
/// certs — pre-pinning discovery). Returns a fully-resolved [`Peer`].
async fn probe(client: &reqwest::Client, c: Candidate) -> Peer {
    let url = format!("https://{}:{}/api/identify", c.host, c.port);
    let version = match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => match resp.json::<Identify>().await {
            Ok(id) if id.app == "mobux" => Some(id.version),
            _ => None,
        },
        _ => None,
    };
    Peer {
        name: c.name,
        host: c.host,
        port: c.port,
        reachable: version.is_some(),
        version,
    }
}

/// Build the probe HTTP client: self-signed certs accepted, short timeout.
fn probe_client() -> Result<reqwest::Client, MeshError> {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(PROBE_TIMEOUT)
        .connect_timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|e| MeshError::ParseError {
            message: format!("building probe client: {e}"),
        })
}

/// Probe every candidate concurrently and collect the results.
pub async fn probe_all(candidates: Vec<Candidate>) -> Result<Vec<Peer>, MeshError> {
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let client = probe_client()?;
    let peers =
        futures_util::future::join_all(candidates.into_iter().map(|c| probe(&client, c))).await;
    Ok(peers)
}

// ── tailscale invocation ─────────────────────────────────────────────────

/// Run `tailscale status --json`, mapping failures to [`MeshError`] variants
/// the UI can distinguish. Override the binary with `MOBUX_TAILSCALE_BIN`
/// (tests / non-standard installs).
pub async fn run_tailscale_status() -> Result<String, MeshError> {
    let bin = std::env::var("MOBUX_TAILSCALE_BIN").unwrap_or_else(|_| "tailscale".to_string());
    let output = Command::new(&bin)
        .args(["status", "--json"])
        .output()
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                MeshError::TailscaleNotInstalled {
                    message: format!(
                        "tailscale not found ({bin}); install Tailscale to enumerate peers"
                    ),
                }
            } else {
                MeshError::TailscaleUnavailable {
                    message: format!("running `{bin} status --json`: {e}"),
                }
            }
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let hint = "is tailscaled running and is mobux allowed to query it? \
             On Linux run `tailscale set --operator=$USER`.";
        return Err(MeshError::TailscaleUnavailable {
            message: if stderr.is_empty() {
                format!("`{bin} status --json` failed; {hint}")
            } else {
                format!("`{bin} status --json` failed: {stderr}; {hint}")
            },
        });
    }

    String::from_utf8(output.stdout).map_err(|e| MeshError::ParseError {
        message: format!("tailscale status output not UTF-8: {e}"),
    })
}

/// Full `/api/peers` pipeline: enumerate tailnet peers, merge manual peers
/// from `MOBUX_PEERS`, probe all. `port` is this node's listen port.
pub async fn enumerate(port: u16) -> Result<Vec<Peer>, MeshError> {
    let json = run_tailscale_status().await?;
    let discovered = parse_tailscale_peers(&json, port)?;
    let manual = std::env::var("MOBUX_PEERS")
        .ok()
        .map(|raw| parse_manual_peers(&raw, port))
        .unwrap_or_default();
    let candidates = merge_candidates(discovered, manual);
    probe_all(candidates).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("testdata/tailscale_status.json");

    #[test]
    fn parses_fixture_peers_with_magicdns_names() {
        let peers = parse_tailscale_peers(FIXTURE, 5151).expect("fixture parses");
        // Fixture has 3 peers (Self is excluded — it's not in the Peer map).
        assert_eq!(peers.len(), 3, "expected 3 peers, got {peers:?}");
        for p in &peers {
            assert_eq!(p.port, 5151);
            // host is the MagicDNS FQDN, no trailing dot
            assert!(p.host.ends_with(".ts.net"), "host not FQDN: {}", p.host);
            assert!(!p.host.ends_with('.'), "trailing dot left on {}", p.host);
            // name is the short label
            assert!(!p.name.contains('.'), "name not shortened: {}", p.name);
        }
        let hosts: Vec<_> = peers.iter().map(|p| p.host.as_str()).collect();
        assert!(hosts.contains(&"host2.tailnet-scrub.ts.net"));
        let names: Vec<_> = peers.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"host2"));
    }

    #[test]
    fn parse_falls_back_to_hostname_without_dnsname() {
        let json = r#"{"Peer":{"k":{"HostName":"barebox","DNSName":""}}}"#;
        let peers = parse_tailscale_peers(json, 8080).unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].host, "barebox");
        assert_eq!(peers[0].name, "barebox");
    }

    #[test]
    fn parse_skips_peer_with_no_addressable_name() {
        let json = r#"{"Peer":{"k":{"HostName":"","DNSName":""}}}"#;
        let peers = parse_tailscale_peers(json, 8080).unwrap();
        assert!(peers.is_empty());
    }

    #[test]
    fn parse_empty_peer_map_is_ok_and_empty() {
        let peers = parse_tailscale_peers(r#"{"Peer":{}}"#, 8080).unwrap();
        assert!(peers.is_empty());
        // Missing Peer key entirely is also fine (no peers, not an error).
        let peers = parse_tailscale_peers(r#"{}"#, 8080).unwrap();
        assert!(peers.is_empty());
    }

    #[test]
    fn parse_rejects_garbage() {
        let err = parse_tailscale_peers("not json", 8080).unwrap_err();
        assert!(matches!(err, MeshError::ParseError { .. }));
    }

    #[test]
    fn manual_peers_default_port_and_explicit_port() {
        let m = parse_manual_peers("a.example, b.example:9000", 5151);
        assert_eq!(m.len(), 2);
        assert_eq!(
            m[0],
            Candidate {
                name: "a.example".into(),
                host: "a.example".into(),
                port: 5151
            }
        );
        assert_eq!(
            m[1],
            Candidate {
                name: "b.example".into(),
                host: "b.example".into(),
                port: 9000
            }
        );
    }

    #[test]
    fn manual_peers_ignores_blanks_and_whitespace() {
        let m = parse_manual_peers("  , host1 ,, host2:1234 , ", 8080);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].host, "host1");
        assert_eq!(m[1].host, "host2");
        assert_eq!(m[1].port, 1234);
    }

    #[test]
    fn manual_peers_bad_port_falls_back_to_whole_string() {
        // A non-numeric suffix isn't a port; keep the entry as a bare host.
        let m = parse_manual_peers("weird:notaport", 7000);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].host, "weird:notaport");
        assert_eq!(m[0].port, 7000);
    }

    #[test]
    fn merge_dedups_on_host_and_port() {
        let discovered = vec![
            Candidate {
                name: "a".into(),
                host: "a.ts.net".into(),
                port: 5151,
            },
            Candidate {
                name: "b".into(),
                host: "b.ts.net".into(),
                port: 5151,
            },
        ];
        let manual = vec![
            // same host+port as discovered "a" -> dedup, manual name wins
            Candidate {
                name: "alpha".into(),
                host: "a.ts.net".into(),
                port: 5151,
            },
            // new host -> appended
            Candidate {
                name: "c".into(),
                host: "c.ts.net".into(),
                port: 5151,
            },
        ];
        let merged = merge_candidates(discovered, manual);
        assert_eq!(merged.len(), 3);
        // discovered "a" adopts the manual label
        assert_eq!(merged[0].name, "alpha");
        assert_eq!(merged[0].host, "a.ts.net");
        assert_eq!(merged[1].host, "b.ts.net");
        // manual-only appended last
        assert_eq!(merged[2].host, "c.ts.net");
        assert_eq!(merged[2].name, "c");
    }

    #[test]
    fn merge_same_host_different_port_kept_separate() {
        let discovered = vec![Candidate {
            name: "a".into(),
            host: "a.ts.net".into(),
            port: 5151,
        }];
        let manual = vec![Candidate {
            name: "a-alt".into(),
            host: "a.ts.net".into(),
            port: 5152,
        }];
        let merged = merge_candidates(discovered, manual);
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn mesh_error_serializes_with_kind_tag() {
        let e = MeshError::TailscaleUnavailable {
            message: "boom".into(),
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "tailscale_unavailable");
        assert_eq!(v["message"], "boom");
    }
}
