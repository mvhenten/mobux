use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::cli::{self, CliOverrides};

pub const DEFAULT_UNIT: &str = "mobux";

/// Everything the unit file needs, already resolved from flags and environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitSpec {
    pub unit: String,
    pub exec_start: String,
    pub port: u16,
    pub user: String,
    pub pin: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Create,
    Update,
    Unchanged,
}

/// The environment `service install` reads when a flag is absent — passed in so
/// the resolution is a pure function the tests can drive.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct EnvSnapshot {
    pub mobux_port: Option<String>,
    pub port: Option<String>,
    pub auth_user: Option<String>,
    pub auth_pass: Option<String>,
    pub pin: Option<String>,
    pub service_name: Option<String>,
}

impl EnvSnapshot {
    fn from_env() -> Self {
        let read = |key: &str| std::env::var(key).ok();
        EnvSnapshot {
            mobux_port: read("MOBUX_PORT"),
            port: read("PORT"),
            auth_user: read("MOBUX_AUTH_USER"),
            auth_pass: read("MOBUX_AUTH_PASS"),
            pin: read("MOBUX_PIN"),
            service_name: read("MOBUX_SERVICE_NAME"),
        }
    }
}

/// The unit name the self-updater will restart: `MOBUX_SERVICE_NAME` if set,
/// `mobux` otherwise — the same lookup `update::resolve_service_name` makes.
pub fn unit_name(service_name: Option<String>) -> String {
    service_name
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_UNIT.to_string())
}

/// Resolve the unit from the flags, the environment and the running binary.
///
/// A boot service is reachable from the network the moment it starts, so an
/// auth-less unit is refused rather than written.
pub fn resolve_unit_spec(
    overrides: &CliOverrides,
    env: &EnvSnapshot,
    exec_start: &Path,
) -> Result<UnitSpec, String> {
    let credentials = cli::resolve_credentials(
        overrides.user.clone(),
        overrides.pin.clone(),
        env.auth_user.clone(),
        env.auth_pass.clone(),
        env.pin.clone(),
    )
    .ok_or_else(|| {
        "a boot service needs a username and PIN — nothing else stops the network from \
         reaching it. Pass --user and --pin, or export MOBUX_AUTH_USER and MOBUX_PIN \
         before running `mobux service install`."
            .to_string()
    })?;

    let spec = UnitSpec {
        unit: unit_name(env.service_name.clone()),
        exec_start: exec_start.to_string_lossy().into_owned(),
        port: cli::resolve_port(overrides.port, env.mobux_port.clone(), env.port.clone()),
        user: credentials.user,
        pin: credentials.pass,
    };

    check_unit_value("--user", &spec.user)?;
    check_unit_value("--pin", &spec.pin)?;
    check_unit_value("the binary path", &spec.exec_start)?;
    check_unit_value("MOBUX_SERVICE_NAME", &spec.unit)?;
    Ok(spec)
}

/// systemd splits an unquoted `Environment=` value on whitespace and eats
/// quotes and backslashes, so a value carrying any of those would reach the
/// server mangled. Refuse it here instead of writing a unit that starts with
/// the wrong PIN.
fn check_unit_value(label: &str, value: &str) -> Result<(), String> {
    let offender = value
        .chars()
        .find(|c| c.is_whitespace() || c.is_control() || matches!(c, '"' | '\'' | '\\' | '$'));
    match offender {
        None => Ok(()),
        Some(c) => Err(format!(
            "{label} contains {c:?}; a systemd unit can't carry whitespace, quotes, \
             backslashes or $ in an environment value. Use a plainer value."
        )),
    }
}

/// The unit file, mirroring the manual recipe in DEPLOY.md.
pub fn render_unit(spec: &UnitSpec) -> String {
    let UnitSpec {
        unit,
        exec_start,
        port,
        user,
        pin,
    } = spec;
    let mut out = String::new();
    let _ = write!(
        out,
        "[Unit]
Description=mobux — mobile tmux web frontend (HTTPS on :{port})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart={exec_start}
Environment=MOBUX_PORT={port}
Environment=MOBUX_AUTH_USER={user}
Environment=MOBUX_PIN={pin}
"
    );
    if unit != DEFAULT_UNIT {
        let _ = writeln!(out, "Environment=MOBUX_SERVICE_NAME={unit}");
    }
    let _ = write!(
        out,
        "# The self-updater runs `cargo install`; the default unit PATH lacks ~/.cargo/bin.
Environment=PATH=%h/.cargo/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=5
# Only kill the mobux process itself — the tmux server it spawned lives in the
# same cgroup, and the default would kill it (and every session) on restart.
KillMode=process

[Install]
WantedBy=default.target
"
    );
    out
}

