use std::{env, fs, path::PathBuf, time::SystemTime};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

pub const CURRENT_VERSION: u32 = 1;
const FENCE_OPEN: &str = "# >>> mobux OSC 133 (managed) >>>";
const FENCE_CLOSE: &str = "# <<< mobux OSC 133 (managed) <<<";
const VERSION_PREFIX: &str = "# version: ";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
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

pub const BASH_SNIPPET: &str = "PS0='\\e]133;C\\a'
PS1='\\[\\e]133;D;$?\\a\\e]133;A\\a\\]'\"$PS1\"'\\[\\e]133;B\\a\\]'";

pub const ZSH_SNIPPET: &str = "preexec() { print -Pn '\\e]133;C\\a' }
precmd()  { print -Pn '\\e]133;D;'$?'\\a\\e]133;A\\a' }";

pub const FISH_SNIPPET: &str = "function __mobux_osc133_preexec --on-event fish_preexec
    printf '\\e]133;C\\a'
end
function __mobux_osc133_postexec --on-event fish_postexec
    printf '\\e]133;D;%s\\a' $status
end
function __mobux_osc133_prompt --on-event fish_prompt
    printf '\\e]133;A\\a'
end";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ShellState {
    NotPresent,
    NotInstalled,
    Installed { version: u32 },
    Outdated { version: u32 },
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub bash: ShellState,
    pub zsh: ShellState,
    pub fish: ShellState,
}

fn home() -> Result<PathBuf> {
    let h = env::var("HOME").map_err(|_| anyhow!("HOME environment variable is not set"))?;
    if h.is_empty() {
        return Err(anyhow!("HOME environment variable is empty"));
    }
    Ok(PathBuf::from(h))
}

fn rc_path(shell: Shell) -> Result<PathBuf> {
    Ok(home()?.join(shell.rc_relative()))
}

fn block_text(snippet: &str) -> String {
    format!(
        "{}\n{}{}\n{}\n{}\n",
        FENCE_OPEN, VERSION_PREFIX, CURRENT_VERSION, snippet, FENCE_CLOSE
    )
}

struct FenceLocation {
    start_line: usize,
    end_line: usize,
    version: u32,
}

fn find_fence(content: &str) -> Option<FenceLocation> {
    let lines: Vec<&str> = content.split('\n').collect();
    let mut start: Option<usize> = None;
    for (i, l) in lines.iter().enumerate() {
        if l.trim_end() == FENCE_OPEN {
            start = Some(i);
            break;
        }
    }
    let s = start?;
    let mut end: Option<usize> = None;
    for (i, l) in lines.iter().enumerate().skip(s + 1) {
        if l.trim_end() == FENCE_CLOSE {
            end = Some(i);
            break;
        }
    }
    let e = end?;
    let mut version = 0u32;
    for l in &lines[s + 1..e] {
        let t = l.trim_start();
        if let Some(rest) = t.strip_prefix(VERSION_PREFIX) {
            version = rest.trim().parse::<u32>().unwrap_or(0);
            break;
        }
    }
    Some(FenceLocation {
        start_line: s,
        end_line: e,
        version,
    })
}

fn classify(content: Option<&str>) -> ShellState {
    let Some(c) = content else {
        return ShellState::NotPresent;
    };
    match find_fence(c) {
        None => ShellState::NotInstalled,
        Some(f) if f.version == CURRENT_VERSION => ShellState::Installed { version: f.version },
        Some(f) => ShellState::Outdated { version: f.version },
    }
}

fn read_rc(shell: Shell) -> Result<Option<String>> {
    let path = rc_path(shell)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(anyhow::Error::new(e).context(format!("reading {}", path.display()))),
    }
}

pub fn shell_state(shell: Shell) -> Result<ShellState> {
    Ok(classify(read_rc(shell)?.as_deref()))
}

pub fn status() -> Result<Status> {
    Ok(Status {
        bash: shell_state(Shell::Bash)?,
        zsh: shell_state(Shell::Zsh)?,
        fish: shell_state(Shell::Fish)?,
    })
}

fn unix_ts() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn make_backup(path: &std::path::Path) -> Result<PathBuf> {
    let mut ts = unix_ts();
    loop {
        let candidate = path.with_file_name(format!(
            "{}.mobux.bak.{}",
            path.file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("rc"),
            ts
        ));
        if !candidate.exists() {
            fs::copy(path, &candidate)
                .with_context(|| format!("backing up {} -> {}", path.display(), candidate.display()))?;
            return Ok(candidate);
        }
        ts += 1;
    }
}

pub fn install(shell: Shell) -> Result<Status> {
    let path = rc_path(shell)?;
    let existing = read_rc(shell)?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }

    let block = block_text(shell.snippet());

    match existing {
        None => {
            fs::write(&path, &block)
                .with_context(|| format!("writing {}", path.display()))?;
        }
        Some(content) => {
            make_backup(&path)?;
            let new_content = match find_fence(&content) {
                Some(f) if f.version == CURRENT_VERSION => return status(),
                Some(f) => replace_fence(&content, f, &block),
                None => append_block(&content, &block),
            };
            fs::write(&path, new_content)
                .with_context(|| format!("writing {}", path.display()))?;
        }
    }

    status()
}

pub fn uninstall(shell: Shell) -> Result<Status> {
    let path = rc_path(shell)?;
    let Some(content) = read_rc(shell)? else {
        return status();
    };
    let Some(fence) = find_fence(&content) else {
        return status();
    };
    make_backup(&path)?;
    let new_content = remove_fence(&content, fence);
    fs::write(&path, new_content)
        .with_context(|| format!("writing {}", path.display()))?;
    status()
}

