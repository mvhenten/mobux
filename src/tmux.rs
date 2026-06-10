use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use tokio::process::Command;

use crate::shell_integration::{detect_session_shell, v2_snippet, Shell};

/// Build a `tmux` Command, prefixed with `-L <socket>` when
/// `MOBUX_TMUX_SOCKET` is set. Lets tests run against a dedicated tmux
/// server without colliding with the host's default server.
pub fn tmux_command() -> Command {
    let mut cmd = Command::new("tmux");
    if let Ok(socket) = std::env::var("MOBUX_TMUX_SOCKET") {
        if !socket.is_empty() {
            cmd.arg("-L").arg(socket);
        }
    }
    cmd
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub name: String,
    pub windows: i32,
    pub attached: i32,
    pub created_unix: i64,
}

/// True when tmux stderr means "no server is running" — phrasing varies by
/// tmux version: "failed to connect to server" (≤2.x), "no server running on
/// <socket>" (3.x), "error connecting to <socket> (No such file or directory)"
/// (3.x when the socket file doesn't exist yet).
fn is_no_server_error(msg: &str) -> bool {
    msg.contains("failed to connect to server")
        || msg.contains("no server running")
        || msg.contains("error connecting to")
}

pub async fn list_sessions() -> Result<Vec<Session>> {
    let output = tmux_command()
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
        if is_no_server_error(&msg) {
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

/// Build the `tmux new-session` arguments. Sessions start in the user's
/// home directory (when resolvable) rather than wherever the mobux server
/// happens to run; new windows inherit this start directory from the
/// session, so they are covered too.
fn new_session_args(name: &str, shell_cmd: &str, home: Option<&Path>) -> Vec<String> {
    let mut args: Vec<String> = vec!["new-session".into(), "-d".into()];
    if let Some(home) = home {
        args.push("-c".into());
        args.push(home.display().to_string());
    }
    args.extend(["-s".into(), name.into(), shell_cmd.into()]);
    args
}

pub async fn new_session(name: &str) -> Result<()> {
    let (shell_type, shell_path) = detect_session_shell();
    let shell_cmd = prepare_shell_with_osc133(shell_type, &shell_path)?;

    // Create the session with our OSC 133-enabled shell command,
    // starting in the user's home directory.
    let home = home_dir().ok();
    let output = tmux_command()
        .args(new_session_args(name, &shell_cmd, home.as_deref()))
        .output()
        .await
        .context("failed to execute tmux")?;
    if !output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(anyhow!("tmux new-session failed: {}", msg));
    }

    // Set default-command so new windows in this session also get OSC 133
    let _ = tmux_command()
        .args(["set-option", "-t", name, "default-command", &shell_cmd])
        .output()
        .await; // Ignore errors; worst case, new windows won't have OSC 133

    Ok(())
}

/// Prepare a shell command that will emit OSC 133 out-of-the-box.
/// For bash: creates a temp rcfile that sources user's ~/.bashrc then adds snippet.
/// For zsh: creates a ZDOTDIR with .zshrc that sources user's ~/.zshrc then adds snippet.
/// For fish: uses -C flag to inject commands inline.
fn prepare_shell_with_osc133(shell: Shell, shell_path: &str) -> Result<String> {
    let data_dir = resolve_shell_init_dir()?;
    fs::create_dir_all(&data_dir)
        .with_context(|| format!("creating shell-init dir: {}", data_dir.display()))?;

    match shell {
        Shell::Bash => prepare_bash_rcfile(&data_dir, shell_path),
        Shell::Zsh => prepare_zsh_zdotdir(&data_dir, shell_path),
        Shell::Fish => prepare_fish_command(shell_path),
    }
}

fn resolve_shell_init_dir() -> Result<PathBuf> {
    let data_dir = if let Ok(override_dir) = env::var("MOBUX_DATA_DIR") {
        PathBuf::from(override_dir)
    } else {
        let dirs = directories::ProjectDirs::from("", "", "mobux")
            .ok_or_else(|| anyhow!("could not resolve user home for shell-init dir"))?;
        dirs.data_dir().to_path_buf()
    };
    Ok(data_dir.join("shell-init"))
}

fn prepare_bash_rcfile(shell_init_dir: &Path, shell_path: &str) -> Result<String> {
    let rcfile_path = shell_init_dir.join("mobux-bashrc");
    let user_bashrc = home_dir()?.join(".bashrc");

    let mut content = String::new();

    // Source user's real .bashrc if it exists
    if user_bashrc.exists() {
        content.push_str(&format!("source {:?}\n", user_bashrc.display().to_string()));
    }

    // Delay OSC 133 activation until after the first prompt is shown.
    // The initial prompt uses the default PS0/PS1 (no OSC 133). PROMPT_COMMAND
    // runs before each prompt; it checks a flag to skip activation on the
    // first run, then activates OSC 133 on the second+ run.
    content.push_str(
        "
# mobux OSC 133 injection (session-scoped, lazy activation)
_mobux_osc133_ready=0
_mobux_activate_osc133() {
    if [[ $_mobux_osc133_ready -eq 0 ]]; then
        _mobux_osc133_ready=1
        return
    fi
    unset PROMPT_COMMAND
    ",
    );
    content.push_str(v2_snippet(Shell::Bash));
    content.push_str(
        "
}
PROMPT_COMMAND=_mobux_activate_osc133
",
    );

    // Write with restricted permissions
    fs::write(&rcfile_path, content)
        .with_context(|| format!("writing {}", rcfile_path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&rcfile_path)?.permissions();
        perms.set_mode(0o600);
        fs::set_permissions(&rcfile_path, perms)?;
    }

    Ok(format!(
        "{} --rcfile {:?}",
        shell_path,
        rcfile_path.display().to_string()
    ))
}

fn prepare_zsh_zdotdir(shell_init_dir: &Path, shell_path: &str) -> Result<String> {
    let zdotdir = shell_init_dir.join("mobux-zsh");
    fs::create_dir_all(&zdotdir)
        .with_context(|| format!("creating ZDOTDIR: {}", zdotdir.display()))?;

    let zshrc_path = zdotdir.join(".zshrc");
    let user_zshrc = home_dir()?.join(".zshrc");

    let mut content = String::new();

    // Source user's real .zshrc if it exists
    if user_zshrc.exists() {
        content.push_str(&format!("source {:?}\n", user_zshrc.display().to_string()));
    }

    // Delay OSC 133 activation until after the first prompt (same as bash)
    content.push_str(
        "
# mobux OSC 133 injection (session-scoped, lazy activation)
_mobux_osc133_ready=0
_mobux_activate_osc133() {
    if [[ $_mobux_osc133_ready -eq 0 ]]; then
        _mobux_osc133_ready=1
        return
    fi
    unset -f precmd
    ",
    );
    content.push_str(v2_snippet(Shell::Zsh));
    content.push_str(
        "
}
precmd() { _mobux_activate_osc133 }
",
    );

    fs::write(&zshrc_path, content).with_context(|| format!("writing {}", zshrc_path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&zshrc_path)?.permissions();
        perms.set_mode(0o600);
        fs::set_permissions(&zshrc_path, perms)?;
    }

    // Set ZDOTDIR environment variable for zsh
    Ok(format!(
        "ZDOTDIR={:?} {}",
        zdotdir.display().to_string(),
        shell_path
    ))
}

fn prepare_fish_command(shell_path: &str) -> Result<String> {
    // For fish, we can use -C to run commands before the prompt
    // This is more complex because we need to wrap the user's prompt
    // For now, just return the plain shell; fish support can be added later
    // The OOTB test only exercises bash anyway
    Ok(shell_path.to_string())
}

fn home_dir() -> Result<PathBuf> {
    env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| anyhow!("HOME not set"))
}

