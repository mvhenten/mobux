//! Server-side conversation history (issue #220): a per-session, append-only
//! JSONL log built by segmenting the PTY relay's byte stream on OSC 133
//! markers as they flow — decoupled from tmux scrollback and the terminal
//! screen model.
//!
//! Simpler than the browser's OSC 133 handling
//! (`web/static/osc133-attribution.js`), which renders a live buffer and so
//! has to attribute a marker to the correct *screen row* under tmux's
//! out-of-order redraw bursts. This module only ever appends — a marker is
//! always handled relative to whatever bytes have already arrived, never
//! "which row is this" — but it does carry a minimal cursor/row model
//! (`terminal_cursor.rs`) just for `command` extraction: enough to tell the
//! row the shell echoed the typed command onto apart from a status-bar
//! redraw or mode-toggle escape landing elsewhere via CSI cursor
//! positioning. See `terminal_cursor.rs`'s module doc for how that model
//! works; `output`/`exit_code` never go through it (see below).
//!
//! ## Marker semantics (measured against a real tmux+bash session)
//!
//! bash's PS0/PS1 hooks emit, in order for one command cycle:
//! `<typed command echo>\r\n` (plain terminal echo, not a marker) — `C` —
//! `<command's own stdout/stderr>` — `D;<exit code>` — `A` —
//! `<next prompt text>`. So `C` arrives **after** the command's own echoed
//! text, immediately before its output starts, not before the echo. A raw
//! capture off a real tmux pane confirms this exact byte order (see the PR
//! description for the hex dump). Consequently:
//!
//! - `command` text is the row the cursor model most recently completed
//!   with a `\n` before `C` fired (see
//!   [`terminal_cursor::CursorModel::take_command_line`]) — the previous
//!   prompt string and the user's typed line, glued together on one line,
//!   since a single-line `PS1` never embeds a newline. This mirrors the
//!   browser reader's own `.rb-command-line`, which likewise keeps the
//!   prompt and the command on one combined line (see
//!   `test/reader-command-grouping.spec.cjs`). Keying off the row, not just
//!   "the last line of whatever's buffered", is what keeps a status-bar
//!   redraw or terminal-mode-toggle escape — both delivered via CSI cursor
//!   positioning rather than a literal newline — from bleeding into the
//!   command text: they land on a different row (or no row-completing `\n`
//!   at all), so they never become the "most recently completed" row.
//!   Likewise, a freshly attached WS connection's first bytes are tmux's
//!   full-screen repaint of whatever's already on screen, with no OSC 133
//!   markers of its own; that content completes its own rows same as any
//!   other text, but the *next* real command's `\r\n` always completes a
//!   later row, which is what wins.
//! - `output` is exactly the bytes between `C` and `D`, verbatim (`output =
//!   bytes until D`, per the design brief) — no attempt to strip ANSI, and
//!   never routed through the cursor model. This held up reliably against a
//!   live instance.
//! - `exit_code` comes from `D;<code>`.
//! - `A` (and `B`, bash's post-prompt marker) are pure boundary markers —
//!   they never produce their own entry, per the two entry shapes in the
//!   design (command block, raw fallback).
//!
//! ## Un-instrumented fallback
//!
//! A session with no shell integration installed never emits `C`/`D`, so
//! bytes just accumulate in `pending`. Flushing on every PTY read would
//! shred a would-be command's echoed line into one raw entry per keystroke
//! (each keypress is its own small PTY read) — so `pending` is only forced
//! out as a raw entry when it grows past [`RAW_FLUSH_THRESHOLD`], or when
//! the caller explicitly [`Segmenter::flush`]s (session detach). A command
//! that's still open (no `D` yet) at detach is flushed too, with
//! `exit_code: None`, rather than silently dropped — the user's typed
//! command and whatever output arrived are real information worth keeping.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64URL, Engine};
use serde::{Deserialize, Serialize};

use crate::terminal_cursor::CursorModel;

/// A completed command block: one shell command, its output, and how it
/// ended.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandEntry {
    pub seq: u64,
    pub command: String,
    pub output: String,
    #[serde(rename = "exitCode")]
    pub exit_code: Option<i32>,
    #[serde(rename = "startedAt")]
    pub started_at: i64,
    #[serde(rename = "endedAt")]
    pub ended_at: i64,
}

/// A raw fallback entry for content that arrived outside any C..D span —
/// either an un-instrumented session, or bookkeeping/idle content that
/// never resolved into a command block.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawEntry {
    pub seq: u64,
    pub raw: String,
    pub ts: i64,
}

/// One line of the JSONL log. Untagged: a consumer distinguishes the two
/// shapes by field presence (`command` vs `raw`), matching the two shapes
/// pinned in the issue — no separate `kind` discriminator.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum HistoryEntry {
    Command(CommandEntry),
    Raw(RawEntry),
}

/// A segmenter-produced entry, before the store assigns it a session-scoped
/// `seq`.
#[derive(Debug, Clone, PartialEq)]
pub enum PendingEntry {
    Command {
        command: String,
        output: String,
        exit_code: Option<i32>,
        started_at: i64,
        ended_at: i64,
    },
    Raw {
        raw: String,
        ts: i64,
    },
}

