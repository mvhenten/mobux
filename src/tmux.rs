use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::shell_integration::{detect_session_shell, rcfile_snippet, Shell};

/// Single-quote a shell word so it survives a remote shell's word-splitting
/// unchanged (embedded `'` becomes `'\''`, the standard POSIX escape).
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// The one-shot, non-interactive `ssh` exec every remote command (tmux or
/// otherwise) runs over: no pty, no prompt — `BatchMode=yes` refuses rather
/// than hangs on a password/host-key prompt, and `ConnectTimeout=3` bounds
/// how long a dead node can stall a request. `remote_cmd` is handed to the
/// remote shell as a single already-quoted string (see `tmux_command` and
/// `write_remote_file` for how their callers build it).
fn ssh_exec_command(ssh_target: &str, remote_cmd: &str) -> Command {
    let mut cmd = Command::new("ssh");
    cmd.args([
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=3",
        ssh_target,
        "--",
        remote_cmd,
    ]);
    cmd
}

/// Build the command every tmux-invoking function runs, with `tmux_args` as
/// the full subcommand (e.g. `["list-sessions", "-F", "..."]`).
///
/// `target = None` runs `tmux` locally (prefixed with `-L <socket>` when
/// `MOBUX_TMUX_SOCKET` is set, so tests can use a dedicated tmux server
/// without colliding with the host's default one).
///
/// `target = Some(ssh_target)` runs the SAME tmux subcommand over a
/// one-shot, non-interactive `ssh` exec — no pty, no prompt: `BatchMode=yes`
/// refuses rather than hangs on a password/host-key prompt, and
/// `ConnectTimeout=3` bounds how long a dead node can stall a request. This
/// is deliberately a different path from the interactive PTY attach (see
/// `nodes::build_attach_command`), which does need a pty for resize
/// passthrough; listing/killing/renaming a session never does.
///
/// `tmux_args` are individually shell-quoted and joined into ONE command
/// string before being handed to `ssh` — ssh joins trailing argv with a bare
/// space when building the remote command line, which would otherwise
/// mis-tokenize any argument containing whitespace. The `-F` format strings
/// below use literal tabs as field separators, so this isn't a hypothetical:
/// without quoting, the remote shell's word-splitting (tabs count as IFS,
/// same as spaces) shreds the format string into several bogus arguments.
pub fn tmux_command(target: Option<&str>, tmux_args: &[&str]) -> Command {
    match target {
        None => {
            let mut cmd = Command::new("tmux");
            if let Ok(socket) = std::env::var("MOBUX_TMUX_SOCKET") {
                if !socket.is_empty() {
                    cmd.arg("-L").arg(socket);
                }
            }
            cmd.args(tmux_args);
            cmd
        }
        Some(ssh_target) => {
            let quoted: Vec<String> = tmux_args.iter().map(|a| shell_quote(a)).collect();
            let remote_cmd = format!("tmux {}", quoted.join(" "));
            ssh_exec_command(ssh_target, &remote_cmd)
        }
    }
}

fn pipe_pane_fifo_path(tmux_bin: &str, session: &str) -> String {
    let socket_tag: String = tmux_bin
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    format!("/tmp/mobux-histpipe-{socket_tag}-{session}.fifo")
}

/// Splits a `tmux_bin` string (`"tmux"` or `"tmux -L <socket>"` — see
/// `handle_ws`) into a program + prefix-args pair a `Command` can run
/// directly, for the local-only calls here that issue their own tmux
/// invocation rather than embedding one in a shell string.
fn tmux_program_and_args(tmux_bin: &str) -> Option<(&str, Vec<&str>)> {
    let mut parts = tmux_bin.split_whitespace();
    let program = parts.next()?;
    Some((program, parts.collect()))
}

fn parse_pane_id(stdout: &[u8]) -> Option<String> {
    let id = String::from_utf8_lossy(stdout).trim().to_string();
    (!id.is_empty()).then_some(id)
}

