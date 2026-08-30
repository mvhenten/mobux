use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

/// Return the current OSC 133 snippet for the given shell, suitable for
/// injection into a mobux-managed rcfile (no FENCE markers). The single
/// source both the settings-page installer (`install`, below) and
/// `tmux.rs`'s session auto-injection path build on — there is exactly one
/// copy of each shell's snippet text in the Rust source.
pub fn rcfile_snippet(shell: Shell) -> &'static str {
    shell.snippet()
}

/// Detect which shell to use for new sessions. The configured `session.shell`
/// wins; an empty one falls through to `$SHELL`, and then to `/bin/bash`.
pub fn detect_session_shell(configured: &str) -> (Shell, String) {
    if !configured.is_empty() {
        return parse_shell_path(configured);
    }

    // Honor $SHELL
    if let Ok(shell_path) = env::var("SHELL") {
        if !shell_path.is_empty() {
            return parse_shell_path(&shell_path);
        }
    }

    // Fallback to bash
    (Shell::Bash, "/bin/bash".to_string())
}

fn parse_shell_path(path: &str) -> (Shell, String) {
    let shell_type = if path.contains("zsh") {
        Shell::Zsh
    } else if path.contains("fish") {
        Shell::Fish
    } else {
        Shell::Bash
    };
    (shell_type, path.to_string())
}

pub const FENCE_OPEN: &str = "# >>> mobux OSC 133 (managed) >>>";
pub const FENCE_CLOSE: &str = "# <<< mobux OSC 133 (managed) <<<";
// v2: wrap OSC 133 emissions in tmux's DCS passthrough envelope when
// `$TMUX` is set, otherwise emit them bare. tmux 3.4 (and earlier)
// drops unknown OSC sequences before forwarding them to the outer
// terminal, so the v1 bare-emission snippets never reached mobux's
// libterm parser when running under tmux. v2 is forward-compatible
// with tmux 3.5+ (which forwards OSC 133 natively) — the wrapped form
// also works there because tmux unwraps the DCS envelope and emits
// the inner sequence verbatim. Mobux additionally sets
// `allow-passthrough on` on the server when attaching (see
// handle_ws in main.rs); without that, tmux would silently discard
// the wrapped sequence.
//
// v3: every embedded ESC inside a DCS passthrough envelope must be
// doubled, not just the first one. The v2 bash/zsh envelopes combined
// the D (command-finished) and A (prompt-start) markers into one
// envelope but only doubled the ESC in front of `D`, leaving a single
// un-doubled ESC in front of `]133;A`. tmux's passthrough unescaper
// reads that lone ESC as a (malformed) unescape marker, drops it, and
// forwards the literal bytes `]133;A` as plain text instead of an OSC
// sequence — the A marker never reaches the client as a recognized
// event. Confirmed against real tmux 3.4 with a raw WS byte capture:
// the client received `...]133;D;0<BEL>]133;A<BEL>...` — no ESC
// before the second `]133;A`.
//
// v4: zsh's D+A marker must ride the same write as the prompt text, not
// a lone `precmd`-emitted envelope. tmux forwards each passthrough
// envelope bracketed by its own cursor-position sync; a lone envelope
// (nothing riding after it in the same shell write) can land on the
// wrong row. v3's zsh snippet emitted D+A from `precmd()` as its own
// `print -Pn` call, separate from the actual prompt text zle draws
// afterward — exactly the "lone envelope" condition. Bash never had
// this problem because its A marker is embedded inside `PS1` itself, so
// it always rides the same write as the visible prompt text (v3 fixed
// the ESC-doubling for that shared envelope but the envelope's
// soundness was already correct for bash). v4 embeds zsh's D+A the same
// way, inside `PROMPT` via a `%{...%}` zero-width escape, using `%?`
// (zsh's native exit-status token) instead of `$?` so no `PROMPT_SUBST`
// is needed and the value is still read fresh on every draw.
//
// This is a substantial improvement, not a complete one: a confirmed-by-
// trace residual race remains, at a much lower rate. tmux can still
// forward that passthrough ahead of regular screen content that, in the
// underlying pty stream, was written first but hadn't been diffed/
// flushed to the client yet — occasionally the D+A marker lands on a
// leftover output row instead of the fresh prompt row, within the very
// same forwarded chunk. A client-side fix (deferring marker row
// attribution past the write that carried it) was prototyped and
// reverted: it collapsed multiple prompt cycles delivered in one
// forwarded burst onto a single row for bash, which never raced before.
// Given a client-side fix could not be made safe for bash within
// reasonable effort, this residual zsh race is accepted and covered by a
// retrying real-tmux test (test/spa.spec.cjs) rather than chased further
// here — see that test's comment for the measured rate and the tradeoff.
pub const CURRENT_VERSION: u32 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Shell {
    Bash,
    Zsh,
    Fish,
}