impl PendingEntry {
    fn into_entry(self, seq: u64) -> HistoryEntry {
        match self {
            PendingEntry::Command {
                command,
                output,
                exit_code,
                started_at,
                ended_at,
            } => HistoryEntry::Command(CommandEntry {
                seq,
                command,
                output,
                exit_code,
                started_at,
                ended_at,
            }),
            PendingEntry::Raw { raw, ts } => HistoryEntry::Raw(RawEntry { seq, raw, ts }),
        }
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── Segmenter ────────────────────────────────────────────────────────────

/// A pending raw span this large is forced out as its own entry instead of
/// waiting indefinitely for a marker or a disconnect — bounds memory for a
/// long-lived un-instrumented session that's continuously noisy. Chosen
/// well above any real prompt+command line (which is what normally
/// occupies `pending` for an instrumented session, briefly, before `C`
/// claims it).
const RAW_FLUSH_THRESHOLD: usize = 4096;

/// A single runaway command's output (e.g. a `yes` piped with no shell
/// integration installed... well, output still requires C/D, but a
/// legitimately huge build log) stops growing `output` past this — the
/// entry, command and exit code are still recorded, just truncated.
const MAX_COMMAND_OUTPUT_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Marker {
    A,
    B,
    C,
    D(Option<i32>),
}

struct OpenCommand {
    command: String,
    output: Vec<u8>,
    started_at: i64,
}

impl OpenCommand {
    fn finish(self, exit_code: Option<i32>, ended_at: i64) -> PendingEntry {
        PendingEntry::Command {
            command: self.command,
            output: String::from_utf8_lossy(&self.output).into_owned(),
            exit_code,
            started_at: self.started_at,
            ended_at,
        }
    }
}

/// Streaming OSC 133 segmenter. Feed it PTY bytes as they arrive; it
/// returns whatever entries that feed completed. Stateful across calls so a
/// marker split across two PTY reads (or two WS chunks) is handled
/// correctly.
pub struct Segmenter {
    scan_buf: Vec<u8>,
    pending: Vec<u8>,
    open: Option<OpenCommand>,
    cursor: CursorModel,
    seen_marker: bool,
}

impl Default for Segmenter {
    fn default() -> Self {
        Self::new()
    }
}

impl Segmenter {
    pub fn new() -> Self {
        Self {
            scan_buf: Vec::new(),
            pending: Vec::new(),
            open: None,
            cursor: CursorModel::new(),
            seen_marker: false,
        }
    }

    pub fn feed(&mut self, chunk: &[u8], now_ms: i64) -> Vec<PendingEntry> {
        self.scan_buf.extend_from_slice(chunk);
        let mut events = Vec::new();
        loop {
            match self.scan_buf.iter().position(|&b| b == 0x1b) {
                None => {
                    let n = self.scan_buf.len();
                    if n > 0 {
                        self.consume_plain(n, now_ms, &mut events);
                    }
                    break;
                }
                Some(0) => match try_match_marker(&self.scan_buf) {
                    MarkerMatch::Complete { markers, len } => {
                        self.scan_buf.drain(0..len);
                        for m in markers {
                            self.handle_marker(m, now_ms, &mut events);
                        }
                    }
                    MarkerMatch::Incomplete => break,
                    MarkerMatch::NotAMarker => {
                        self.consume_plain(1, now_ms, &mut events);
                    }
                },
                Some(pos) => self.consume_plain(pos, now_ms, &mut events),
            }
        }
        events
    }

    /// Flush whatever is in flight — an open command with no `D` yet, or
    /// buffered un-instrumented content — as a best-effort entry. Call this
    /// once, when the PTY relay this segmenter is attached to disconnects.
    ///
    /// On an instrumented session the trailing `pending` remainder is
    /// dropped rather than recorded. Between one command's `D` and the next
    /// command's `C` it holds the prompt plus whatever else wrote to the
    /// screen, so emitting it wedges a raw entry into the conversation on
    /// every detach — and a phone that backgrounds and reconnects detaches
    /// often. Anything past `RAW_FLUSH_THRESHOLD` was already emitted during
    /// `feed`, so what is dropped is the sub-threshold tail. Without a
    /// marker there is no conversation to protect, and raw entries are the
    /// whole record, so that case is unchanged.
    pub fn flush(&mut self, now_ms: i64) -> Option<PendingEntry> {
        if let Some(open) = self.open.take() {
            return Some(open.finish(None, now_ms));
        }
        if self.seen_marker {
            self.pending.clear();
            return None;
        }
        if !self.pending.is_empty() {
            let raw = String::from_utf8_lossy(&self.pending).into_owned();
            self.pending.clear();
            return Some(PendingEntry::Raw { raw, ts: now_ms });
        }
        None
    }

    fn consume_plain(&mut self, n: usize, now_ms: i64, events: &mut Vec<PendingEntry>) {
        let bytes: Vec<u8> = self.scan_buf.drain(0..n).collect();
        // Every non-marker byte also feeds the cursor model, regardless of
        // whether a command is currently open — it needs continuous cursor
        // tracking to stay in sync with tmux's own screen state (an open
        // command's own output can move the cursor via CSI just like
        // anything else), even though only the row content it derives at
        // the next `C` (see `handle_marker`) is ever consumed.
        self.cursor.feed(&bytes);
        if let Some(open) = &mut self.open {
            if open.output.len() < MAX_COMMAND_OUTPUT_BYTES {
                let room = MAX_COMMAND_OUTPUT_BYTES - open.output.len();
                let take = room.min(bytes.len());
                open.output.extend_from_slice(&bytes[..take]);
            }
            return;
        }
        self.pending.extend_from_slice(&bytes);
        while self.pending.len() >= RAW_FLUSH_THRESHOLD {
            let chunk: Vec<u8> = self.pending.drain(0..RAW_FLUSH_THRESHOLD).collect();
            events.push(PendingEntry::Raw {
                raw: String::from_utf8_lossy(&chunk).into_owned(),
                ts: now_ms,
            });
        }
    }

    fn handle_marker(&mut self, marker: Marker, now_ms: i64, events: &mut Vec<PendingEntry>) {
        self.seen_marker = true;
        match marker {
            Marker::C => {
                // A stray C with no preceding D (shouldn't happen with a
                // well-formed shell snippet) closes the previous command
                // best-effort instead of silently overwriting it.
                if let Some(open) = self.open.take() {
                    events.push(open.finish(None, now_ms));
                }
                let command = self.cursor.take_command_line();
                self.pending.clear();
                self.open = Some(OpenCommand {
                    command,
                    output: Vec::new(),
                    started_at: now_ms,
                });
            }
            Marker::D(code) => {
                if let Some(open) = self.open.take() {
                    events.push(open.finish(code, now_ms));
                }
                // D with no open command (e.g. mid-stream attach) is a
                // defensive no-op; still clear pending so stray prompt
                // bytes since the last boundary don't leak into the next
                // command's text.
                self.pending.clear();
                // The command that just closed may still have output
                // trailing behind it on the wire (nothing forces it to
                // stop the instant D fires) — without this, that trailing
                // activity could win the *next* command's `take_command_line`
                // fallback even though it belongs to this one. See
                // `CursorModel::mark_output_boundary`'s doc comment.
                self.cursor.mark_output_boundary();
            }
            Marker::A | Marker::B => {
                // Pure boundary — no entry of its own, per the two entry
                // shapes this store persists.
            }
        }
    }
}

enum MarkerMatch {
    Complete { markers: Vec<Marker>, len: usize },
    Incomplete,
    NotAMarker,
}

fn try_match_marker(buf: &[u8]) -> MarkerMatch {
    debug_assert_eq!(buf.first(), Some(&0x1b));
    if buf.len() < 2 {
        return MarkerMatch::Incomplete;
    }
    match buf[1] {
        b']' => try_match_bare(buf),
        b'P' => try_match_wrapped(buf),
        _ => MarkerMatch::NotAMarker,
    }
}

fn build_marker(kind: u8, code: Option<i32>) -> Option<Marker> {
    match kind {
        b'A' => Some(Marker::A),
        b'B' => Some(Marker::B),
        b'C' => Some(Marker::C),
        b'D' => Some(Marker::D(code)),
        _ => None,
    }
}

/// Matches a bare `ESC ] 133 ; <letter> [ ; <digits> ] (BEL | ESC \)`
/// sequence starting at `buf[0]`. `buf[0]` is guaranteed to be `ESC`.
fn try_match_bare(buf: &[u8]) -> MarkerMatch {
    const PREFIX: &[u8] = b"\x1b]133;";
    if buf.len() < PREFIX.len() {
        return if PREFIX.starts_with(buf) {
            MarkerMatch::Incomplete
        } else {
            MarkerMatch::NotAMarker
        };
    }
    if &buf[..PREFIX.len()] != PREFIX {
        return MarkerMatch::NotAMarker;
    }
    let mut i = PREFIX.len();
    if i >= buf.len() {
        return MarkerMatch::Incomplete;
    }
    let kind = buf[i];
    i += 1;

    let mut code: Option<i32> = None;
    if i < buf.len() && buf[i] == b';' {
        let start = i + 1;
        let mut j = start;
        while j < buf.len() && buf[j].is_ascii_digit() {
            j += 1;
        }
        if j == buf.len() {
            // Could still be more digits, or the terminator right after.
            return MarkerMatch::Incomplete;
        }
        if j > start {
            code = std::str::from_utf8(&buf[start..j])
                .ok()
                .and_then(|s| s.parse().ok());
        }
        i = j;
    }

    if i >= buf.len() {
        return MarkerMatch::Incomplete;
    }
    let (terminator_len, ok) = match buf[i] {
        0x07 => (1, true),
        0x1b => {
            if i + 1 >= buf.len() {
                return MarkerMatch::Incomplete;
            }
            (2, buf[i + 1] == b'\\')
        }
        _ => (0, false),
    };
    if !ok {
        return MarkerMatch::NotAMarker;
    }
    match build_marker(kind, code) {
        Some(marker) => MarkerMatch::Complete {
            markers: vec![marker],
            len: i + terminator_len,
        },
        None => MarkerMatch::NotAMarker,
    }
}

/// Matches tmux's DCS passthrough wrap (`ESC P tmux ; <payload, every ESC
/// doubled> ESC \`) — the form the shell integration snippet emits when
/// `$TMUX` is set (see `shell_integration.rs`'s v2-v4 notes). In the normal
/// relay path tmux itself unwraps this before mobux's PTY reader ever sees
/// it (confirmed by a real capture — see the PR description), so this is a
/// defensive fallback, not the common case. A single envelope can carry
/// more than one marker (bash/zsh v3+ combine D and A in one write), hence
/// returning a `Vec`.
fn try_match_wrapped(buf: &[u8]) -> MarkerMatch {
    const PREFIX: &[u8] = b"\x1bPtmux;";
    if buf.len() < PREFIX.len() {
        return if PREFIX.starts_with(buf) {
            MarkerMatch::Incomplete
        } else {
            MarkerMatch::NotAMarker
        };
    }
    if &buf[..PREFIX.len()] != PREFIX {
        return MarkerMatch::NotAMarker;
    }

    let mut payload = Vec::new();
    let mut i = PREFIX.len();
    loop {
        if i >= buf.len() {
            return MarkerMatch::Incomplete;
        }
        if buf[i] == 0x1b {
            if i + 1 >= buf.len() {
                return MarkerMatch::Incomplete;
            }
            match buf[i + 1] {
                0x1b => {
                    payload.push(0x1b);
                    i += 2;
                }
                b'\\' => {
                    i += 2;
                    break;
                }
                _ => return MarkerMatch::NotAMarker,
            }
        } else {
            payload.push(buf[i]);
            i += 1;
        }
    }

    let markers = parse_all_bare_markers(&payload);
    if markers.is_empty() {
        return MarkerMatch::NotAMarker;
    }
    MarkerMatch::Complete { markers, len: i }
}

/// Parses every bare OSC 133 sequence out of an already-unwrapped DCS
/// payload, skipping over anything unrecognized one byte at a time (never
/// blocks — the payload is already fully buffered).
fn parse_all_bare_markers(payload: &[u8]) -> Vec<Marker> {
    let mut markers = Vec::new();
    let mut pos = 0;
    while pos < payload.len() {
        if payload[pos] == 0x1b {
            match try_match_bare(&payload[pos..]) {
                MarkerMatch::Complete {
                    markers: mut m,
                    len,
                } => {
                    markers.append(&mut m);
                    pos += len;
                    continue;
                }
                _ => {
                    pos += 1;
                    continue;
                }
            }
        }
        pos += 1;
    }
    markers
}

// ── Storage: one JSONL file per session, bounded retention, cursor pages ──

/// Retention cap: a session's JSONL file is trimmed back to this many
/// entries (oldest dropped first) once it grows past `CAP + TRIM_MARGIN`.
/// Personal tool, no config knob — a constant chosen generously above any
/// realistic single-session interactive history.
pub const MAX_ENTRIES_PER_SESSION: u64 = 2000;
/// Trimming rewrites the whole file (cheap at this scale, see `trim`) — the
/// margin amortizes that rewrite across many appends instead of doing it on
/// every single one past the cap.
const TRIM_MARGIN: u64 = 100;

pub const DEFAULT_LIMIT: usize = 50;
pub const MAX_LIMIT: usize = 500;

struct SessionSlot {
    last_seq: u64,
    entry_count: u64,
}

pub struct SessionHistoryStore {
    root: PathBuf,
    slots: Mutex<HashMap<String, Arc<Mutex<SessionSlot>>>>,
    active_feeders: Mutex<HashSet<String>>,
}

/// Held by the one WS connection currently allowed to feed a session's
/// segmenter. tmux lets multiple clients attach to the same session (two
/// browser tabs on one phone+laptop, say); each attach spawns its own PTY
/// reader carrying a full copy of the same output. Without this guard, two
/// concurrent attaches would double-segment and double-append every byte.
/// Only the first attacher feeds history; others still relay normally, they
/// just don't write to the log. Dropped (and the slot freed for the next
/// attacher) when that connection's `handle_ws` returns.
pub struct FeederGuard {
    store: Arc<SessionHistoryStore>,
    session: String,
}

impl Drop for FeederGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.store.active_feeders.lock() {
            active.remove(&self.session);
        }
    }
}