/// The pane id tmux currently considers active in `session`'s current
/// window. `None` on any failure (no such session, tmux unreachable, bad
/// `tmux_bin`). A bare session name re-resolves to "whichever pane is
/// active right now" on every tmux invocation — fine for a one-shot
/// command, wrong for a tap that must keep targeting the SAME pane across
/// its own start and stop (see [`PanePipeTap`]).
pub async fn active_pane_id(tmux_bin: &str, session: &str) -> Option<String> {
    let (program, args) = tmux_program_and_args(tmux_bin)?;
    let output = Command::new(program)
        .args(&args)
        .args(["display-message", "-p", "-t", session, "#{pane_id}"])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_pane_id(&output.stdout)
}

/// True while `tapped_pane` is still the pane a just-refreshed
/// [`active_pane_id`] query names. A failed query (`current: None`) is
/// inconclusive rather than a mismatch, so a transient tmux error never
/// tears down a healthy tap — only a confirmed different pane does.
fn pane_still_current(tapped_pane: &str, current: Option<&str>) -> bool {
    match current {
        Some(id) => id == tapped_pane,
        None => true,
    }
}

/// How often a running tap re-checks whether its pane is still the active
/// one (see [`drain_pipe_pane`]).
const PANE_CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

/// Reads `child`'s stdout to completion, forwarding each chunk on `tx`,
/// while also polling [`active_pane_id`] every [`PANE_CHECK_INTERVAL`] and
/// stopping (without an error) the moment `session`'s active pane is no
/// longer `tapped_pane`. Every stop path — clean EOF, a read error, or a
/// confirmed pane switch — logs which one fired, then kills and reaps
/// `child`: a broken or superseded tap must never be silent, and must never
/// leave its own reader process behind.
///
/// A dedicated function (rather than inline in [`PanePipeTap::start`]) so
/// it can be driven against a stand-in child in a test, without a real tmux
/// server — `check_interval` is a parameter (production always passes
/// [`PANE_CHECK_INTERVAL`]) for exactly that: a test drives it in
/// milliseconds instead of waiting out the real interval.
async fn drain_pipe_pane(
    mut child: tokio::process::Child,
    tx: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
    tmux_bin: String,
    session: String,
    tapped_pane: String,
    check_interval: std::time::Duration,
) {
    let Some(mut stdout) = child.stdout.take() else {
        eprintln!("history: pipe-pane tap for '{session}' has no stdout handle");
        return;
    };
    let mut stderr = child.stderr.take();
    let mut buf = [0u8; 8192];
    let mut interval = tokio::time::interval(check_interval);
    interval.tick().await; // first tick fires immediately

    loop {
        tokio::select! {
            result = tokio::io::AsyncReadExt::read(&mut stdout, &mut buf) => {
                match result {
                    Ok(0) => {
                        eprintln!("history: pipe-pane tap for '{session}' ended (reader saw EOF)");
                        break;
                    }
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        eprintln!("history: pipe-pane tap for '{session}' read error: {e}");
                        break;
                    }
                }
            }
            _ = interval.tick() => {
                let current = active_pane_id(&tmux_bin, &session).await;
                if !pane_still_current(&tapped_pane, current.as_deref()) {
                    eprintln!(
                        "history: pipe-pane tap for '{session}' stopped — active pane changed from {tapped_pane} to {current:?}"
                    );
                    break;
                }
            }
        }
    }

    // Kill (a pane-switch or a read error may leave `child` still very much
    // alive — e.g. still blocked reading the fifo) and reap BEFORE draining
    // stderr: reading a live child's stderr to EOF blocks until it exits,
    // and on this path we're the one ending it, so reading first would hang
    // this task forever instead of tearing it down.
    let _ = child.kill().await;
    let _ = child.wait().await;
    if let Some(stderr) = stderr.as_mut() {
        let mut err_buf = Vec::new();
        let _ = tokio::io::AsyncReadExt::read_to_end(stderr, &mut err_buf).await;
        if !err_buf.is_empty() {
            eprintln!(
                "history: pipe-pane tap for '{session}' stderr: {}",
                String::from_utf8_lossy(&err_buf).trim()
            );
        }
    }
}

