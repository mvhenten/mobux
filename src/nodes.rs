//! Fleet node identity + transparent SSH proxy plumbing (issue #176 phase 2).
//!
//! A node is just a name -> ssh target mapping (see `db::Node`). Reaching a
//! node's tmux is "the same PTY handler, but spawn `ssh -tt <target> ...`
//! instead of `bash -c ...`" — no new protocol. SSH's own pty allocation
//! (`-tt`) already forwards window-change (resize) requests to the remote
//! pty over the SSH channel, so the existing resize path (client -> local
//! pty -> here) just works once the child process is `ssh` instead of
//! `bash` — nothing else in the PTY plumbing changes.

use std::time::Duration;

use portable_pty::CommandBuilder;
use tokio::net::TcpStream;

/// Build the attach command for a tmux session: local (`bash -c "tmux ..."`)
/// when `ssh_target` is `None`, or remote (`ssh -tt <target> "tmux ..."`)
/// otherwise. The mouse/passthrough/aggressive-resize tmux options and the
/// forced TERM are identical either way — the only difference is the outer
/// shell the tmux commands run under.
pub fn build_attach_command(
    ssh_target: Option<&str>,
    tmux_bin: &str,
    session_name: &str,
) -> CommandBuilder {
    let tmux_setup = format!(
        "{tmux} set-option -g mouse on 2>/dev/null; \
         {tmux} set-option -g allow-passthrough on 2>/dev/null; \
         {tmux} set-window-option -g aggressive-resize on 2>/dev/null; \
         {tmux} attach-session -t {session}",
        tmux = tmux_bin,
        session = session_name,
    );

    match ssh_target {
        None => {
            let mut cmd = CommandBuilder::new("bash");
            // See handle_ws in main.rs for why TERM is forced unconditionally.
            cmd.env("TERM", "xterm-256color");
            cmd.args(["-c", &tmux_setup]);
            cmd
        }
        Some(target) => {
            let mut cmd = CommandBuilder::new("ssh");
            // -tt forces remote pty allocation. The remote shell doesn't
            // inherit our TERM env (ssh only forwards vars the server's
            // AcceptEnv allows, which defaults to none), so set it inline
            // as part of the remote command instead.
            cmd.args(["-tt", target, &format!("TERM=xterm-256color {tmux_setup}")]);
            cmd
        }
    }
}

/// Parse an `ssh` target (`user@host`, `user@host:port`, bare `host`, or
/// `host:port`) into a dialable `host:port`, defaulting to port 22.
fn resolve_addr(ssh_target: &str) -> String {
    let host_port = ssh_target.rsplit_once('@').map_or(ssh_target, |(_, h)| h);
    if host_port.contains(':') {
        host_port.to_string()
    } else {
        format!("{host_port}:22")
    }
}

/// Reachability probe: attempt a TCP connect to the node's ssh target within
/// `timeout`. This checks transport reachability only — it never attempts
/// SSH auth, so a node needing an unconfirmed host key still probes
/// reachable (the picker only needs "is anything listening there").
pub async fn probe_reachable(ssh_target: &str, timeout: Duration) -> bool {
    let addr = resolve_addr(ssh_target);
    tokio::time::timeout(timeout, TcpStream::connect(&addr))
        .await
        .map(|r| r.is_ok())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn resolve_addr_defaults_port_22() {
        assert_eq!(resolve_addr("gpu-box.local"), "gpu-box.local:22");
        assert_eq!(resolve_addr("mvhenten@gpu-box.local"), "gpu-box.local:22");
    }

    #[test]
    fn resolve_addr_keeps_explicit_port() {
        assert_eq!(resolve_addr("gpu-box.local:2222"), "gpu-box.local:2222");
        assert_eq!(
            resolve_addr("mvhenten@gpu-box.local:2222"),
            "gpu-box.local:2222"
        );
    }

    #[test]
    fn resolve_addr_handles_bare_ip() {
        assert_eq!(resolve_addr("10.0.0.5"), "10.0.0.5:22");
        assert_eq!(resolve_addr("root@10.0.0.5:22"), "10.0.0.5:22");
    }

    #[tokio::test]
    async fn probe_reachable_true_for_listening_port() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        // Keep the listener alive for the duration of the probe.
        let _accept = tokio::spawn(async move {
            let _ = listener.accept().await;
        });
        assert!(probe_reachable(&addr.to_string(), Duration::from_secs(2)).await);
    }

    #[tokio::test]
    async fn probe_reachable_false_for_closed_port() {
        // Bind then immediately drop to get a port nothing listens on.
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        drop(listener);
        assert!(!probe_reachable(&addr.to_string(), Duration::from_millis(500)).await);
    }

    fn argv(cmd: &CommandBuilder) -> Vec<String> {
        cmd.get_argv()
            .iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn build_attach_command_local_uses_bash() {
        let cmd = build_attach_command(None, "tmux", "demo");
        let argv = argv(&cmd);
        assert_eq!(argv[0], "bash");
        assert_eq!(argv[1], "-c");
        assert!(argv[2].contains("tmux attach-session -t demo"));
    }

    #[test]
    fn build_attach_command_remote_uses_ssh_tt() {
        let cmd = build_attach_command(Some("mvhenten@gpu-box"), "tmux", "demo");
        let argv = argv(&cmd);
        assert_eq!(argv[0], "ssh");
        assert_eq!(argv[1], "-tt");
        assert_eq!(argv[2], "mvhenten@gpu-box");
        assert!(argv[3].starts_with("TERM=xterm-256color "));
        assert!(argv[3].contains("tmux attach-session -t demo"));
    }
}