impl SessionHistoryStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            root: data_dir.join("history"),
            slots: Mutex::new(HashMap::new()),
            active_feeders: Mutex::new(HashSet::new()),
        }
    }

    pub fn try_acquire_feeder(self: &Arc<Self>, session: &str) -> Option<FeederGuard> {
        let mut active = self.active_feeders.lock().ok()?;
        if !active.insert(session.to_string()) {
            return None;
        }
        Some(FeederGuard {
            store: self.clone(),
            session: session.to_string(),
        })
    }

    fn file_path(&self, session: &str) -> PathBuf {
        self.root.join(format!("{session}.jsonl"))
    }

    fn slot(&self, session: &str) -> anyhow::Result<Arc<Mutex<SessionSlot>>> {
        let mut slots = self
            .slots
            .lock()
            .map_err(|_| anyhow::anyhow!("session history slots lock poisoned"))?;
        if let Some(existing) = slots.get(session) {
            return Ok(existing.clone());
        }
        let hydrated = Self::hydrate(&self.file_path(session));
        let arc = Arc::new(Mutex::new(hydrated));
        slots.insert(session.to_string(), arc.clone());
        Ok(arc)
    }

    fn hydrate(path: &Path) -> SessionSlot {
        let mut last_seq = 0u64;
        let mut entry_count = 0u64;
        if let Ok(f) = File::open(path) {
            for line in BufReader::new(f).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                entry_count += 1;
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    if let Some(seq) = v.get("seq").and_then(|s| s.as_u64()) {
                        last_seq = last_seq.max(seq);
                    }
                }
            }
        }
        SessionSlot {
            last_seq,
            entry_count,
        }
    }

    /// Appends one entry, assigning it the next monotonic `seq` for this
    /// session. `seq` values are never reused or renumbered — trimming only
    /// ever drops the oldest lines, so a cursor built from a `seq` stays
    /// meaningful (`give me everything after this point`) even once the
    /// entry it named has itself been trimmed away.
    pub fn append(&self, session: &str, entry: PendingEntry) -> anyhow::Result<HistoryEntry> {
        let slot = self.slot(session)?;
        let mut s = slot
            .lock()
            .map_err(|_| anyhow::anyhow!("session history slot lock poisoned"))?;
        s.last_seq += 1;
        let full = entry.into_entry(s.last_seq);

        fs::create_dir_all(&self.root)?;
        let line = serde_json::to_string(&full)?;
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.file_path(session))?;
        writeln!(f, "{line}")?;
        s.entry_count += 1;

        if s.entry_count > MAX_ENTRIES_PER_SESSION + TRIM_MARGIN {
            self.trim(session, &mut s)?;
        }
        Ok(full)
    }

    fn trim(&self, session: &str, s: &mut SessionSlot) -> anyhow::Result<()> {
        let path = self.file_path(session);
        let lines: Vec<String> = BufReader::new(File::open(&path)?)
            .lines()
            .map_while(Result::ok)
            .filter(|l| !l.trim().is_empty())
            .collect();
        let keep_from = lines.len().saturating_sub(MAX_ENTRIES_PER_SESSION as usize);
        let kept = &lines[keep_from..];

        let tmp_path = path.with_extension("jsonl.tmp");
        {
            let mut tmp = File::create(&tmp_path)?;
            for l in kept {
                writeln!(tmp, "{l}")?;
            }
        }
        fs::rename(&tmp_path, &path)?;
        s.entry_count = kept.len() as u64;
        Ok(())
    }

    /// Returns up to `limit` entries with `seq > cursor` (oldest of the page
    /// first — the file is always in ascending-`seq` order by construction:
    /// append-only, and trimming only ever drops a prefix), plus the `seq`
    /// pagination should resume from next (the last entry actually
    /// returned, or the given cursor unchanged if nothing new was found).
    pub fn read_page(
        &self,
        session: &str,
        cursor: Option<u64>,
        limit: usize,
    ) -> anyhow::Result<(Vec<serde_json::Value>, u64)> {
        let path = self.file_path(session);
        let floor = cursor.unwrap_or(0);
        let mut entries = Vec::new();
        let mut last_seq = floor;

        if let Ok(f) = File::open(&path) {
            for line in BufReader::new(f).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                let seq = v.get("seq").and_then(|s| s.as_u64()).unwrap_or(0);
                if seq <= floor {
                    continue;
                }
                last_seq = seq;
                entries.push(v);
                if entries.len() >= limit {
                    break;
                }
            }
        }
        Ok((entries, last_seq))
    }
}