/// A running `tmux pipe-pane` tap on one concrete pane of a local session,
/// feeding the conversation-history segmenter (`session_history.rs`) bytes
/// in the exact order the shell inside the pane produced them — unlike the
/// live WS attach relay (`handle_ws`'s other PTY, running `tmux attach`),
/// which only ever delivers tmux's own on-demand screen redraws and can
/// land an OSC 133 marker out of order relative to nearby screen content
/// (see the PR description for a captured trace).
///
/// Pinned to the pane id [`active_pane_id`] resolves at [`PanePipeTap::start`],
/// not the bare session name, so start and stop always agree on which pane.
/// Splitting or switching panes ends this tap (`drain_pipe_pane` notices
/// and the channel closes) rather than following the new one — multiplexing
/// two panes' bytes into one segmenter would corrupt its single-command-at-
/// a-time model worse than not recording the second pane at all. The
/// caller falls back to the attach-relay feed, same as for a tap that
/// failed outright (`start` returning `None`).
///
/// `Drop` (not straight-line cleanup at the end of `handle_ws`) stops the
/// tmux-side target and removes the fifo, so an early return or panic
/// anywhere after `start` still tears it down.
pub struct PanePipeTap {
    tmux_bin: String,
    pane_id: String,
    fifo_path: String,
}

impl PanePipeTap {
    pub async fn start(
        tmux_bin: &str,
        session: &str,
    ) -> Option<(Self, tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>)> {
        let pane_id = match active_pane_id(tmux_bin, session).await {
            Some(id) => id,
            None => {
                eprintln!(
                    "history: pipe-pane tap for '{session}' not started — could not resolve an active pane"
                );
                return None;
            }
        };
        let fifo_path = pipe_pane_fifo_path(tmux_bin, session);
        let _ = tokio::fs::remove_file(&fifo_path).await;
        match tokio::process::Command::new("mkfifo")
            .arg(&fifo_path)
            .status()
            .await
        {
            Ok(status) if status.success() => {}
            other => {
                eprintln!(
                    "history: pipe-pane tap for '{session}' not started — mkfifo {fifo_path} failed: {other:?}"
                );
                return None;
            }
        }

        let script = format!(
            "{tmux_bin} pipe-pane -t {pane} {cmd} && exec cat {fifo}",
            pane = shell_quote(&pane_id),
            cmd = shell_quote(&format!("cat >> {fifo_path}")),
            fifo = shell_quote(&fifo_path),
        );
        let child = match tokio::process::Command::new("sh")
            .arg("-c")
            .arg(&script)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(child) => child,
            Err(e) => {
                eprintln!("history: pipe-pane tap for '{session}' failed to spawn: {e}");
                let _ = tokio::fs::remove_file(&fifo_path).await;
                return None;
            }
        };

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        tokio::spawn(drain_pipe_pane(
            child,
            tx,
            tmux_bin.to_string(),
            session.to_string(),
            pane_id.clone(),
            PANE_CHECK_INTERVAL,
        ));

        Some((
            Self {
                tmux_bin: tmux_bin.to_string(),
                pane_id,
                fifo_path,
            },
            rx,
        ))
    }
}

