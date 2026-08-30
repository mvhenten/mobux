use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::cli::{RunOptions, CONFIG_FLAG};
use crate::config::{self, Config};
use crate::configure;

pub const DEFAULT_UNIT: &str = "mobux";

/// Everything the unit file needs. The settings themselves live in the config
/// file the unit names, so no credential reaches systemd.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitSpec {
    pub unit: String,
    pub exec_start: String,
    pub config_path: String,
    pub port: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Create,
    Update,
    Unchanged,
}

/// The unit name the self-updater will restart: the config file and
/// `MOBUX_SERVICE_NAME` state it, `mobux` is the default — the same answer
/// `update::resolve_service_name` reaches.
pub fn unit_name(service_name: Option<String>) -> String {
    service_name
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_UNIT.to_string())
}

/// Resolve the unit from the settings it will run on, the running binary and
/// the config file the unit will name.
///
/// A boot service is reachable from the network the moment it starts, so an
/// auth-less unit is refused rather than written.
pub fn resolve_unit_spec(
    settings: &Config,
    exec_start: &Path,
    config_path: &Path,
) -> Result<UnitSpec, String> {
    config::check(settings)?;
    if settings.credentials().is_none() {
        return Err(
            "a boot service needs a username and PIN — nothing else stops the network \
                    from reaching it. Pass --user and --pin, or export MOBUX_AUTH_USER and \
                    MOBUX_PIN before running `mobux service install`."
                .to_string(),
        );
    }

    let spec = UnitSpec {
        unit: unit_name(Some(settings.app.service_name.clone())),
        exec_start: exec_start.to_string_lossy().into_owned(),
        config_path: config_path.to_string_lossy().into_owned(),
        port: settings.server.port,
    };

    check_unit_value("the binary path", &spec.exec_start)?;
    check_unit_value("the config file path", &spec.config_path)?;
    check_unit_value("app.service_name", &spec.unit)?;
    Ok(spec)
}

/// systemd splits an unquoted value on whitespace and eats quotes and
/// backslashes, so a path or a unit name carrying any of those would reach the
/// server mangled. Refuse it here instead of writing a unit that never starts.
fn check_unit_value(label: &str, value: &str) -> Result<(), String> {
    let offender = value
        .chars()
        .find(|c| c.is_whitespace() || c.is_control() || matches!(c, '"' | '\'' | '\\' | '$'));
    match offender {
        None => Ok(()),
        Some(c) => Err(format!(
            "{label} contains {c:?}; a systemd unit can't carry whitespace, quotes, \
             backslashes or $ in a value. Use a plainer value."
        )),
    }
}

/// The unit file, mirroring the manual recipe in DEPLOY.md. Every setting is
/// read from the config file the unit names, so the PIN never lands here.
pub fn render_unit(spec: &UnitSpec) -> String {
    let UnitSpec {
        unit,
        exec_start,
        config_path,
        port,
    } = spec;
    let mut out = String::new();
    let _ = write!(
        out,
        "[Unit]
Description=mobux — mobile tmux web frontend (:{port})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart={exec_start} {CONFIG_FLAG} {config_path}
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
        crate::cli::ServiceCommand::Install(options) => report(install(options)),
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

fn install(options: &RunOptions) -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("could not resolve this binary's own path: {e}"))?;
    let config_path = options
        .config_path
        .clone()
        .unwrap_or_else(config::config_file_path);
    let settings = resolve_settings(&config_path, options)?;
    // Resolve before the systemd probe so a missing PIN is reported as such
    // even on a host where the user bus is out of reach.
    let spec = resolve_unit_spec(&settings, &exe, &config_path)?;
    preflight()?;

    let unit_file = unit_path(&config_dir()?, &spec.unit);
    let desired = render_unit(&spec);
    let unit_change = decide(read(&unit_file).as_deref(), &desired);
    let config_change = decide(
        read(&config_path).as_deref(),
        &configure::document(&settings),
    );

    if unit_change == Decision::Unchanged && config_change == Decision::Unchanged {
        return Err(format!(
            "{} and {} already describe this exact service — nothing to do. Pass \
             --port/--user/--pin to change it, or `mobux service uninstall` to remove it.",
            config_path.display(),
            unit_file.display()
        ));
    }

    if config_change != Decision::Unchanged {
        configure::write_file(&config_path, &settings, true)
            .map_err(|e| format!("writing {}: {e}", config_path.display()))?;
        println!(
            "{} {} (mode 600)",
            verb(config_change),
            config_path.display()
        );
    }
    if unit_change != Decision::Unchanged {
        write_unit(&unit_file, &desired)?;
        println!("{} {} (mode 600)", verb(unit_change), unit_file.display());
    }

    systemctl(&["daemon-reload"])?;
    // The settings moved into the config file, so an unchanged unit still has
    // to be restarted to pick them up.
    systemctl(&["enable", &spec.unit])?;
    systemctl(&["restart", &spec.unit])?;
    enable_linger();

    println!(
        "mobux listens on {}://<this-host>:{} as user {:?}",
        if settings.tls.enabled {
            "https"
        } else {
            "http"
        },
        spec.port,
        settings.auth.user
    );
    if !settings.tls.enabled {
        println!("rerun `mobux service install --tls` to serve HTTPS instead");
    }
    println!(
        "check it with: systemctl --user status {} --no-pager",
        spec.unit
    );
    Ok(())
}