impl Shell {
    pub fn rc_relative(self) -> &'static str {
        match self {
            Shell::Bash => ".bashrc",
            Shell::Zsh => ".zshrc",
            Shell::Fish => ".config/fish/config.fish",
        }
    }

    pub fn snippet(self) -> &'static str {
        match self {
            Shell::Bash => BASH_SNIPPET,
            Shell::Zsh => ZSH_SNIPPET,
            Shell::Fish => FISH_SNIPPET,
        }
    }
}

// Bash snippet. When running inside tmux (`$TMUX` is set), OSC 133
// sequences are wrapped in tmux's DCS passthrough envelope
// (`\ePtmux;\e<original>\e\\`, with EVERY embedded `\e` doubled — the D
// and A markers below share one envelope, so both of their `\e`s must
// be doubled, not just the first), so tmux forwards the inner
// sequence to the outer terminal instead of dropping it. Outside
// tmux, the bare form is emitted.
pub const BASH_SNIPPET: &str = "if [ -n \"$TMUX\" ]; then
    PS0='\\ePtmux;\\e\\e]133;C\\a\\e\\\\'
    PS1='\\[\\ePtmux;\\e\\e]133;D;$?\\a\\e\\e]133;A\\a\\e\\\\\\]'\"$PS1\"'\\[\\ePtmux;\\e\\e]133;B\\a\\e\\\\\\]'
else
    PS0='\\e]133;C\\a'
    PS1='\\[\\e]133;D;$?\\a\\e]133;A\\a\\]'\"$PS1\"'\\[\\e]133;B\\a\\]'
fi";

// Zsh snippet. The tmux branch embeds D+A directly inside `PROMPT` via a
// `%{...%}` zero-width escape (zsh's equivalent of bash's `\[...\]`) so the
// marker rides the same write zle uses to draw the prompt text — the same
// reason bash embeds its marker in PS1 rather than a separate hook. `%?` is
// zsh's own exit-status prompt token (no `PROMPT_SUBST` needed, unlike a
// bare `$?`), re-read fresh every time the prompt is drawn. The DCS
// terminator's embedded literal backslash (as opposed to the `\e`/`\a`
// control-character escapes, which are converted to raw bytes once at
// `$'...'` assignment time and untouched afterward) survives zsh's OWN
// prompt-expansion pass unchanged when written once, same as `print`'s
// escape handling in `preexec` below — doubling it (as if to survive a
// second collapse) was tried and produces a stray literal backslash in the
// rendered prompt; verified on the wire both ways. `preexec`'s C marker
// keeps using a plain `print -Pn` call, unaffected: it already fires from
// its own single-purpose hook with nothing else riding the same write, and
// unlike D+A was never observed landing on the wrong row.
pub const ZSH_SNIPPET: &str = "if [ -n \"$TMUX\" ]; then
    preexec() { print -Pn '\\ePtmux;\\e\\e]133;C\\a\\e\\\\' }
    PROMPT=$'%{\\ePtmux;\\e\\e]133;D;%?\\a\\e\\e]133;A\\a\\e\\\\%}'\"$PROMPT\"
else
    preexec() { print -Pn '\\e]133;C\\a' }
    precmd()  { print -Pn '\\e]133;D;'$?'\\a\\e]133;A\\a' }
fi";

pub const FISH_SNIPPET: &str = "if test -n \"$TMUX\"
    function __mobux_osc133_preexec --on-event fish_preexec
        printf '\\ePtmux;\\e\\e]133;C\\a\\e\\\\'
    end
    function __mobux_osc133_postexec --on-event fish_postexec
        printf '\\ePtmux;\\e\\e]133;D;%s\\a\\e\\\\' $status
    end
    function __mobux_osc133_prompt --on-event fish_prompt
        printf '\\ePtmux;\\e\\e]133;A\\a\\e\\\\'
    end
