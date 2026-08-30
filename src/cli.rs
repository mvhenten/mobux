use std::fmt::Write as _;
use std::path::PathBuf;

use crate::config::{self, FieldKind, FieldSpec, FieldValue, FIELDS};

/// Names the config file rather than a value inside it, so it has no field in
/// the tree and no environment variable beside it.
pub const CONFIG_FLAG: &str = "--config";

/// What the command line states, in the shape the config file states it. The
/// flags are the same surface as the file and the environment, so they land in
/// the same tree.
pub type CliOverrides = config::PartialConfig;

/// Everything a run takes from the command line: the layer the flags state,
/// and the file the lower layers are read from.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RunOptions {
    pub overrides: CliOverrides,
    /// `--config PATH`. `None` reads the config file out of the config
    /// directory, and its absence is not an error.
    pub config_path: Option<PathBuf>,
}

// `install` carries the whole config surface; boxing it to shrink a value that
// is built once at startup would only add indirection.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceCommand {
    Install(RunOptions),
    Uninstall,
    Status,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateCommand {
    /// Report the current and latest version without touching anything.
    Check,
    /// Install the latest version over this binary.
    Apply,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigureCommand {
    /// Walk the prompts and write `config.json`.
    Interactive { force: bool },
    /// Print the JSON schema for `config.json`.
    Schema,
    /// Validate a config file: the named one, or the one in the config dir.
    Check(Option<String>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Parsed {
    Run(RunOptions),
    Service(ServiceCommand),
    Update(UpdateCommand),
    Configure(ConfigureCommand),
    Help,
    Version,
    Invalid(String),
}

/// Parse the argument list, program name already stripped.
///
/// Returns an outcome rather than a `Result` so `--help` and `--version` are
/// ordinary results the caller prints, not errors.
pub fn parse<I: IntoIterator<Item = String>>(args: I) -> Parsed {
    let mut args = args.into_iter().peekable();
    if args.peek().is_some_and(|arg| arg == "service") {
        args.next();
        return parse_service(args);
    }
    if args.peek().is_some_and(|arg| arg == "update") {
        args.next();
        return parse_update(args);
    }
    if args.peek().is_some_and(|arg| arg == "configure") {
        args.next();
        return parse_configure(args);
    }

    match parse_flags(args) {
        Ok(options) => Parsed::Run(options),
        Err(stop) => stop.parsed(),
    }
}

fn parse_service<I: Iterator<Item = String>>(mut args: I) -> Parsed {
    let Some(subcommand) = args.next() else {
        return Parsed::Invalid(
            "service needs a subcommand: install, uninstall or status".to_string(),
        );
    };

    match subcommand.as_str() {
        "--help" | "-h" => Parsed::Help,
        "install" => match parse_flags(args) {
            Ok(options) => Parsed::Service(ServiceCommand::Install(options)),
            Err(stop) => stop.parsed(),
        },
        "uninstall" | "status" => {
            let command = match subcommand.as_str() {
                "uninstall" => ServiceCommand::Uninstall,
                _ => ServiceCommand::Status,
            };
            match args.next() {
                None => Parsed::Service(command),
                Some(extra) if extra == "--help" || extra == "-h" => Parsed::Help,
                Some(extra) => Parsed::Invalid(format!(
                    "service {subcommand} takes no arguments, got {extra:?}"
                )),
            }
        }
        _ => Parsed::Invalid(format!(
            "unknown service subcommand {subcommand:?} — expected install, uninstall or status"
        )),
    }
}

fn parse_update<I: Iterator<Item = String>>(mut args: I) -> Parsed {
    let mut command = UpdateCommand::Apply;
    for arg in args.by_ref() {
        match arg.as_str() {
            "--help" | "-h" => return Parsed::Help,
            "--check" => command = UpdateCommand::Check,
            _ => {
                return Parsed::Invalid(format!(
                    "unknown argument {arg:?} — `mobux update` takes only --check"
                ))
            }
        }
    }
    Parsed::Update(command)
}

/// `configure` does one of three things, so the flag naming it may appear only
/// once. `--force` is not one of them; it qualifies the walkthrough.
fn parse_configure<I: Iterator<Item = String>>(args: I) -> Parsed {
    let mut mode: Option<ConfigureCommand> = None;
    let mut force = false;
    let mut args = args.peekable();

    while let Some(arg) = args.next() {
        let chosen = match arg.as_str() {
            "--help" | "-h" => return Parsed::Help,
            "--force" | "-f" => {
                force = true;
                continue;
            }
            "--interactive" | "-i" => ConfigureCommand::Interactive { force: false },
            "--schema" => ConfigureCommand::Schema,
            "--check" => {
                let path = args.next_if(|next| !next.starts_with('-'));
                ConfigureCommand::Check(path)
            }
            _ => {
                return Parsed::Invalid(format!(
                    "unknown argument {arg:?} — `mobux configure` takes --interactive, --schema, \
                     --check [PATH] or --force"
                ))
            }
        };
        if mode.is_some() {
            return Parsed::Invalid(
                "configure takes one of --interactive, --schema or --check".to_string(),
            );
        }
        mode = Some(chosen);
    }

    match mode.unwrap_or(ConfigureCommand::Interactive { force: false }) {
        ConfigureCommand::Interactive { .. } => {
            Parsed::Configure(ConfigureCommand::Interactive { force })
        }
        other if force => Parsed::Invalid(format!(
            "--force applies to the walkthrough, not to {}",
            match other {
                ConfigureCommand::Schema => "--schema",
                _ => "--check",
            }
        )),
        other => Parsed::Configure(other),
    }
}

/// Why the flag walk ended before it produced overrides.
enum Stop {
    Help,
    Version,
    Invalid(String),
}

impl Stop {
    fn parsed(self) -> Parsed {
        match self {
            Stop::Help => Parsed::Help,
            Stop::Version => Parsed::Version,
            Stop::Invalid(message) => Parsed::Invalid(message),
        }
    }
}

fn parse_flags<I: IntoIterator<Item = String>>(args: I) -> Result<RunOptions, Stop> {
    let mut fields: Vec<(&'static str, FieldValue)> = Vec::new();
    let mut config_path: Option<PathBuf> = None;
    let mut args = args.into_iter().peekable();

    while let Some(arg) = args.next() {
        let (name, inline_value) = match arg.split_once('=') {
            Some((name, value)) => (name.to_string(), Some(value.to_string())),
            None => (arg.clone(), None),
        };

        if name == "--help" || name == "-h" {
            return Err(Stop::Help);
        }
        if name == "--version" || name == "-V" {
            return Err(Stop::Version);
        }

        if name == CONFIG_FLAG {
            let Some(value) = inline_value.or_else(|| args.next()) else {
                return Err(Stop::Invalid(format!("{CONFIG_FLAG} needs a value")));
            };
            let value = value.trim();
            if value.is_empty() {
                return Err(Stop::Invalid(format!("{CONFIG_FLAG} needs a path")));
            }
            config_path = Some(PathBuf::from(value));
            continue;
        }

        let Some((spec, negated)) = option_for(&name) else {
            return Err(Stop::Invalid(format!("unknown argument {arg:?}")));
        };

        if negated {
            if inline_value.is_some() {
                return Err(Stop::Invalid(format!("{name} takes no value")));
            }
            fields.push((spec.key, FieldValue::Toggle(false)));
            continue;
        }

        if spec.kind == FieldKind::Toggle {
            let on = match &inline_value {
                None => true,
                Some(raw) => match toggle_value(raw) {
                    Some(on) => on,
                    None => {
                        return Err(Stop::Invalid(format!(
                            "{name} needs true or false, got {raw:?}"
                        )))
                    }
                },
            };
            fields.push((spec.key, FieldValue::Toggle(on)));
            continue;
        }

        let Some(value) = inline_value.or_else(|| args.next()) else {
            return Err(Stop::Invalid(format!("{name} needs a value")));
        };

        match spec.kind {
            FieldKind::Number => match value.trim().parse::<u16>() {
                Ok(number) => fields.push((spec.key, FieldValue::Number(number))),
                Err(_) => {
                    return Err(Stop::Invalid(format!(
                        "{name} needs a number between 0 and 65535, got {value:?}"
                    )))
                }
            },
            FieldKind::List => {
                fields.push((spec.key, FieldValue::List(config::split_list(&value))))
            }
            _ => fields.push((spec.key, FieldValue::Text(value.trim().to_string()))),
        }
    }

    Ok(RunOptions {
        overrides: config::partial_from_fields(&fields),
        config_path,
    })
}

/// The field a flag names, and whether it was the `--no-` half of a toggle.
fn option_for(name: &str) -> Option<(&'static FieldSpec, bool)> {
    if let Some(spec) = FIELDS.iter().find(|spec| spec.flag == Some(name)) {
        return Some((spec, false));
    }
    let positive = format!("--{}", name.strip_prefix("--no-")?);
    FIELDS
        .iter()
        .find(|spec| spec.flag == Some(positive.as_str()) && spec.kind == FieldKind::Toggle)
        .map(|spec| (spec, true))
}

/// The spellings a toggle accepts, shared with the `configure` prompts so a
/// flag and an answer read the same value the same way.
pub fn toggle_value(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

pub fn help_text(version: &str) -> String {
    let mut out = String::new();
    let _ = write!(
        out,
        "mobux {version} — touch-friendly tmux web UI

Usage: mobux [OPTIONS]
       mobux service <install|uninstall|status> [OPTIONS]
       mobux update [--check]
       mobux configure [--force | --schema | --check [PATH]]

Commands:
  service install     Install and start a systemd --user service that survives
                      a reboot. Takes the same options, writes them to the
                      config file the unit reads, and needs a username and PIN.
  service uninstall   Stop, disable and remove that service
  service status      Show the service's systemd status
  update              Install the latest release over this binary, then restart
                      the systemd --user service when one is installed
  update --check      Report the current and latest version, install nothing
  configure           Ask for every setting and write config.json, refusing to
                      overwrite an existing one without --force
  configure --schema  Print the JSON schema for config.json
  configure --check   Validate a config file and report what is wrong with it

Options:
"
    );

    let mut options: Vec<(String, &str)> = vec![(
        format!("      {CONFIG_FLAG} <PATH>"),
        "Config file to read (default <config dir>/config.json)",
    )];
    options.extend(
        FIELDS
            .iter()
            .filter_map(|spec| Some((option_column(spec.flag?, spec.kind), spec.help))),
    );
    options.push(("  -h, --help".to_string(), "Print this help"));
    options.push(("  -V, --version".to_string(), "Print the version"));
    let width = column_width(options.iter().map(|(left, _)| left.as_str()));
    for (left, help) in &options {
        let _ = writeln!(out, "{left:width$}  {help}");
    }

    let _ = writeln!(out, "\nEnvironment:");
    let width = column_width(FIELDS.iter().map(|spec| spec.env)) + 2;
    for spec in FIELDS {
        let _ = writeln!(out, "  {:width$}{}", spec.env, spec.help, width = width);
    }

    let _ = write!(
        out,
        "
A flag wins over the environment variable next to it, which wins over the
config file. A list flag may be repeated or take a comma-separated value.
Anything on the command line is visible to other users in the process list, so
prefer MOBUX_PIN on a shared host.
"
    );
    out
}

fn option_column(flag: &str, kind: FieldKind) -> String {
    if kind == FieldKind::Toggle {
        return format!("      {flag}, --no-{}", flag.trim_start_matches("--"));
    }
    let placeholder = flag
        .trim_start_matches("--")
        .to_uppercase()
        .replace('-', "_");
    format!("      {flag} <{placeholder}>")
}

fn column_width<'a, I: Iterator<Item = &'a str>>(columns: I) -> usize {
    columns
        .map(|column| column.chars().count())
        .max()
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    fn some(value: &str) -> Option<String> {
        Some(value.to_string())
    }

    fn run(list: &[&str]) -> CliOverrides {
        options(list).overrides
    }

    fn options(list: &[&str]) -> RunOptions {
        match parse(args(list)) {
            Parsed::Run(options) => options,
            other => panic!("expected a run, got {other:?}"),
        }
    }

    fn invalid(list: &[&str]) -> String {
        match parse(args(list)) {
            Parsed::Invalid(message) => message,
            other => panic!("expected a rejection, got {other:?}"),
        }
    }

    #[test]
    fn no_arguments_leaves_every_override_empty() {
        assert_eq!(parse(args(&[])), Parsed::Run(RunOptions::default()));
    }

    #[test]
    fn flags_take_a_separate_or_inline_value() {
        let expected = Parsed::Run(RunOptions {
            overrides: CliOverrides {
                server: Some(config::PartialServerConfig { port: Some(5151) }),
                auth: Some(config::PartialAuthConfig {
                    pin: some("12345"),
                    user: some("dogwalker"),
                    ..Default::default()
                }),
                ..Default::default()
            },
            config_path: None,
        });
        assert_eq!(
            parse(args(&[
                "--port",
                "5151",
                "--pin",
                "12345",
                "--user",
                "dogwalker"
            ])),
            expected
        );
        assert_eq!(
            parse(args(&["--port=5151", "--pin=12345", "--user=dogwalker"])),
            expected
        );
    }

    #[test]
    fn config_names_the_file_without_touching_the_tree() {
        let expected = Some(PathBuf::from("/etc/mobux/config.json"));
        for spelling in [
            vec!["--config", "/etc/mobux/config.json"],
            vec!["--config=/etc/mobux/config.json"],
        ] {
            let parsed = options(&spelling);
            assert_eq!(parsed.config_path, expected);
            assert_eq!(parsed.overrides, CliOverrides::default());
        }
    }

    #[test]
    fn config_without_a_path_is_rejected() {
        assert!(invalid(&["--config"]).contains("--config"));
        assert!(invalid(&["--config", "  "]).contains("--config"));
    }

    #[test]
    fn service_install_names_the_file_its_unit_will_read() {
        assert_eq!(
            parse(args(&["service", "install", "--config", "/etc/mobux.json"])),
            Parsed::Service(ServiceCommand::Install(RunOptions {
                overrides: CliOverrides::default(),
                config_path: Some(PathBuf::from("/etc/mobux.json")),
            }))
        );
    }

    #[test]
    fn help_and_version_short_forms_are_recognised() {
        assert_eq!(parse(args(&["--help"])), Parsed::Help);
        assert_eq!(parse(args(&["-h"])), Parsed::Help);
        assert_eq!(parse(args(&["--version"])), Parsed::Version);
        assert_eq!(parse(args(&["-V"])), Parsed::Version);
    }

    #[test]
    fn unknown_flag_is_rejected() {
        let Parsed::Invalid(message) = parse(args(&["--nope"])) else {
            panic!("unknown flag should not parse");
        };
        assert!(message.contains("--nope"), "{message}");
    }

    #[test]
    fn flag_without_a_value_is_rejected() {
        assert!(matches!(parse(args(&["--port"])), Parsed::Invalid(_)));
        assert!(matches!(parse(args(&["--pin"])), Parsed::Invalid(_)));
    }

    #[test]
    fn non_numeric_port_is_rejected() {
        let Parsed::Invalid(message) = parse(args(&["--port", "https"])) else {
            panic!("a non-numeric port should not parse");
        };
        assert!(message.contains("--port"), "{message}");
    }

    #[test]
    fn service_subcommands_parse() {
        assert_eq!(
            parse(args(&["service", "install"])),
            Parsed::Service(ServiceCommand::Install(RunOptions::default()))
        );
        assert_eq!(
            parse(args(&["service", "uninstall"])),
            Parsed::Service(ServiceCommand::Uninstall)
        );
        assert_eq!(
            parse(args(&["service", "status"])),
            Parsed::Service(ServiceCommand::Status)
        );
    }

    #[test]
    fn service_install_takes_the_run_flags() {
        assert_eq!(
            parse(args(&[
                "service", "install", "--port", "5151", "--user", "walker", "--pin", "99999"
            ])),
            Parsed::Service(ServiceCommand::Install(RunOptions {
                overrides: CliOverrides {
                    server: Some(config::PartialServerConfig { port: Some(5151) }),
                    auth: Some(config::PartialAuthConfig {
                        pin: some("99999"),
                        user: some("walker"),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                config_path: None,
            }))
        );
        assert!(matches!(
            parse(args(&["service", "install", "--nope"])),
            Parsed::Invalid(_)
        ));
        assert!(matches!(
            parse(args(&["service", "install", "--port"])),
            Parsed::Invalid(_)
        ));
    }

    #[test]
    fn unknown_or_missing_service_subcommand_is_rejected() {
        let Parsed::Invalid(message) = parse(args(&["service", "reinstall"])) else {
            panic!("an unknown subcommand should not parse");
        };
        assert!(message.contains("reinstall"), "{message}");
        assert!(matches!(parse(args(&["service"])), Parsed::Invalid(_)));
    }

    #[test]
    fn uninstall_and_status_take_no_flags() {
        assert!(matches!(
            parse(args(&["service", "status", "--port", "5151"])),
            Parsed::Invalid(_)
        ));
        assert_eq!(
            parse(args(&["service", "uninstall", "--help"])),
            Parsed::Help
        );
        assert_eq!(parse(args(&["service", "--help"])), Parsed::Help);
    }

    #[test]
    fn update_parses_bare_and_with_check() {
        assert_eq!(
            parse(args(&["update"])),
            Parsed::Update(UpdateCommand::Apply)
        );
        assert_eq!(
            parse(args(&["update", "--check"])),
            Parsed::Update(UpdateCommand::Check)
        );
        assert_eq!(parse(args(&["update", "--help"])), Parsed::Help);
        assert_eq!(parse(args(&["update", "-h"])), Parsed::Help);
    }

    #[test]
    fn update_rejects_anything_but_check() {
        let Parsed::Invalid(message) = parse(args(&["update", "--force"])) else {
            panic!("an unknown update flag should not parse");
        };
        assert!(message.contains("--force"), "{message}");
        assert!(matches!(
            parse(args(&["update", "--port", "5151"])),
            Parsed::Invalid(_)
        ));
        assert!(matches!(
            parse(args(&["update", "now"])),
            Parsed::Invalid(_)
        ));
    }

    #[test]
    fn configure_defaults_to_the_walkthrough() {
        assert_eq!(
            parse(args(&["configure"])),
            Parsed::Configure(ConfigureCommand::Interactive { force: false })
        );
        assert_eq!(
            parse(args(&["configure", "--interactive"])),
            Parsed::Configure(ConfigureCommand::Interactive { force: false })
        );
        assert_eq!(
            parse(args(&["configure", "--force"])),
            Parsed::Configure(ConfigureCommand::Interactive { force: true })
        );
        assert_eq!(parse(args(&["configure", "--help"])), Parsed::Help);
    }

    #[test]
    fn configure_schema_and_check_parse() {
        assert_eq!(
            parse(args(&["configure", "--schema"])),
            Parsed::Configure(ConfigureCommand::Schema)
        );
        assert_eq!(
            parse(args(&["configure", "--check"])),
            Parsed::Configure(ConfigureCommand::Check(None))
        );
        assert_eq!(
            parse(args(&["configure", "--check", "/etc/mobux.json"])),
            Parsed::Configure(ConfigureCommand::Check(some("/etc/mobux.json")))
        );
    }

    #[test]
    fn configure_takes_one_mode_and_force_only_with_the_walkthrough() {
        assert!(invalid(&["configure", "--schema", "--check"]).contains("one of"));
        assert!(invalid(&["configure", "--schema", "--force"]).contains("--schema"));
        assert!(invalid(&["configure", "--check", "--force"]).contains("--check"));
        assert!(invalid(&["configure", "--pin", "12345"]).contains("--pin"));
    }

    #[test]
    fn help_lists_the_flags_and_the_main_env_vars() {
        let help = help_text("1.2.3");
        for expected in [
            "service install",
            "service uninstall",
            "service status",
            "update",
            "update --check",
            "configure",
            "configure --schema",
            "configure --check",
            "--config",
            "--port",
            "--pin",
            "--user",
            "--help",
            "--version",
            "MOBUX_PORT",
            "MOBUX_AUTH_USER",
            "MOBUX_PIN",
            "MOBUX_TLS",
            "MOBUX_DOMAIN",
            "1.2.3",
        ] {
            assert!(help.contains(expected), "help is missing {expected}");
        }
    }

    #[test]
    fn every_schema_field_has_a_flag_the_parser_accepts() {
        for spec in FIELDS {
            let flag = spec
                .flag
                .unwrap_or_else(|| panic!("{} has no flag", spec.key));
            let overrides = match spec.kind {
                FieldKind::Toggle => run(&[flag]),
                FieldKind::Number => run(&[flag, "8443"]),
                _ => run(&[flag, "sample.example"]),
            };
            assert_ne!(
                overrides,
                CliOverrides::default(),
                "{flag} set nothing on the tree"
            );
        }
    }

    #[test]
    fn every_toggle_has_a_no_form_that_turns_it_off() {
        let toggles = FIELDS.iter().filter(|spec| spec.kind == FieldKind::Toggle);
        for spec in toggles {
            let flag = spec.flag.expect("a toggle has a flag");
            let negated = format!("--no-{}", flag.trim_start_matches("--"));
            assert_ne!(run(&[flag]), run(&[&negated]), "{flag} and {negated} agree");
            assert_eq!(run(&[flag]), run(&[&format!("{flag}=true")]));
            assert_eq!(run(&[&negated]), run(&[&format!("{flag}=0")]));
        }
    }

    #[test]
    fn the_tls_flags_land_in_the_tls_section() {
        let tls = run(&[
            "--no-tls",
            "--tls-host",
            "a.example",
            "--cert-file",
            "/etc/cert.pem",
            "--key-file",
            "/etc/key.pem",
            "--acme-domain",
            "b.example,c.example",
            "--acme-email",
            "me@example.com",
            "--acme-directory",
            "https://acme.example/dir",
            "--acme-http-port",
            "8081",
        ])
        .tls
        .expect("a tls section");

        assert_eq!(tls.enabled, Some(false));
        assert_eq!(tls.hosts, Some(vec!["a.example".to_string()]));
        assert_eq!(tls.cert_file.as_deref(), Some("/etc/cert.pem"));
        assert_eq!(tls.key_file.as_deref(), Some("/etc/key.pem"));
        assert_eq!(
            tls.acme_domains,
            Some(vec!["b.example".to_string(), "c.example".to_string()])
        );
        assert_eq!(tls.acme_email.as_deref(), Some("me@example.com"));
        assert_eq!(
            tls.acme_directory.as_deref(),
            Some("https://acme.example/dir")
        );
        assert_eq!(tls.acme_http_port, Some(8081));
    }

    #[test]
    fn a_repeated_list_flag_accumulates() {
        let hosts = run(&["--tls-host", "a.example", "--tls-host=b.example"])
            .tls
            .and_then(|tls| tls.hosts);
        assert_eq!(
            hosts,
            Some(vec!["a.example".to_string(), "b.example".to_string()])
        );
    }

    #[test]
    fn the_remaining_flags_land_in_their_own_sections() {
        let overrides = run(&[
            "--pass",
            "secret",
            "--data-dir",
            "/srv/mobux",
            "--shell",
            "/bin/zsh",
            "--domain",
            "mobux.example:5151",
            "--dev",
            "--service-name",
            "mobux-dev",
            "--vapid-contact",
            "mailto:me@example.com",
            "--update-check-url",
            "https://index.example/mobux",
        ]);

        assert_eq!(
            overrides.auth.and_then(|auth| auth.pass).as_deref(),
            Some("secret")
        );
        assert_eq!(
            overrides.paths.and_then(|paths| paths.data_dir).as_deref(),
            Some("/srv/mobux")
        );
        assert_eq!(
            overrides
                .session
                .and_then(|session| session.shell)
                .as_deref(),
            Some("/bin/zsh")
        );
        assert_eq!(
            overrides
                .push
                .and_then(|push| push.vapid_contact)
                .as_deref(),
            Some("mailto:me@example.com")
        );
        assert_eq!(
            overrides
                .update
                .and_then(|update| update.check_url)
                .as_deref(),
            Some("https://index.example/mobux")
        );

        let app = overrides.app.expect("an app section");
        assert_eq!(app.domain.as_deref(), Some("mobux.example:5151"));
        assert_eq!(app.dev, Some(true));
        assert_eq!(app.service_name.as_deref(), Some("mobux-dev"));
    }

    #[test]
    fn the_flags_merge_onto_the_config_tree() {
        let config = config::Config::default().merged(run(&[
            "--port",
            "5151",
            "--no-tls",
            "--data-dir",
            "/srv/mobux",
        ]));
        assert_eq!(config.server.port, 5151);
        assert!(!config.tls.enabled);
        assert_eq!(config.paths.data_dir, "/srv/mobux");
        assert_eq!(config.app.service_name, "mobux");
    }

    /// HTTPS is off by default, so `--tls` has to turn it on.
    #[test]
    fn the_tls_flag_turns_https_on_over_the_default() {
        assert!(!config::Config::default().tls.enabled);
        assert!(
            config::Config::default()
                .merged(run(&["--tls"]))
                .tls
                .enabled
        );
    }

    #[test]
    fn a_toggle_rejects_a_value_it_cannot_read() {
        assert!(invalid(&["--tls=maybe"]).contains("--tls"), "message");
        assert!(invalid(&["--no-tls=1"]).contains("takes no value"));
    }

    #[test]
    fn every_new_flag_is_rejected_without_a_value() {
        let valued = FIELDS
            .iter()
            .filter(|spec| !matches!(spec.kind, FieldKind::Toggle));
        for spec in valued {
            let flag = spec.flag.expect("a flag");
            assert!(
                invalid(&[flag]).contains(flag),
                "{flag} was accepted without a value"
            );
        }
    }

    #[test]
    fn service_install_takes_the_whole_option_surface() {
        assert_eq!(
            parse(args(&["service", "install", "--data-dir", "/srv/mobux"])),
            Parsed::Service(ServiceCommand::Install(options(&[
                "--data-dir",
                "/srv/mobux"
            ])))
        );
    }

    #[test]
    fn help_lists_every_flag_and_environment_variable() {
        let help = help_text("1.2.3");
        for spec in FIELDS {
            assert!(
                help.contains(spec.flag.expect("a flag")),
                "help is missing the flag for {}",
                spec.key
            );
            assert!(help.contains(spec.env), "help is missing {}", spec.env);
        }
        assert!(help.contains("--no-tls"), "help is missing --no-tls");
    }
}
