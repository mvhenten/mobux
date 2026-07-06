//! Embedded copies of the `bin/stt-*` helper scripts.
//!
//! Prebuilt-binary releases don't ship the source tree's `bin/` directory, so
//! a persisted `install_cmd`/`start_cmd`/`stop_cmd` of the bare path
//! `bin/stt-install` (etc.) resolves to nothing (`sh: 1: bin/stt-install: not
//! found`, exit 127). Embedding the script bodies makes the local-STT
//! remediation self-contained: `SttConfig::default()` stores the full script
//! text instead of a path, and `resolve` upgrades any legacy bare `bin/stt-*`
//! path already persisted in a config DB to the matching embedded script.

pub const INSTALL_SCRIPT: &str = include_str!("../bin/stt-install");
pub const SERVE_SCRIPT: &str = include_str!("../bin/stt-serve");
pub const STOP_SCRIPT: &str = include_str!("../bin/stt-stop");

/// Resolve a configured command against its embedded default.
///
/// A configured value that looks like a bare filesystem path (no whitespace,
/// rooted at `bin/`, `./`, or `/`) and does not exist on disk is treated as a
/// stale reference to the source tree's `bin/` directory — e.g. a legacy
/// `bin/stt-install` value saved before this fix. In that case the embedded
/// script body is run instead. Any other value, including a bare path that
/// does exist on disk, is left untouched so an explicit custom command still
/// wins.
pub fn resolve(cmd: &str, embedded: &str) -> String {
    resolve_with(cmd, embedded, |p| std::path::Path::new(p).is_file())
}

fn resolve_with(cmd: &str, embedded: &str, path_exists: impl Fn(&str) -> bool) -> String {
    let trimmed = cmd.trim();
    let looks_like_bare_path = !trimmed.is_empty()
        && !trimmed.chars().any(char::is_whitespace)
        && (trimmed.starts_with("bin/") || trimmed.starts_with("./") || trimmed.starts_with('/'));

    if looks_like_bare_path && !path_exists(trimmed) {
        return embedded.to_string();
    }
    cmd.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_scripts_are_self_contained_podman_wrappers() {
        for script in [INSTALL_SCRIPT, SERVE_SCRIPT, STOP_SCRIPT] {
            assert!(script.contains("podman"), "expected podman in: {script}");
            assert!(
                !script.contains("bin/stt-"),
                "embedded script must not reference a bin/stt- path: {script}"
            );
        }
    }

    // Simulates a prebuilt-binary release, where the source tree's `bin/`
    // directory (and therefore any bin/stt-* path) never exists on disk.
    fn binary_release_fs(_path: &str) -> bool {
        false
    }

    #[test]
    fn legacy_bare_bin_path_resolves_to_embedded_install_script() {
        let resolved = resolve_with("bin/stt-install", INSTALL_SCRIPT, binary_release_fs);
        assert_eq!(resolved, INSTALL_SCRIPT);
        assert!(resolved.contains("podman pull"));
    }

    #[test]
    fn legacy_bare_bin_path_resolves_to_embedded_serve_script() {
        let resolved = resolve_with("bin/stt-serve", SERVE_SCRIPT, binary_release_fs);
        assert_eq!(resolved, SERVE_SCRIPT);
        assert!(resolved.contains("podman run"));
    }

    #[test]
    fn legacy_bare_bin_path_resolves_to_embedded_stop_script() {
        let resolved = resolve_with("bin/stt-stop", STOP_SCRIPT, binary_release_fs);
        assert_eq!(resolved, STOP_SCRIPT);
        assert!(resolved.contains("podman stop"));
    }

    #[test]
    fn existing_file_path_is_left_untouched() {
        let resolved = resolve_with("bin/stt-install", INSTALL_SCRIPT, |_| true);
        assert_eq!(resolved, "bin/stt-install");
    }

    #[test]
    fn custom_shell_command_is_left_untouched() {
        let custom = "podman pull my-custom-image:latest";
        assert_eq!(
            resolve_with(custom, INSTALL_SCRIPT, binary_release_fs),
            custom
        );
    }

    #[test]
    fn missing_nonpath_bare_word_is_left_untouched() {
        let resolved = resolve_with("true", INSTALL_SCRIPT, binary_release_fs);
        assert_eq!(resolved, "true");
    }

    #[test]
    fn resolve_uses_real_filesystem() {
        assert_eq!(resolve("Cargo.toml", INSTALL_SCRIPT), "Cargo.toml");
    }
}