/// Writing the same bytes again would bounce a healthy service for nothing, so
/// an identical unit is refused and a changed one is an update.
pub fn decide(existing: Option<&str>, desired: &str) -> Decision {
    match existing {
        None => Decision::Create,
        Some(current) if current == desired => Decision::Unchanged,
        Some(_) => Decision::Update,
    }
}

pub fn unit_path(config_dir: &Path, unit: &str) -> PathBuf {
    config_dir
        .join("systemd/user")
        .join(format!("{unit}.service"))
}

// ---------------------------------------------------------------------------
// Everything below shells out to systemctl/loginctl; the tests never call it.
// ---------------------------------------------------------------------------

pub fn run(command: &crate::cli::ServiceCommand) -> i32 {
    match command {
        crate::cli::ServiceCommand::Install(overrides) => report(install(overrides)),
        crate::cli::ServiceCommand::Uninstall => report(uninstall()),
        crate::cli::ServiceCommand::Status => match status() {
            Ok(code) => code,
            Err(message) => {
                eprintln!("mobux: {message}");
                1
            }
        },
    }
}

fn report(result: Result<(), String>) -> i32 {
    match result {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("mobux: {message}");
            1
        }
    }
}

fn install(overrides: &CliOverrides) -> Result<(), String> {
    let env = EnvSnapshot::from_env();
    let exe = std::env::current_exe()
        .map_err(|e| format!("could not resolve this binary's own path: {e}"))?;
    // Resolve before the systemd probe so a missing PIN is reported as such
    // even on a host where the user bus is out of reach.
    let spec = resolve_unit_spec(overrides, &env, &exe)?;
    preflight()?;
    let desired = render_unit(&spec);
    let path = unit_path(&config_dir()?, &spec.unit);

    let existing = std::fs::read_to_string(&path).ok();
    let decision = decide(existing.as_deref(), &desired);
    if decision == Decision::Unchanged {
        return Err(format!(
            "{} already describes this exact service — nothing to do. Pass --port/--user/--pin \
             to change it, or `mobux service uninstall` to remove it.",
            path.display()
        ));
    }

    write_unit(&path, &desired)?;
    println!("{} {} (mode 600)", verb(decision), path.display());

    systemctl(&["daemon-reload"])?;
    match decision {
        Decision::Update => systemctl(&["restart", &spec.unit])?,
        _ => systemctl(&["enable", "--now", &spec.unit])?,
    }
    enable_linger();

    println!(
        "mobux listens on https://<this-host>:{} as user {:?}",
        spec.port, spec.user
    );
    println!(
        "check it with: systemctl --user status {} --no-pager",
        spec.unit
    );
    Ok(())
}

fn verb(decision: Decision) -> &'static str {
    match decision {
        Decision::Update => "updated",
        _ => "wrote",
    }
}

fn uninstall() -> Result<(), String> {
    preflight()?;
    let unit = unit_name(std::env::var("MOBUX_SERVICE_NAME").ok());
    let path = unit_path(&config_dir()?, &unit);
    if !path.exists() {
        return Err(format!(
            "{} does not exist — nothing to uninstall.",
            path.display()
        ));
    }

    systemctl(&["disable", "--now", &unit])?;
    std::fs::remove_file(&path).map_err(|e| format!("removing {}: {e}", path.display()))?;
    systemctl(&["daemon-reload"])?;

    println!("removed {}", path.display());
    println!("linger is left enabled — other user services may depend on it. Turn it off with:");
    println!("  loginctl disable-linger");
    Ok(())
}

fn status() -> Result<i32, String> {
    preflight()?;
    let unit = unit_name(std::env::var("MOBUX_SERVICE_NAME").ok());
    let status = Command::new("systemctl")
        .args(["--user", "status", &unit, "--no-pager"])
        .status()
        .map_err(|e| format!("running systemctl: {e}"))?;
    Ok(status.code().unwrap_or(1))
}

