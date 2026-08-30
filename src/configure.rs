//! `mobux configure` — write a validated `config.json`.
//!
//! The walkthrough is a plain read-a-line loop over the schema's field list, so
//! it works down a pipe, over ssh and inside a test. There is no TUI and no raw
//! mode: the PIN is read like any other answer and the prompt says so.
//!
//! The driver is pure over `BufRead` and `Write`. Everything that touches the
//! real terminal, the real config directory or the process exit code lives in
//! `run` at the bottom.

use std::fmt;
use std::io::{BufRead, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use crate::cli::{self, ConfigureCommand};
use crate::config::{self, Config, FieldKind, FieldSpec, FieldValue, FIELDS};

/// Fields whose current value is never echoed back.
const SECRETS: &[&str] = &["auth.pass", "auth.pin"];

/// The answer that empties a field that has a value.
const CLEAR: &str = "-";

#[derive(Debug)]
pub enum ConfigureError {
    Io(std::io::Error),
    /// The input ran out mid-walkthrough, so no answer set was ever completed.
    InputEnded,
    /// The assembled tree breaks a rule no single answer could fix.
    Invalid(String),
    /// The file is already there and `--force` was not given.
    Exists(PathBuf),
}

impl fmt::Display for ConfigureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigureError::Io(err) => write!(f, "{err}"),
            ConfigureError::InputEnded => {
                write!(f, "input ended before every setting was answered")
            }
            ConfigureError::Invalid(message) => write!(f, "{message}"),
            ConfigureError::Exists(path) => write!(
                f,
                "{} already exists — pass --force to overwrite it",
                path.display()
            ),
        }
    }
}

impl std::error::Error for ConfigureError {}

impl From<std::io::Error> for ConfigureError {
    fn from(err: std::io::Error) -> Self {
        ConfigureError::Io(err)
    }
}

// ---------------------------------------------------------------------------
// The walkthrough
// ---------------------------------------------------------------------------

/// Ask for every field in turn, starting from `start`, and return the tree the
/// answers make. An answer that breaks its own rule is reported and asked
/// again; a tree that only breaks a cross-field rule sends the walk round once
/// more, and stops if that pass changes nothing.
pub fn walk<R: BufRead, W: Write>(
    input: &mut R,
    output: &mut W,
    start: Config,
) -> Result<Config, ConfigureError> {
    preamble(output)?;
    let mut config = start;
    let mut previous: Option<Config> = None;

    loop {
        for spec in FIELDS {
            config = ask(input, output, config, spec)?;
        }
        let Err(message) = config::check(&config) else {
            return Ok(config);
        };
        if previous.as_ref() == Some(&config) {
            return Err(ConfigureError::Invalid(message));
        }
        writeln!(output, "\n{message}")?;
        writeln!(output, "Going round again so that answer can change.\n")?;
        previous = Some(config.clone());
    }
}

fn preamble<W: Write>(output: &mut W) -> Result<(), ConfigureError> {
    writeln!(
        output,
        "Answer each setting, or press Enter to keep the value in brackets.\n\
         Answer {CLEAR} to empty a setting that has one."
    )?;
    Ok(())
}

fn ask<R: BufRead, W: Write>(
    input: &mut R,
    output: &mut W,
    config: Config,
    spec: &FieldSpec,
) -> Result<Config, ConfigureError> {
    loop {
        writeln!(output, "\n{}", spec.help)?;
        if SECRETS.contains(&spec.key) {
            writeln!(
                output,
                "  typed in the clear — this prompt hides nothing and clears nothing"
            )?;
        }
        write!(
            output,
            "{} [{}]: ",
            spec.key,
            shown(config_value(&config, spec), spec)
        )?;
        output.flush()?;

        let Some(line) = read_line(input)? else {
            return Err(ConfigureError::InputEnded);
        };
        let answer = line.trim();
        if answer.is_empty() {
            return Ok(config);
        }

        let value = match parse_answer(spec, answer) {
            Ok(value) => value,
            Err(message) => {
                writeln!(output, "  {message}")?;
                continue;
            }
        };

        let candidate = config
            .clone()
            .merged(config::partial_from_fields(&[(spec.key, value)]));
        match config::check_fields(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(message) => writeln!(output, "  {message}")?,
        }
    }
}

fn read_line<R: BufRead>(input: &mut R) -> Result<Option<String>, ConfigureError> {
    let mut line = String::new();
    if input.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    Ok(Some(line))
}

