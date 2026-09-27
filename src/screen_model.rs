//! The recorder's screen model (issue #315). A full-screen app on the pane's
//! alternate screen repaints constantly, so recording its bytes as they flow
//! lands the same lines in the conversation dozens of times. This runs the
//! stream through a VT screen (`vt100`) and hands back two kinds of piece:
//! bytes drawn on the normal screen, verbatim, for the segmenter to record as
//! it always has; and lines of alternate-screen text, each at most once,
//! taken from what the screen shows rather than from the bytes that drew it.
//!
//! Alternate-screen lines come from a snapshot of the visible rows, taken
//! when the caller asks (quiet time, an OSC 133 marker, detach) and right
//! before the app leaves the alternate screen, plus any row a linefeed
//! scrolls off the top in between. The alternate grid keeps no scrollback,
//! so that row would otherwise be gone before the next snapshot.

use std::collections::{HashSet, VecDeque};

const ALT_SWITCHES: [&[u8]; 6] = [
    b"\x1b[?1049h",
    b"\x1b[?1049l",
    b"\x1b[?1047h",
    b"\x1b[?1047l",
    b"\x1b[?47h",
    b"\x1b[?47l",
];

const ALT_EXITS: [&[u8]; 3] = [b"\x1b[?1049l", b"\x1b[?1047l", b"\x1b[?47l"];

/// Lines already recorded, remembered so a repaint never records them twice.
/// Bounded for a long-lived session; the oldest are forgotten first.
const SEEN_LINES_CAP: usize = 4096;

#[derive(Debug, PartialEq)]
pub enum Drawn {
    Normal(Vec<u8>),
    Lines(Vec<String>),
}

pub struct ScreenModel {
    parser: vt100::Parser,
    held: Vec<u8>,
    dirty: bool,
    scrolled_off: Vec<String>,
    seen: HashSet<String>,
    seen_order: VecDeque<String>,
}

impl ScreenModel {
    pub fn new(rows: u16, cols: u16) -> Self {
        Self {
            parser: vt100::Parser::new(rows.max(1), cols.max(1), 0),
            held: Vec::new(),
            dirty: false,
            scrolled_off: Vec::new(),
            seen: HashSet::new(),
            seen_order: VecDeque::new(),
        }
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.parser.screen_mut().set_size(rows.max(1), cols.max(1));
    }

    pub fn assume_alternate_screen(&mut self) {
        if !self.alternate() {
            self.parser.process(b"\x1b[?1049h");
        }
    }

    /// Alternate-screen content has been drawn since the last snapshot.
    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Drawn> {
        let mut buf = std::mem::take(&mut self.held);
        buf.extend_from_slice(bytes);
        let keep = held_tail_start(&buf);
        self.held = buf.split_off(keep);
        let mut drawn = Vec::new();
        let mut start = 0;
        while start < buf.len() {
            let end = buf[start + 1..]
                .iter()
                .position(|&b| b == 0x1b)
                .map_or(buf.len(), |p| start + 1 + p);
            self.draw_run(&buf[start..end], &mut drawn);
            start = end;
        }
        drawn
    }

    /// Draws a partial escape `feed` held back for its next call.
    pub fn release_held(&mut self) -> Vec<Drawn> {
        let held = std::mem::take(&mut self.held);
        let mut drawn = Vec::new();
        if !held.is_empty() {
            self.draw_run(&held, &mut drawn);
        }
        drawn
    }

    /// The alternate-screen lines not recorded yet, or `None` when nothing
    /// new was drawn since the last snapshot.
    pub fn snapshot(&mut self) -> Option<Vec<String>> {
        if !self.dirty {
            return None;
        }
        self.dirty = false;
        let mut candidates = std::mem::take(&mut self.scrolled_off);
        let screen = self.parser.screen();
        if screen.alternate_screen() {
            let (_, cols) = screen.size();
            candidates.extend(screen.rows(0, cols).map(|row| row.trim_end().to_string()));
        }
        let lines: Vec<String> = candidates
            .into_iter()
            .filter(|line| !line.is_empty() && self.remember(line))
            .collect();
        (!lines.is_empty()).then_some(lines)
    }

    fn alternate(&self) -> bool {
        self.parser.screen().alternate_screen()
    }