fn config_dir() -> Result<PathBuf, String> {
    directories::BaseDirs::new()
        .map(|dirs| dirs.config_dir().to_path_buf())
        .ok_or_else(|| "could not resolve your home directory (is $HOME set?)".to_string())
}

fn write_unit(path: &Path, contents: &str) -> Result<(), String> {
    use std::io::Write as _;
    use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};

    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("writing {}: {e}", path.display()))?;
    file.write_all(contents.as_bytes())
        .map_err(|e| format!("writing {}: {e}", path.display()))?;
    // The unit carries the PIN, and an existing file keeps its old mode.
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("securing {}: {e}", path.display()))
}

/// Refuse early where systemd can't be reached, naming the fix for each case.
fn preflight() -> Result<(), String> {
    if !cfg!(target_os = "linux") {
        return Err(
            "`mobux service` manages a systemd --user unit, which exists only on Linux. \
             Run mobux under your platform's own service manager instead."
                .to_string(),
        );
    }

    let probe = Command::new("systemctl")
        .args(["--user", "is-system-running"])
        .output();

    let output = match probe {
        Ok(output) => output,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(
                "systemctl is not on PATH, so this host isn't running systemd. \
                 Start mobux from your init system (or a tmux session) instead."
                    .to_string(),
            )
        }
        Err(e) => return Err(format!("running systemctl: {e}")),
    };

    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if combined.contains("Failed to connect to") || combined.contains("Failed to get D-Bus") {
        return Err(format!(
            "no systemd --user bus for this session: {}\n\
             That usually means an SSH session without lingering. Fix it from a local login \
             (or as root) with: loginctl enable-linger {}\n\
             then reconnect, or export XDG_RUNTIME_DIR=/run/user/$(id -u).",
            combined.trim(),
            whoami()
        ));
    }
    Ok(())
}

