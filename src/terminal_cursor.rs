//! A minimal cursor/screen model for the session-history segmenter
//! (`session_history.rs`'s `Segmenter`): just enough to tell "the row the
//! shell echoed the typed command onto" apart from bytes that land
//! elsewhere on the pane — a tmux status-bar redraw, a bracketed-paste
//! mode toggle, a full-screen repaint — all of which move around with CSI
//! cursor-positioning escapes rather than a literal newline.
//!
//! This is deliberately NOT a terminal emulator: no colors/attributes, no
//! scrollback, no line wrapping, no alternate-screen buffer. It tracks
//! exactly three things — cursor row/col, a sparse per-row text buffer,
//! and which row most recently completed via `\n` — because that's the
//! one signal `command` extraction needs (see `Segmenter::handle_marker`'s
//! `Marker::C` arm).
//!
//! Built on `vte` (the byte-level ANSI/VT state machine Alacritty uses)
//! rather than a hand-rolled CSI scanner: `vte` already resolves the
//! partial-sequence-across-reads and private-mode-prefix (`?`) parsing
//! correctly, which a from-scratch scanner would have to re-solve. Only
//! `print`, `execute`, and `csi_dispatch` are implemented; `osc_dispatch`,
//! `hook`/`put`/`unhook` (DCS), and `esc_dispatch` are left as no-ops —
//! those bytes still reach the segmenter's `output`/raw capture verbatim
//! (that capture is a separate, byte-for-byte path — see
//! `Segmenter::consume_plain`), they just don't count as *screen content*
//! for command-line extraction.

use std::collections::BTreeMap;

use vte::{Params, Parser, Perform};

/// Distinct rows retained at once. Bounds memory for a long-lived session:
/// tmux addresses status-bar/redraw rows absolutely, but always within the
/// small range of the pane's actual height, so this is generous headroom
/// above any real terminal size, not a tight budget.
const MAX_TRACKED_ROWS: usize = 512;

/// A single row's stored length is capped for the same reason
/// `session_history.rs`'s `MAX_COMMAND_OUTPUT_BYTES` caps command output:
/// a huge, newline-free byte run (command output with no OSC 133
/// installed to segment it, or pathological input) must not grow one
/// row's buffer unboundedly. Well above any real terminal width.
const MAX_ROW_CHARS: usize = 4096;

pub struct CursorModel {
    parser: Parser,
    state: ScreenState,
}

impl CursorModel {
    pub fn new() -> Self {
        Self {
            parser: Parser::new(),
            state: ScreenState::new(),
        }
    }

    /// Feed the next chunk of PTY bytes — the exact same bytes (and
    /// chunking) the segmenter is also capturing verbatim into `pending`/
    /// `output`. `vte::Parser` is stateful across calls, so a sequence
    /// split across two chunks (or fed one byte at a time) still resolves
    /// correctly.
    pub fn feed(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.state, bytes);
    }

    /// The row most recently completed by a `\n` since the last call (a
    /// fresh command's echoed line always ends in `\r\n` before its `C`
    /// marker fires — see `session_history.rs`'s module doc). Falls back to
    /// the row most recently *written to* (even with no trailing `\n` yet)
    /// if none completed — same best-effort spirit as the old flat-buffer
    /// `last_line`. Trimmed of trailing padding (a row grows padded with
    /// spaces when the cursor is moved forward past written content — e.g.
    /// a CSI cursor move with nothing printed after — never real command
    /// text).
    ///
    /// If NEITHER happened — nothing completed a line and nothing was even
    /// partially written since the last call — this returns empty rather
    /// than falling back to the cursor's current row regardless: under
    /// tmux's redraw-burst reordering, the cursor can already be
    /// positioned on a row that holds unrelated leftover content from an
    /// earlier, different command (measured against a real tmux+zsh
    /// session — see `session_history.rs`'s tests) — reusing it would
    /// misattribute one command's text to a different entry, which is
    /// worse than an empty (honestly "didn't arrive yet") result.
    ///
    /// Consumes both signals: after this call, only fresh activity (not
    /// stale leftover state from an earlier line) satisfies the next call.
    pub fn take_command_line(&mut self) -> String {
        let completed = self.state.last_completed_row.take();
        let dirty = self.state.dirty_row.take();
        match completed.or(dirty) {
            Some(row) => self.state.row_text(row),
            None => String::new(),
        }
    }

    /// Marks a command's own output as over (the segmenter's `D` marker):
    /// clears the "most recently completed/written" row without consuming
    /// it as a command line. Without this, the tail of a command's own
    /// stdout — real terminal activity, just not the *next* command's
    /// echoed line — would still count as "fresh activity" and could win
    /// [`take_command_line`]'s fallback for the following cycle even
    /// though it has nothing to do with that command (measured against a
    /// real tmux+bash session: a short command's output landing on the row
    /// the *next* command's `C` later resolved to, because that next
    /// command's own echo hadn't arrived on the wire yet).
    pub fn mark_output_boundary(&mut self) {
        self.state.last_completed_row = None;
        self.state.dirty_row = None;
    }
}