/// What one field currently holds. Read back out of the serialized tree so the
/// field list stays the only place a key is spelled.
fn config_value(config: &Config, spec: &FieldSpec) -> FieldValue {
    let document = serde_json::to_value(config).expect("the config serializes");
    let (section, leaf) = spec.key.split_once('.').expect("a dotted field key");
    let node = &document[section][leaf];
    match spec.kind {
        FieldKind::Number => FieldValue::Number(node.as_u64().unwrap_or_default() as u16),
        FieldKind::Toggle => FieldValue::Toggle(node.as_bool().unwrap_or_default()),
        FieldKind::List => FieldValue::List(
            node.as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
        ),
        FieldKind::Text => FieldValue::Text(node.as_str().unwrap_or_default().to_string()),
    }
}

/// The bracketed value. A secret is reported as set or unset, never echoed.
fn shown(value: FieldValue, spec: &FieldSpec) -> String {
    let text = match &value {
        FieldValue::Number(number) => number.to_string(),
        FieldValue::Text(text) => text.clone(),
        FieldValue::Toggle(on) => on.to_string(),
        FieldValue::List(items) => items.join(","),
    };
    if SECRETS.contains(&spec.key) && !text.is_empty() {
        return "set".to_string();
    }
    text
}

fn parse_answer(spec: &FieldSpec, answer: &str) -> Result<FieldValue, String> {
    let cleared = answer == CLEAR;
    match spec.kind {
        FieldKind::Number => {
            if cleared {
                return Err("this setting always holds a number; it cannot be emptied".to_string());
            }
            answer
                .parse::<u16>()
                .map(FieldValue::Number)
                .map_err(|_| format!("needs a number between 0 and 65535, got {answer:?}"))
        }
        FieldKind::Toggle => {
            if cleared {
                return Err("this setting is on or off; it cannot be emptied".to_string());
            }
            cli::toggle_value(answer)
                .map(FieldValue::Toggle)
                .ok_or_else(|| format!("needs yes or no, got {answer:?}"))
        }
        FieldKind::List => Ok(FieldValue::List(if cleared {
            Vec::new()
        } else {
            config::split_list(answer)
        })),
        FieldKind::Text => Ok(FieldValue::Text(if cleared {
            String::new()
        } else {
            answer.to_string()
        })),
    }
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/// The document written to disk: every setting spelled out, so the file reads
/// as the whole surface rather than the handful the walk changed.
pub fn document(config: &Config) -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(config).expect("the config serializes")
    )
}

