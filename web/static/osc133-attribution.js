// OSC 133 ; A (prompt-start) row attribution.
//
// The problem this solves: the cursor row *at the instant* an OSC 133;A
// sequence is parsed is not trustworthy under tmux. tmux forwards pane
// output in bursts bracketed by its own mode-reset/cursor-position
// boilerplate, and those bursts don't necessarily arrive in the same order
// their content was originally written to the pty — a burst can carry
// stale, already-on-screen content (a redraw) ahead of the marker's own
// fresh prompt text, or the marker's own text can simply not have arrived
// yet. Trusting whichever text shows up *first* after the marker (an
// earlier, simpler version of this fix) attributes it to that stale
// content instead.
//
// The fix: within one incoming chunk, scan everything from the marker up to
// (not past) the NEXT A marker for visible text, and take the LAST run
// found in that bounded span rather than the first — a later run
// supersedes an earlier one, so stale content that happened to arrive
// ahead of the real prompt text (both still within the same burst) loses
// to it. As soon as any candidate is found, commit it immediately — don't
// keep watching for a "better" one in a later, unrelated chunk (typed
// command echo, that command's own output): once a candidate exists it's
// trusted, which is what keeps that later, unrelated content from
// overwriting an already-correct attribution. If nothing is found at all
// in the current chunk (the marker arrived in its own lone envelope with
// no trailing text — zsh's structural case), the cycle stays open and
// retries fresh against the next chunk. This never withholds anything from
// rendering — every byte is written to the renderer as soon as it's
// available; only the bookkeeping (which row counts as "the" prompt row)
// is deferred.
//
// Marker kinds B/C/D only close the search once a candidate already exists.
// tmux does not reliably deliver B/C/D relative to the prompt's own text on
// the wire (B routinely arrives BEFORE the text it nominally closes), so
// treating it as an unconditional stop would drop legitimate same-write
// resolutions (bash's common case) whenever it precedes the real text.
// But once real text HAS been found, any of B/C/D marks a genuine end to
// this prompt's own text-drawing window (a new command starting or
// finishing) — not stopping there would let unrelated content that rides
// the very same write (no tmux reordering involved, so nothing arrives out
// of order) get compared against an already-good candidate. A fresh A
// always closes the search unconditionally regardless of any candidate: a
// prompt's own text can never legitimately appear beyond the start of the
// next cycle, which is what stops a burst containing several complete
// prompt cycles from collapsing onto the last one's row (the bash-stress
// regression a reverted prototype had).

// Matches a bare OSC 133;A sequence, BEL- or ST-terminated — the exact wire
// form the server relays (it always sends WS Text frames built from
// `String::from_utf8_lossy`, and tmux has already unwrapped its own DCS
// passthrough envelope by the time bytes reach the client — see
// src/shell_integration.rs).
const OSC_133_A_RE = /\x1b\]133;A(?:\x07|\x1b\\)/g;
// Matches any OSC 133 marker, capturing its kind letter.
const OSC_133_KIND_RE = /^\x1b\]133;([A-Za-z])/;

// A CSI sequence: ESC [ params intermediates final. Sticky so it only
// matches starting exactly at lastIndex.
const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/y;
// Any OSC sequence (window title, OSC 133 of any kind, …), BEL- or
// ST-terminated. Sticky, same reason.
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;

function isSkippableControl(code) {
  // BEL, BS, NUL, SO, SI, VT, FF — control bytes that don't print a glyph
  // and don't change row. \r and \n are handled separately (they DO change
  // row, but only reset the "currently tracking a visible run" state — see
  // scanForNextAAndCandidate).
  return (
    code === 0x07 ||
    code === 0x08 ||
    code === 0x00 ||
    code === 0x0e ||
    code === 0x0f ||
    code === 0x0b ||
    code === 0x0c
  );
}

// Find the first OSC 133;A sequence at or after `fromIndex`. Returns the
// string index immediately after its terminator, or -1 if none is found in
// the data available so far (a marker split across two WS messages is
// handled by simply not finding it here yet — the caller re-scans the next
// chunk fresh).
export function findOsc133AEnd(str, fromIndex = 0) {
  OSC_133_A_RE.lastIndex = fromIndex;
  const m = OSC_133_A_RE.exec(str);
  return m ? OSC_133_A_RE.lastIndex : -1;
}

// Scans `text` from `start`, while an A marker's cycle is open, for two
// things at once — see the module doc comment above for the full
// reasoning:
//   - `candidateEnd`: the end of the LAST visible-text run seen before the
//     search stops (a later run supersedes an earlier one within the same
//     scan, so real prompt text wins over an out-of-order tmux redraw of
//     stale content preceding it). `candidateEnd === start` means none was
//     found yet.
//   - `nextAEnd`: where the next A marker ends, if the search stopped
//     because one was found, else -1 (stopped for another reason — ran out
//     of data, or a B/C/D closed an already-nonempty candidate).
export function scanForNextAAndCandidate(text, start) {
  let i = start;
  const len = text.length;
  let sawVisible = false;
  let candidateEnd = start;

  while (i < len) {
    const code = text.charCodeAt(i);

    if (code === 0x1b /* ESC */) {
      CSI_RE.lastIndex = i;
      const csi = CSI_RE.exec(text);
      if (csi && csi.index === i) {
        i += csi[0].length;
        continue;
      }
      OSC_RE.lastIndex = i;
      const osc = OSC_RE.exec(text);
      if (osc && osc.index === i) {
        const kindMatch = OSC_133_KIND_RE.exec(osc[0]);
        if (kindMatch && kindMatch[1] === "A") {
          return { candidateEnd, nextAEnd: i + osc[0].length };
        }
        // B/C/D: on the real wire these are unreliable as a boundary — B in
        // particular routinely arrives BEFORE the prompt text it nominally
        // closes (tmux redraw reordering), so treating it as a stop before
        // any candidate has been found would drop the real text once it
        // does show up. But once a candidate DOES exist, any of these
        // marks a legitimate end to this prompt's own text-drawing window
        // (a new command starting, or finishing) — stopping there prevents
        // whatever comes after from being compared against an
        // already-good candidate, which matters when a marker rides the
        // exact same write as its own following B, C, or D (no tmux
        // reordering involved at all, so nothing DOES arrive out of
        // order).
        if (kindMatch && candidateEnd !== start) {
          return { candidateEnd, nextAEnd: -1 };
        }
        i += osc[0].length;
        continue;
      }
      // An introduced-but-not-yet-terminated CSI/OSC, or a lone ESC at the
      // very end of the data — nothing more can be learned from this chunk
      // past this point. Stop here; the caller retries once more data
      // arrives, folding these last couple of bytes back in as ordinary
      // text (a marker's own introducer never legitimately looks like
      // this, so misreading it as text on a future retry is harmless).
      const next = text[i + 1];
      if (next === "[" || next === "]") {
        return { candidateEnd, nextAEnd: -1 };
      }
      i += i + 1 < len ? 2 : 1;
      continue;
    }

    if (code === 0x0d /* \r */ || code === 0x0a /* \n */) {
      if (sawVisible) candidateEnd = i;
      sawVisible = false;
      i += 1;
      continue;
    }

    if (isSkippableControl(code)) {
      i += 1;
      continue;
    }

    sawVisible = true;
    i += 1;
  }

  if (sawVisible) candidateEnd = i;
  return { candidateEnd, nextAEnd: -1 };
}