fn read(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// The settings the unit will run on, layered the way a run layers them: the
/// config file, then the environment, then the flags. `install` writes the
/// result back, so a file that is not there yet is the defaults.
fn resolve_settings(path: &Path, options: &RunOptions) -> Result<Config, String> {
    let file = config::load_partial_from(path)
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    Ok(config::resolve(
        Config::default(),
        file,
        &config::EnvSnapshot::from_env(),
        options.overrides.clone(),
    ))
}

/// The unit `uninstall` and `status` act on: the one the config file and the
/// environment name between them.
fn installed_unit() -> String {
    let path = config::config_file_path();
    let file = config::load_partial_from(&path)
        .ok()
        .flatten()
        .unwrap_or_default();
    let settings = config::resolve(
        Config::default(),
        file,
        &config::EnvSnapshot::from_env(),
        config::PartialConfig::default(),
    );
    unit_name(Some(settings.app.service_name))
}

fn verb(decision: Decision) -> &'static str {
    match decision {
        Decision::Update => "updated",
        _ => "wrote",
    }
}

fn uninstall() -> Result<(), String> {
    preflight()?;
    let unit = installed_unit();
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
    let unit = installed_unit();
    let status = Command::new("systemctl")
        .args(["--user", "status", &unit, "--no-pager"])
        .status()
        .map_err(|e| format!("running systemctl: {e}"))?;
    Ok(status.code().unwrap_or(1))
}

