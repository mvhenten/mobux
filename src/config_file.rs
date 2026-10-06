//! The one writer of `config.json` while mobux runs. Every Settings page that
//! edits the file goes through [`ConfigFile::edit`], which holds a single lock
//! across read → change → validate → write, so two saves never write over
//! each other's keys.

use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::Mutex;

use crate::config;

#[derive(Debug, PartialEq, Eq)]
pub enum EditError {
    Invalid(String),
    Io(String),
}

pub struct ConfigFile {
    path: PathBuf,
    lock: Mutex<()>,
}

impl ConfigFile {
    pub fn new(path: PathBuf) -> Self {
        ConfigFile {
            path,
            lock: Mutex::new(()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Set each `block.key` the change returns, check the result with the
    /// loader's rules, and write it. The change sees the file as it is under
    /// the lock, so one that rewrites a whole map never drops an entry another
    /// save wrote a moment earlier. A refused edit leaves the file alone.
    pub async fn edit_with<'a, F>(&self, change: F) -> Result<(), EditError>
    where
        F: FnOnce(&config::Config) -> Vec<(&'a str, &'a str, serde_json::Value)>,
    {
        let _held = self.lock.lock().await;
        let previous = read_optional(&self.path).map_err(EditError::Io)?;
        let current = config::parse(&self.path, previous.as_deref().unwrap_or("{}"))
            .map_err(|e| EditError::Invalid(e.to_string()))?;
        let keys = change(&current);
        let next = with_keys(previous.as_deref(), &keys).map_err(EditError::Invalid)?;
        config::parse(&self.path, &next).map_err(|e| EditError::Invalid(e.to_string()))?;
        write_atomic(&self.path, &next).map_err(|e| EditError::Io(e.to_string()))
    }

    /// The file as it is now, merged onto the defaults and checked. Read on
    /// every call, so a hand edit applies without a restart.
    pub fn read(&self) -> Result<config::Config, config::LoadError> {
        config::load_from(&self.path)
    }
}

/// Set each `block.key` and leave every other key where it was; serde_json
/// keeps insertion order (`preserve_order`).
fn with_keys(
    raw: Option<&str>,
    keys: &[(&str, &str, serde_json::Value)],
) -> Result<String, String> {
    let mut document: serde_json::Value = match raw {
        Some(raw) => serde_json::from_str(raw).map_err(|e| format!("config.json: {e}"))?,
        None => serde_json::json!({}),
    };
    let root = document
        .as_object_mut()
        .ok_or("config.json: the top level must be an object")?;
    for (block, key, value) in keys {
        let block = root
            .entry(block.to_string())
            .or_insert_with(|| serde_json::json!({}));
        if !block.is_object() {
            *block = serde_json::json!({});
        }
        block
            .as_object_mut()
            .expect("just made an object")
            .insert(key.to_string(), value.clone());
    }
    let text = serde_json::to_string_pretty(&document).map_err(|e| e.to_string())?;
    Ok(format!("{text}\n"))
}

pub fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => Ok(Some(raw)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

static STAGING: AtomicU64 = AtomicU64::new(0);

/// Replace the file in one rename, through a symlink to the file it names,
/// at mode 600 because it can hold the PIN. The staging name is unique, so a
/// `mobux configure` run beside the server never shares it.
fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let parent = target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
        .to_path_buf();
    std::fs::create_dir_all(&parent)?;
    let mut staging = target.clone().into_os_string();
    staging.push(format!(
        ".{}.{}.tmp",
        std::process::id(),
        STAGING.fetch_add(1, Ordering::Relaxed)
    ));
    let staging = PathBuf::from(staging);
    let written = stage(&staging, text).and_then(|()| std::fs::rename(&staging, &target));
    if written.is_err() {
        let _ = std::fs::remove_file(&staging);
    }
    written?;
    std::fs::File::open(&parent)?.sync_all()
}

fn stage(staging: &Path, text: &str) -> std::io::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(staging)?;
    std::fs::set_permissions(staging, std::fs::Permissions::from_mode(0o600))?;
    file.write_all(text.as_bytes())?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn concurrent_edits_to_different_blocks_both_land() {
        let dir = tempfile::tempdir().unwrap();
        let file = Arc::new(ConfigFile::new(dir.path().join(config::CONFIG_FILE_NAME)));
        let edits: Vec<_> = (0..40u16)
            .map(|n| {
                let file = file.clone();
                tokio::spawn(async move {
                    let edit = match n % 2 {
                        0 => ("mcp", "port", serde_json::json!(9000 + n)),
                        _ => ("files", "listing", serde_json::json!(true)),
                    };
                    file.edit_with(|_| vec![edit]).await.unwrap();
                })
            })
            .collect();
        for edit in edits {
            edit.await.unwrap();
        }
        let written = config::load_from(file.path()).unwrap();
        assert!(written.files.listing);
        assert_ne!(written.mcp.port, 0);
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name())
            .filter(|name| name != config::CONFIG_FILE_NAME)
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }
}