// ── Opaque cursor ────────────────────────────────────────────────────────
//
// A cursor is just a `seq` value, base64-encoded with a version tag so it
// can never be hand-constructed or guessed at as "just an integer" by a
// caller (the API contract only promises opacity, not stability of this
// encoding).

pub fn encode_cursor(seq: u64) -> String {
    BASE64URL.encode(format!("v1:{seq}"))
}

pub fn decode_cursor(cursor: &str) -> Option<u64> {
    let bytes = BASE64URL.decode(cursor).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    text.strip_prefix("v1:")?.parse::<u64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_str(seg: &mut Segmenter, s: &str, t: i64) -> Vec<PendingEntry> {
        seg.feed(s.as_bytes(), t)
    }

    // Real byte order captured off an actual tmux+bash session with the
    // installed OSC 133 snippet (`tmux pipe-pane -o` on a probe session):
    // the typed command is echoed BEFORE `C`; `C` fires immediately before
    // the command's own output starts, not before its echo.
    const REAL_ECHO_HELLO: &str =
        "echo hello\r\n\x1b]133;C\x07hello\r\n\x1b[?2004h\x1b]133;D;0\x07\x1b]133;A\x07mvhenten@sandbox:~$ ";

    #[test]
    fn real_command_cycle_produces_one_command_entry() {
        let mut seg = Segmenter::new();
        let events = feed_str(&mut seg, REAL_ECHO_HELLO, 1000);
        assert_eq!(events.len(), 1);
        match &events[0] {
            PendingEntry::Command {
                command,
                output,
                exit_code,
                started_at,
                ended_at,
            } => {
                assert_eq!(command, "echo hello");
                // Includes the trailing bracketed-paste-on toggle — it's
                // genuinely between C and D in the real capture, and
                // "output = bytes until D" makes no promise to strip ANSI.
                assert_eq!(output, "hello\r\n\x1b[?2004h");
                assert_eq!(*exit_code, Some(0));
                assert_eq!(*started_at, 1000);
                assert_eq!(*ended_at, 1000);
            }
            other => panic!("expected a command entry, got {other:?}"),
        }
    }

    #[test]
    fn command_text_keeps_the_prompt_prefix_like_the_client_reader_does() {
        // The command field is whatever's on the completed row before C —
        // prompt included, not a stripped bare command. This matches the
        // browser reader's own `.rb-command-line`, which is likewise the
        // whole prompt+command line (see
        // test/reader-command-grouping.spec.cjs).
        let mut seg = Segmenter::new();
        let events = feed_str(
            &mut seg,
            "mvhenten@host:~$ ls -la\r\n\x1b]133;C\x07f\r\n\x1b]133;D;0\x07\x1b]133;A\x07",
            1,
        );
        let PendingEntry::Command { command, .. } = &events[0] else {
            panic!("expected command entry");
        };
        assert_eq!(command, "mvhenten@host:~$ ls -la");
    }

    #[test]
    fn command_survives_a_leading_unmarked_repaint_burst() {
        // Reproduces a real regression found end-to-end against a live
        // mobux instance (isolated port/tmux socket/data dir, real bash +
        // OSC 133 install, real WS attach): a freshly attached WS
        // connection's very first bytes are tmux's full-screen repaint of
        // whatever's already on screen — terminal-init sequences plus a
        // multi-line motd/prompt redraw, none of it carrying a marker. Each
        // repaint line completes its own row same as any other text; the
        // real command's own `\r\n` completes a later row, which is what
        // the cursor model hands back at `C` — this used to instead take
        // the *first* line of the whole unmarked span (picking the
        // repaint's banner text) before the cursor model existed.
        let repaint_burst = "\x1b[?1049h\x1b[?1h\x1b=\x1b[H\x1b[2J\x1b[?25h\r\n\
             Welcome to Ubuntu — motd banner line one\r\n\
             Last login: Tue Jul 21 07:00:00 2026\r\n";
        let mut seg = Segmenter::new();
        let events = feed_str(
            &mut seg,
            &format!(
                "{repaint_burst}mvhenten@sandbox:~$ echo hello\r\n\x1b]133;C\x07hello\r\n\x1b]133;D;0\x07\x1b]133;A\x07"
            ),
            1,
        );
        assert_eq!(events.len(), 1);
        let PendingEntry::Command {
            command,
            output,
            exit_code,
            ..
        } = &events[0]
        else {
            panic!("expected a command entry, got {events:?}");
        };
        assert_eq!(command, "mvhenten@sandbox:~$ echo hello");
        assert_eq!(output, "hello\r\n");
        assert_eq!(*exit_code, Some(0));
    }

    #[test]
    fn command_survives_a_status_bar_redraw_between_echo_and_c() {
        // Reproduces the exact bug this module's cursor model exists to
        // fix: tmux redraws its status bar by repositioning the cursor
        // with CSI (`ESC[<row>;<col>H`), writing status text, then
        // repositioning back — none of it newline-delimited, so it can
        // land, byte-wise, between the command's own `\r\n` and `C`. The
        // old flat-buffer `last_line` heuristic took whatever followed the
        // last `\n` in that span; since the status-bar noise here has no
        // trailing `\n` of its own, that would have picked the noise
        // itself (`"\x1b[24;1H\x1b[K[ 0:bash* ]\x1b[2;1H"`) as `command`
        // instead of the real line. The cursor model instead keys off the
        // row that last completed via `\n` — row 0, the command's own
        // echoed line — which the status-bar redraw (row 23) never
        // touches.
        let mut seg = Segmenter::new();
        let events = feed_str(
            &mut seg,
            "mvhenten@sandbox:~$ echo hi\r\n\
             \x1b[24;1H\x1b[K[ 0:bash* ]\x1b[2;1H\
             \x1b]133;C\x07hi\r\n\x1b]133;D;0\x07\x1b]133;A\x07",
            1,
        );
        assert_eq!(events.len(), 1);
        let PendingEntry::Command {
            command,
            output,
            exit_code,
            ..
        } = &events[0]
        else {
            panic!("expected a command entry, got {events:?}");
        };
        assert_eq!(command, "mvhenten@sandbox:~$ echo hi");
        assert_eq!(output, "hi\r\n");
        assert_eq!(*exit_code, Some(0));
    }

    #[test]
    fn command_never_carries_a_mode_toggle_escape_riding_the_same_line() {
        // A terminal-mode-toggle CSI (bracketed-paste-off, in this case)
        // landing on the exact same row as the echoed command, before its
        // `\r\n` — the old byte-flat approach had no CSI parser at all, so
        // these bytes were treated as literal characters and ended up
        // inside the "last line" verbatim. The cursor model's `csi_dispatch`
        // recognizes `?2004l` as a private-mode reset with no text effect,
        // so it's never `print`ed into the row.
        let mut seg = Segmenter::new();
        let events = feed_str(
            &mut seg,
            "mvhenten@sandbox:~$ echo hi\x1b[?2004l\r\n\x1b]133;C\x07hi\r\n\x1b]133;D;0\x07\x1b]133;A\x07",
            1,
        );
        let PendingEntry::Command { command, .. } = &events[0] else {
            panic!("expected command entry");
        };
        assert_eq!(command, "mvhenten@sandbox:~$ echo hi");
    }

    #[test]
    fn two_commands_including_a_failing_one() {
        let mut seg = Segmenter::new();
        let mut events = feed_str(&mut seg, REAL_ECHO_HELLO, 1);
        events.extend(feed_str(
            &mut seg,
            "false\r\n\x1b]133;C\x07\x1b[?2004h\x1b]133;D;1\x07\x1b]133;A\x07mvhenten@sandbox:~$ ",
            2,
        ));
        assert_eq!(events.len(), 2);
        let PendingEntry::Command { exit_code, .. } = &events[1] else {
            panic!("expected command entry");
        };
        assert_eq!(*exit_code, Some(1));
    }

    #[test]
    fn marker_split_across_two_feed_calls_still_resolves() {
        let mut seg = Segmenter::new();
        let whole = REAL_ECHO_HELLO;
        let split = whole.len() / 2;
        // Split mid-marker: `\x1b]133;D;0\x07` in the second half must not
        // be misread if the first `feed` call ends partway through it.
        let mut events = feed_str(&mut seg, &whole[..split], 5);
        assert!(
            events.is_empty(),
            "no entry should complete before the D marker arrives, got {events:?}"
        );
        events.extend(feed_str(&mut seg, &whole[split..], 6));
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], PendingEntry::Command { .. }));
    }

    #[test]
    fn marker_split_byte_by_byte_still_resolves() {
        let mut seg = Segmenter::new();
        let mut events = Vec::new();
        for b in REAL_ECHO_HELLO.as_bytes() {
            events.extend(seg.feed(&[*b], 9));
        }
        assert_eq!(events.len(), 1);
        let PendingEntry::Command {
            command,
            output,
            exit_code,
            ..
        } = &events[0]
        else {
            panic!("expected command entry");
        };
        assert_eq!(command, "echo hello");
        assert_eq!(output, "hello\r\n\x1b[?2004h");
        assert_eq!(*exit_code, Some(0));
    }

    #[test]
    fn tmux_dcs_passthrough_wrapped_markers_are_unwrapped() {
        // Matches shell_integration.rs's v3+ combined D+A envelope: every
        // embedded ESC doubled, terminated by a bare (undoubled) ESC \.
        let mut seg = Segmenter::new();
        feed_str(
            &mut seg,
            "prompt$ true\r\n\x1bPtmux;\x1b\x1b]133;C\x07\x1b\\",
            1,
        );
        let events = feed_str(
            &mut seg,
            "ok\r\n\x1bPtmux;\x1b\x1b]133;D;0\x07\x1b\x1b]133;A\x07\x1b\\",
            2,
        );
        assert_eq!(events.len(), 1);
        let PendingEntry::Command {
            command,
            output,
            exit_code,
            ..
        } = &events[0]
        else {
            panic!("expected command entry, got {events:?}");
        };
        assert_eq!(command, "prompt$ true");
        assert_eq!(output, "ok\r\n");
        assert_eq!(*exit_code, Some(0));
    }

    #[test]
    fn wrapped_marker_split_across_feed_calls() {
        let mut seg = Segmenter::new();
        let envelope = "x\r\n\x1bPtmux;\x1b\x1b]133;C\x07\x1b\\out\x1bPtmux;\x1b\x1b]133;D;7\x07\x1b\x1b]133;A\x07\x1b\\";
        let split = envelope.len() / 2;
        let mut events = feed_str(&mut seg, &envelope[..split], 1);
        events.extend(feed_str(&mut seg, &envelope[split..], 2));
        assert_eq!(events.len(), 1);
        let PendingEntry::Command { exit_code, .. } = &events[0] else {
            panic!("expected command entry");
        };
        assert_eq!(*exit_code, Some(7));
    }

    #[test]
    fn uninstrumented_session_falls_back_to_raw_chunks_on_flush() {
        let mut seg = Segmenter::new();
        let events = feed_str(&mut seg, "plain output, no OSC 133 at all\n", 1);
        assert!(events.is_empty(), "must not flush eagerly mid-session");
        let flushed = seg.flush(2);
        match flushed {
            Some(PendingEntry::Raw { raw, ts }) => {
                assert_eq!(raw, "plain output, no OSC 133 at all\n");
                assert_eq!(ts, 2);
            }
            other => panic!("expected a raw entry, got {other:?}"),
        }
    }

    #[test]
    fn large_uninstrumented_burst_flushes_in_bounded_chunks() {
        let mut seg = Segmenter::new();
        let burst = "x".repeat(RAW_FLUSH_THRESHOLD * 2 + 10);
        let events = seg.feed(burst.as_bytes(), 1);
        assert_eq!(events.len(), 2, "two full RAW_FLUSH_THRESHOLD chunks");
        for e in &events {
            let PendingEntry::Raw { raw, .. } = e else {
                panic!("expected raw entry");
            };
            assert_eq!(raw.len(), RAW_FLUSH_THRESHOLD);
        }
        let flushed = seg.flush(2);
        let Some(PendingEntry::Raw { raw, .. }) = flushed else {
            panic!("expected leftover raw entry");
        };
        assert_eq!(raw.len(), 10);
    }

    #[test]
    fn open_command_at_disconnect_flushes_best_effort_with_no_exit_code() {
        let mut seg = Segmenter::new();
        feed_str(&mut seg, "cmd\r\n\x1b]133;C\x07partial out", 1);
        let flushed = seg.flush(5);
        match flushed {
            Some(PendingEntry::Command {
                command,
                output,
                exit_code,
                ended_at,
                ..
            }) => {
                assert_eq!(command, "cmd");
                assert_eq!(output, "partial out");
                assert_eq!(exit_code, None);
                assert_eq!(ended_at, 5);
            }
            other => panic!("expected a command entry, got {other:?}"),
        }
    }

    #[test]
    fn instrumented_session_drops_the_trailing_prompt_remainder_on_flush() {
        let mut seg = Segmenter::new();
        feed_str(&mut seg, "cmd\r\n\x1b]133;C\x07out", 1);
        let events = feed_str(&mut seg, "\x1b]133;D;0\x07\x1b]133;A\x07", 2);
        assert_eq!(events.len(), 1);
        feed_str(&mut seg, "mvhenten@sandbox:~$ ", 3);
        assert_eq!(seg.flush(4), None);
    }

    #[test]
    fn command_output_is_capped_not_unbounded() {
        let mut seg = Segmenter::new();
        feed_str(&mut seg, "cmd\r\n\x1b]133;C\x07", 1);
        let huge = "y".repeat(MAX_COMMAND_OUTPUT_BYTES + 1000);
        seg.feed(huge.as_bytes(), 1);
        let events = seg.feed(b"\x1b]133;D;0\x07\x1b]133;A\x07", 2);
        let PendingEntry::Command { output, .. } = &events[0] else {
            panic!("expected command entry");
        };
        assert_eq!(output.len(), MAX_COMMAND_OUTPUT_BYTES);
    }

    #[test]
    fn d_without_open_command_is_a_defensive_no_op() {
        let mut seg = Segmenter::new();
        let events = feed_str(&mut seg, "\x1b]133;D;0\x07\x1b]133;A\x07", 1);
        assert!(events.is_empty());
    }

    #[test]
    fn cursor_roundtrips_and_is_not_a_bare_integer_string() {
        let c = encode_cursor(42);
        assert_ne!(c, "42");
        assert_eq!(decode_cursor(&c), Some(42));
        assert_eq!(decode_cursor("not-a-real-cursor"), None);
    }

    // ── store: append, retention trim, cursor stability ────────────────

    fn temp_store() -> (tempfile::TempDir, SessionHistoryStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionHistoryStore::new(dir.path());
        (dir, store)
    }

    #[test]
    fn append_assigns_monotonic_seq_and_persists_jsonl() {
        let (_dir, store) = temp_store();
        let a = store
            .append(
                "s1",
                PendingEntry::Raw {
                    raw: "one".into(),
                    ts: 1,
                },
            )
            .unwrap();
        let b = store
            .append(
                "s1",
                PendingEntry::Raw {
                    raw: "two".into(),
                    ts: 2,
                },
            )
            .unwrap();
        let HistoryEntry::Raw(a) = a else { panic!() };
        let HistoryEntry::Raw(b) = b else { panic!() };
        assert_eq!(a.seq, 1);
        assert_eq!(b.seq, 2);

        let contents = fs::read_to_string(store.file_path("s1")).unwrap();
        assert_eq!(contents.lines().count(), 2);
    }

    #[test]
    fn seq_counter_survives_process_restart_by_rehydrating_from_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionHistoryStore::new(dir.path());
        for i in 0..3 {
            store
                .append(
                    "s1",
                    PendingEntry::Raw {
                        raw: format!("e{i}"),
                        ts: i,
                    },
                )
                .unwrap();
        }
        // Simulate a fresh process: a brand new store over the same data
        // dir (not `store.root`, which is already `<data_dir>/history`).
        let store2 = SessionHistoryStore::new(dir.path());
        let next = store2
            .append(
                "s1",
                PendingEntry::Raw {
                    raw: "e3".into(),
                    ts: 3,
                },
            )
            .unwrap();
        let HistoryEntry::Raw(next) = next else {
            panic!()
        };
        assert_eq!(next.seq, 4);
    }

    // The append at which `entry_count` first exceeds CAP + MARGIN, forcing
    // a trim back down to exactly CAP. After this many appends (seq 1..=
    // TRIGGER), the oldest surviving seq is deterministically
    // `TRIGGER - CAP + 1` = `MARGIN + 2`.
    const TRIGGER: u64 = MAX_ENTRIES_PER_SESSION + TRIM_MARGIN + 1;

    fn fill(store: &SessionHistoryStore, session: &str, count: u64) {
        for i in 0..count {
            store
                .append(
                    session,
                    PendingEntry::Raw {
                        raw: format!("e{i}"),
                        ts: i as i64,
                    },
                )
                .unwrap();
        }
    }

    #[test]
    fn retention_trims_oldest_entries_once_past_cap_plus_margin() {
        let (_dir, store) = temp_store();
        fill(&store, "s1", TRIGGER);

        let contents = fs::read_to_string(store.file_path("s1")).unwrap();
        let line_count = contents.lines().count() as u64;
        assert_eq!(line_count, MAX_ENTRIES_PER_SESSION);

        let first_line: serde_json::Value =
            serde_json::from_str(contents.lines().next().unwrap()).unwrap();
        assert_eq!(first_line["seq"].as_u64().unwrap(), TRIM_MARGIN + 2);

        // 5 more appends after the trim: no re-trim yet (count is CAP + 5,
        // still under CAP + MARGIN), so nothing else is dropped.
        fill(&store, "s1", 5);
        let contents = fs::read_to_string(store.file_path("s1")).unwrap();
        assert_eq!(contents.lines().count() as u64, MAX_ENTRIES_PER_SESSION + 5);
    }

    #[test]
    fn cursor_stays_stable_across_a_trim() {
        let (_dir, store) = temp_store();
        fill(&store, "s1", TRIGGER);

        // A cursor from well before the trimmed prefix must still page
        // forward correctly — no error, just resumes at the oldest entry
        // still retained.
        let stale_cursor = 5u64;
        let (page, next_cursor) = store.read_page("s1", Some(stale_cursor), 10).unwrap();
        assert_eq!(page.len(), 10);
        let expected_first_seq = TRIM_MARGIN + 2;
        assert_eq!(page[0]["seq"].as_u64().unwrap(), expected_first_seq);
        assert_eq!(next_cursor, expected_first_seq + 9);
    }

    #[test]
    fn read_page_paginates_forward_with_limit() {
        let (_dir, store) = temp_store();
        for i in 0..5u64 {
            store
                .append(
                    "s1",
                    PendingEntry::Raw {
                        raw: format!("e{i}"),
                        ts: i as i64,
                    },
                )
                .unwrap();
        }
        let (page1, cursor1) = store.read_page("s1", None, 2).unwrap();
        assert_eq!(page1.len(), 2);
        assert_eq!(page1[0]["seq"], 1);
        assert_eq!(page1[1]["seq"], 2);
        assert_eq!(cursor1, 2);

        let (page2, cursor2) = store.read_page("s1", Some(cursor1), 2).unwrap();
        assert_eq!(page2[0]["seq"], 3);
        assert_eq!(page2[1]["seq"], 4);
        assert_eq!(cursor2, 4);

        let (page3, cursor3) = store.read_page("s1", Some(cursor2), 2).unwrap();
        assert_eq!(page3.len(), 1);
        assert_eq!(page3[0]["seq"], 5);
        assert_eq!(cursor3, 5);

        // Fully caught up: empty page, cursor unchanged.
        let (page4, cursor4) = store.read_page("s1", Some(cursor3), 2).unwrap();
        assert!(page4.is_empty());
        assert_eq!(cursor4, cursor3);
    }

    #[test]
    fn two_concurrent_attaches_only_one_acquires_the_feeder() {
        let (_dir, store) = temp_store();
        let store = Arc::new(store);
        let first = store.try_acquire_feeder("s1");
        assert!(first.is_some());
        let second = store.try_acquire_feeder("s1");
        assert!(second.is_none(), "a second attach must not double-feed");
        drop(first);
        let third = store.try_acquire_feeder("s1");
        assert!(third.is_some(), "freed once the first attach disconnects");
    }
}
