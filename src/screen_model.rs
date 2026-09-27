//! The recorder's screen model (issue #315). A full-screen app on the pane's
//! alternate screen repaints constantly, so recording its bytes as they flow
//! lands the same lines in the conversation dozens of times. This runs the
//! stream through a VT screen (`vt100`) and hands back two kinds of piece:
//! bytes drawn on the normal screen, verbatim, for the segmenter to record as
//! it always has; and lines of alternate-screen text, taken from what the
//! screen shows rather than from the bytes that drew it.
//!
//! A snapshot is taken when the caller asks (quiet time, a marker, detach),
//! right before the app clears the screen, re-enters or leaves the alternate
//! screen, and whenever enough scrolled-off rows pile up. Rows scrolled off
//! the top of the scroll region in between — by a linefeed on its bottom row
//! or by `CSI S` — are kept as they go, because the alternate grid keeps no
//! scrollback. Each snapshot is diffed against the recent snapshots, line by
//! line in order, so an unchanged repaint records nothing while a screen
//! that really shows `ok` three times records it three times. Leaving the
//! alternate screen forgets the recent snapshots: the next app starts fresh.
//!
//! `vt100` keeps the scroll region private, so this mirrors it: `CSI r`, the
//! grid clear on `?1049h`, `ESC c` and a resize, applied the same way.

use std::collections::VecDeque;

/// Scrolled-off rows held before a snapshot is forced, bounding memory
/// while an app scrolls without ever going quiet.
const SCROLLED_OFF_CAP: usize = 500;

/// Lines of recent snapshots a new one is diffed against.
const RECENT_CAP: usize = 1000;

#[derive(Debug, PartialEq)]
pub enum Drawn {
    Normal(Vec<u8>),
    Lines(Vec<String>),
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Region {
    top: u16,
    bottom: u16,
}

impl Region {
    fn full(rows: u16) -> Self {
        Self {
            top: 0,
            bottom: rows.saturating_sub(1),
        }
    }
}

enum Lead {
    Csi {
        private: bool,
        intermediate: bool,
        params: Vec<u16>,
        final_byte: u8,
        len: usize,
    },
    Esc {
        byte: u8,
    },
    Other,
}

impl Lead {
    fn len(&self) -> usize {
        match self {
            Lead::Csi { len, .. } => *len,
            Lead::Esc { .. } => 2,
            Lead::Other => 0,
        }
    }

    fn param(&self, index: usize) -> u16 {
        match self {
            Lead::Csi { params, .. } => params.get(index).copied().unwrap_or(0),
            _ => 0,
        }
    }

    fn is_csi(&self, want_private: bool, want_final: u8) -> bool {
        matches!(self, Lead::Csi { private, intermediate: false, final_byte, .. }
            if *private == want_private && *final_byte == want_final)
    }

    fn is_alt_switch(&self, final_byte: u8) -> bool {
        self.is_csi(true, final_byte) && matches!(self.param(0), 47 | 1047 | 1049)
    }
}

pub struct ScreenModel {
    parser: vt100::Parser,
    held: Vec<u8>,
    dirty: bool,
    scrolled_off: Vec<String>,
    recent: VecDeque<String>,
    regions: [Region; 2],
}

impl ScreenModel {
    pub fn new(rows: u16, cols: u16) -> Self {
        let (rows, cols) = (rows.max(1), cols.max(1));
        Self {
            parser: vt100::Parser::new(rows, cols, 0),
            held: Vec::new(),
            dirty: false,
            scrolled_off: Vec::new(),
            recent: VecDeque::new(),
            regions: [Region::full(rows); 2],
        }
    }

    pub fn size(&self) -> (u16, u16) {
        self.parser.screen().size()
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        let (rows, cols) = (rows.max(1), cols.max(1));
        let (old_rows, _) = self.size();
        self.parser.screen_mut().set_size(rows, cols);
        for region in &mut self.regions {
            if region.bottom + 1 == old_rows {
                region.bottom = rows - 1;
            }
            region.bottom = region.bottom.min(rows - 1);
            if region.bottom < region.top {
                region.top = 0;
            }
        }
    }

