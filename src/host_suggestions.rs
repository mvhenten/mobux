//! Best-effort host suggestions for the "add remote node" host field
//! (issue #193). Three independent providers are attempted; each is
//! fully optional — a missing tool, a parse error, or a timeout means it
//! contributes nothing, never an error surfaced to the client:
//!
//! 1. `ssh-config` — parses `Host` aliases out of `~/.ssh/config`. Zero
//!    deps, always attempted, runs synchronously (a single small local
//!    file read).
//! 2. `tailscale` — `tailscale status --json`, only useful (and only
//!    even worth trying) when the binary resolves; peers map to a
//!    hostname plus an online flag.
//! 3. `mdns` (avahi) — a short `avahi-browse` scan for `_workstation._tcp`
//!    records, hard-capped so a stalled/absent daemon can't stall the
//!    endpoint.
//!
//! The three providers run concurrently (see `api_host_suggestions` in
//! main.rs) so the endpoint's total latency is bounded by the slowest
//! one, not their sum.
//!
//! Both subprocess-backed providers set `kill_on_drop(true)`: `tokio::time::
//! timeout` firing drops the `output()` future without waiting on the
//! child, and without `kill_on_drop` tokio leaves it running — a
//! never-answering `tailscaled`/`avahi-daemon` would otherwise leak one
//! child process per picker open instead of being reaped at the timeout.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HostSuggestion {
    pub name: String,
    pub source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub online: Option<bool>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

// ── ssh-config ──────────────────────────────────────────────────────────

/// `Host` aliases from `~/.ssh/config`. Missing file, unreadable file, or no
/// `~/.ssh` at all is a normal "nothing to suggest" outcome, not an error.
pub fn ssh_config_hosts() -> Vec<HostSuggestion> {
    let Some(home) = home_dir() else {
        return Vec::new();
    };
    let Ok(contents) = std::fs::read_to_string(home.join(".ssh").join("config")) else {
        return Vec::new();
    };
    parse_ssh_config_hosts(&contents)
}

/// A `Host` line can list several space-separated aliases; each is
/// suggested independently. Patterns (`*`, `?`) and negations (`!foo`)
/// describe a matching *rule*, not an addressable host, so they're skipped.
/// `Include` directives are not followed — aliases living in an included
/// file (e.g. `~/.ssh/config.d/*`) are not suggested. Best-effort only;
/// not worth the added complexity here.
fn parse_ssh_config_hosts(contents: &str) -> Vec<HostSuggestion> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.splitn(2, char::is_whitespace);
        let Some(keyword) = parts.next() else {
            continue;
        };
        if !keyword.eq_ignore_ascii_case("host") {
            continue;
        }
        let Some(rest) = parts.next() else {
            continue;
        };
        for alias in rest.split_whitespace() {
            if alias.contains('*') || alias.contains('?') || alias.starts_with('!') {
                continue;
            }
            if seen.insert(alias.to_string()) {
                out.push(HostSuggestion {
                    name: alias.to_string(),
                    source: "ssh",
                    online: None,
                });
            }
        }
    }
    out
}

// ── tailscale ───────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
struct TailscalePeer {
    #[serde(rename = "HostName", default)]
    host_name: String,
    #[serde(rename = "DNSName", default)]
    dns_name: String,
    #[serde(rename = "Online", default)]
    online: bool,
}

#[derive(Debug, Default, Deserialize)]
struct TailscaleStatus {
    #[serde(rename = "Peer", default)]
    peer: HashMap<String, TailscalePeer>,
}

/// Runs `tailscale status --json` under `timeout`. Any failure — binary
/// missing, non-zero exit, malformed JSON, or the timeout firing — yields
/// an empty list rather than an error.
pub async fn tailscale_hosts(timeout: Duration) -> Vec<HostSuggestion> {
    let stdout = match tokio::time::timeout(
        timeout,
        tokio::process::Command::new("tailscale")
            .args(["status", "--json"])
            .kill_on_drop(true)
            .output(),
    )
    .await
    {
        Ok(Ok(output)) if output.status.success() => output.stdout,
        _ => return Vec::new(),
    };

    let Ok(status) = serde_json::from_slice::<TailscaleStatus>(&stdout) else {
        return Vec::new();
    };
    parse_tailscale_peers(status)
}

fn parse_tailscale_peers(status: TailscaleStatus) -> Vec<HostSuggestion> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for peer in status.peer.into_values() {
        let name = tailscale_display_name(&peer);
        if name.is_empty() || !seen.insert(name.clone()) {
            continue;
        }
        out.push(HostSuggestion {
            name,
            source: "tailscale",
            online: Some(peer.online),
        });
    }
    out
}

fn tailscale_display_name(peer: &TailscalePeer) -> String {
    if !peer.host_name.is_empty() {
        return peer.host_name.clone();
    }
    peer.dns_name.trim_end_matches('.').to_string()
}

// ── avahi / mDNS ────────────────────────────────────────────────────────

/// Runs a short, hard-timed-out `avahi-browse` scan. Any failure — binary
/// missing, non-zero exit, or the timeout firing — yields an empty list.
pub async fn avahi_hosts(timeout: Duration) -> Vec<HostSuggestion> {
    let stdout = match tokio::time::timeout(
        timeout,
        tokio::process::Command::new("avahi-browse")
            .args(["-rpt", "_workstation._tcp"])
            .kill_on_drop(true)
            .output(),
    )
    .await
    {
        Ok(Ok(output)) if output.status.success() => output.stdout,
        _ => return Vec::new(),
    };

    parse_avahi_output(&String::from_utf8_lossy(&stdout))
}