fn systemctl(args: &[&str]) -> Result<(), String> {
    let output = Command::new("systemctl")
        .arg("--user")
        .args(args)
        .output()
        .map_err(|e| format!("running systemctl --user {}: {e}", args.join(" ")))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "systemctl --user {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

/// Best effort: without linger the unit still runs, it just waits for a login,
/// so a refusal here is a warning rather than a failed install.
fn enable_linger() {
    let user = whoami();
    let outcome = Command::new("loginctl")
        .args(["enable-linger", &user])
        .output();
    match outcome {
        Ok(output) if output.status.success() => {
            println!("linger enabled for {user} — the service starts at boot without a login")
        }
        Ok(output) => eprintln!(
            "warning: loginctl enable-linger {user} failed: {}\n\
             mobux will start when you log in, not at boot. Run it again as root to fix that.",
            String::from_utf8_lossy(&output.stderr).trim()
        ),
        Err(e) => eprintln!(
            "warning: could not run loginctl enable-linger {user}: {e}\n\
             mobux will start when you log in, not at boot."
        ),
    }
}

fn whoami() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .unwrap_or_else(|_| "$USER".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn some(value: &str) -> Option<String> {
        Some(value.to_string())
    }

    fn authed_env() -> EnvSnapshot {
        EnvSnapshot {
            auth_user: some("me"),
            pin: some("12345"),
            ..EnvSnapshot::default()
        }
    }

    fn spec_from(overrides: CliOverrides, env: EnvSnapshot) -> UnitSpec {
        resolve_unit_spec(&overrides, &env, Path::new("/home/me/.local/bin/mobux"))
            .expect("spec should resolve")
    }

    #[test]
    fn unit_carries_the_binary_path_the_port_and_the_credentials() {
        let unit = render_unit(&spec_from(
            CliOverrides {
                port: Some(5151),
                pin: some("99999"),
                user: some("walker"),
            },
            EnvSnapshot::default(),
        ));

        assert!(
            unit.contains("ExecStart=/home/me/.local/bin/mobux"),
            "{unit}"
        );
        assert!(unit.contains("Environment=MOBUX_PORT=5151"), "{unit}");
        assert!(
            unit.contains("Environment=MOBUX_AUTH_USER=walker"),
            "{unit}"
        );
        assert!(unit.contains("Environment=MOBUX_PIN=99999"), "{unit}");
        assert!(unit.contains("Restart=on-failure"), "{unit}");
        assert!(unit.contains("WantedBy=default.target"), "{unit}");
        assert!(unit.contains("KillMode=process"), "{unit}");
    }

    #[test]
    fn unit_path_extends_the_default_path_with_cargo_bin() {
        let unit = render_unit(&spec_from(CliOverrides::default(), authed_env()));
        assert!(
            unit.contains("Environment=PATH=%h/.cargo/bin:"),
            "the self-updater shells out to cargo: {unit}"
        );
    }

    #[test]
    fn flags_beat_the_environment() {
        let spec = spec_from(
            CliOverrides {
                port: Some(5151),
                pin: some("99999"),
                user: some("walker"),
            },
            EnvSnapshot {
                mobux_port: some("8080"),
                auth_user: some("me"),
                pin: some("12345"),
                ..EnvSnapshot::default()
            },
        );
        assert_eq!(spec.port, 5151);
        assert_eq!(spec.user, "walker");
        assert_eq!(spec.pin, "99999");
    }

    #[test]
    fn the_environment_fills_in_what_the_flags_leave_out() {
        let spec = spec_from(
            CliOverrides::default(),
            EnvSnapshot {
                mobux_port: some("5151"),
                auth_user: some("me"),
                pin: some("12345"),
                ..EnvSnapshot::default()
            },
        );
        assert_eq!(spec.port, 5151);
        assert_eq!(spec.user, "me");
        assert_eq!(spec.pin, "12345");
    }

    #[test]
    fn no_unit_without_auth() {
        let error = resolve_unit_spec(
            &CliOverrides {
                user: some("me"),
                ..CliOverrides::default()
            },
            &EnvSnapshot::default(),
            Path::new("/home/me/.local/bin/mobux"),
        )
        .expect_err("an auth-less boot service must be refused");
        assert!(error.contains("--pin"), "{error}");
    }

    #[test]
    fn a_pin_that_systemd_would_mangle_is_refused() {
        for pin in ["hunter 2", "hunter\"2", "hunter$2", "hunter\\2"] {
            let error = resolve_unit_spec(
                &CliOverrides {
                    pin: some(pin),
                    user: some("me"),
                    ..CliOverrides::default()
                },
                &EnvSnapshot::default(),
                Path::new("/home/me/.local/bin/mobux"),
            )
            .expect_err("a PIN systemd would mangle must be refused");
            assert!(error.contains("--pin"), "{error}");
        }
    }

    #[test]
    fn the_default_unit_is_the_one_the_self_updater_restarts() {
        assert_eq!(unit_name(None), "mobux");
        assert_eq!(unit_name(Some("  ".to_string())), "mobux");
        assert_eq!(unit_name(some("mobux-dev")), "mobux-dev");
        assert_eq!(
            unit_path(Path::new("/home/me/.config"), "mobux"),
            Path::new("/home/me/.config/systemd/user/mobux.service")
        );
    }

    #[test]
    fn a_renamed_unit_tells_the_self_updater_its_own_name() {
        let default = render_unit(&spec_from(CliOverrides::default(), authed_env()));
        assert!(!default.contains("MOBUX_SERVICE_NAME"), "{default}");

        let renamed = render_unit(&spec_from(
            CliOverrides::default(),
            EnvSnapshot {
                service_name: some("mobux-dev"),
                ..authed_env()
            },
        ));
        assert!(
            renamed.contains("Environment=MOBUX_SERVICE_NAME=mobux-dev"),
            "{renamed}"
        );
    }

    #[test]
    fn an_identical_unit_is_refused_and_a_changed_one_is_an_update() {
        let unit = render_unit(&spec_from(CliOverrides::default(), authed_env()));
        let other = render_unit(&spec_from(
            CliOverrides {
                port: Some(5151),
                ..CliOverrides::default()
            },
            authed_env(),
        ));

        assert_eq!(decide(None, &unit), Decision::Create);
        assert_eq!(decide(Some(&unit), &unit), Decision::Unchanged);
        assert_eq!(decide(Some(&other), &unit), Decision::Update);
    }
}