impl Default for CursorModel {
    fn default() -> Self {
        Self::new()
    }
}

struct ScreenState {
    rows: BTreeMap<i64, Vec<char>>,
    cursor_row: i64,
    cursor_col: usize,
    last_completed_row: Option<i64>,
    /// The row most recently `print`ed to, whether or not it's gone on to
    /// complete with a `\n` yet — see `CursorModel::take_command_line`.
    dirty_row: Option<i64>,
}

impl ScreenState {
    fn new() -> Self {
        Self {
            rows: BTreeMap::new(),
            cursor_row: 0,
            cursor_col: 0,
            last_completed_row: None,
            dirty_row: None,
        }
    }

    fn row_text(&self, row: i64) -> String {
        self.rows
            .get(&row)
            .map(|chars| chars.iter().collect::<String>().trim_end().to_string())
            .unwrap_or_default()
    }

    fn prune(&mut self) {
        while self.rows.len() > MAX_TRACKED_ROWS {
            let Some(&oldest) = self.rows.keys().next() else {
                break;
            };
            self.rows.remove(&oldest);
        }
    }

    fn put_char(&mut self, c: char) {
        self.dirty_row = Some(self.cursor_row);
        let row = self.rows.entry(self.cursor_row).or_default();
        if row.len() < MAX_ROW_CHARS {
            if self.cursor_col >= row.len() {
                row.resize(self.cursor_col + 1, ' ');
            }
            if self.cursor_col < MAX_ROW_CHARS {
                row[self.cursor_col] = c;
            }
        }
        self.cursor_col += 1;
    }

    fn erase_in_line(&mut self, mode: i64) {
        let Some(row) = self.rows.get_mut(&self.cursor_row) else {
            return;
        };
        match mode {
            // Cursor to end of line.
            0 => row.truncate(self.cursor_col.min(row.len())),
            // Start of line to cursor.
            1 => {
                let end = (self.cursor_col + 1).min(row.len());
                for cell in &mut row[..end] {
                    *cell = ' ';
                }
            }
            // Whole line.
            _ => row.clear(),
        }
    }

    fn erase_in_display(&mut self, mode: i64) {
        match mode {
            // Cursor to end of screen.
            0 => {
                self.erase_in_line(0);
                let cur = self.cursor_row;
                self.rows.retain(|&r, _| r <= cur);
            }
            // Start of screen to cursor.
            1 => {
                self.erase_in_line(1);
                let cur = self.cursor_row;
                self.rows.retain(|&r, _| r >= cur);
            }
            // Whole screen (2) and screen+scrollback (3) — no scrollback
            // model here, so both just clear everything tracked.
            _ => self.rows.clear(),
        }
    }
}

fn csi_param(params: &Params, index: usize) -> Option<i64> {
    params
        .iter()
        .nth(index)
        .and_then(|sub| sub.first())
        .map(|&v| v as i64)
}

/// A movement/position count of `0` means "1" per ECMA-48 (CSI params
/// default to 1, and an explicit `0` is treated the same as omitted) —
/// distinct from erase-mode params, where `0` is a real, distinct mode
/// (see [`csi_param`] used directly for those).
fn csi_count(params: &Params, index: usize) -> i64 {
    match csi_param(params, index) {
        Some(0) | None => 1,
        Some(n) => n,
    }
}

