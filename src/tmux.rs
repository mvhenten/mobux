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

pub async fn send_line(session: &str, text: &str) -> Result<()> {
    let output = Command::new("tmux")
        .args(["set-buffer", "--", text])
        .output()
        .await
        .context("failed to execute tmux")?;
    if !output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(anyhow!("tmux set-buffer failed: {}", msg));
    }

    let output = Command::new("tmux")
        .args(["paste-buffer", "-t", session])
        .output()
        .await
        .context("failed to execute tmux")?;
    if !output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(anyhow!("tmux paste-buffer failed: {}", msg));
    }

    let output = Command::new("tmux")
        .args(["send-keys", "-t", session, "Enter"])
        .output()
        .await
        .context("failed to execute tmux")?;
    if !output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(anyhow!("tmux send-keys failed: {}", msg));
    }

    Ok(())
}