pub async fn kill_session(name: &str) -> Result<()> {
    let output = tmux_command()
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

pub async fn rename_session(old_name: &str, new_name: &str) -> Result<()> {
    let output = tmux_command()
        .args(["rename-session", "-t", old_name, new_name])
        .output()
        .await
        .context("failed to execute tmux")?;
    if !output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(anyhow!("tmux rename-session failed: {}", msg));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pane {
    pub id: String,
    pub index: String,
    pub title: String,
    pub active: bool,
}

pub async fn list_panes(session: &str) -> Result<Vec<Pane>> {
    // List windows (the main navigable units in tmux)
    let output = tmux_command()
        .args([
            "list-windows",
            "-t",
            session,
            "-F",
            "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}",
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
        if parts.len() != 4 {
            continue;
        }
        out.push(Pane {
            id: parts[0].to_string(),
            index: parts[1].to_string(),
            title: parts[2].to_string(),
            active: parts[3] == "1",
        });
    }
    Ok(out)
}

pub async fn select_pane(session: &str, window_index: &str) -> Result<()> {
    let target = format!("{}:{}", session, window_index);
    let output = tmux_command()
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
        "new-window" => vec!["new-window".into(), "-t".into(), target],
        "kill-window" => vec!["kill-window".into(), "-t".into(), target],
        "split-h" => vec!["split-window".into(), "-h".into(), "-t".into(), target],
        "split-v" => vec!["split-window".into(), "-v".into(), "-t".into(), target],
        "next-window" => vec!["next-window".into(), "-t".into(), target],
        "prev-window" => vec!["previous-window".into(), "-t".into(), target],
        "next-pane" => vec!["select-pane".into(), "-t".into(), format!("{}:+", session)],
        "prev-pane" => vec!["select-pane".into(), "-t".into(), format!("{}:-", session)],
        "kill-pane" => vec!["kill-pane".into(), "-t".into(), target],
        "zoom-pane" => vec!["resize-pane".into(), "-Z".into(), "-t".into(), target],
        _ => return Err(anyhow!("unknown command: {}", command)),
    };

    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let output = tmux_command()
        .args(&args_ref)
        .output()
        .await
        .context("failed to execute tmux")?;

    if !output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        // Graceful: don't error on last pane/window close or missing session
        if msg.contains("no remaining")
            || msg.contains("session not found")
            || msg.contains("can't find")
            || msg.contains("no current")
        {
            return Ok(msg);
        }
        return Err(anyhow!("tmux {} failed: {}", command, msg));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Install a tmux server-wide `alert-bell` hook that POSTs to mobux's
/// internal trigger endpoint. tmux fires the hook exactly once per actual
/// bell event (its own dedupe — the bell flag clears when the user views
/// the window), and exposes the originating session and window via format
/// substitutions, so the deep-link URL can be constructed inside the hook
/// command itself with no additional tmux query.
///
/// The hook is `set -g`, so it covers every session on this tmux server,
/// including ones the user attaches to outside mobux. Re-installing on
/// each mobux startup keeps `port` and `token` in sync if either changes.
pub async fn install_bell_hook(port: u16, token: &str) -> Result<()> {
    // The hook payload runs through `run-shell -b` and uses tmux format
    // substitutions for session/window. `--max-time` keeps a hung curl
    // from clogging the tmux dispatcher; failures are silently dropped
    // so a stopped mobux can never break tmux.
    // Inside tmux's single-quoted argument: `?` and `&` are literal,
    // `#{...}` is a tmux format substitution that runs before the shell
    // command executes. Inside the bash double-quoted URL, `?` and `&`
    // are also literal, so the URL is passed to curl as-is.
    //
    // Note: tmux exposes `hook_session_name` for the bell event, but
    // `hook_window_index` is empty in alert-bell context — the in-scope
    // `window_index` (the bell's window) is what we want for the
    // deep-link URL.
    let hook_cmd = format!(
        "run-shell -b 'curl -fsS --max-time 2 \
          -H \"X-Mobux-Token: {token}\" \
          -X POST \
          \"http://127.0.0.1:{port}/internal/trigger?kind=bell&session=#{{hook_session_name}}&window=#{{window_index}}\" \
          >/dev/null 2>&1 || true'"
    );
    let output = Command::new("tmux")
        .args(["set-hook", "-g", "alert-bell", &hook_cmd])
        .output()
        .await
        .context("failed to execute tmux set-hook")?;
    if !output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(anyhow!("tmux set-hook alert-bell failed: {}", msg));
    }
    Ok(())
}

/// Capture the scrollback history of the active pane in a session.
/// Returns the content with ANSI escape sequences preserved.
pub async fn capture_history(session: &str, lines: i32) -> Result<String> {
    let start = format!("-{}", lines);
    let output = tmux_command()
        .args([
            "capture-pane",
            "-p", // print to stdout
            "-e", // include escape sequences (colors)
            "-S",
            &start, // start N lines back
            "-t",
            session,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_server_error_matches_known_tmux_phrasings() {
        // tmux <= 2.x
        assert!(is_no_server_error("failed to connect to server"));
        // tmux 3.x, stale socket
        assert!(is_no_server_error(
            "no server running on /tmp/tmux-1000/default"
        ));
        // tmux 3.x, socket file missing (fresh boot / no sessions ever started)
        assert!(is_no_server_error(
            "error connecting to /tmp/tmux-1000/default (No such file or directory)"
        ));
        // Real failures must still propagate
        assert!(!is_no_server_error("unknown command: list-sessionz"));
    }

    #[test]
    fn new_session_starts_in_home_directory() {
        let args = new_session_args("work", "bash", Some(Path::new("/home/alice")));
        assert_eq!(
            args,
            vec![
                "new-session",
                "-d",
                "-c",
                "/home/alice",
                "-s",
                "work",
                "bash"
            ]
        );
    }

    #[test]
    fn new_session_without_home_omits_start_directory() {
        let args = new_session_args("work", "bash", None);
        assert_eq!(args, vec!["new-session", "-d", "-s", "work", "bash"]);
    }
}