else
    function __mobux_osc133_preexec --on-event fish_preexec
        printf '\\e]133;C\\a'
    end
    function __mobux_osc133_postexec --on-event fish_postexec
        printf '\\e]133;D;%s\\a' $status
    end
    function __mobux_osc133_prompt --on-event fish_prompt
        printf '\\e]133;A\\a'
    end
end";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ShellState {
    NotPresent,
    NotInstalled,
    Installed { version: u32 },
    Outdated { version: u32 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Status {
    pub bash: ShellState,
    pub zsh: ShellState,
    pub fish: ShellState,
}

fn home_dir() -> Result<PathBuf> {
    let h = env::var("HOME").map_err(|_| anyhow!("HOME not set"))?;
    if h.is_empty() {
        return Err(anyhow!("HOME is empty"));
    }
    Ok(PathBuf::from(h))
}

fn rc_path(home: &Path, shell: Shell) -> PathBuf {
    home.join(shell.rc_relative())
}

pub fn status() -> Result<Status> {
    let home = home_dir()?;
    Ok(Status {
        bash: shell_state(&home, Shell::Bash),
        zsh: shell_state(&home, Shell::Zsh),
        fish: shell_state(&home, Shell::Fish),
    })
}

fn shell_state(home: &Path, shell: Shell) -> ShellState {
    let path = rc_path(home, shell);
    if !path.exists() {
        return ShellState::NotPresent;
    }
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return ShellState::NotPresent,
    };
    match find_block(&content) {
        None => ShellState::NotInstalled,
        Some(b) => {
            if b.version == CURRENT_VERSION {
                ShellState::Installed { version: b.version }
            } else {
                ShellState::Outdated { version: b.version }
            }
        }
    }
}

struct Block {
    start: usize,
    end: usize,
    version: u32,
    leading_blank: bool,
}

fn find_block(content: &str) -> Option<Block> {
    let start = content.find(FENCE_OPEN)?;
    let after_open = start + FENCE_OPEN.len();
    let close_rel = content[after_open..].find(FENCE_CLOSE)?;
    let close_abs = after_open + close_rel;
    let end = close_abs + FENCE_CLOSE.len();
    let mut end_with_nl = end;
    if content.as_bytes().get(end_with_nl).copied() == Some(b'\n') {
        end_with_nl += 1;
    }

    let mut version = 0u32;
    for line in content[after_open..close_abs].lines() {
        let l = line.trim();
        if let Some(v) = l.strip_prefix("# version:") {
            if let Ok(n) = v.trim().parse::<u32>() {
                version = n;
                break;
            }
        }
    }

    let leading_blank = start >= 2 && &content[start - 2..start] == "\n\n";
    let real_start = if leading_blank { start - 1 } else { start };

    Some(Block {
        start: real_start,
        end: end_with_nl,
        version,
        leading_blank,
    })
}

fn render_block(snippet: &str) -> String {
    format!(
        "{}\n# version: {}\n{}\n{}\n",
        FENCE_OPEN, CURRENT_VERSION, snippet, FENCE_CLOSE
    )
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn backup(path: &Path) -> Result<()> {
    let mut bak = path.as_os_str().to_owned();
    bak.push(format!(".mobux.bak.{}", timestamp()));
    let bak_path = PathBuf::from(bak);
    fs::copy(path, &bak_path)
        .with_context(|| format!("backing up {} -> {}", path.display(), bak_path.display()))?;
    Ok(())
}

pub fn install(shell: Shell) -> Result<Status> {
    let home = home_dir()?;
    install_with_home(&home, shell)?;
    status()
}

fn install_with_home(home: &Path, shell: Shell) -> Result<()> {
    let path = rc_path(home, shell);
    let block = render_block(shell.snippet());

    if !path.exists() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
        }
        fs::write(&path, &block).with_context(|| format!("writing {}", path.display()))?;
        return Ok(());
    }

    let content = fs::read_to_string(&path)?;

    if let Some(existing) = find_block(&content) {
        if existing.version == CURRENT_VERSION {
            return Ok(());
        }
        backup(&path)?;
        let mut new_content = String::with_capacity(content.len() + block.len());
        new_content.push_str(&content[..existing.start]);
        if existing.leading_blank {
            new_content.push('\n');
        }
        new_content.push_str(&block);
        new_content.push_str(&content[existing.end..]);
        fs::write(&path, new_content)?;
        return Ok(());
    }

    backup(&path)?;
    let mut new_content = content.clone();
    if !new_content.is_empty() {
        if !new_content.ends_with('\n') {
            new_content.push('\n');
        }
        new_content.push('\n');
    }
    new_content.push_str(&block);
    fs::write(&path, new_content)?;
    Ok(())
}