/// `avahi-browse -rpt` (parseable + resolve + terminate) emits `;`-separated
/// records; a resolved one starts with `=` and has the shape
/// `=;iface;proto;name;type;domain;host;address;port;txt`. Only resolved
/// records carry a usable hostname (field index 6), so unresolved `+`
/// (found-but-not-yet-resolved) records are skipped.
fn parse_avahi_output(text: &str) -> Vec<HostSuggestion> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for line in text.lines() {
        if !line.starts_with('=') {
            continue;
        }
        let fields: Vec<&str> = line.split(';').collect();
        let Some(host) = fields.get(6) else {
            continue;
        };
        let host = host.trim();
        if host.is_empty() || !seen.insert(host.to_string()) {
            continue;
        }
        out.push(HostSuggestion {
            name: host.to_string(),
            source: "mdns",
            online: None,
        });
    }
    out
}

// ── merge ───────────────────────────────────────────────────────────────

/// Merges provider results in the given order, deduping by exact name
/// match. A later duplicate never displaces an earlier provider's `source`,
/// but it can fill in an `online` flag the earlier occurrence didn't have
/// (e.g. an ssh-config alias that also shows up as a tailscale peer keeps
/// its `ssh` source and gains the peer's online status).
pub fn merge(lists: impl IntoIterator<Item = Vec<HostSuggestion>>) -> Vec<HostSuggestion> {
    let mut out: Vec<HostSuggestion> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();

    for list in lists {
        for item in list {
            if let Some(&i) = index.get(&item.name) {
                if out[i].online.is_none() && item.online.is_some() {
                    out[i].online = item.online;
                }
                continue;
            }
            index.insert(item.name.clone(), out.len());
            out.push(item);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ssh_config_hosts_skips_patterns_and_negations() {
        let config = "
Host devbox
    HostName 10.0.0.5

Host *
    ForwardAgent yes

Host gpu-box lab-box
    User mvhenten

Host !excluded jump-host
    ProxyJump devbox

Host web?
    User www
";
        let parsed = parse_ssh_config_hosts(config);
        let hosts: Vec<&str> = parsed.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(hosts, vec!["devbox", "gpu-box", "lab-box", "jump-host"]);
        assert!(parsed
            .iter()
            .all(|h| h.source == "ssh" && h.online.is_none()));
    }

    #[test]
    fn parse_ssh_config_hosts_dedupes_repeated_aliases() {
        let config = "Host devbox\n  User a\nHost devbox\n  User b\n";
        let hosts = parse_ssh_config_hosts(config);
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].name, "devbox");
    }

    #[test]
    fn parse_ssh_config_hosts_empty_on_blank_file() {
        assert!(parse_ssh_config_hosts("").is_empty());
        assert!(parse_ssh_config_hosts("# just a comment\n").is_empty());
    }

    #[test]
    fn tailscale_peers_map_hostname_and_online() {
        let status: TailscaleStatus = serde_json::from_str(
            r#"{
                "Peer": {
                    "peer1": {"HostName": "gpu-box", "DNSName": "gpu-box.tailnet.ts.net.", "Online": true},
                    "peer2": {"HostName": "", "DNSName": "lab-box.tailnet.ts.net.", "Online": false}
                }
            }"#,
        )
        .unwrap();
        let mut hosts = parse_tailscale_peers(status);
        hosts.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(
            hosts,
            vec![
                HostSuggestion {
                    name: "gpu-box".into(),
                    source: "tailscale",
                    online: Some(true)
                },
                HostSuggestion {
                    name: "lab-box.tailnet.ts.net".into(),
                    source: "tailscale",
                    online: Some(false)
                },
            ]
        );
    }

    #[test]
    fn tailscale_peers_empty_when_no_peers() {
        let status = TailscaleStatus::default();
        assert!(parse_tailscale_peers(status).is_empty());
    }

    #[test]
    fn parse_avahi_output_reads_resolved_records_only() {
        let text = "\
+;eth0;IPv4;devbox;_workstation._tcp;local\n\
=;eth0;IPv4;devbox;_workstation._tcp;local;devbox.local;192.168.1.5;9;\"\"\n\
=;eth0;IPv4;labbox;_workstation._tcp;local;labbox.local;192.168.1.6;9;\"\"\n\
=;eth0;IPv4;devbox;_workstation._tcp;local;devbox.local;192.168.1.5;9;\"\"\n";
        let hosts = parse_avahi_output(text);
        let names: Vec<&str> = hosts.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, vec!["devbox.local", "labbox.local"]);
        assert!(hosts.iter().all(|h| h.source == "mdns" && h.online.is_none()));
    }

    #[test]
    fn parse_avahi_output_empty_on_garbage() {
        assert!(parse_avahi_output("not avahi output at all\n").is_empty());
    }

    #[test]
    fn merge_dedupes_by_name_first_source_wins() {
        let ssh = vec![HostSuggestion {
            name: "devbox".into(),
            source: "ssh",
            online: None,
        }];
        let tailscale = vec![HostSuggestion {
            name: "devbox".into(),
            source: "tailscale",
            online: Some(true),
        }];
        let mdns = vec![HostSuggestion {
            name: "labbox.local".into(),
            source: "mdns",
            online: None,
        }];

        let merged = merge([ssh, tailscale, mdns]);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].name, "devbox");
        assert_eq!(merged[0].source, "ssh");
        assert_eq!(merged[0].online, Some(true));
        assert_eq!(merged[1].name, "labbox.local");
    }

    #[test]
    fn merge_empty_lists_yield_empty_result() {
        assert!(merge([Vec::new(), Vec::new(), Vec::new()]).is_empty());
    }
}