impl Perform for ScreenState {
    fn print(&mut self, c: char) {
        self.put_char(c);
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            b'\r' => self.cursor_col = 0,
            b'\n' => {
                self.last_completed_row = Some(self.cursor_row);
                self.cursor_row += 1;
                self.prune();
            }
            0x08 => self.cursor_col = self.cursor_col.saturating_sub(1),
            0x09 => self.cursor_col = (self.cursor_col / 8 + 1) * 8,
            _ => {}
        }
    }

    fn csi_dispatch(
        &mut self,
        params: &Params,
        _intermediates: &[u8],
        _ignore: bool,
        action: char,
    ) {
        match action {
            'H' | 'f' => {
                self.cursor_row = csi_count(params, 0) - 1;
                self.cursor_col = (csi_count(params, 1) - 1).max(0) as usize;
            }
            'A' => self.cursor_row -= csi_count(params, 0),
            'B' => self.cursor_row += csi_count(params, 0),
            'C' => self.cursor_col += csi_count(params, 0) as usize,
            'D' => {
                self.cursor_col = self
                    .cursor_col
                    .saturating_sub(csi_count(params, 0) as usize)
            }
            'G' | '`' => self.cursor_col = (csi_count(params, 0) - 1).max(0) as usize,
            'd' => self.cursor_row = csi_count(params, 0) - 1,
            'K' => self.erase_in_line(csi_param(params, 0).unwrap_or(0)),
            'J' => self.erase_in_display(csi_param(params, 0).unwrap_or(0)),
            _ => {}
        }
        self.prune();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_ending_in_crlf_becomes_a_completed_row() {
        let mut m = CursorModel::new();
        m.feed(b"hello world\r\n");
        assert_eq!(m.take_command_line(), "hello world");
    }

    #[test]
    fn cup_repositioning_writes_to_a_different_row_than_the_completed_one() {
        let mut m = CursorModel::new();
        m.feed(b"prompt$ cmd\r\n");
        // Jump elsewhere and write unrelated content — a status-bar-style
        // redraw with no newline of its own.
        m.feed(b"\x1b[24;1H\x1b[Kstatus noise, no newline");
        assert_eq!(m.take_command_line(), "prompt$ cmd");
    }

    #[test]
    fn mode_toggle_csi_never_becomes_printed_text() {
        let mut m = CursorModel::new();
        m.feed(b"prompt$ cmd\x1b[?2004l\r\n");
        assert_eq!(m.take_command_line(), "prompt$ cmd");
    }

    #[test]
    fn take_resets_so_a_stale_row_is_not_reused() {
        let mut m = CursorModel::new();
        m.feed(b"first\r\n");
        assert_eq!(m.take_command_line(), "first");
        // No newline since the take — nothing new completed.
        m.feed(b"partial, no newline yet");
        assert_eq!(m.take_command_line(), "partial, no newline yet");
    }

    #[test]
    fn no_fresh_activity_since_last_take_returns_empty_not_stale_content() {
        // Reproduces a real regression measured against a real tmux+zsh
        // session: tmux repositions the cursor back onto a row that still
        // holds a PREVIOUS, unrelated command's leftover text (the real
        // echo for THIS cycle hasn't arrived on the wire yet — tmux's own
        // redraw-burst reordering, the same class of jitter documented in
        // `session_history.rs`). Falling back to "whatever's on the
        // cursor's current row" would misattribute that stale text; empty
        // is the honest answer when nothing new happened this cycle.
        let mut m = CursorModel::new();
        m.feed(b"echo one\r\n");
        assert_eq!(m.take_command_line(), "echo one");
        // Reposition onto row 0 (the row "echo one" occupied) without
        // printing or completing anything new.
        m.feed(b"\x1b[1;1H");
        assert_eq!(m.take_command_line(), "");
    }

    #[test]
    fn erase_in_line_truncates_from_cursor() {
        let mut m = CursorModel::new();
        m.feed(b"0123456789");
        m.feed(b"\x1b[5G"); // column 5 (1-based) -> index 4
        m.feed(b"\x1b[K"); // erase to end of line
        m.feed(b"\r\n");
        assert_eq!(m.take_command_line(), "0123");
    }
}