pub fn uninstall(shell: Shell) -> Result<Status> {
    let home = home_dir()?;
    uninstall_with_home(&home, shell)?;
    status()
}

fn uninstall_with_home(home: &Path, shell: Shell) -> Result<()> {
    let path = rc_path(home, shell);
    if !path.exists() {
        return Ok(());
    }
    let content = fs::read_to_string(&path)?;
    let block = match find_block(&content) {
        None => return Ok(()),
        Some(b) => b,
    };
    backup(&path)?;
    let mut new_content = String::with_capacity(content.len());
    new_content.push_str(&content[..block.start]);
    new_content.push_str(&content[block.end..]);
    fs::write(&path, new_content)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn tmp_home() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn a_configured_session_shell_wins_and_names_its_type() {
        assert_eq!(
            detect_session_shell("/usr/bin/zsh"),
            (Shell::Zsh, "/usr/bin/zsh".to_string())
        );
        assert_eq!(
            detect_session_shell("/usr/bin/fish"),
            (Shell::Fish, "/usr/bin/fish".to_string())
        );
        // Anything else is treated as bash-compatible.
        assert_eq!(
            detect_session_shell("/bin/dash"),
            (Shell::Bash, "/bin/dash".to_string())
        );
    }

    #[test]
    fn an_empty_setting_falls_through_to_the_environment() {
        let _g = ENV_LOCK.lock().unwrap();
        // SAFETY: single-threaded under ENV_LOCK; restored before returning.
        unsafe { env::set_var("SHELL", "/usr/bin/zsh") };
        let detected = detect_session_shell("");
        unsafe { env::remove_var("SHELL") };
        assert_eq!(detected, (Shell::Zsh, "/usr/bin/zsh".to_string()));
    }

    fn read(p: &Path) -> String {
        fs::read_to_string(p).expect("read")
    }

    #[test]
    fn install_creates_missing_file() {
        let _g = ENV_LOCK.lock().unwrap();
        let home = tmp_home();
        install_with_home(home.path(), Shell::Bash).unwrap();
        let rc = home.path().join(".bashrc");
        let c = read(&rc);
        assert!(c.contains(FENCE_OPEN));
        assert!(c.contains(FENCE_CLOSE));
        assert!(c.contains("PS0="));
    }

    #[test]
    fn install_creates_fish_parent_dir() {
        let _g = ENV_LOCK.lock().unwrap();
        let home = tmp_home();
        install_with_home(home.path(), Shell::Fish).unwrap();
        let rc = home.path().join(".config/fish/config.fish");
        assert!(rc.exists());
        assert!(read(&rc).contains("__mobux_osc133_preexec"));
    }

    #[test]
    fn install_preserves_prior_content_with_blank_line() {
        let _g = ENV_LOCK.lock().unwrap();
        let home = tmp_home();
        let rc = home.path().join(".bashrc");
        fs::write(&rc, "export FOO=1\n").unwrap();
        install_with_home(home.path(), Shell::Bash).unwrap();
        let c = read(&rc);
        assert!(c.starts_with("export FOO=1\n\n"));
        assert!(c.contains(FENCE_OPEN));
        assert_eq!(c.matches(FENCE_OPEN).count(), 1);
        let baks: Vec<_> = fs::read_dir(home.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .contains(".bashrc.mobux.bak.")
            })
            .collect();
        assert_eq!(baks.len(), 1, "backup file expected");
    }

    #[test]
    fn install_idempotent_at_current_version() {
        let _g = ENV_LOCK.lock().unwrap();
        let home = tmp_home();
        install_with_home(home.path(), Shell::Zsh).unwrap();
        let rc = home.path().join(".zshrc");
        let first = read(&rc);
        install_with_home(home.path(), Shell::Zsh).unwrap();
        let second = read(&rc);
        assert_eq!(first, second);
        let baks: Vec<_> = fs::read_dir(home.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .contains(".zshrc.mobux.bak.")
            })
            .collect();
        assert!(baks.is_empty(), "no backup on no-op install");
    }

    #[test]
    fn install_replaces_outdated_block() {
        let _g = ENV_LOCK.lock().unwrap();
        let home = tmp_home();
        let rc = home.path().join(".bashrc");
        let outdated = format!(
            "before\n\n{}\n# version: 0\nold-snippet\n{}\nafter\n",
            FENCE_OPEN, FENCE_CLOSE
        );
        fs::write(&rc, &outdated).unwrap();
        install_with_home(home.path(), Shell::Bash).unwrap();
        let c = read(&rc);
        assert!(c.contains("before\n"));
        assert!(c.contains("after\n"));
        assert!(!c.contains("old-snippet"));
        assert!(c.contains(&format!("# version: {CURRENT_VERSION}")));
        assert!(c.contains("PS0="));
        assert_eq!(c.matches(FENCE_OPEN).count(), 1);
    }

    #[test]
    fn uninstall_removes_only_the_fence() {
        let _g = ENV_LOCK.lock().unwrap();
        let home = tmp_home();
        let rc = home.path().join(".bashrc");
        fs::write(&rc, "first line\nsecond line\n").unwrap();
        install_with_home(home.path(), Shell::Bash).unwrap();
        uninstall_with_home(home.path(), Shell::Bash).unwrap();
        let c = read(&rc);
        assert_eq!(c, "first line\nsecond line\n");
    }

    #[test]
    fn uninstall_noop_when_not_installed() {
        let _g = ENV_LOCK.lock().unwrap();
        let home = tmp_home();
        let rc = home.path().join(".bashrc");
        fs::write(&rc, "nothing here\n").unwrap();
        uninstall_with_home(home.path(), Shell::Bash).unwrap();
        let c = read(&rc);
        assert_eq!(c, "nothing here\n");
    }

    /// v2 regression: every snippet must branch on `$TMUX` and emit the
    /// DCS-passthrough wrap (`\ePtmux;\e<seq>\e\\`) for the in-tmux
    /// branch. tmux 3.4's default `allow-passthrough off` drops bare
    /// OSC 133 entirely, so without the wrap the reader's heuristics
    /// hint never auto-dismisses.
    #[test]
    fn snippets_wrap_osc133_when_inside_tmux() {
        // bash + zsh use POSIX `[ -n "$TMUX" ]`; fish uses `test -n "$TMUX"`.
        assert!(BASH_SNIPPET.contains("[ -n \"$TMUX\" ]"));
        assert!(ZSH_SNIPPET.contains("[ -n \"$TMUX\" ]"));
        assert!(FISH_SNIPPET.contains("test -n \"$TMUX\""));

        // The DCS envelope opens `\ePtmux;` and closes with `\e\\` (ST).
        // Inside, the original ESC must be doubled to `\e\e` so tmux
        // emits one ESC byte to the outer terminal.
        for snippet in [BASH_SNIPPET, ZSH_SNIPPET, FISH_SNIPPET] {
            assert!(
                snippet.contains("\\ePtmux;\\e\\e]133;"),
                "missing tmux DCS-passthrough wrap in snippet:\n{snippet}"
            );
            assert!(
                snippet.contains("\\a\\e\\\\"),
                "missing DCS terminator (\\e\\\\) in snippet:\n{snippet}"
            );
        }

        // The bare-emission branch must still exist for the no-tmux case.
        for snippet in [BASH_SNIPPET, ZSH_SNIPPET, FISH_SNIPPET] {
            assert!(
                snippet.contains("'\\e]133;"),
                "missing bare OSC 133 (no-tmux) branch in snippet:\n{snippet}"
            );
        }
    }

    /// CURRENT_VERSION must bump to 4 when zsh's D+A marker moves into
    /// PROMPT, otherwise existing v3 installs (which still emit D+A from a
    /// lone precmd() write) would be reported as "installed" and never
    /// re-installed.
    #[test]
    fn current_version_is_v4_for_zsh_prompt_embedded_marker() {
        assert_eq!(CURRENT_VERSION, 4);
    }

    /// v4 regression: zsh's D+A marker must ride the same write as the
    /// prompt text — embedded in PROMPT via a `%{...%}` zero-width escape —
    /// not emitted from a separate `precmd()` write. A lone envelope with
    /// nothing following it in the same shell write is exactly the
    /// condition (see term-tokenizer.js's doc comment) that lets tmux's
    /// per-envelope cursor sync land the marker on the wrong row; confirmed
    /// on a real tmux 3.4 + real zsh trace before this fix (the A marker
    /// landed on a just-finished command's own output line, not the fresh
    /// prompt line).
    #[test]
    fn zsh_marker_rides_prompt_not_a_lone_precmd_write() {
        let tmux_branch = ZSH_SNIPPET.split("else").next().unwrap();
        assert!(
            tmux_branch.contains("PROMPT=$'%{"),
            "zsh's D+A marker must be embedded in PROMPT: {tmux_branch}"
        );
        assert!(
            !tmux_branch.contains("precmd()"),
            "zsh's tmux branch must not emit D/A from a separate precmd() write: {tmux_branch}"
        );
        // `%?` is zsh's native exit-status prompt token — re-read fresh on
        // every prompt draw, no PROMPT_SUBST required (unlike a bare `$?`).
        assert!(
            tmux_branch.contains("%?"),
            "zsh D marker must use the native %? exit-status token: {tmux_branch}"
        );
    }

    #[test]
    fn v1_install_is_reported_as_outdated() {
        let _g = ENV_LOCK.lock().unwrap();
        let home = tmp_home();
        let rc = home.path().join(".bashrc");
        let v1 = format!(
            "{}\n# version: 1\n# old v1 snippet\n{}\n",
            FENCE_OPEN, FENCE_CLOSE
        );
        fs::write(&rc, &v1).unwrap();
        let st = shell_state(home.path(), Shell::Bash);
        assert!(
            matches!(st, ShellState::Outdated { version: 1 }),
            "got {st:?}"
        );
    }

    /// v2 regression: a v2 install (un-doubled ESC before the A marker) must
    /// be reported Outdated, and re-running install must upgrade it in
    /// place to v3 — this is the actual upgrade path a real v2 install goes
    /// through in production.
    #[test]
    fn v2_install_is_reported_as_outdated_and_upgrades_to_v3() {
        let _g = ENV_LOCK.lock().unwrap();
        let home = tmp_home();
        let rc = home.path().join(".bashrc");
        let v2 = format!(
            "{}\n# version: 2\n# old v2 snippet (undoubled ESC before A)\n{}\n",
            FENCE_OPEN, FENCE_CLOSE
        );
        fs::write(&rc, &v2).unwrap();
        let st = shell_state(home.path(), Shell::Bash);
        assert!(
            matches!(st, ShellState::Outdated { version: 2 }),
            "got {st:?}"
        );

        install_with_home(home.path(), Shell::Bash).unwrap();
        let st = shell_state(home.path(), Shell::Bash);
        assert!(
            matches!(st, ShellState::Installed { version: v } if v == CURRENT_VERSION),
            "got {st:?}"
        );
        let c = read(&rc);
        assert!(!c.contains("old v2 snippet"));
        assert!(c.contains(&format!("# version: {CURRENT_VERSION}")));
    }

    /// v3 regression: a v3 zsh install (D+A still emitted from a lone
    /// precmd() write) must be reported Outdated, and re-running install
    /// must upgrade it in place to v4 — the actual upgrade path a real v3
    /// zsh install goes through in production.
    #[test]
    fn v3_zsh_install_is_reported_as_outdated_and_upgrades_to_v4() {
        let _g = ENV_LOCK.lock().unwrap();
        let home = tmp_home();
        let rc = home.path().join(".zshrc");
        let v3 = format!(
            "{}\n# version: 3\n# old v3 snippet (D+A from a lone precmd write)\n{}\n",
            FENCE_OPEN, FENCE_CLOSE
        );
        fs::write(&rc, &v3).unwrap();
        let st = shell_state(home.path(), Shell::Zsh);
        assert!(
            matches!(st, ShellState::Outdated { version: 3 }),
            "got {st:?}"
        );

        install_with_home(home.path(), Shell::Zsh).unwrap();
        let st = shell_state(home.path(), Shell::Zsh);
        assert!(
            matches!(st, ShellState::Installed { version: v } if v == CURRENT_VERSION),
            "got {st:?}"
        );
        let c = read(&rc);
        assert!(!c.contains("old v3 snippet"));
        assert!(c.contains(&format!("# version: {CURRENT_VERSION}")));
        assert!(c.contains("PROMPT=$'%{"));
    }

    /// Extract every tmux DCS-passthrough envelope (`\ePtmux;...\e\\`) from a
    /// snippet's raw text.
    fn tmux_envelopes(snippet: &str) -> Vec<&str> {
        const OPEN: &str = "\\ePtmux;";
        const CLOSE: &str = "\\e\\\\";
        let mut out = vec![];
        let mut rest = snippet;
        while let Some(start) = rest.find(OPEN) {
            let after_open = &rest[start + OPEN.len()..];
            match after_open.find(CLOSE) {
                Some(end) => {
                    out.push(&after_open[..end]);
                    rest = &after_open[end + CLOSE.len()..];
                }
                None => break,
            }
        }
        out
    }

    /// v3 regression: every embedded OSC 133 start (`]133;`) inside a tmux
    /// DCS-passthrough envelope must be immediately preceded by a DOUBLED
    /// ESC (`\e\e`), not a single `\e`. tmux's passthrough unescaper reads a
    /// lone embedded ESC as a malformed unescape marker, drops it, and
    /// forwards the following bytes as literal text instead of an OSC
    /// sequence — this is exactly the v2 bug: the bash/zsh snippets combined
    /// the D and A markers into one envelope but only doubled the ESC before
    /// D, leaving the ESC before A un-doubled. Covers every shell (bash,
    /// zsh, fish) and, since `rcfile_snippet` reads straight off
    /// these same constants, both the settings-install path and tmux.rs's
    /// session auto-injection rcfile path.
    #[test]
    fn every_embedded_osc133_start_is_doubled_inside_tmux_envelopes() {
        for (name, snippet) in [
            ("bash", BASH_SNIPPET),
            ("zsh", ZSH_SNIPPET),
            ("fish", FISH_SNIPPET),
        ] {
            let envelopes = tmux_envelopes(snippet);
            assert!(
                !envelopes.is_empty(),
                "{name}: no tmux DCS-passthrough envelopes found"
            );
            for envelope in envelopes {
                for (idx, _) in envelope.match_indices("]133;") {
                    assert!(
                        idx >= 4 && &envelope[idx - 4..idx] == "\\e\\e",
                        "{name}: un-doubled ESC before `]133;` inside tmux envelope {envelope:?}"
                    );
                }
            }
        }
    }

    /// The settings-install path (`Shell::snippet` / `rcfile_snippet`) and
    /// tmux.rs's session auto-injection path both build on the exact same
    /// constants — asserted here so a future edit can't silently fork them.
    #[test]
    fn rcfile_snippet_is_the_single_source_for_every_shell() {
        assert_eq!(rcfile_snippet(Shell::Bash), BASH_SNIPPET);
        assert_eq!(rcfile_snippet(Shell::Zsh), ZSH_SNIPPET);
        assert_eq!(rcfile_snippet(Shell::Fish), FISH_SNIPPET);
        assert_eq!(rcfile_snippet(Shell::Bash), Shell::Bash.snippet());
    }

    #[test]
    fn status_reports_states() {
        let _g = ENV_LOCK.lock().unwrap();
        let home = tmp_home();
        let bashrc = home.path().join(".bashrc");
        fs::write(&bashrc, "stuff\n").unwrap();
        install_with_home(home.path(), Shell::Bash).unwrap();

        let zshrc = home.path().join(".zshrc");
        fs::write(&zshrc, "no fence\n").unwrap();

        let bash = shell_state(home.path(), Shell::Bash);
        let zsh = shell_state(home.path(), Shell::Zsh);
        let fish = shell_state(home.path(), Shell::Fish);
        assert!(matches!(bash, ShellState::Installed { version: v } if v == CURRENT_VERSION));
        assert!(matches!(zsh, ShellState::NotInstalled));
        assert!(matches!(fish, ShellState::NotPresent));
    }
}