    pub fn assume_alternate_screen(&mut self) {
        if !self.alternate() {
            self.process_lead(b"\x1b[?1049h");
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

    /// The alternate-screen lines the recent snapshots do not already hold,
    /// or `None` when nothing new was drawn since the last snapshot.
    pub fn snapshot(&mut self) -> Option<Vec<String>> {
        if !self.dirty {
            return None;
        }
        self.dirty = false;
        let mut candidate = std::mem::take(&mut self.scrolled_off);
        if self.alternate() {
            let (_, cols) = self.size();
            candidate.extend(
                self.parser
                    .screen()
                    .rows(0, cols)
                    .map(|row| row.trim_end().to_string()),
            );
        }
        candidate.retain(|line| !line.is_empty());
        if candidate.is_empty() || self.recent_ends_with(&candidate) {
            return None;
        }
        let new = unmatched(self.recent.make_contiguous(), &candidate);
        self.recent.extend(candidate);
        while self.recent.len() > RECENT_CAP {
            self.recent.pop_front();
        }
        (!new.is_empty()).then_some(new)
    }

    fn alternate(&self) -> bool {
        self.parser.screen().alternate_screen()
    }

    fn recent_ends_with(&self, candidate: &[String]) -> bool {
        candidate.len() <= self.recent.len()
            && self
                .recent
                .iter()
                .skip(self.recent.len() - candidate.len())
                .eq(candidate.iter())
    }

    fn push_snapshot(&mut self, drawn: &mut Vec<Drawn>) {
        if let Some(lines) = self.snapshot() {
            drawn.push(Drawn::Lines(lines));
        }
    }

    fn draw_run(&mut self, run: &[u8], drawn: &mut Vec<Drawn>) {
        let lead = parse_lead(run);
        let was_alternate = self.alternate();
        let new_frame = lead.is_alt_switch(b'h')
            || lead.is_alt_switch(b'l')
            || (lead.is_csi(false, b'J') && matches!(lead.param(0), 2 | 3));
        if was_alternate && new_frame {
            self.push_snapshot(drawn);
        }
        let lead_len = lead.len().min(run.len());
        if was_alternate && lead.is_csi(false, b'S') {
            self.capture_scroll_up(lead.param(0).max(1));
        }
        self.process_lead(&run[..lead_len]);
        self.track_region(&lead);
        self.process_text(&run[lead_len..]);

        if self.alternate() != was_alternate {
            self.recent.clear();
        }
        if self.alternate() {
            self.dirty = true;
            if self.scrolled_off.len() >= SCROLLED_OFF_CAP {
                self.push_snapshot(drawn);
            }
            return;
        }
        match drawn.last_mut() {
            Some(Drawn::Normal(bytes)) => bytes.extend_from_slice(run),
            _ => drawn.push(Drawn::Normal(run.to_vec())),
        }
    }

    fn process_lead(&mut self, lead: &[u8]) {
        self.parser.process(lead);
    }

    fn track_region(&mut self, lead: &Lead) {
        let (rows, _) = self.size();
        if matches!(lead, Lead::Esc { byte: b'c' }) {
            self.regions = [Region::full(rows); 2];
            return;
        }
        if lead.is_csi(true, b'h') && lead.param(0) == 1049 {
            self.regions[1] = Region::full(rows);
            return;
        }
        if !lead.is_csi(false, b'r') {
            return;
        }
        let top = lead.param(0).max(1) - 1;
        let bottom = match lead.param(1) {
            0 => rows,
            b => b,
        }
        .saturating_sub(1)
        .min(rows - 1);
        let grid = usize::from(self.alternate());
        self.regions[grid] = if top < bottom {
            Region { top, bottom }
        } else {
            Region::full(rows)
        };
    }

    fn process_text(&mut self, text: &[u8]) {
        let mut rest = text;
        while let Some(i) = rest.iter().position(|b| matches!(b, b'\n' | 0x0b | 0x0c)) {
            self.parser.process(&rest[..i]);
            let region = self.regions[1];
            if self.alternate() && self.parser.screen().cursor_position().0 == region.bottom {
                self.capture_scroll_up(1);
            }
            self.parser.process(&rest[i..=i]);
            rest = &rest[i + 1..];
        }
        self.parser.process(rest);
    }

    fn capture_scroll_up(&mut self, count: u16) {
        let region = self.regions[1];
        let (_, cols) = self.size();
        let end = region.bottom.min(region.top.saturating_add(count - 1));
        let lost: Vec<String> = self
            .parser
            .screen()
            .rows(0, cols)
            .skip(usize::from(region.top))
            .take(usize::from(end - region.top) + 1)
            .map(|row| row.trim_end().to_string())
            .filter(|row| !row.is_empty())
            .collect();
        if !lost.is_empty() {
            self.scrolled_off.extend(lost);
            self.dirty = true;
        }
    }
}

/// The candidate lines a longest common subsequence with `recent` leaves
/// unmatched, in order: what this snapshot shows that the recent ones did
/// not, counting a repeated line once per repeat.
fn unmatched(recent: &[String], candidate: &[String]) -> Vec<String> {
    let (n, m) = (recent.len(), candidate.len());
    let mut table = vec![0u16; (n + 1) * (m + 1)];
    let at = |i: usize, j: usize| i * (m + 1) + j;
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            table[at(i, j)] = if recent[i] == candidate[j] {
                table[at(i + 1, j + 1)] + 1
            } else {
                table[at(i + 1, j)].max(table[at(i, j + 1)])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut new = Vec::new();
    while j < m {
        if i < n && recent[i] == candidate[j] {
            i += 1;
            j += 1;
        } else if i < n && table[at(i + 1, j)] >= table[at(i, j + 1)] {
            i += 1;
        } else {
            new.push(candidate[j].clone());
            j += 1;
        }
    }
    new
}

fn parse_lead(run: &[u8]) -> Lead {
    if run.first() != Some(&0x1b) || run.len() < 2 {
        return Lead::Other;
    }
    if run[1] != b'[' {
        return Lead::Esc { byte: run[1] };
    }
    let mut i = 2;
    let private = run
        .get(i)
        .is_some_and(|b| matches!(b, b'?' | b'<' | b'=' | b'>'));
    if private {
        i += 1;
    }
    let params_start = i;
    while run.get(i).is_some_and(|b| (0x30..=0x3f).contains(b)) {
        i += 1;
    }
    let params_end = i;
    let mut intermediate = false;
    while run.get(i).is_some_and(|b| (0x20..=0x2f).contains(b)) {
        intermediate = true;
        i += 1;
    }
    let Some(&final_byte) = run.get(i).filter(|b| (0x40..=0x7e).contains(*b)) else {
        return Lead::Other;
    };
    let params = String::from_utf8_lossy(&run[params_start..params_end])
        .split(';')
        .map(|p| p.split(':').next().unwrap_or("").parse().unwrap_or(0))
        .collect();
    Lead::Csi {
        private,
        intermediate,
        params,
        final_byte,
        len: i + 1,
    }
}

/// Where a trailing partial escape starts, so `feed` can hold it for the
/// next call and still see the whole sequence at the start of one run.
/// `buf.len()` when the tail is no such prefix.
fn held_tail_start(buf: &[u8]) -> usize {
    let Some(esc) = buf.iter().rposition(|&b| b == 0x1b) else {
        return buf.len();
    };
    let tail = &buf[esc..];
    let partial_csi = tail.len() < 32
        && (tail.len() == 1
            || (tail[1] == b'[' && tail[2..].iter().all(|b| (0x20..=0x3f).contains(b))));
    if partial_csi {
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

    fn numbered(prefix: &str, count: usize) -> Vec<String> {
        (1..=count).map(|i| format!("{prefix}-{i}")).collect()
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
        assert_eq!(lines(&drawn), numbered("line", 12));
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

    #[test]
    fn a_scroll_region_above_a_status_line_keeps_every_scrolled_row() {
        // Rows 1-3 scroll, row 4 is a status line. Lines scroll away both by
        // a linefeed on the region's bottom row and by `CSI S`.
        let mut screen = ScreenModel::new(4, 40);
        let mut body = String::from("\x1b[?1049h\x1b[1;3r\x1b[4;1Hstatus");
        for i in 1..=6 {
            body.push_str(&format!("\x1b[3;1Hrow-{i}\n"));
        }
        for i in 1..=6 {
            body.push_str(&format!("\x1b[3;1Hnew-{i}\x1b[S"));
        }
        body.push_str("\x1b[?1049l");
        let drawn = screen.feed(body.as_bytes());
        let mut expected = numbered("row", 6);
        expected.extend(numbered("new", 6));
        expected.push("status".to_string());
        assert_eq!(lines(&drawn), expected);
    }

    #[test]
    fn a_line_the_screen_shows_twice_is_recorded_twice_and_again_next_run() {
        let run = b"\x1b[?1049h\x1b[H\x1b[2Jok\r\nok\r\nPASS\r\nok\x1b[?1049l";
        let mut screen = ScreenModel::new(10, 40);
        let expected: Vec<String> = ["ok", "ok", "PASS", "ok"].map(String::from).to_vec();
        assert_eq!(lines(&screen.feed(run)), expected);
        assert_eq!(
            lines(&screen.feed(run)),
            expected,
            "a second run records again"
        );
    }

    #[test]
    fn scrolled_off_rows_are_bounded_while_the_app_never_goes_quiet() {
        let mut screen = ScreenModel::new(5, 40);
        let mut recorded = lines(&screen.feed(b"\x1b[?1049h"));
        for i in 1..=2000 {
            recorded.extend(lines(&screen.feed(format!("line-{i}\r\n").as_bytes())));
            assert!(screen.scrolled_off.len() < SCROLLED_OFF_CAP);
        }
        recorded.extend(screen.snapshot().unwrap_or_default());
        assert_eq!(recorded, numbered("line", 2000));
    }
}
