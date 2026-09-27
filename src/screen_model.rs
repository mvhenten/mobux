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
//! screen, before a resize, and whenever enough scrolled-off rows pile up.
//! Rows that leave the screen in between are kept as they go, because the
//! alternate grid keeps no scrollback: off the top of the scroll region by a
//! linefeed, `ESC D` or `ESC E` on its bottom row, by `CSI S` or by `CSI M`;
//! off its bottom by `ESC M` on its top row, by `CSI T` or by `CSI L`.
//!
//! A snapshot is those rows followed by the visible rows, and is compared
//! with the previous snapshot only. A row is already seen when the previous
//! snapshot holds the same text at the same screen row, or at the shift
//! where the most rows agree that way — which is how a scroll lines up, and
//! how text scrolling above a fixed input box and footer lines up at the
//! shift while the footer lines up in place. A shift only counts when its
//! agreeing rows outnumber the rows it contradicts, and a scroll (any shift
//! but in place) needs at least two rows agreeing at the shift itself; with
//! no such shift the screen is a different one and every row of it is new,
//! so a second screen of code keeps its closing brace. A snapshot with
//! nothing new leaves the previous one in place; leaving the alternate
//! screen forgets it.
//!
//! A spinner or timer line that is rewritten in place is recorded again at
//! each snapshot it changed in, at most every few seconds.
//!
//! `vt100` keeps the scroll region private, so this mirrors it: `CSI r`, the
//! grid clear on `?1049h`, `ESC c` and a resize, applied the same way.
//! `vt100` ignores `ESC D` and `ESC E`, so they are drawn as the linefeed and
//! carriage return plus linefeed they stand for.

