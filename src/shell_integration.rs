use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

pub const FENCE_OPEN: &str = "# >>> mobux OSC 133 (managed) >>>";
pub const FENCE_CLOSE: &str = "# <<< mobux OSC 133 (managed) <<<";
pub const CURRENT_VERSION: u32 = 1;

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
        assert!(c.contains("# version: 1"));
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
        assert!(matches!(bash, ShellState::Installed { version: 1 }));
        assert!(matches!(zsh, ShellState::NotInstalled));
        assert!(matches!(fish, ShellState::NotPresent));
    }
}