    fn draw_run(&mut self, run: &[u8], drawn: &mut Vec<Drawn>) {
        if self.alternate() && ALT_EXITS.iter().any(|exit| run.starts_with(exit)) {
            if let Some(lines) = self.snapshot() {
                drawn.push(Drawn::Lines(lines));
            }
        }
        self.process(run);
        if self.alternate() {
            self.dirty = true;
            return;
        }
        match drawn.last_mut() {
            Some(Drawn::Normal(bytes)) => bytes.extend_from_slice(run),
            _ => drawn.push(Drawn::Normal(run.to_vec())),
        }
    }

    fn process(&mut self, run: &[u8]) {
        let mut rest = run;
        while let Some(i) = rest.iter().position(|&b| b == b'\n') {
            self.parser.process(&rest[..i]);
            self.capture_scroll_off();
            self.parser.process(b"\n");
            rest = &rest[i + 1..];
        }
        self.parser.process(rest);
    }

    fn capture_scroll_off(&mut self) {
        let screen = self.parser.screen();
        if !screen.alternate_screen() {
            return;
        }
        let (rows, cols) = screen.size();
        if screen.cursor_position().0 + 1 != rows {
            return;
        }
        let top = screen.rows(0, cols).next().unwrap_or_default();
        let top = top.trim_end();
        if !top.is_empty() {
            self.scrolled_off.push(top.to_string());
            self.dirty = true;
        }
    }

    fn remember(&mut self, line: &str) -> bool {
        if !self.seen.insert(line.to_string()) {
            return false;
        }
        self.seen_order.push_back(line.to_string());
        while self.seen_order.len() > SEEN_LINES_CAP {
            if let Some(old) = self.seen_order.pop_front() {
                self.seen.remove(&old);
            }
        }
        true
    }
}

/// Where a trailing partial alternate-screen switch starts, so `feed` can
/// hold it for the next call and still see the whole switch at the start of
/// one run. `buf.len()` when the tail is no such prefix.
fn held_tail_start(buf: &[u8]) -> usize {
    let Some(esc) = buf.iter().rposition(|&b| b == 0x1b) else {
        return buf.len();
    };
    let tail = &buf[esc..];
    let partial = ALT_SWITCHES
        .iter()
        .any(|switch| switch.len() > tail.len() && switch.starts_with(tail));
    if partial {
        esc
    } else {
        buf.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normal_bytes(drawn: &[Drawn]) -> Vec<u8> {
        drawn
            .iter()
            .filter_map(|d| match d {
                Drawn::Normal(b) => Some(b.clone()),
                Drawn::Lines(_) => None,
            })
            .flatten()
            .collect()
    }

    fn lines(drawn: &[Drawn]) -> Vec<String> {
        drawn
            .iter()
            .filter_map(|d| match d {
                Drawn::Lines(l) => Some(l.clone()),
                Drawn::Normal(_) => None,
            })
            .flatten()
            .collect()
    }

    #[test]
    fn normal_screen_bytes_pass_through_verbatim() {
        let mut screen = ScreenModel::new(24, 80);
        let drawn = screen.feed(b"hello \x1b[1mworld\x1b[0m\r\n");
        assert_eq!(normal_bytes(&drawn), b"hello \x1b[1mworld\x1b[0m\r\n");
        assert!(!screen.is_dirty());
    }

    #[test]
    fn lines_scrolled_off_the_alternate_screen_are_kept() {
        let mut screen = ScreenModel::new(5, 40);
        let mut body = String::from("\x1b[?1049h");
        for i in 1..=12 {
            body.push_str(&format!("line-{i}\r\n"));
        }
        body.push_str("\x1b[?1049ldone\r\n");
        let drawn = screen.feed(body.as_bytes());
        let expected: Vec<String> = (1..=12).map(|i| format!("line-{i}")).collect();
        assert_eq!(lines(&drawn), expected);
        assert_eq!(normal_bytes(&drawn), b"\x1b[?1049ldone\r\n");
    }

    #[test]
    fn an_exit_split_across_feeds_still_snapshots_first() {
        let mut screen = ScreenModel::new(5, 40);
        let mut drawn = screen.feed(b"\x1b[?1049hpainted\x1b");
        drawn.extend(screen.feed(b"[?1049"));
        drawn.extend(screen.feed(b"lafter"));
        assert_eq!(lines(&drawn), vec!["painted".to_string()]);
        assert_eq!(normal_bytes(&drawn), b"\x1b[?1049lafter");
    }
}
