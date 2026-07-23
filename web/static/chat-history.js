// Chat history — fetches the server-side conversation record (issue #220,
// `GET /api/sessions/{name}/conversation`) for the reader's chat view (issue
// #221) and keeps it in sync with newly-completed commands while mounted.
//
// This is the piece that decouples the reader from tmux scrollback: the
// server keeps every command this session ever ran (bounded by its own
// retention cap), independent of what the terminal engine's own bounded
// buffer still holds. reader.js renders `turns` for everything already
// flushed here, plus (from the live terminal document) whatever command is
// still in flight and hasn't landed in a `D` marker yet — see reader.js's
// `mergeTurns`.
//
// Nothing here is persisted client-side (#215) — `turns` lives only for the
// lifetime of one mount; every mount re-fetches from the server.

// Mirrors session_history.rs's MAX_LIMIT — the largest page the server will
// hand back in one call.
const PAGE_LIMIT = 500;

// Strips ANSI/control bytes from a command's `output` (and a raw entry's
// text), which the server stores verbatim (`output = bytes until D`, no
// stripping — see session_history.rs's module doc). `command` itself is
// already plain text server-side (built from the cursor model's parsed
// characters, not raw bytes) but running it through here too is harmless.
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const DCS_RE = /\x1bP[^\x1b]*\x1b\\/g;
// Generic ECMA-48 "Fe"/"nF" escape: ESC, zero or more intermediate bytes
// (0x20-0x2F), one final byte (0x30-0x7E). Covers everything CSI_RE/OSC_RE/
// DCS_RE don't already special-case above — charset designation (bash/
// readline's `ESC ( B` resetting G0 to ASCII, seen after nearly every
// command), RIS (`ESC c`), DECKPAM/DECKPNM (`ESC =` / `ESC >`), etc. Must
// run after the three above (it would otherwise also match their own
// opening bytes and leave the rest of a longer sequence behind).
const FE_RE = /\x1b[\x20-\x2f]*[\x30-\x7e]/g;
// Remaining C0 control bytes, excluding \t and \n (checked separately below).
const C0_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function stripAnsi(text) {
  if (!text) return "";
  return text
    .replace(OSC_RE, "")
    .replace(DCS_RE, "")
    .replace(CSI_RE, "")
    .replace(FE_RE, "")
    .replace(C0_RE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function toTurn(entry) {
  if ("command" in entry) {
    return {
      seq: entry.seq,
      kind: "command",
      command: stripAnsi(entry.command),
      output: stripAnsi(entry.output),
      exitCode: entry.exitCode,
    };
  }
  return {
    seq: entry.seq,
    kind: "raw",
    text: stripAnsi(entry.raw),
  };
}

// createChatHistory({ session, fetchImpl }) →
//   { loadAll(), refreshTail(), get turns() }
//
//   loadAll()      walks every page from the beginning (there is no
//                   reverse-pagination on the server — the cursor only
//                   resumes forward from a seq) until caught up, bounded by
//                   the server's retention cap (a handful of requests even
//                   at the cap). Populates `turns` in full.
//   refreshTail()   pulls anything appended since the last page this
//                   instance has seen — cheap, meant to be called
//                   opportunistically (e.g. once a live in-progress command
//                   closes) to pick up what the server just recorded.
//   turns           the current ordered (oldest-first) turn array. Never
//                   mutated in place — each successful fetch replaces it
//                   with a new array, so a caller holding a reference to an
//                   older `turns` array keeps seeing that snapshot.
export function createChatHistory({ session, fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  let turns = [];
  let cursor = null;
  let caughtUp = false;

  async function fetchPage(cursorStr) {
    const q = new URLSearchParams();
    if (cursorStr) q.set("cursor", cursorStr);
    q.set("limit", String(PAGE_LIMIT));
    const res = await doFetch(
      `/api/sessions/${encodeURIComponent(session)}/conversation?${q}`,
    );
    if (!res.ok) {
      throw new Error(`conversation fetch failed: ${res.status}`);
    }
    return res.json();
  }

  async function loadAll() {
    let c = null;
    let entries = [];
    let page;
    do {
      page = await fetchPage(c);
      entries = entries.concat(page.entries);
      c = page.nextCursor;
    } while (page.entries.length === PAGE_LIMIT);
    cursor = c;
    turns = entries.map(toTurn);
    caughtUp = true;
    return turns;
  }

  async function refreshTail() {
    if (!caughtUp) return turns;
    const page = await fetchPage(cursor);
    cursor = page.nextCursor;
    if (page.entries.length > 0) {
      turns = turns.concat(page.entries.map(toTurn));
    }
    return turns;
  }

  return {
    loadAll,
    refreshTail,
    get turns() {
      return turns;
    },
  };
}