/// Write the config at mode 600, creating the directory around it. The mode is
/// set again after the write because `mode` only applies to a file this call
/// created, and `--force` writes over one it did not.
pub fn write_file(path: &Path, config: &Config, force: bool) -> Result<(), ConfigureError> {
    if !force && path.exists() {
        return Err(ConfigureError::Exists(path.to_path_buf()));
    }
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(document(config).as_bytes())?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

/// What `--check` reports. A named file that is not there is a mistake worth
/// reporting; the default file not being there is how mobux usually runs.
pub fn check_report(path: &Path, named: bool) -> Result<String, String> {
    if !path.exists() {
        if named {
            return Err(format!("{}: no such file", path.display()));
        }
        return Ok(format!(
            "no config file at {} — mobux runs on the defaults",
            path.display()
        ));
    }
    match config::load_from(path) {
        Ok(_) => Ok(format!("{}: ok", path.display())),
        Err(error) => Err(error.to_string()),
    }
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

pub fn run(command: &ConfigureCommand) -> i32 {
    match command {
        ConfigureCommand::Schema => {
            print!("{}", config::SCHEMA_JSON);
            0
        }
        ConfigureCommand::Check(path) => check(path.as_deref()),
        ConfigureCommand::Interactive { force } => interactive(*force),
    }
}

fn check(named: Option<&str>) -> i32 {
    let path = named
        .map(PathBuf::from)
        .unwrap_or_else(config::config_file_path);
    match check_report(&path, named.is_some()) {
        Ok(line) => {
            println!("{line}");
            0
        }
        Err(message) => {
            eprintln!("mobux: {message}");
            1
        }
    }
}

fn interactive(force: bool) -> i32 {
    let path = config::config_file_path();
    if !force && path.exists() {
        eprintln!("mobux: {}", ConfigureError::Exists(path));
        return 1;
    }

    let start = match config::load_from(&path) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("mobux: {error}");
            eprintln!("       starting from the defaults — finishing replaces that file");
            Config::default()
        }
    };

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let config = match walk(&mut stdin.lock(), &mut stdout.lock(), start) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("mobux: {error}");
            return 1;
        }
    };

    match write_file(&path, &config, force) {
        Ok(()) => {
            println!("wrote {}", path.display());
            0
        }
        Err(error) => {
            eprintln!("mobux: {error}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One line per field in the order the walk asks, so a test names only the
    /// answers it cares about and the rest keep their current value.
    fn answers(stated: &[(&str, &str)]) -> String {
        let mut script = String::new();
        for spec in FIELDS {
            let answer = stated
                .iter()
                .find(|(key, _)| *key == spec.key)
                .map(|(_, answer)| *answer)
                .unwrap_or("");
            script.push_str(answer);
            script.push('\n');
        }
        script
    }

    fn drive(script: &str, start: Config) -> (Result<Config, ConfigureError>, String) {
        let mut input = script.as_bytes();
        let mut output: Vec<u8> = Vec::new();
        let result = walk(&mut input, &mut output, start);
        (result, String::from_utf8(output).expect("utf-8 prompts"))
    }

    fn walked(stated: &[(&str, &str)]) -> Config {
        drive(&answers(stated), Config::default())
            .0
            .expect("the walkthrough finishes")
    }

    #[test]
    fn every_field_is_asked_for_by_key_and_help() {
        let (_, prompts) = drive(&answers(&[]), Config::default());
        for spec in FIELDS {
            assert!(prompts.contains(spec.key), "{} was never asked", spec.key);
            assert!(prompts.contains(spec.help), "{} lost its help", spec.key);
        }
    }

    #[test]
    fn pressing_enter_through_the_walk_keeps_the_defaults() {
        assert_eq!(walked(&[]), Config::default());
    }

    #[test]
    fn the_current_value_is_shown_in_brackets() {
        let (_, prompts) = drive(&answers(&[]), Config::default());
        assert!(prompts.contains("server.port [8080]:"), "{prompts}");
        assert!(prompts.contains("tls.enabled [true]:"), "{prompts}");
        assert!(prompts.contains("app.service_name [mobux]:"), "{prompts}");
    }

    #[test]
    fn a_secret_is_reported_as_set_and_never_echoed() {
        let start = Config {
            auth: config::AuthConfig {
                pin: "battery".to_string(),
                ..Default::default()
            },
            ..Default::default()
        };
        let (result, prompts) = drive(&answers(&[]), start);
        assert!(prompts.contains("auth.pin [set]:"), "{prompts}");
        assert!(
            !prompts.contains("battery"),
            "the PIN was echoed: {prompts}"
        );
        assert!(prompts.contains("typed in the clear"), "{prompts}");
        assert_eq!(result.expect("finishes").auth.pin, "battery");
    }

    #[test]
    fn every_kind_of_answer_lands_on_the_tree() {
        let config = walked(&[
            ("server.port", "5151"),
            ("auth.user", "walker"),
            ("auth.pin", "12345"),
            ("tls.enabled", "no"),
            ("tls.hosts", "a.example, b.example"),
            ("paths.data_dir", "/srv/mobux"),
            ("app.dev", "yes"),
        ]);
        assert_eq!(config.server.port, 5151);
        assert_eq!(config.auth.user, "walker");
        assert_eq!(config.auth.pin, "12345");
        assert!(!config.tls.enabled);
        assert_eq!(
            config.tls.hosts,
            vec!["a.example".to_string(), "b.example".to_string()]
        );
        assert_eq!(config.paths.data_dir, "/srv/mobux");
        assert!(config.app.dev);
    }

    #[test]
    fn a_dash_empties_a_setting_that_has_one() {
        let start = Config {
            paths: config::PathsConfig {
                data_dir: "/srv/mobux".to_string(),
            },
            tls: config::TlsConfig {
                hosts: vec!["a.example".to_string()],
                ..Default::default()
            },
            ..Default::default()
        };
        let cleared = drive(
            &answers(&[("paths.data_dir", CLEAR), ("tls.hosts", CLEAR)]),
            start,
        )
        .0
        .expect("the walkthrough finishes");
        assert_eq!(cleared.paths.data_dir, "");
        assert!(cleared.tls.hosts.is_empty());
    }

    /// A setting with no empty state stays as it was: the answer is rejected
    /// and asked again rather than written through.
    #[test]
    fn a_dash_is_refused_where_there_is_no_empty_state() {
        let mut script = String::new();
        for spec in FIELDS {
            match spec.key {
                "server.port" => script.push_str("-\n5151\n"),
                "tls.enabled" => script.push_str("-\nno\n"),
                _ => script.push('\n'),
            }
        }
        let (result, prompts) = drive(&script, Config::default());
        let config = result.expect("the walkthrough finishes");
        assert_eq!(config.server.port, 5151);
        assert!(!config.tls.enabled);
        assert!(prompts.contains("cannot be emptied"), "{prompts}");
        assert!(prompts.contains("is on or off"), "{prompts}");
    }

    #[test]
    fn an_answer_that_breaks_its_own_rule_is_asked_again() {
        let mut script = String::new();
        for spec in FIELDS {
            match spec.key {
                "server.port" => script.push_str("http\n5151\n"),
                "auth.pin" => script.push_str("12\n12345\n"),
                _ => script.push('\n'),
            }
        }
        let (result, prompts) = drive(&script, Config::default());
        let config = result.expect("the walkthrough finishes");
        assert_eq!(config.server.port, 5151);
        assert_eq!(config.auth.pin, "12345");
        assert!(prompts.contains("needs a number"), "{prompts}");
        assert!(prompts.contains("between 4 and 64"), "{prompts}");
    }

    #[test]
    fn a_toggle_rejects_a_word_it_cannot_read() {
        let mut script = String::new();
        for spec in FIELDS {
            match spec.key {
                "tls.enabled" => script.push_str("maybe\noff\n"),
                _ => script.push('\n'),
            }
        }
        let (result, prompts) = drive(&script, Config::default());
        assert!(!result.expect("finishes").tls.enabled);
        assert!(prompts.contains("needs yes or no"), "{prompts}");
    }

    /// The one rule no single answer can satisfy: the walk says so and asks
    /// again rather than writing a file the loader would reject.
    #[test]
    fn a_cross_field_rule_sends_the_walk_round_again() {
        let first = answers(&[("tls.acme_domains", "mobux.example")]);
        let second = answers(&[("tls.acme_email", "me@example.com")]);
        let (result, prompts) = drive(&format!("{first}{second}"), Config::default());
        let config = result.expect("the second pass fixes it");
        assert_eq!(config.tls.acme_email, "me@example.com");
        assert!(prompts.contains("tls.acme_email: required"), "{prompts}");
    }

    #[test]
    fn a_pass_that_changes_nothing_stops_instead_of_looping() {
        let pass = answers(&[("tls.acme_domains", "mobux.example")]);
        let (result, _) = drive(&pass.repeat(4), Config::default());
        let Err(ConfigureError::Invalid(message)) = result else {
            panic!("an unfixable tree should not produce a config");
        };
        assert!(message.contains("tls.acme_email"), "{message}");
    }

    #[test]
    fn input_that_ends_early_is_not_a_half_written_config() {
        let (result, _) = drive("5151\n", Config::default());
        assert!(matches!(result, Err(ConfigureError::InputEnded)));
    }

    #[test]
    fn the_answers_round_trip_through_the_file_and_the_loader() {
        let config = walked(&[
            ("server.port", "5151"),
            ("auth.user", "walker"),
            ("auth.pin", "12345"),
            ("tls.hosts", "a.example"),
            ("session.shell", "/bin/zsh"),
            ("app.domain", "mobux.example:5151"),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(config::CONFIG_FILE_NAME);
        write_file(&path, &config, false).expect("writing the config");
        assert_eq!(
            config::load_from(&path).expect("the loader reads it"),
            config
        );
    }

    #[test]
    fn the_written_file_is_readable_by_its_owner_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(config::CONFIG_FILE_NAME);
        write_file(&path, &Config::default(), false).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "mode was {:o}", mode & 0o777);
    }

    #[test]
    fn an_existing_file_is_only_overwritten_with_force() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(config::CONFIG_FILE_NAME);
        std::fs::write(&path, "{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        let refused = write_file(&path, &Config::default(), false);
        assert!(matches!(refused, Err(ConfigureError::Exists(_))));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");

        write_file(&path, &Config::default(), true).expect("--force overwrites");
        assert_eq!(config::load_from(&path).unwrap(), Config::default());
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "a forced write left mode {:o}",
            mode & 0o777
        );
    }

    #[test]
    fn the_directory_is_created_when_it_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join(config::CONFIG_FILE_NAME);
        write_file(&path, &Config::default(), false).expect("writing the config");
        assert!(path.exists());
    }

    #[test]
    fn check_reports_a_good_file_and_names_what_is_wrong_with_a_bad_one() {
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("good.json");
        std::fs::write(&good, r#"{"server": {"port": 5151}}"#).unwrap();
        assert!(check_report(&good, true).unwrap().ends_with(": ok"));

        let bad = dir.path().join("bad.json");
        std::fs::write(&bad, r#"{"server": {"prot": 5151}}"#).unwrap();
        let message = check_report(&bad, true).expect_err("a typo is not ok");
        assert!(message.contains("did you mean `port`?"), "{message}");
    }

    #[test]
    fn check_separates_a_named_file_that_is_missing_from_the_default_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(config::CONFIG_FILE_NAME);
        assert!(check_report(&path, true).is_err());
        assert!(check_report(&path, false)
            .expect("no file is how mobux usually runs")
            .contains("runs on the defaults"));
    }

    #[test]
    fn the_embedded_schema_is_the_committed_one() {
        let embedded: serde_json::Value =
            serde_json::from_str(config::SCHEMA_JSON).expect("the embedded schema is JSON");
        assert_eq!(embedded, config::schema());
    }
}
