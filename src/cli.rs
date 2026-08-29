use std::fmt::Write as _;

pub const DEFAULT_PORT: u16 = 8080;
pub const DEFAULT_USER: &str = "mobux";

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CliOverrides {
    pub port: Option<u16>,
    pub pin: Option<String>,
    pub user: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Parsed {
    Run(CliOverrides),
    Help,
    Version,
    Invalid(String),
}

/// Parse the argument list, program name already stripped.
///
/// Returns an outcome rather than a `Result` so `--help` and `--version` are
/// ordinary results the caller prints, not errors.
pub fn parse<I: IntoIterator<Item = String>>(args: I) -> Parsed {
    let mut overrides = CliOverrides::default();
    let mut args = args.into_iter().peekable();

    while let Some(arg) = args.next() {
        let (name, inline_value) = match arg.split_once('=') {
            Some((name, value)) => (name.to_string(), Some(value.to_string())),
            None => (arg.clone(), None),
        };

        match name.as_str() {
            "--help" | "-h" => return Parsed::Help,
            "--version" | "-V" => return Parsed::Version,
            "--port" | "--pin" | "--user" => {
                let value = match inline_value.or_else(|| args.next()) {
                    Some(value) => value,
                    None => return Parsed::Invalid(format!("{name} needs a value")),
                };
                match name.as_str() {
                    "--port" => match value.trim().parse::<u16>() {
                        Ok(port) => overrides.port = Some(port),
                        Err(_) => {
                            return Parsed::Invalid(format!(
                                "--port needs a number between 0 and 65535, got {value:?}"
                            ))
                        }
                    },
                    "--pin" => overrides.pin = Some(value.trim().to_string()),
                    _ => overrides.user = Some(value.trim().to_string()),
                }
            }
            _ => return Parsed::Invalid(format!("unknown argument {arg:?}")),
        }
    }

    Parsed::Run(overrides)
}

pub fn help_text(version: &str) -> String {
    let mut out = String::new();
    let _ = write!(
        out,
        "mobux {version} — touch-friendly tmux web UI

Usage: mobux [OPTIONS]

Options:
      --port <PORT>   Port to listen on (default {DEFAULT_PORT})
      --pin <PIN>     PIN to unlock the web UI
      --user <USER>   Username to unlock the web UI (default {DEFAULT_USER})
  -h, --help          Print this help
  -V, --version       Print the version

Environment:
  MOBUX_PORT          Port to listen on (default {DEFAULT_PORT})
  MOBUX_AUTH_USER     Username to unlock the web UI
  MOBUX_PIN           PIN to unlock the web UI
  MOBUX_TLS           HTTPS with a generated cert, on unless 0 or false
  MOBUX_DOMAIN        Public host:port the Android app is pinned to

A flag wins over the environment variable next to it. Anything on the command
line is visible to other users in the process list, so prefer MOBUX_PIN on a
shared host.
"
    );
    out
}

/// `--port` wins over `MOBUX_PORT`, which wins over the deprecated bare `PORT`.
/// An unparseable value falls through to the next source, matching the
/// long-standing behavior of the `PORT` lookup.
pub fn resolve_port(flag: Option<u16>, mobux_port: Option<String>, port: Option<String>) -> u16 {
    flag.or_else(|| parse_port(mobux_port))
        .or_else(|| parse_port(port))
        .unwrap_or(DEFAULT_PORT)
}

/// True when the port in use came from the deprecated bare `PORT` var, so the
/// caller can warn once at startup.
pub fn port_is_deprecated_source(
    flag: Option<u16>,
    mobux_port: Option<String>,
    port: Option<String>,
) -> bool {
    flag.is_none() && parse_port(mobux_port).is_none() && parse_port(port).is_some()
}

fn parse_port(value: Option<String>) -> Option<u16> {
    value.and_then(|v| v.trim().parse::<u16>().ok())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credentials {
    pub user: String,
    pub pass: String,
}

/// Resolve the credentials that unlock the web UI, or `None` when auth is off.
///
/// `--user`/`--pin` win over `MOBUX_AUTH_USER`/`MOBUX_PIN`. A PIN given on the
/// command line also wins over `MOBUX_AUTH_PASS`; otherwise the existing rule
/// holds — a user/password pair beats a PIN.
pub fn resolve_credentials(
    flag_user: Option<String>,
    flag_pin: Option<String>,
    env_user: Option<String>,
    env_pass: Option<String>,
    env_pin: Option<String>,
) -> Option<Credentials> {
    let flag_pin = flag_pin.filter(|v| !v.is_empty());
    let user = flag_user
        .filter(|v| !v.is_empty())
        .or(env_user)
        .filter(|v| !v.is_empty());
    let pass = env_pass.filter(|v| !v.is_empty() && flag_pin.is_none());
    let pin = flag_pin.or(env_pin).filter(|v| !v.is_empty());

    if let (Some(user), Some(pass)) = (user.clone(), pass) {
        return Some(Credentials { user, pass });
    }

    pin.map(|pin| Credentials {
        user: user.unwrap_or_else(|| DEFAULT_USER.to_string()),
        pass: pin,
    })
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

    #[test]
    fn no_arguments_leaves_every_override_empty() {
        assert_eq!(parse(args(&[])), Parsed::Run(CliOverrides::default()));
    }

    #[test]
    fn flags_take_a_separate_or_inline_value() {
        let expected = Parsed::Run(CliOverrides {
            port: Some(5151),
            pin: some("12345"),
            user: some("dogwalker"),
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
    fn help_lists_the_flags_and_the_main_env_vars() {
        let help = help_text("1.2.3");
        for expected in [
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
    fn port_falls_back_to_the_default() {
        assert_eq!(resolve_port(None, None, None), 8080);
    }

    #[test]
    fn port_flag_beats_both_env_vars() {
        assert_eq!(resolve_port(Some(5151), some("5152"), some("5153")), 5151);
    }

    #[test]
    fn mobux_port_beats_the_deprecated_port() {
        assert_eq!(resolve_port(None, some("5152"), some("5153")), 5152);
        assert!(!port_is_deprecated_source(None, some("5152"), some("5153")));
    }

    #[test]
    fn deprecated_port_alone_still_works_and_is_flagged() {
        assert_eq!(resolve_port(None, None, some("5153")), 5153);
        assert!(port_is_deprecated_source(None, None, some("5153")));
    }

    #[test]
    fn unparseable_port_values_fall_through() {
        assert_eq!(resolve_port(None, some("http"), some("5153")), 5153);
        assert_eq!(resolve_port(None, some("http"), None), 8080);
        assert!(!port_is_deprecated_source(Some(5151), None, some("5153")));
    }

    #[test]
    fn credentials_are_absent_without_a_pin_or_password() {
        assert_eq!(
            resolve_credentials(None, None, some("me"), None, None),
            None
        );
        assert_eq!(resolve_credentials(None, None, None, None, None), None);
    }

    #[test]
    fn env_pin_still_works_on_its_own() {
        assert_eq!(
            resolve_credentials(None, None, None, None, some("12345")),
            Some(Credentials {
                user: "mobux".to_string(),
                pass: "12345".to_string(),
            })
        );
        assert_eq!(
            resolve_credentials(None, None, some("me"), None, some("12345")),
            Some(Credentials {
                user: "me".to_string(),
                pass: "12345".to_string(),
            })
        );
    }

    #[test]
    fn env_user_and_password_still_work() {
        assert_eq!(
            resolve_credentials(None, None, some("me"), some("secret"), None),
            Some(Credentials {
                user: "me".to_string(),
                pass: "secret".to_string(),
            })
        );
    }

    #[test]
    fn pin_and_user_flags_beat_their_env_vars() {
        assert_eq!(
            resolve_credentials(
                some("walker"),
                some("99999"),
                some("me"),
                None,
                some("12345")
            ),
            Some(Credentials {
                user: "walker".to_string(),
                pass: "99999".to_string(),
            })
        );
    }

    #[test]
    fn pin_flag_beats_an_env_password() {
        assert_eq!(
            resolve_credentials(None, some("99999"), some("me"), some("secret"), None),
            Some(Credentials {
                user: "me".to_string(),
                pass: "99999".to_string(),
            })
        );
    }

    #[test]
    fn empty_values_are_ignored() {
        assert_eq!(
            resolve_credentials(
                Some(String::new()),
                None,
                some("me"),
                Some(String::new()),
                some("12345")
            ),
            Some(Credentials {
                user: "me".to_string(),
                pass: "12345".to_string(),
            })
        );
    }
}