impl Drop for PanePipeTap {
    fn drop(&mut self) {
        // Best-effort: the pane (or its whole session) may already be gone
        // by the time a connection tears down, so a "can't find pane"
        // stderr here is the expected case, not a failure worth logging —
        // discard it rather than let it read as a real error.
        if let Some((program, args)) = tmux_program_and_args(&self.tmux_bin) {
            let _ = std::process::Command::new(program)
                .args(&args)
                .args(["pipe-pane", "-t", &self.pane_id])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
        let _ = std::fs::remove_file(&self.fifo_path);
    }
}

/// Build the `mkdir -p <dir> && cat > <dest>` ssh command that
/// `write_remote_file` runs, plus the full remote destination path. Split
/// out from `write_remote_file` so the command construction — the part that
/// actually matters for injection-safety — is unit-testable without
/// spawning a real `ssh`, mirroring `tmux_command`. `dest_dir` and `dest`
/// are individually shell-quoted (`filename` is additionally pre-sanitized
/// by the caller to `[A-Za-z0-9._-]`, but this stays injection-safe even if
/// that ever changes).
fn build_write_remote_command(
    ssh_target: &str,
    dest_dir: &str,
    filename: &str,
) -> (Command, String) {
    let dest = format!("{}/{}", dest_dir.trim_end_matches('/'), filename);
    let remote_cmd = format!(
        "mkdir -p {} && cat > {}",
        shell_quote(dest_dir),
        shell_quote(&dest)
    );
    (ssh_exec_command(ssh_target, &remote_cmd), dest)
}

/// Write `data` to `<dest_dir>/<filename>` on `ssh_target`, over the same
/// `BatchMode` ssh exec every other remote op uses — but piped over stdin
/// (`cat >`) instead of `.output()`, since the payload is arbitrary upload
/// bytes rather than a command's own argv. `mkdir -p` first so the remote
/// upload directory doesn't need to pre-exist, mirroring the local
/// `fs::create_dir_all` the caller runs for the non-remote case. Returns the
/// full remote path so the caller can hand it back to a client that will
/// paste it into a shell running ON `ssh_target` — a hub-local path there
/// resolves to nothing.
pub async fn write_remote_file(
    ssh_target: &str,
    dest_dir: &str,
    filename: &str,
    data: &[u8],
) -> Result<String> {
    let (mut cmd, dest) = build_write_remote_command(ssh_target, dest_dir, filename);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .with_context(|| format!("failed to spawn ssh to {ssh_target} for upload"))?;
    let mut stdin = child
        .stdin
        .take()
        .context("ssh stdin unavailable for upload")?;
    stdin
        .write_all(data)
        .await
        .with_context(|| format!("failed to stream upload bytes to {ssh_target}"))?;
    drop(stdin);

    let output = child
        .wait_with_output()
        .await
        .with_context(|| format!("ssh upload to {ssh_target} failed"))?;
    if !output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(anyhow!("remote upload to {ssh_target} failed: {msg}"));
    }
    Ok(dest)
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

// Field separators in `-F` formats must be PRINTABLE: tmux ≥ 3.4 replaces
// control characters (tabs included) with `_` when printing to a non-tty,
// which is every invocation here — and always the remote (`ssh`) one. A
// tab-separated format therefore parses fine against an older local tmux
// and comes back as one underscore-joined field from a newer node, silently
// emptying the remote session list (#185). `:` is safe as separator: tmux
// itself refuses it in session names, and the other fields are numeric; any
// free-text field (window names) goes last, re-joined via `splitn`.
pub async fn list_sessions(target: Option<&str>) -> Result<Vec<Session>> {
    let output = tmux_command(
        target,
        &[
            "list-sessions",
            "-F",
            "#{session_windows}:#{session_attached}:#{session_created}:#{session_name}",
        ],
    )
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
        let parts: Vec<&str> = line.splitn(4, ':').collect();
        if parts.len() != 4 {
            continue;
        }
        out.push(Session {
            name: parts[3].to_string(),
            windows: parts[0].parse().unwrap_or(0),
            attached: parts[1].parse().unwrap_or(0),
            created_unix: parts[2].parse().unwrap_or(0),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Build the `tmux new-session` arguments. Sessions start in the user's
/// home directory (when resolvable) rather than wherever the mobux server
/// happens to run; new windows inherit this start directory from the
/// session, so they are covered too. `shell_cmd` is omitted entirely
/// (tmux starts the default shell) when `None`.
fn new_session_args(name: &str, shell_cmd: Option<&str>, home: Option<&Path>) -> Vec<String> {
    let mut args: Vec<String> = vec!["new-session".into(), "-d".into()];
    if let Some(home) = home {
        args.push("-c".into());
        args.push(home.display().to_string());
    }
    args.push("-s".into());
    args.push(name.into());
    if let Some(cmd) = shell_cmd {
        args.push(cmd.into());
    }
    args
}

pub async fn new_session(name: &str, target: Option<&str>) -> Result<()> {
    // Remote node: the OSC-133 rcfile lives on the hub's local disk, so it
    // can't be injected into a session on another machine, and the hub's
    // $HOME has no meaning there either — start the node's default shell
    // in its own default directory instead.
    let Some(ssh_target) = target else {
        let (shell_type, shell_path) = detect_session_shell();
        let shell_cmd = prepare_shell_with_osc133(shell_type, &shell_path)?;
        let home = home_dir().ok();
        let args = new_session_args(name, Some(&shell_cmd), home.as_deref());
        let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = tmux_command(None, &args_ref)
            .output()
            .await
            .context("failed to execute tmux")?;
        if !output.status.success() {
            let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(anyhow!("tmux new-session failed: {}", msg));
        }

        // Set default-command so new windows in this session also get OSC 133
        let _ = tmux_command(
            None,
            &["set-option", "-t", name, "default-command", &shell_cmd],
        )
        .output()
        .await; // Ignore errors; worst case, new windows won't have OSC 133

        return Ok(());
    };

    let args = new_session_args(name, None, None);
    let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = tmux_command(Some(ssh_target), &args_ref)
        .output()
        .await
        .context("failed to execute tmux")?;
    if !output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(anyhow!("tmux new-session failed: {}", msg));
    }
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
    content.push_str(rcfile_snippet(Shell::Bash));
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
    content.push_str(rcfile_snippet(Shell::Zsh));
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

pub async fn kill_session(name: &str, target: Option<&str>) -> Result<()> {
    let output = tmux_command(target, &["kill-session", "-t", name])
        .output()
        .await
        .context("failed to execute tmux")?;
    if !output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(anyhow!("tmux kill-session failed: {}", msg));
    }
    Ok(())
}

pub async fn rename_session(old_name: &str, new_name: &str, target: Option<&str>) -> Result<()> {
    let output = tmux_command(target, &["rename-session", "-t", old_name, new_name])
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

pub async fn list_panes(session: &str, target: Option<&str>) -> Result<Vec<Pane>> {
    // List windows (the main navigable units in tmux)
    let output = tmux_command(
        target,
        &[
            "list-windows",
            "-t",
            session,
            "-F",
            // Printable separator, free-text window name LAST — see the
            // separator note above list_sessions. `splitn` keeps any `:`
            // inside the window name intact.
            "#{window_id}:#{window_index}:#{window_active}:#{window_name}",
        ],
    )
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
        let parts: Vec<&str> = line.splitn(4, ':').collect();
        if parts.len() != 4 {
            continue;
        }
        out.push(Pane {
            id: parts[0].to_string(),
            index: parts[1].to_string(),
            title: parts[3].to_string(),
            active: parts[2] == "1",
        });
    }
    Ok(out)
}

pub async fn select_pane(session: &str, window_index: &str, target: Option<&str>) -> Result<()> {
    let window_target = format!("{}:{}", session, window_index);
    let output = tmux_command(target, &["select-window", "-t", &window_target])
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
pub async fn run_command(session: &str, command: &str, target: Option<&str>) -> Result<String> {
    // Append ':' so tmux treats it as a session target, not a window index
    // (e.g. session "0" would otherwise target window 0)
    let win_target = format!("{}:", session);
    let args: Vec<String> = match command {
        "new-window" => vec!["new-window".into(), "-t".into(), win_target],
        "kill-window" => vec!["kill-window".into(), "-t".into(), win_target],
        "split-h" => vec!["split-window".into(), "-h".into(), "-t".into(), win_target],
        "split-v" => vec!["split-window".into(), "-v".into(), "-t".into(), win_target],
        "next-window" => vec!["next-window".into(), "-t".into(), win_target],
        "prev-window" => vec!["previous-window".into(), "-t".into(), win_target],
        "next-pane" => vec!["select-pane".into(), "-t".into(), format!("{}:+", session)],
        "prev-pane" => vec!["select-pane".into(), "-t".into(), format!("{}:-", session)],
        "kill-pane" => vec!["kill-pane".into(), "-t".into(), win_target],
        "zoom-pane" => vec!["resize-pane".into(), "-Z".into(), "-t".into(), win_target],
        _ => return Err(anyhow!("unknown command: {}", command)),
    };

    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let output = tmux_command(target, &args_ref)
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
pub async fn capture_history(session: &str, lines: i32, target: Option<&str>) -> Result<String> {
    let start = format!("-{}", lines);
    let output = tmux_command(
        target,
        &[
            "capture-pane",
            "-p", // print to stdout
            "-e", // include escape sequences (colors)
            "-S",
            &start, // start N lines back
            "-t",
            session,
        ],
    )
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
        let args = new_session_args("work", Some("bash"), Some(Path::new("/home/alice")));
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
        let args = new_session_args("work", Some("bash"), None);
        assert_eq!(args, vec!["new-session", "-d", "-s", "work", "bash"]);
    }

    #[test]
    fn new_session_remote_omits_shell_cmd_and_home() {
        // Remote node sessions get no OSC-133 shell_cmd (it references a
        // local rcfile path) and no home-dir override (the hub's $HOME has
        // no meaning on another machine) — tmux just starts its default.
        let args = new_session_args("work", None, None);
        assert_eq!(args, vec!["new-session", "-d", "-s", "work"]);
    }

    fn argv(cmd: &Command) -> Vec<String> {
        cmd.as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn tmux_command_local_is_plain_tmux() {
        std::env::remove_var("MOBUX_TMUX_SOCKET");
        let cmd = tmux_command(None, &["list-sessions"]);
        assert_eq!(
            cmd.as_std().get_program().to_string_lossy(),
            "tmux",
            "no target => plain local tmux"
        );
        assert_eq!(argv(&cmd), vec!["list-sessions"]);
    }

    #[test]
    fn tmux_command_remote_wraps_in_batch_mode_ssh() {
        let cmd = tmux_command(Some("mvhenten@devbox"), &["kill-session", "-t", "work"]);
        assert_eq!(cmd.as_std().get_program().to_string_lossy(), "ssh");
        assert_eq!(
            argv(&cmd),
            vec![
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=3",
                "mvhenten@devbox",
                "--",
                "tmux 'kill-session' '-t' 'work'",
            ]
        );
    }

    #[test]
    fn tmux_command_remote_quotes_tab_containing_format_strings() {
        // Regression test: ssh joins trailing argv with a bare space when
        // building the remote command line. Without per-arg quoting, the
        // literal tabs in tmux's -F format strings get word-split by the
        // remote shell (tab is IFS, same as space), shredding "-F" from its
        // value and producing "command list-sessions: -F expects an
        // argument" on the actual remote tmux. Reproduced live against a
        // loopback sshd before this fix landed.
        let cmd = tmux_command(
            Some("devbox"),
            &["list-sessions", "-F", "#{session_name}\t#{session_windows}"],
        );
        let remote_cmd = argv(&cmd).pop().expect("remote command string");
        assert_eq!(
            remote_cmd,
            "tmux 'list-sessions' '-F' '#{session_name}\t#{session_windows}'",
        );
        // The whole format string survives as ONE single-quoted word — a
        // naive space-join would have split it at the tab.
        assert_eq!(remote_cmd.matches('\'').count(), 6, "3 quoted words");
    }

    #[test]
    fn shell_quote_escapes_embedded_single_quotes() {
        assert_eq!(shell_quote("plain"), "'plain'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
    }

    #[test]
    fn pipe_pane_fifo_path_scoped_by_socket_and_session() {
        let default_a = pipe_pane_fifo_path("tmux", "work");
        let default_b = pipe_pane_fifo_path("tmux", "other");
        let socketed = pipe_pane_fifo_path("tmux -L histflake-test", "work");
        assert_ne!(
            default_a, default_b,
            "different sessions must not share a fifo"
        );
        assert_ne!(
            default_a, socketed,
            "different tmux sockets must not share a fifo, same session name"
        );
        assert_eq!(
            pipe_pane_fifo_path("tmux -L histflake-test", "work"),
            socketed,
            "same socket + session is deterministic"
        );
    }

    #[test]
    fn write_remote_command_targets_the_node_not_the_hub() {
        // Regression: an upload while attached to a remote node used to
        // write under the HUB's local /tmp/mobux-uploads and hand back that
        // hub-local path, which doesn't exist on the remote shell the user
        // is actually looking at. The command built here must run entirely
        // on `ssh_target` (mkdir + write both inside the remote command
        // string handed to ssh) and the returned path must be the one that
        // resolves there.
        let (cmd, dest) = build_write_remote_command(
            "mvhenten@devbox",
            "/tmp/mobux-uploads",
            "1700000000000-photo.jpg",
        );
        assert_eq!(dest, "/tmp/mobux-uploads/1700000000000-photo.jpg");
        assert_eq!(cmd.as_std().get_program().to_string_lossy(), "ssh");
        assert_eq!(
            argv(&cmd),
            vec![
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=3",
                "mvhenten@devbox",
                "--",
                "mkdir -p '/tmp/mobux-uploads' && cat > '/tmp/mobux-uploads/1700000000000-photo.jpg'",
            ]
        );
    }

    #[test]
    fn tmux_program_and_args_splits_the_socket_flag() {
        assert_eq!(
            tmux_program_and_args("tmux -L histflake-test"),
            Some(("tmux", vec!["-L", "histflake-test"]))
        );
        assert_eq!(tmux_program_and_args("tmux"), Some(("tmux", vec![])));
        assert_eq!(tmux_program_and_args(""), None);
    }

    #[test]
    fn parse_pane_id_trims_and_rejects_empty() {
        assert_eq!(parse_pane_id(b"%3\n"), Some("%3".to_string()));
        assert_eq!(parse_pane_id(b"   \n"), None);
        assert_eq!(parse_pane_id(b""), None);
    }

    #[test]
    fn pane_still_current_matches_only_the_tapped_pane() {
        assert!(
            pane_still_current("%0", Some("%0")),
            "same pane => still current"
        );
        assert!(
            !pane_still_current("%0", Some("%1")),
            "a confirmed different pane => not current"
        );
        assert!(
            pane_still_current("%0", None),
            "a failed query is inconclusive, not a mismatch"
        );
    }

    // Regression coverage for review issue #249: `pipe-pane -t <session>`
    // resolves to whatever pane is active at invocation time, which drifted
    // between a tap's own start and stop once the user split or switched
    // panes. `PanePipeTap` pins to one `pane_id` instead — these three
    // tests exercise that without a real tmux server: a bogus `tmux_bin`
    // stands in for "tmux unreachable" (tap fails to start), and a tiny
    // stub script standing in for `tmux_bin` proves the mid-session
    // pane-switch detection in `drain_pipe_pane` actually stops the tap
    // rather than silently continuing to record the wrong pane.

    #[tokio::test]
    async fn pipe_pane_tap_does_not_start_when_tmux_is_unreachable() {
        let started = PanePipeTap::start("definitely-not-a-real-tmux-xyz", "irrelevant").await;
        assert!(
            started.is_none(),
            "a tmux_bin that can't even resolve the active pane must not start a tap"
        );
    }

    #[tokio::test]
    async fn drain_pipe_pane_forwards_bytes_then_closes_on_child_exit() {
        let child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg("printf hello")
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("spawn stand-in child");
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            drain_pipe_pane(
                child,
                tx,
                "definitely-not-a-real-tmux-xyz".to_string(),
                "irrelevant".to_string(),
                "%0".to_string(),
                std::time::Duration::from_secs(60),
            ),
        )
        .await
        .expect("drain must return once the child's stdout hits EOF, not hang");

        let mut received = Vec::new();
        while let Ok(chunk) = rx.try_recv() {
            received.extend(chunk);
        }
        assert_eq!(received, b"hello");
        assert!(
            rx.recv().await.is_none(),
            "the channel closes once the child exits — a dead feed must be visible \
             to the caller, not silently starved"
        );
    }

    #[tokio::test]
    async fn drain_pipe_pane_stops_when_the_active_pane_changes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let stub = dir.path().join("fake-tmux");
        std::fs::write(&stub, "#!/bin/sh\necho %99\n").expect("write stub");
        let mut perms = std::fs::metadata(&stub).unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o755);
        std::fs::set_permissions(&stub, perms).expect("chmod stub");

        // A long-running, silent child with its stderr piped too: nothing
        // about its own stdout/stderr ends this drain — only the pane-
        // mismatch check can. A still-alive child with a piped stderr is
        // also the regression case for killing before (not after) draining
        // stderr — reading a live child's stderr to EOF blocks until it
        // exits, and this drain is the one that has to end it.
        let child = tokio::process::Command::new("sleep")
            .arg("30")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn stand-in child");
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            drain_pipe_pane(
                child,
                tx,
                stub.to_string_lossy().into_owned(),
                "irrelevant".to_string(),
                "%0".to_string(),
                std::time::Duration::from_millis(20),
            ),
        )
        .await
        .expect("drain must return once the pane mismatch is detected, not hang forever");

        assert!(rx.recv().await.is_none());
    }

    #[test]
    fn write_remote_command_quotes_a_directory_with_a_trailing_slash() {
        let (_, dest) = build_write_remote_command("devbox", "/tmp/mobux-uploads/", "f.txt");
        // No double slash from a caller-supplied trailing one.
        assert_eq!(dest, "/tmp/mobux-uploads/f.txt");
    }

    #[test]
    fn write_remote_command_survives_a_single_quote_in_the_filename() {
        // Sanitize_upload_filename (main.rs) never lets a quote through in
        // practice, but the command builder must stay injection-safe on its
        // own — a quote here must not let the filename break out of the
        // single-quoted word and inject a second shell command.
        let (cmd, dest) = build_write_remote_command("devbox", "/tmp/mobux-uploads", "it's.txt");
        assert_eq!(dest, "/tmp/mobux-uploads/it's.txt");
        let remote_cmd = argv(&cmd).pop().expect("remote command string");
        assert_eq!(
            remote_cmd,
            r"mkdir -p '/tmp/mobux-uploads' && cat > '/tmp/mobux-uploads/it'\''s.txt'",
        );
    }

    // Injection proof: actually hand the built remote command string to a
    // REAL `sh -c`, exactly as the remote sshd would — ssh does no
    // interpretation of its own; it just execs the user's shell with this
    // string as `-c '<remote_cmd>'`. So running it through a local `sh -c`
    // here reproduces precisely what happens on the node, without needing a
    // live ssh connection.
    //
    // Single-quoting is what does the work: POSIX says nothing inside a
    // single-quoted string is special except a literal `'` — not `$(`, not
    // backticks, not `;`, not a newline. `shell_quote` escapes the one
    // character that matters and leaves everything else untouched, so a
    // filename carrying a command substitution, a backtick command, or an
    // embedded newline all land as inert literal bytes in the path — never
    // executed. sanitize_upload_filename (main.rs) already strips all of
    // these before a real upload ever reaches this code; this test proves
    // the command builder doesn't ALSO need that to stay safe.
    #[tokio::test]
    async fn write_remote_command_is_injection_safe_against_a_real_shell() {
        let dir = tempfile::tempdir().expect("tempdir");
        let dest_dir = dir.path().to_str().expect("utf8 tempdir");
        let canary = dir.path().join("PWNED");

        let adversarial_filename = "$(touch PWNED)`touch PWNED`;touch PWNED\ntouch-PWNED.txt";
        let (cmd, dest) = build_write_remote_command("devbox", dest_dir, adversarial_filename);
        let remote_cmd = argv(&cmd).pop().expect("remote command string");

        let mut sh = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(&remote_cmd)
            .current_dir(dir.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn sh");
        sh.stdin
            .take()
            .expect("stdin")
            .write_all(b"payload")
            .await
            .expect("write payload");
        let output = sh.wait_with_output().await.expect("sh -c exited");
        assert!(
            output.status.success(),
            "sh -c failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        // No command embedded in the filename ran — the canary file was
        // never created.
        assert!(
            !canary.exists(),
            "injected command executed: PWNED canary file exists"
        );

        // The file landed under the LITERAL adversarial name, newline and
        // all — never interpreted.
        assert_eq!(dest, format!("{dest_dir}/{adversarial_filename}"));
        let written = fs::read_to_string(&dest)
            .expect("uploaded file exists under its literal, unexecuted name");
        assert_eq!(written, "payload");
    }
}