fn append_block(content: &str, block: &str) -> String {
    if content.is_empty() {
        return block.to_string();
    }
    let mut out = String::with_capacity(content.len() + block.len() + 2);
    out.push_str(content);
    if !content.ends_with('\n') {
        out.push('\n');
    }
    out.push('\n');
    out.push_str(block);
    out
}

fn replace_fence(content: &str, f: FenceLocation, block: &str) -> String {
    let lines: Vec<&str> = content.split('\n').collect();
    let mut out = String::new();
    for line in &lines[..f.start_line] {
        out.push_str(line);
        out.push('\n');
    }
    out.push_str(block);
    let after_start = f.end_line + 1;
    if after_start < lines.len() {
        let tail = &lines[after_start..];
        let joined = tail.join("\n");
        if !joined.is_empty() || tail.len() > 1 {
            out.push_str(&joined);
        }
    }
    out
}

fn remove_fence(content: &str, f: FenceLocation) -> String {
    let lines: Vec<&str> = content.split('\n').collect();
    let mut start = f.start_line;
    if start > 0 && lines[start - 1].is_empty() {
        start -= 1;
    }
    let after = f.end_line + 1;
    let mut out = String::new();
    for (i, line) in lines[..start].iter().enumerate() {
        out.push_str(line);
        if i + 1 < start {
            out.push('\n');
        }
    }
    if after < lines.len() {
        if !out.is_empty() {
            out.push('\n');
        }
        let tail = &lines[after..];
        out.push_str(&tail.join("\n"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_home<F: FnOnce(&std::path::Path)>(f: F) {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let prev = env::var("HOME").ok();
        env::set_var("HOME", tmp.path());
        f(tmp.path());
        match prev {
            Some(v) => env::set_var("HOME", v),
            None => env::remove_var("HOME"),
        }
    }

    #[test]
    fn install_into_nonexistent_file() {
        with_home(|home| {
            let st = install(Shell::Bash).unwrap();
            assert!(matches!(st.bash, ShellState::Installed { version: 1 }));
            let body = fs::read_to_string(home.join(".bashrc")).unwrap();
            assert!(body.contains(FENCE_OPEN));
            assert!(body.contains(FENCE_CLOSE));
            assert!(body.contains(BASH_SNIPPET));
            // No backup since file did not exist before.
            let entries: Vec<_> = fs::read_dir(home).unwrap().collect();
            assert!(!entries.iter().any(|e| e.as_ref().unwrap().file_name().to_string_lossy().contains(".mobux.bak.")));
        });
    }

    #[test]
    fn install_preserves_prior_content() {
        with_home(|home| {
            let rc = home.join(".zshrc");
            fs::write(&rc, "export FOO=bar\nalias ll='ls -la'\n").unwrap();
            install(Shell::Zsh).unwrap();
            let body = fs::read_to_string(&rc).unwrap();
            assert!(body.starts_with("export FOO=bar\nalias ll='ls -la'\n"));
            assert!(body.contains(FENCE_OPEN));
            assert!(body.contains(ZSH_SNIPPET));
        });
    }

    #[test]
    fn install_idempotent_at_current_version() {
        with_home(|home| {
            install(Shell::Bash).unwrap();
            let first = fs::read_to_string(home.join(".bashrc")).unwrap();
            install(Shell::Bash).unwrap();
            let second = fs::read_to_string(home.join(".bashrc")).unwrap();
            assert_eq!(first, second);
        });
    }

    #[test]
    fn install_replaces_outdated_block() {
        with_home(|home| {
            let rc = home.join(".bashrc");
            let outdated = format!(
                "leading\n\n{}\n# version: 0\nold-snippet\n{}\ntrailing\n",
                FENCE_OPEN, FENCE_CLOSE
            );
            fs::write(&rc, &outdated).unwrap();
            let st = install(Shell::Bash).unwrap();
            assert!(matches!(st.bash, ShellState::Installed { version: 1 }));
            let body = fs::read_to_string(&rc).unwrap();
            assert!(body.contains("leading"));
            assert!(body.contains("trailing"));
            assert!(body.contains(BASH_SNIPPET));
            assert!(!body.contains("old-snippet"));
        });
    }

    #[test]
    fn uninstall_removes_only_the_fence() {
        with_home(|home| {
            let rc = home.join(".bashrc");
            fs::write(&rc, "before line\n").unwrap();
            install(Shell::Bash).unwrap();
            uninstall(Shell::Bash).unwrap();
            let body = fs::read_to_string(&rc).unwrap();
            assert_eq!(body.trim_end(), "before line");
            assert!(!body.contains(FENCE_OPEN));
        });
    }

    #[test]
    fn install_creates_backup_when_file_existed() {
        with_home(|home| {
            let rc = home.join(".bashrc");
            fs::write(&rc, "prior\n").unwrap();
            install(Shell::Bash).unwrap();
            let entries: Vec<_> = fs::read_dir(home)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
                .collect();
            assert!(
                entries.iter().any(|n| n.starts_with(".bashrc.mobux.bak.")),
                "no backup found in {entries:?}"
            );
        });
    }

    #[test]
    fn uninstall_no_op_when_not_installed() {
        with_home(|home| {
            let rc = home.join(".zshrc");
            fs::write(&rc, "untouched\n").unwrap();
            uninstall(Shell::Zsh).unwrap();
            assert_eq!(fs::read_to_string(&rc).unwrap(), "untouched\n");
        });
    }

    #[test]
    fn fish_install_creates_parent_dir() {
        with_home(|home| {
            install(Shell::Fish).unwrap();
            assert!(home.join(".config/fish/config.fish").exists());
        });
    }
}