pub fn config_dir() -> Result<PathBuf, String> {
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
    // `mode` only applies to a file this call created, and a rewrite lands on
    // one it did not.
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
    use crate::cli::CliOverrides;
    use std::os::unix::fs::PermissionsExt as _;

    const EXE: &str = "/home/me/.local/bin/mobux";
    const CONFIG: &str = "/home/me/.config/mobux/config.json";

    /// The unit mobux wrote before the config file existed. It is still on
    /// disk on every host installed by an older release.
    const OLD_STYLE_UNIT: &str = "\
[Unit]
Description=mobux — mobile tmux web frontend (HTTPS on :5151)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/home/me/.local/bin/mobux
Environment=MOBUX_PORT=5151
Environment=MOBUX_AUTH_USER=walker
Environment=MOBUX_PIN=99999
Environment=PATH=%h/.cargo/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=5
KillMode=process

[Install]
WantedBy=default.target
";

    fn overrides(port: Option<u16>, user: Option<&str>, pin: Option<&str>) -> CliOverrides {
        CliOverrides {
            server: port.map(|port| config::PartialServerConfig {
                port: Some(port),
                ..Default::default()
            }),
            auth: (user.is_some() || pin.is_some()).then(|| config::PartialAuthConfig {
                user: user.map(str::to_string),
                pin: pin.map(str::to_string),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    /// The settings `install` would resolve from those flags alone.
    fn settings(overrides: CliOverrides) -> Config {
        config::resolve(
            Config::default(),
            config::PartialConfig::default(),
            &config::EnvSnapshot::default(),
            overrides,
        )
    }

    fn authed() -> Config {
        settings(overrides(None, Some("me"), Some("12345")))
    }

    fn spec_from(settings: &Config) -> UnitSpec {
        resolve_unit_spec(settings, Path::new(EXE), Path::new(CONFIG)).expect("spec should resolve")
    }

    /// The environment a unit's `Environment=` lines put in front of mobux.
    fn unit_environment(unit: &str) -> config::EnvSnapshot {
        config::EnvSnapshot::new(
            unit.lines()
                .filter_map(|line| line.strip_prefix("Environment=")?.split_once('=')),
        )
    }

    #[test]
    fn the_unit_names_the_config_file_and_carries_no_credentials() {
        let unit = render_unit(&spec_from(&settings(overrides(
            Some(5151),
            Some("walker"),
            Some("99999"),
        ))));

        assert!(
            unit.contains(&format!("ExecStart={EXE} --config {CONFIG}")),
            "{unit}"
        );
        assert!(!unit.contains("MOBUX_PIN"), "{unit}");
        assert!(!unit.contains("MOBUX_AUTH_USER"), "{unit}");
        assert!(!unit.contains("MOBUX_PORT"), "{unit}");
        assert!(!unit.contains("99999"), "the PIN reached the unit: {unit}");
        assert!(unit.contains("Description=mobux"), "{unit}");
        assert!(unit.contains("Restart=on-failure"), "{unit}");
        assert!(unit.contains("WantedBy=default.target"), "{unit}");
        assert!(unit.contains("KillMode=process"), "{unit}");
    }

    #[test]
    fn unit_path_extends_the_default_path_with_cargo_bin() {
        let unit = render_unit(&spec_from(&authed()));
        assert!(
            unit.contains("Environment=PATH=%h/.cargo/bin:"),
            "the self-updater shells out to cargo: {unit}"
        );
    }

    #[test]
    fn no_unit_without_auth() {
        let error = resolve_unit_spec(
            &settings(overrides(None, Some("me"), None)),
            Path::new(EXE),
            Path::new(CONFIG),
        )
        .expect_err("an auth-less boot service must be refused");
        assert!(error.contains("--pin"), "{error}");
    }

    #[test]
    fn a_pin_that_systemd_would_mangle_is_refused() {
        for pin in ["hunter 2", "hunter\"2", "hunter$2", "hunter\\2"] {
            let error = resolve_unit_spec(
                &settings(overrides(None, Some("me"), Some(pin))),
                Path::new(EXE),
                Path::new(CONFIG),
            )
            .expect_err("a PIN systemd would mangle must be refused");
            assert!(error.contains("auth.pin"), "{error}");
        }
    }

    #[test]
    fn a_config_path_the_unit_cannot_carry_is_refused() {
        let error = resolve_unit_spec(
            &authed(),
            Path::new(EXE),
            Path::new("/home/my configs/config.json"),
        )
        .expect_err("a path systemd would split must be refused");
        assert!(error.contains("config file path"), "{error}");
    }

    #[test]
    fn the_default_unit_is_the_one_the_self_updater_restarts() {
        assert_eq!(unit_name(None), "mobux");
        assert_eq!(unit_name(Some("  ".to_string())), "mobux");
        assert_eq!(unit_name(Some("mobux-dev".to_string())), "mobux-dev");
        assert_eq!(
            unit_path(Path::new("/home/me/.config"), "mobux"),
            Path::new("/home/me/.config/systemd/user/mobux.service")
        );
    }

    #[test]
    fn a_renamed_unit_tells_the_self_updater_its_own_name() {
        let default = render_unit(&spec_from(&authed()));
        assert!(!default.contains("MOBUX_SERVICE_NAME"), "{default}");

        let mut renamed = authed();
        renamed.app.service_name = "mobux-dev".to_string();
        let unit = render_unit(&spec_from(&renamed));
        assert!(
            unit.contains("Environment=MOBUX_SERVICE_NAME=mobux-dev"),
            "{unit}"
        );
    }

    #[test]
    fn an_identical_unit_is_refused_and_an_old_style_one_is_an_update() {
        let unit = render_unit(&spec_from(&authed()));

        assert_eq!(decide(None, &unit), Decision::Create);
        assert_eq!(decide(Some(&unit), &unit), Decision::Unchanged);
        assert_eq!(decide(Some(OLD_STYLE_UNIT), &unit), Decision::Update);
    }

    /// The security win only holds if an upgrade does not strand the hosts
    /// running the old unit: its `Environment=` lines still answer, so it
    /// resolves to exactly what the new install would write.
    #[test]
    fn an_old_style_unit_resolves_to_the_settings_it_always_did() {
        let resolved = config::resolve(
            Config::default(),
            config::PartialConfig::default(),
            &unit_environment(OLD_STYLE_UNIT),
            config::PartialConfig::default(),
        );

        assert_eq!(
            resolved,
            settings(overrides(Some(5151), Some("walker"), Some("99999")))
        );
        assert_eq!(resolved.server.port, 5151);
        assert_eq!(
            resolved.credentials(),
            Some(config::Credentials {
                user: "walker".to_string(),
                pass: "99999".to_string(),
            })
        );
    }

    #[test]
    fn the_config_the_unit_names_is_readable_by_its_owner_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(config::CONFIG_FILE_NAME);
        let settings = settings(overrides(Some(5151), Some("walker"), Some("99999")));

        configure::write_file(&path, &settings, true).expect("install writes the config");

        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "mode was {:o}", mode & 0o777);
        assert_eq!(config::load_from(&path).expect("it reads back"), settings);
    }
}
