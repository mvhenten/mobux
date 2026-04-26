use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use tokio::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub name: String,
    pub windows: i32,
    pub attached: i32,
    pub created_unix: i64,
}

pub async fn list_sessions() -> Result<Vec<Session>> {
    let output = Command::new("tmux")
        .args([
            "list-sessions",
            "-F",
            "#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}",
        ])
        .output()
        .await
        .context("failed to execute tmux")?;

    if !output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        // Common case when no tmux server is running yet.
        if msg.contains("failed to connect to server") || msg.contains("no server running") {
            return Ok(vec![]);
        }
        return Err(anyhow!("tmux list-sessions failed: {}", msg));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut out = vec![];
    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() != 4 {
            continue;
        }
        out.push(Session {
            name: parts[0].to_string(),
            windows: parts[1].parse().unwrap_or(0),
            attached: parts[2].parse().unwrap_or(0),
            created_unix: parts[3].parse().unwrap_or(0),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub async fn new_session(name: &str) -> Result<()> {
    let output = Command::new("tmux")
        .args(["new-session", "-d", "-s", name])
        .output()
        .await
        .context("failed to execute tmux")?;
    if !output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(anyhow!("tmux new-session failed: {}", msg));
    }
    Ok(())
}

pub async fn kill_session(name: &str) -> Result<()> {
    let output = Command::new("tmux")
        .args(["kill-session", "-t", name])
        .output()
        .await
        .context("failed to execute tmux")?;
    if !output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(anyhow!("tmux kill-session failed: {}", msg));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pane {
    pub index: String,
    pub title: String,
    pub active: bool,
}

pub async fn list_panes(session: &str) -> Result<Vec<Pane>> {
    // List windows (the main navigable units in tmux)
    let output = Command::new("tmux")
        .args([
            "list-windows",
            "-t", session,
            "-F",
            "#{window_index}\t#{window_name}\t#{window_active}",
        ])
        .output()
        .await
        .context("failed to execute tmux")?;

    if !output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(anyhow!("tmux list-windows failed: {}", msg));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut out = vec![];
    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() != 3 {
            continue;
        }
        out.push(Pane {
            index: parts[0].to_string(),
            title: parts[1].to_string(),
            active: parts[2] == "1",
        });
    }
    Ok(out)
}

pub async fn select_pane(session: &str, window_index: &str) -> Result<()> {
    let target = format!("{}:{}", session, window_index);
    let output = Command::new("tmux")
        .args(["select-window", "-t", &target])
        .output()
        .await
        .context("failed to execute tmux")?;
    if !output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(anyhow!("tmux select-window failed: {}", msg));
    }
    Ok(())
}

/// Run a tmux command against a session.
pub async fn run_command(session: &str, command: &str) -> Result<String> {
    // Append ':' so tmux treats it as a session target, not a window index
    // (e.g. session "0" would otherwise target window 0)
    let target = format!("{}:", session);
    let args: Vec<String> = match command {
        "new-window"   => vec!["new-window".into(), "-t".into(), target],
        "kill-window"  => vec!["kill-window".into(), "-t".into(), target],
        "split-h"      => vec!["split-window".into(), "-h".into(), "-t".into(), target],
        "split-v"      => vec!["split-window".into(), "-v".into(), "-t".into(), target],
        "next-window"  => vec!["next-window".into(), "-t".into(), target],
        "prev-window"  => vec!["previous-window".into(), "-t".into(), target],
        "next-pane"    => vec!["select-pane".into(), "-t".into(), format!("{}:+", session)],
        "prev-pane"    => vec!["select-pane".into(), "-t".into(), format!("{}:-", session)],
        "kill-pane"    => vec!["kill-pane".into(), "-t".into(), target],
        "zoom-pane"    => vec!["resize-pane".into(), "-Z".into(), "-t".into(), target],
        _ => return Err(anyhow!("unknown command: {}", command)),
    };

    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let output = Command::new("tmux")
        .args(&args_ref)
        .output()
        .await
        .context("failed to execute tmux")?;

    if !output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        // Graceful: don't error on last pane/window close or missing session
        if msg.contains("no remaining") || msg.contains("session not found")
            || msg.contains("can't find") || msg.contains("no current")
        {
            return Ok(msg);
        }
        return Err(anyhow!("tmux {} failed: {}", command, msg));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Capture the scrollback history of the active pane in a session.
/// Returns the content with ANSI escape sequences preserved.
pub async fn capture_history(session: &str, lines: i32) -> Result<String> {
    let start = format!("-{}", lines);
    let output = Command::new("tmux")
        .args([
            "capture-pane",
            "-p",     // print to stdout
            "-e",     // include escape sequences (colors)
            "-S", &start,  // start N lines back
            "-t", session,
        ])
        .output()
        .await
        .context("failed to execute tmux capture-pane")?;

    if !output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(anyhow!("tmux capture-pane failed: {}", msg));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