/// Scrolled-off rows held before a snapshot is forced, bounding memory
/// while an app scrolls without ever going quiet.
const SCROLLED_OFF_CAP: usize = 500;

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
    previous: Vec<String>,
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
            previous: Vec::new(),
            regions: [Region::full(rows); 2],
        }
    }

    pub fn size(&self) -> (u16, u16) {
        self.parser.screen().size()
    }

    /// Resizes the model, first snapshotting what a smaller screen would
    /// cut off.
    pub fn resize(&mut self, rows: u16, cols: u16) -> Option<Vec<String>> {
        let (rows, cols) = (rows.max(1), cols.max(1));
        let (old_rows, old_cols) = self.size();
        if (rows, cols) == (old_rows, old_cols) {
            return None;
        }
        let lines = self.snapshot();
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
        lines
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

    /// The alternate-screen lines the previous snapshot does not hold, or
    /// `None` when nothing new was drawn since it.
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
        if candidate.iter().all(String::is_empty) {
            return None;
        }
        let new = new_rows(&self.previous, &candidate);
        if new.is_empty() {
            return None;
        }
        self.previous = candidate;
        Some(new)
    }

    fn alternate(&self) -> bool {
        self.parser.screen().alternate_screen()
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
        match lead {
            Lead::Esc { byte: b'D' } => self.process_text(b"\n"),
            Lead::Esc { byte: b'E' } => self.process_text(b"\r\n"),
            _ => {
                if was_alternate {
                    self.capture_lead_scroll(&lead);
                }
                self.process_lead(&run[..lead_len]);
            }
        }
        self.track_region(&lead);
        self.process_text(&run[lead_len..]);

        if self.alternate() != was_alternate {
            self.previous.clear();
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

    /// Rows the lead escape is about to push off the screen: `CSI S`, `CSI M`
    /// and `ESC M`, `CSI T`, `CSI L`, the way `vt100` applies them.
    fn capture_lead_scroll(&mut self, lead: &Lead) {
        let region = self.regions[1];
        let (row, _) = self.parser.screen().cursor_position();
        let count = lead.param(0).max(1);
        let in_region = (region.top..=region.bottom).contains(&row);
        if lead.is_csi(false, b'S') {
            self.capture_scroll_up(count);
        } else if lead.is_csi(false, b'M') && in_region {
            let end = region.bottom.min(row.saturating_add(count - 1));
            self.capture_rows(row, end);
        } else if matches!(lead, Lead::Esc { byte: b'M' }) && row == region.top {
            self.capture_rows(region.bottom, region.bottom);
        } else if lead.is_csi(false, b'T') {
            let start = region.top.max((region.bottom + 1).saturating_sub(count));
            self.capture_rows(start, region.bottom);
        } else if lead.is_csi(false, b'L') && row <= region.bottom {
            let start = row.max((region.bottom + 1).saturating_sub(count));
            self.capture_rows(start, region.bottom);
        }
    }

    fn capture_scroll_up(&mut self, count: u16) {
        let region = self.regions[1];
        let end = region.bottom.min(region.top.saturating_add(count - 1));
        self.capture_rows(region.top, end);
    }

    fn capture_rows(&mut self, start: u16, end: u16) {
        let (_, cols) = self.size();
        let lost: Vec<String> = self
            .parser
            .screen()
            .rows(0, cols)
            .skip(usize::from(start))
            .take(usize::from(end.saturating_sub(start)) + 1)
            .map(|row| row.trim_end().to_string())
            .collect();
        self.scrolled_off.extend(lost);
        self.dirty = true;
    }
}

/// The non-blank rows of `candidate` that `previous` holds neither at the
/// same screen row nor at the best shift — or all of them when no shift
/// lines up (a different screen). Both snapshots end with the visible rows,
/// so the same screen row is the same distance from the end.
fn new_rows(previous: &[String], candidate: &[String]) -> Vec<String> {
    let (p, c) = (previous.len() as isize, candidate.len() as isize);
    let in_place = c - p;
    let at = |i: isize| (0..p).contains(&i).then(|| &previous[i as usize]);
    let seen = |j: isize, shift: isize| {
        let now = &candidate[j as usize];
        at(j - shift) == Some(now) || at(j - in_place) == Some(now)
    };
    type Rank = (usize, std::cmp::Reverse<usize>, std::cmp::Reverse<isize>);
    let mut best: Option<(isize, Rank)> = None;
    for shift in (1 - p)..c {
        let (mut agree, mut agree_at_shift, mut differ) = (0, 0, 0);
        for j in 0..c {
            let now = &candidate[j as usize];
            if now.is_empty() {
                continue;
            }
            if at(j - shift) == Some(now) {
                agree_at_shift += 1;
            }
            if seen(j, shift) {
                agree += 1;
            } else if at(j - shift).is_some_and(|was| !was.is_empty()) {
                differ += 1;
            }
        }
        let lines_up = agree > differ && (shift == in_place || agree_at_shift >= 2);
        if !lines_up {
            continue;
        }
        let rank = (
            agree,
            std::cmp::Reverse(differ),
            std::cmp::Reverse((shift - in_place).abs()),
        );
        if best.as_ref().is_none_or(|(_, best_rank)| rank > *best_rank) {
            best = Some((shift, rank));
        }
    }
    (0..c)
        .filter(|&j| {
            !candidate[j as usize].is_empty()
                && best.as_ref().is_none_or(|(shift, _)| !seen(j, *shift))
        })
        .map(|j| candidate[j as usize].clone())
        .collect()
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

    fn screen(body: &str) -> String {
        format!("\x1b[H\x1b[2J{body}")
    }

    #[test]
    fn shrinking_the_screen_records_the_rows_it_cuts_off_first() {
        let mut model = ScreenModel::new(6, 40);
        model.feed(b"\x1b[?1049hfresh-1\r\nfresh-2\r\nfresh-3\r\nfresh-4\r\nfresh-5\r\nfresh-6");
        assert_eq!(model.resize(4, 40), Some(numbered("fresh", 6)));
        assert_eq!(model.size(), (4, 40));
        assert_eq!(
            model.resize(4, 40),
            None,
            "an unchanged size records nothing"
        );
    }

    #[test]
    fn index_reverse_index_and_line_insert_delete_keep_the_rows_they_push_off() {
        // Rows 1-3 scroll, row 4 is a status line. ncurses scrolls with
        // ESC D on the bottom row and CSI M at the top, and the other way
        // with ESC M on the top row and CSI L.
        let mut model = ScreenModel::new(4, 40);
        let mut body = String::from("\x1b[?1049h\x1b[1;3r\x1b[4;1Hstatus");
        for i in 1..=4 {
            body.push_str(&format!("\x1b[3;1Hrow-{i}\x1bD"));
        }
        body.push_str("\x1b[3;1Hind-1\x1bD\x1b[3;1Hind-2\x1bD");
        body.push_str("\x1b[1;1H\x1b[2M");
        body.push_str("\x1b[3;1Hri-1\x1b[1;1H\x1bM");
        body.push_str("\x1b[3;1Hil-1\x1b[2;1H\x1b[2L");
        body.push_str("\x1b[?1049l");
        let mut expected = numbered("row", 4);
        expected.extend(["ind-1", "ind-2", "ri-1", "il-1", "status"].map(String::from));
        assert_eq!(lines(&model.feed(body.as_bytes())), expected);
    }

    #[test]
    fn a_second_screen_of_code_keeps_its_closing_brace() {
        let mut model = ScreenModel::new(10, 40);
        model.feed(b"\x1b[?1049h");
        model.feed(screen("fn a() {\r\n    let x = 1;\r\n}").as_bytes());
        assert_eq!(
            model.snapshot(),
            Some(
                ["fn a() {", "    let x = 1;", "}"]
                    .map(String::from)
                    .to_vec()
            )
        );
        let drawn = model.feed(screen("fn b() {\r\n    let y = 2;\r\n}").as_bytes());
        assert!(lines(&drawn).is_empty(), "{drawn:?}");
        assert_eq!(
            model.snapshot(),
            Some(
                ["fn b() {", "    let y = 2;", "}"]
                    .map(String::from)
                    .to_vec()
            )
        );
    }

    #[test]
    fn test_output_shown_again_after_a_different_screen_is_recorded_again() {
        let tests = "test one ... ok\r\ntest two ... ok\r\n2 passed";
        let expected: Vec<String> = ["test one ... ok", "test two ... ok", "2 passed"]
            .map(String::from)
            .to_vec();
        let mut model = ScreenModel::new(10, 40);
        model.feed(b"\x1b[?1049h");
        model.feed(screen(tests).as_bytes());
        assert_eq!(model.snapshot(), Some(expected.clone()));
        model.feed(screen("usage: app [options]\r\n  --help").as_bytes());
        assert!(model.snapshot().is_some());
        model.feed(screen(tests).as_bytes());
        assert_eq!(model.snapshot(), Some(expected));
    }

    #[test]
    fn a_line_shown_twice_within_one_run_is_recorded_twice() {
        let mut model = ScreenModel::new(10, 40);
        model.feed(b"\x1b[?1049h");
        model.feed(screen("ok\r\nok\r\nPASS\r\nok").as_bytes());
        assert_eq!(
            model.snapshot(),
            Some(["ok", "ok", "PASS", "ok"].map(String::from).to_vec())
        );
        model.feed(screen("build started\r\nok").as_bytes());
        assert_eq!(
            model.snapshot(),
            Some(["build started", "ok"].map(String::from).to_vec())
        );
        model.feed(screen("build finished\r\nok").as_bytes());
        assert_eq!(
            model.snapshot(),
            Some(["build finished", "ok"].map(String::from).to_vec())
        );
    }

    #[test]
    fn text_scrolling_above_a_fixed_footer_records_only_the_new_text() {
        // Claude Code's layout: text scrolls in rows 1-5 above an input box
        // and a footer that stay put in rows 6-8.
        let footer = ["+-----+", "| > |", "? help"].map(String::from);
        let mut model = ScreenModel::new(8, 40);
        let mut body = String::from("\x1b[?1049h\x1b[1;5r");
        for (i, row) in footer.iter().enumerate() {
            body.push_str(&format!("\x1b[{};1H{row}", i + 6));
        }
        for i in 1..=5 {
            body.push_str(&format!("\x1b[{i};1Ht-{i}"));
        }
        model.feed(body.as_bytes());
        let mut first = numbered("t", 5);
        first.extend(footer.iter().cloned());
        assert_eq!(model.snapshot(), Some(first));

        model.feed(b"\x1b[5;1H\nt-6\x1b[5;1H\nt-7");
        assert_eq!(
            model.snapshot(),
            Some(["t-6", "t-7"].map(String::from).to_vec()),
            "a linefeed in the region"
        );

        let mut redraw = String::new();
        for (row, i) in (5..=9).enumerate() {
            redraw.push_str(&format!("\x1b[{};1Ht-{i}\x1b[K", row + 1));
        }
        model.feed(redraw.as_bytes());
        assert_eq!(
            model.snapshot(),
            Some(["t-8", "t-9"].map(String::from).to_vec()),
            "a redraw two rows further down"
        );
    }

    #[test]
    fn a_repaint_of_the_same_screen_records_nothing() {
        let mut model = ScreenModel::new(10, 40);
        model.feed(b"\x1b[?1049h");
        model.feed(screen("same\r\nscreen").as_bytes());
        assert!(model.snapshot().is_some());
        model.feed(screen("same\r\nscreen").as_bytes());
        assert_eq!(model.snapshot(), None);
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
