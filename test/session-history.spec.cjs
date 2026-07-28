// Server-side conversation history (issue #220): GET
// /api/sessions/{name}/conversation, the OSC 133-segmented, paginated JSON
// history endpoint. Server-side only — this does NOT touch the reader UI
// (that's issue #221) — but it needs a real terminal-engine WS attach to a
// real tmux+bash/zsh session, since that's the only thing that actually
// feeds the segmenter (src/session_history.rs). Same real-shell-integration
// harness as spa.spec.cjs's "OSC 133: real tmux classifies prompts off the
// A marker" test: install the real rcfile snippet, drive a real shell
// through a real tmux session, attach the actual `/ws/{name}` relay via the
// app.
//
// Rides the same isolated smoke instance as the rest of the suite
// (MOBUX_URL, tmux socket "mobux-test", SANDBOX_HOME) — see Makefile's
// test-spa target, which this file is appended to (same "no need for its
// own CI step" reasoning as reader-font.spec.cjs / reader-command-grouping
// .spec.cjs).

const fs = require("fs");
const path = require("path");
const { test, expect } = require("./fixtures.cjs");
const { createTmuxRunner, waitForClientAttached } = require("./lib/tmux.cjs");
const { resolveZshBin } = require("./lib/zsh.cjs");

const BASE = process.env.MOBUX_URL || "https://localhost:5151";
const APP = `${BASE}/app`;
const USER = process.env.MOBUX_USER || "";
const PASS = process.env.MOBUX_PASS || "";
const AUTH =
  USER && PASS
    ? "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64")
    : null;

test.use({
  ...(AUTH ? { extraHTTPHeaders: { Authorization: AUTH } } : {}),
});

const SANDBOX_HOME = process.env.MOBUX_TEST_HOME || "/tmp/mobux-smoke/home";
const SHELL_ENV = `-e HISTFILE=/dev/null -e HOME=${SANDBOX_HOME}`;
const tmux = createTmuxRunner("mobux-test");

async function apiInstall(page, shell) {
  await page.evaluate(async (shell) => {
    const res = await fetch("/api/shell-integration/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shell }),
    });
    if (!res.ok) throw new Error(`install failed: ${res.status}`);
  }, shell);
}

async function apiUninstall(page, shell) {
  await page.evaluate(async (shell) => {
    await fetch("/api/shell-integration/uninstall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shell }),
    });
  }, shell);
}

async function fetchConversation(page, session, query = "") {
  return page.evaluate(
    async ({ session, query }) => {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(session)}/conversation${query}`,
      );
      const status = res.status;
      const body = await res.json().catch(() => null);
      return { status, body };
    },
    { session, query },
  );
}

// A raw escape byte, or tmux's own status-bar shape (`<index>:<name>[*-]`,
// e.g. `0:bash*`) landing in `command` — either one is exactly the class of
// bug the segmenter's cursor model (`src/terminal_cursor.rs`) exists to
// fix: status-bar redraws and mode-toggle escapes are delivered via CSI
// cursor positioning rather than a literal newline, so a segmenter with no
// row model can glue them onto the "current line" it's building. Both must
// be structurally impossible now — a row only ever accumulates characters
// the cursor model's `print` callback actually received, and CSI bytes
// never reach it as text (see terminal_cursor.rs's module doc) — so, unlike
// the exact-match assertions below, this check is NOT tolerant of tmux's
// redraw-burst reordering jitter: it must hold on every attempt, not just
// on average.
function findNoiseInCommands(commands) {
  const failures = [];
  for (const c of commands) {
    if (c.command.includes("\x1b")) {
      failures.push(
        `command contains a raw escape byte: ${JSON.stringify(c.command)}`,
      );
    }
    if (/\d+:\S+[*-]/.test(c.command)) {
      failures.push(
        `command looks like tmux status-bar bleed: ${JSON.stringify(c.command)}`,
      );
    }
  }
  return failures;
}

// One attempt: real shell + real tmux + real WS attach, a warm-up plus
// several known commands, then the endpoint. Returns `{ ok, detail }`
// rather than asserting directly — same reason as spa.spec.cjs's
// attemptOscPromptClassification: tmux's own redraw-burst reordering
// (documented in session_history.rs's module doc, and independently
// confirmed against a live instance for this endpoint under both bash and
// zsh — see the PR description) can still leave a rare `command` entry
// empty (the real echo hadn't reached the wire yet when `C` fired) — a
// measured, low-rate timing gap, not a structural bug, and never anything
// OTHER than empty: `findNoiseInCommands` above is asserted on every
// attempt, with no tolerance, because noise/misattribution is exactly the
// regression this test exists to catch. `output` and `exitCode` are
// unaffected by the timing gap (raw bytes between two markers, no line-
// splitting heuristic involved) and are asserted exactly, every attempt.
async function attemptConversationHistory(
  page,
  { shell, rcPath, seedRc, shellCommand, knownCommands, promptSuffixRe },
) {
  const SESSION = `histtest-${shell}-${process.pid}-${Date.now()}`;

  await page.goto(`${APP}#/settings`, { waitUntil: "networkidle" });
  await apiUninstall(page, shell);
  if (seedRc) {
    fs.writeFileSync(rcPath, seedRc);
  }
  await apiInstall(page, shell);

  try {
    tmux(`kill-session -t ${SESSION}`);
  } catch (_) {}
  tmux(`new-session -d -s ${SESSION} ${SHELL_ENV} ${shellCommand}`);

  try {
    await page.goto(`${APP}#/s/${SESSION}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => window.__mobuxView && window.__mobuxView.test,
    );
    await waitForClientAttached(tmux, SESSION);

    // Warm-up: the session's very first prompt drew before the browser
    // attached, so it carries no marker (see spa.spec.cjs's identical
    // comment) — without this, the first real command below would land on
    // that unmarked prompt. The warm-up's own command text is never
    // asserted on for the same reason.
    //
    // Waits for each command's own entry to land before sending the next
    // one, instead of sending back-to-back like spa.spec.cjs does: real
    // usage is paced at human typing speed, never zero-delay between
    // commands; pacing by the previous command's own completion is a
    // tighter bound than a fixed sleep and matches that.
    const commandCountAtLeast = async (n) => {
      await expect
        .poll(
          async () => {
            const { status, body } = await fetchConversation(page, SESSION);
            if (status !== 200 || !body) return 0;
            return body.entries.filter((e) => "command" in e).length;
          },
          { timeout: 8000, message: `waiting for ${n} command entries` },
        )
        .toBeGreaterThanOrEqual(n);
    };
    tmux(`send-keys -t ${SESSION} 'true' Enter`);
    await commandCountAtLeast(1);
    for (let i = 0; i < knownCommands.length; i++) {
      tmux(`send-keys -t ${SESSION} '${knownCommands[i].text}' Enter`);
      await commandCountAtLeast(2 + i);
    }

    const { status, body } = await fetchConversation(page, SESSION);
    const failures = [];
    if (status !== 200) failures.push(`unexpected status ${status}`);
    if (typeof body.nextCursor !== "string" || !body.nextCursor) {
      failures.push(`nextCursor missing or not a string: ${body.nextCursor}`);
    }

    const commands = body.entries.filter((e) => "command" in e);
    failures.push(...findNoiseInCommands(commands));

    // Exit codes have been reliable across every real-instance run this
    // endpoint was verified against (unlike `command`, which can rarely
    // land empty under tmux's redraw-burst reordering — see this
    // function's doc comment). Assert them strictly, in order: true, plus
    // each known command's own exit code.
    const expectedExitCodes = [0, ...knownCommands.map((c) => c.exitCode)];
    if (commands.length !== expectedExitCodes.length) {
      failures.push(
        `expected ${expectedExitCodes.length} command entries, got ${commands.length}`,
      );
    } else {
      commands.forEach((c, i) => {
        if (c.exitCode !== expectedExitCodes[i]) {
          failures.push(
            `command ${i}: expected exitCode ${expectedExitCodes[i]}, got ${c.exitCode}`,
          );
        }
      });
    }

    // Every non-warm-up command entry either exactly ends with the real
    // typed text (prompt prefix + the command, never partial/garbled — a
    // strict suffix match, not `.includes()`) or is empty (the honest
    // "didn't arrive yet" case — see this function's doc comment). Never
    // anything in between: a command entry with SOME text that doesn't
    // exactly match what was typed would mean either noise leaked in
    // (already covered by `findNoiseInCommands`) or a different entry's
    // text got misattributed here, which this test must catch.
    const nonWarmup = commands.slice(1);
    for (const c of nonWarmup) {
      if (c.command === "") continue;
      const matchesKnown = knownCommands.some((k) =>
        c.command.endsWith(k.text),
      );
      if (!matchesKnown) {
        failures.push(
          `command text doesn't exactly match any known typed command: ${JSON.stringify(c.command)}`,
        );
      }
      if (promptSuffixRe && !promptSuffixRe.test(c.command)) {
        failures.push(
          `command text doesn't look like <prompt> <typed command>: ${JSON.stringify(c.command)}`,
        );
      }
    }

    // At least all but one of the known commands must show up with exact,
    // clean text somewhere — tolerates tmux's own measured redraw-burst
    // timing gap (never noise: see `findNoiseInCommands` above, asserted
    // unconditionally).
    const matchedKnown = knownCommands.filter((k) =>
      commands.some((c) => c.command.endsWith(k.text)),
    );
    if (matchedKnown.length < knownCommands.length - 1) {
      failures.push(
        `only matched ${matchedKnown.length}/${knownCommands.length} known commands exactly: ${JSON.stringify(matchedKnown.map((k) => k.text))}`,
      );
    }

    const anyOutputText = commands.some((c) =>
      knownCommands.some(
        (k) => k.outputContains && c.output.includes(k.outputContains),
      ),
    );
    if (!anyOutputText) {
      failures.push(
        `no command entry's output contains an expected fragment: ${JSON.stringify(commands)}`,
      );
    }

    // Pagination: paging with limit=1 must yield the same entries, in the
    // same order, as the unpaginated fetch — and the cursor must be usable
    // to resume (stability is unit-tested directly against trims in
    // session_history.rs; this proves the HTTP contract end to end).
    let cursor = "";
    const paged = [];
    for (let i = 0; i < body.entries.length; i++) {
      const page1 = await fetchConversation(
        page,
        SESSION,
        `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      if (page1.body.entries.length !== 1) {
        failures.push(
          `page ${i}: expected exactly 1 entry, got ${page1.body.entries.length}`,
        );
        break;
      }
      paged.push(page1.body.entries[0]);
      cursor = page1.body.nextCursor;
    }
    if (paged.length === body.entries.length) {
      for (let i = 0; i < paged.length; i++) {
        if (paged[i].seq !== body.entries[i].seq) {
          failures.push(
            `paged entry ${i} seq mismatch: ${paged[i].seq} vs ${body.entries[i].seq}`,
          );
        }
      }
    }

    return { ok: failures.length === 0, detail: failures.join("; ") };
  } finally {
    try {
      tmux(`kill-session -t ${SESSION}`);
    } catch (_) {}
    await apiUninstall(page, shell);
  }
}

// `attempts` tolerates the small residual timing jitter measured against a
// real instance (this function's own doc comment) without masking a
// structural regression — a reverted fix (or a segmenter with no cursor
// model at all) fails essentially every attempt on `findNoiseInCommands`
// alone, which every attempt asserts unconditionally.
async function verifyConversationHistory(page, opts, attempts = 3) {
  let last = { ok: false, detail: "no attempts run" };
  for (let i = 0; i < attempts; i++) {
    last = await attemptConversationHistory(page, opts);
    if (last.ok) return;
  }
  expect(
    last.ok,
    `all ${attempts} attempt(s) failed; last: ${last.detail}`,
  ).toBe(true);
}

test("conversation history: real tmux+bash session produces clean, correctly-attributed command entries with correct output/exitCode, paginates stably", async ({
  page,
}) => {
  await verifyConversationHistory(page, {
    shell: "bash",
    // A known, seeded PS1 rather than relying on the sandbox's ambient
    // default: SANDBOX_HOME is shared with every other spec file in the
    // same `test-spa` run (single worker, one smoke instance), and
    // spa.spec.cjs's own bash OSC 133 coverage seeds a PS1 outside
    // mobux's managed fence — `apiUninstall` only strips that fence, so a
    // stray PS1 from an earlier test in the same run can otherwise still
    // be sitting in `.bashrc` here. Seeding overwrites the whole file, so
    // this test's prompt shape is never dependent on run order.
    rcPath: `${SANDBOX_HOME}/.bashrc`,
    seedRc: "PS1='sessionhisttest: '\n",
    shellCommand: "bash",
    knownCommands: [
      { text: "echo one", exitCode: 0, outputContains: "one" },
      { text: "false", exitCode: 1 },
      { text: "echo two-$?", exitCode: 0, outputContains: "two-1" },
      { text: "echo three", exitCode: 0, outputContains: "three" },
    ],
    promptSuffixRe: /^sessionhisttest: \S/,
  });
});

// ── zsh coverage — mirrors the bash test above. zsh isn't preinstalled on
// the CI runner (see test/lib/zsh.cjs), so it's resolved once for this
// group instead of at file load, to avoid slowing down every other test in
// this file with an unconditional download. A known, sigil-free PROMPT
// (same seed spa.spec.cjs's own zsh coverage uses) keeps the exact-suffix
// assertions independent of whatever zsh ships as its own default prompt.
test.describe("conversation history: zsh", () => {
  let zshBin;

  test.beforeAll(() => {
    zshBin = resolveZshBin();
  });

  test("conversation history: real tmux+zsh session produces clean, correctly-attributed command entries with correct output/exitCode, paginates stably", async ({
    page,
  }) => {
    await verifyConversationHistory(page, {
      shell: "zsh",
      rcPath: `${SANDBOX_HOME}/.zshrc`,
      seedRc: "PROMPT='mobuxtest: '\n",
      shellCommand: zshBin,
      knownCommands: [
        { text: "echo one", exitCode: 0, outputContains: "one" },
        { text: "false", exitCode: 1 },
        { text: "echo two-$?", exitCode: 0, outputContains: "two-1" },
        { text: "echo three", exitCode: 0, outputContains: "three" },
      ],
      promptSuffixRe: /^mobuxtest: \S/,
    });
  });
});

// ── Recording lifecycle across attach/detach (issue #237) ────────────
//
// The two tests below drive the write path — `handle_ws`'s feeder handling
// and `Segmenter::flush` — rather than the endpoint's shape. Every step is
// sequenced on an observed fact (tmux's own client count, or an entry
// landing in the log), never on a sleep: this file's history of flake
// (#223, #183) makes a timing window an unacceptable way to order a test.

// tmux's view of how many clients are attached — the server-side truth the
// WS relay's lifetime is tied to, so it is what the steps below wait on.
function attachedClientCount(session) {
  try {
    return tmux(`list-clients -t ${session} -F x`)
      .toString()
      .split("\n")
      .filter((l) => l.trim()).length;
  } catch (_) {
    // A throw is "tmux could not answer", not "nobody is attached" — the
    // barriers below wait for a count of 0, and returning 0 here would let
    // a broken tmux satisfy one of them.
    return -1;
  }
}

async function waitForClientCount(session, n) {
  await expect
    .poll(() => attachedClientCount(session), {
      timeout: 10000,
      message: `waiting for ${n} attached tmux client(s) on ${session}`,
    })
    .toBe(n);
}

async function attachSessionPage(context, session) {
  const attached = await context.newPage();
  await attached.goto(`${APP}#/s/${session}`, {
    waitUntil: "domcontentloaded",
  });
  await attached.waitForFunction(
    () => window.__mobuxView && window.__mobuxView.test,
  );
  await waitForClientAttached(tmux, session);
  return attached;
}

// A bash session with a known PS1 — with the real shell-integration
// snippet installed or deliberately without it — torn down (session +
// snippet) whatever the body does. `page` stays on a non-session route: it
// is the fetch client only, so it never takes a WS attach of its own and
// never competes for the recording slot.
async function withSession(page, { instrumented }, body) {
  const session = `histlifecycle-${process.pid}-${Date.now()}`;
  await page.goto(`${APP}#/settings`, { waitUntil: "networkidle" });
  await apiUninstall(page, "bash");
  fs.writeFileSync(`${SANDBOX_HOME}/.bashrc`, "PS1='lifecycletest: '\n");
  if (instrumented) await apiInstall(page, "bash");
  try {
    tmux(`kill-session -t ${session}`);
  } catch (_) {}
  tmux(`new-session -d -s ${session} ${SHELL_ENV} bash`);
  await page.goto(`${APP}#/`, { waitUntil: "domcontentloaded" });
  try {
    await body(session);
  } finally {
    try {
      tmux(`kill-session -t ${session}`);
    } catch (_) {}
    await apiUninstall(page, "bash");
  }
}

async function fetchEntries(page, session) {
  const { status, body } = await fetchConversation(page, session, "?limit=500");
  expect(status).toBe(200);
  return body.entries;
}

async function commandEntries(page, session) {
  return (await fetchEntries(page, session)).filter((e) => "command" in e);
}

// Exact, not "at least": these tests send one command at a time and wait
// for its entry before the next, so an extra entry means two feeders
// recorded the same bytes — which is the failure mode the recording slot
// exists to prevent.
async function waitForCommandCount(page, session, n) {
  await expect
    .poll(async () => (await commandEntries(page, session)).length, {
      timeout: 15000,
      message: `waiting for exactly ${n} command entries`,
    })
    .toBe(n);
}

test("conversation history: a client that loses the recording slot picks it up when the holder detaches", async ({
  context,
  page,
}) => {
  // The steps below wait on real tmux and on entries landing in the log;
  // their budgets add up past the suite's 30s default.
  test.setTimeout(90000);
  await withSession(page, { instrumented: true }, async (session) => {
    const first = await attachSessionPage(context, session);
    await waitForClientCount(session, 1);

    // The very first prompt drew before anything attached, so it carries no
    // marker (same warm-up as attemptConversationHistory above).
    tmux(`send-keys -t ${session} 'true' Enter`);
    await waitForCommandCount(page, session, 1);
    tmux(`send-keys -t ${session} 'echo handover-one' Enter`);
    await waitForCommandCount(page, session, 2);

    // `second` attaches while `first` is provably the recorder — it has
    // already written an entry — so `second` loses the slot every run. No
    // race decides which of the two holds it.
    const second = await attachSessionPage(context, session);
    await waitForClientCount(session, 2);

    const beforeHandover = await commandEntries(page, session);
    await first.close();
    await waitForClientCount(session, 1);

    // tmux drops the departing client before the relay handling it returns
    // and frees the recording slot, so "one client left" does not mean "the
    // slot is free" — a command sent on that edge finishes before the
    // survivor can take over. Re-sending each tick converges instead of
    // betting on that gap: every send after the handover is recorded, and a
    // handover that never happens leaves the count where it was.
    //
    // The assertion is the entry count, not the text of any entry. Under
    // tmux's redraw-burst reordering a `C..D` window can capture repaint
    // bytes and the previous line's echo, so neither `command` nor `output`
    // is a sound thing to match on here (see attemptConversationHistory's
    // doc comment, and the 3-attempt harness it needs to survive that).
    // That an entry exists at all is what the handover is about.
    await expect
      .poll(
        async () => {
          tmux(`send-keys -t ${session} 'echo handover-two' Enter`);
          return (await commandEntries(page, session)).length;
        },
        {
          timeout: 20000,
          intervals: [1000],
          message: "waiting for the surviving client to record a command",
        },
      )
      .toBeGreaterThan(beforeHandover.length);
    await second.close();

    // The record the departing client wrote survives the handover intact —
    // entries are append-only, so this is exact, not a text match.
    const afterHandover = await commandEntries(page, session);
    expect(
      afterHandover.slice(0, beforeHandover.length).map((e) => e.seq),
    ).toEqual(beforeHandover.map((e) => e.seq));
  });
});

test("conversation history: detaching an instrumented session appends no trailing raw entry", async ({
  context,
  page,
}) => {
  test.setTimeout(60000);
  await withSession(page, { instrumented: true }, async (session) => {
    const attached = await attachSessionPage(context, session);
    await waitForClientCount(session, 1);

    tmux(`send-keys -t ${session} 'true' Enter`);
    await waitForCommandCount(page, session, 1);
    tmux(`send-keys -t ${session} 'echo flushcheck' Enter`);
    await waitForCommandCount(page, session, 2);

    // The relay flushes its segmenter and appends before it kills the
    // attach subprocess, so tmux dropping to zero clients means whatever
    // detach was going to write is already on disk. Nothing to settle for.
    await attached.close();
    await waitForClientCount(session, 0);

    // Not "no raw entries at all": a fresh attach repaints the whole screen
    // into `pending`, and at a 35x120 PTY that burst exceeds
    // RAW_FLUSH_THRESHOLD and is emitted as raw entries during `feed`,
    // before any `C`. Those are unrelated to the detach flush. What the
    // flush change removes is the entry appended *after* the conversation's
    // last command.
    const entries = await fetchEntries(page, session);
    const lastCommand = entries.map((e) => "command" in e).lastIndexOf(true);
    expect(lastCommand).toBeGreaterThanOrEqual(0);
    const trailing = entries.slice(lastCommand + 1).filter((e) => "raw" in e);
    expect(
      trailing,
      `raw entries after the last command: ${JSON.stringify(trailing)}`,
    ).toEqual([]);
  });
});

// The other half of the flush contract, and the half that is easy to break
// by accident: a session with no shell integration has no markers, so raw
// entries ARE its record and detach must still write the tail. Covered
// end-to-end here because CI compiles the Rust tests without running them
// (`ci.yml`'s `cargo test --no-run`), so the unit test that pins this
// exactly never executes there.
test("conversation history: detaching a session with no shell integration still records its tail", async ({
  context,
  page,
}) => {
  test.setTimeout(60000);
  await withSession(page, { instrumented: false }, async (session) => {
    const attached = await attachSessionPage(context, session);
    await waitForClientCount(session, 1);

    tmux(`send-keys -t ${session} 'echo plain-tail-marker' Enter`);
    await expect
      .poll(() => tmux(`capture-pane -p -t ${session}`).toString(), {
        timeout: 10000,
        message: "waiting for the command to run in the pane",
      })
      .toContain("plain-tail-marker");

    await attached.close();
    await waitForClientCount(session, 0);

    const entries = await fetchEntries(page, session);
    expect(entries.filter((e) => "command" in e)).toEqual([]);
    // The marker must be in the LAST entry and nowhere before it. Only
    // detach writes the last entry; everything earlier was drained mid-
    // stream at RAW_FLUSH_THRESHOLD. Asserting over the whole record would
    // still pass once a bigger PTY, a MOTD or a longer prompt pushes the
    // marker into a drained chunk — at which point it would be testing the
    // drain, not the flush.
    expect(
      entries.slice(0, -1).map((e) => e.raw),
      "the marker must reach the record through flush, not a mid-stream drain",
    ).not.toContain(expect.stringContaining("plain-tail-marker"));
    expect(entries.at(-1).raw).toContain("plain-tail-marker");
  });
});

test("conversation history: unknown/never-attached session returns an empty page, not an error", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
  const { status, body } = await fetchConversation(
    page,
    `never-attached-${process.pid}`,
  );
  expect(status).toBe(200);
  expect(body.entries).toEqual([]);
  expect(typeof body.nextCursor).toBe("string");
});

test("conversation history: invalid cursor is a 400, not a silent empty page", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
  const { status } = await fetchConversation(
    page,
    `whatever-${process.pid}`,
    "?cursor=not-a-real-cursor",
  );
  expect(status).toBe(400);
});

// ── Page shape: offset cursor, tail, byte budget (issue #233) ─────────
//
// The clauses below are the endpoint's read path, so they run against a
// seeded log rather than a real tmux session: what a page holds, where its
// cursor points and where the byte budget cuts are properties of the file,
// and a real shell cannot produce a 600 KiB entry or an exactly-known byte
// offset on demand. The recording path keeps its own coverage above.
//
// CI runs the Rust unit tests through `cargo test --no-run` (`ci.yml`), so
// these are the gate and the unit tests mirroring them are additive.

// The smoke instance's MOBUX_DATA_DIR: the Makefile's smoke-start puts the
// sandbox HOME inside it.
const DATA_DIR = process.env.MOBUX_TEST_DATA_DIR || path.dirname(SANDBOX_HOME);
const HISTORY_DIR = `${DATA_DIR}/history`;
const MAX_WIRE_OUTPUT_BYTES = 16 * 1024;
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_LIMIT = 500;

let seedCounter = 0;

function rawEntry(seq, raw = `raw-${seq}`) {
  return { seq, raw, ts: 1000 + seq };
}

function commandEntry(seq, output) {
  return {
    seq,
    command: `cmd-${seq}`,
    output,
    exitCode: 0,
    startedAt: 1000 + seq,
    endedAt: 1001 + seq,
  };
}

function jsonl(entries) {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

// The seeded file is the server's own store file, so the endpoint reads it
// through exactly the path a recorded session would. A wrong data dir
// yields an empty page, which fails these assertions loudly rather than
// passing quietly.
async function withSeededHistory(entries, body) {
  const session = `histseed-${process.pid}-${Date.now()}-${seedCounter++}`;
  const file = `${HISTORY_DIR}/${session}.jsonl`;
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.writeFileSync(file, jsonl(entries));
  try {
    return await body(session, file);
  } finally {
    try {
      fs.unlinkSync(file);
    } catch (_) {}
  }
}

function decodeCursor(cursor) {
  return Buffer.from(cursor, "base64url").toString("utf8");
}

function makeCursor(text) {
  return Buffer.from(text, "utf8").toString("base64url");
}

function seqsOf(body) {
  return body.entries.map((e) => e.seq);
}

function entryBytes(body) {
  return body.entries.reduce((n, e) => n + JSON.stringify(e).length, 0);
}

// A line of exactly `byteLength` bytes, newline included, carrying a seq a
// forward scan would return.
function decoyLine(seq, byteLength) {
  const base = Buffer.byteLength(JSON.stringify({ seq, raw: "", ts: 0 }));
  const padded = "p".repeat(byteLength - 1 - base);
  return JSON.stringify({ seq, raw: padded, ts: 0 }) + "\n";
}

test.describe("conversation endpoint: paging contract", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
  });

  test("conversation endpoint: neither tail nor cursor pages forward from the oldest retained entry", async ({
    page,
  }) => {
    const entries = [1, 2, 3, 4, 5].map((seq) => rawEntry(seq));
    await withSeededHistory(entries, async (session) => {
      const { status, body } = await fetchConversation(page, session);
      expect(status).toBe(200);
      expect(seqsOf(body)).toEqual([1, 2, 3, 4, 5]);

      const limited = await fetchConversation(page, session, "?limit=2");
      expect(seqsOf(limited.body)).toEqual([1, 2]);
    });
  });

  test("conversation endpoint: tail returns the newest entries, and its cursor resumes forward with no gap or duplicate", async ({
    page,
  }) => {
    const entries = Array.from({ length: 10 }, (_, i) => rawEntry(i + 1));
    await withSeededHistory(entries, async (session, file) => {
      const { status, body } = await fetchConversation(
        page,
        session,
        "?tail=3",
      );
      expect(status).toBe(200);
      expect(seqsOf(body)).toEqual([8, 9, 10]);

      const cursor = encodeURIComponent(body.nextCursor);
      const caughtUp = await fetchConversation(
        page,
        session,
        `?cursor=${cursor}`,
      );
      expect(seqsOf(caughtUp.body)).toEqual([]);

      fs.appendFileSync(file, jsonl([rawEntry(11), rawEntry(12)]));
      const resumed = await fetchConversation(
        page,
        session,
        `?cursor=${cursor}`,
      );
      expect(seqsOf(resumed.body)).toEqual([11, 12]);
    });
  });

  test("conversation endpoint: tail alongside cursor or limit is a 400", async ({
    page,
  }) => {
    await withSeededHistory([rawEntry(1)], async (session) => {
      const cursor = encodeURIComponent(makeCursor("v2:1:0"));
      const withCursor = await fetchConversation(
        page,
        session,
        `?tail=2&cursor=${cursor}`,
      );
      expect(withCursor.status).toBe(400);

      const withLimit = await fetchConversation(
        page,
        session,
        "?tail=2&limit=2",
      );
      expect(withLimit.status).toBe(400);
    });
  });

  test("conversation endpoint: limit and tail clamp to 1..500 rather than rejecting", async ({
    page,
  }) => {
    const entries = Array.from({ length: 520 }, (_, i) => rawEntry(i + 1));
    await withSeededHistory(entries, async (session) => {
      const bigLimit = await fetchConversation(page, session, "?limit=99999");
      expect(bigLimit.status).toBe(200);
      expect(bigLimit.body.entries).toHaveLength(MAX_LIMIT);
      expect(seqsOf(bigLimit.body)[0]).toBe(1);

      const zeroLimit = await fetchConversation(page, session, "?limit=0");
      expect(zeroLimit.status).toBe(200);
      expect(seqsOf(zeroLimit.body)).toEqual([1]);

      const bigTail = await fetchConversation(page, session, "?tail=99999");
      expect(bigTail.status).toBe(200);
      expect(bigTail.body.entries).toHaveLength(MAX_LIMIT);
      expect(seqsOf(bigTail.body).at(-1)).toBe(520);

      const zeroTail = await fetchConversation(page, session, "?tail=0");
      expect(zeroTail.status).toBe(200);
      expect(seqsOf(zeroTail.body)).toEqual([520]);
    });
  });

  test("conversation endpoint: output over the wire cap keeps its end and reports the bytes it dropped", async ({
    page,
  }) => {
    const output = `HEAD-MARKER${"A".repeat(20000)}TAIL-MARKER`;
    await withSeededHistory([commandEntry(1, output)], async (session) => {
      const { status, body } = await fetchConversation(page, session);
      expect(status).toBe(200);
      const entry = body.entries[0];
      expect(entry.output).toHaveLength(MAX_WIRE_OUTPUT_BYTES);
      expect(entry.output.endsWith("TAIL-MARKER")).toBe(true);
      expect(entry.output.includes("HEAD-MARKER")).toBe(false);
      expect(entry.outputTruncatedBytes).toBe(
        output.length - MAX_WIRE_OUTPUT_BYTES,
      );
    });
  });

  test("conversation endpoint: an entry inside the wire cap carries no outputTruncatedBytes", async ({
    page,
  }) => {
    await withSeededHistory(
      [commandEntry(1, "short output")],
      async (session) => {
        const { body } = await fetchConversation(page, session);
        expect(body.entries[0].output).toBe("short output");
        expect("outputTruncatedBytes" in body.entries[0]).toBe(false);
      },
    );
  });

  test("conversation endpoint: nextCursor decodes to v2:<seq>:<offset> at the end of the file, and a poll on it returns an empty page", async ({
    page,
  }) => {
    const entries = [1, 2, 3, 4].map((seq) => rawEntry(seq));
    await withSeededHistory(entries, async (session, file) => {
      const { body } = await fetchConversation(page, session);
      const fileLength = fs.statSync(file).size;
      expect(decodeCursor(body.nextCursor)).toBe(`v2:4:${fileLength}`);

      const polled = await fetchConversation(
        page,
        session,
        `?cursor=${encodeURIComponent(body.nextCursor)}`,
      );
      expect(polled.status).toBe(200);
      expect(polled.body.entries).toEqual([]);
      expect(polled.body.nextCursor).toBe(body.nextCursor);
    });
  });

  test("conversation endpoint: a v1 cursor and a v2 cursor with a wrong offset both return the correct page", async ({
    page,
  }) => {
    const entries = [1, 2, 3, 4, 5].map((seq) => rawEntry(seq));
    await withSeededHistory(entries, async (session) => {
      const legacy = await fetchConversation(
        page,
        session,
        `?cursor=${encodeURIComponent(makeCursor("v1:2"))}`,
      );
      expect(legacy.status).toBe(200);
      expect(seqsOf(legacy.body)).toEqual([3, 4, 5]);
      expect(decodeCursor(legacy.body.nextCursor).startsWith("v2:5:")).toBe(
        true,
      );

      // An offset that is a real line boundary but the wrong one — it
      // points at seq 4, one entry past where seq 2's cursor resumes. A
      // trusted offset would silently skip seq 3; the seq check must catch
      // it and fall back to a scan.
      const pastSeqThree = Buffer.byteLength(jsonl(entries.slice(0, 3)));
      const misplaced = await fetchConversation(
        page,
        session,
        `?cursor=${encodeURIComponent(makeCursor(`v2:2:${pastSeqThree}`))}`,
      );
      expect(misplaced.status).toBe(200);
      expect(seqsOf(misplaced.body)).toEqual([3, 4, 5]);

      const midLine = await fetchConversation(
        page,
        session,
        `?cursor=${encodeURIComponent(makeCursor("v2:2:7"))}`,
      );
      expect(midLine.status).toBe(200);
      expect(seqsOf(midLine.body)).toEqual([3, 4, 5]);
    });
  });

  test("conversation endpoint: the byte budget bounds a page, keeps the newest on tail, and skips no seq", async ({
    page,
  }) => {
    const entries = Array.from({ length: 60 }, (_, i) =>
      commandEntry(i + 1, "x".repeat(20 * 1024)),
    );
    await withSeededHistory(entries, async (session) => {
      const { status, body } = await fetchConversation(
        page,
        session,
        "?tail=200",
      );
      expect(status).toBe(200);
      expect(body.entries.length).toBeLessThan(60);
      expect(body.entries.length).toBeGreaterThan(0);
      expect(entryBytes(body)).toBeLessThanOrEqual(MAX_PAGE_BYTES);
      expect(seqsOf(body).at(-1)).toBe(60);

      const walked = [];
      let cursor = "";
      for (let i = 0; i < 60; i++) {
        const forward = await fetchConversation(
          page,
          session,
          cursor
            ? `?limit=500&cursor=${encodeURIComponent(cursor)}`
            : "?limit=500",
        );
        expect(forward.status).toBe(200);
        expect(entryBytes(forward.body)).toBeLessThanOrEqual(MAX_PAGE_BYTES);
        if (forward.body.entries.length === 0) break;
        walked.push(...seqsOf(forward.body));
        cursor = forward.body.nextCursor;
      }
      expect(walked).toEqual(entries.map((e) => e.seq));
    });
  });

  test("conversation endpoint: a page whose first entry alone exceeds the budget still returns it", async ({
    page,
  }) => {
    const oversized = rawEntry(1, "x".repeat(MAX_PAGE_BYTES + 1024));
    await withSeededHistory([oversized, rawEntry(2)], async (session) => {
      const forward = await fetchConversation(page, session, "?limit=50");
      expect(forward.status).toBe(200);
      expect(seqsOf(forward.body)).toEqual([1]);

      const tail = await fetchConversation(page, session, "?tail=50");
      expect(tail.status).toBe(200);
      expect(seqsOf(tail.body)).toEqual([2]);
    });
  });

  // `append` writes a line and its newline separately, and a large line is
  // copied incrementally, so a poll can observe a prefix that ends inside a
  // multi-byte character — which terminal output carries constantly. Every
  // mode must skip that line rather than fail on it.
  test("conversation endpoint: a line torn inside a multi-byte character is skipped, not an error", async ({
    page,
  }) => {
    await withSeededHistory(
      [rawEntry(1), rawEntry(2)],
      async (session, file) => {
        const complete = await fetchConversation(page, session);
        expect(seqsOf(complete.body)).toEqual([1, 2]);
        const atEof = encodeURIComponent(complete.body.nextCursor);
        const legacy = encodeURIComponent(makeCursor("v1:1"));

        const third = Buffer.from(JSON.stringify(rawEntry(3, "€€€")), "utf8");
        const cut = third.indexOf(0xe2) + 1;
        fs.appendFileSync(file, third.subarray(0, cut));

        const fresh = await fetchConversation(page, session);
        expect(fresh.status).toBe(200);
        expect(seqsOf(fresh.body)).toEqual([1, 2]);

        const polled = await fetchConversation(
          page,
          session,
          `?cursor=${atEof}`,
        );
        expect(polled.status).toBe(200);
        expect(seqsOf(polled.body)).toEqual([]);

        const fallback = await fetchConversation(
          page,
          session,
          `?cursor=${legacy}`,
        );
        expect(fallback.status).toBe(200);
        expect(seqsOf(fallback.body)).toEqual([2]);

        const tail = await fetchConversation(page, session, "?tail=10");
        expect(tail.status).toBe(200);
        expect(seqsOf(tail.body)).toEqual([1, 2]);

        fs.appendFileSync(
          file,
          Buffer.concat([third.subarray(cut), Buffer.from("\n")]),
        );
        const settled = await fetchConversation(page, session);
        expect(seqsOf(settled.body)).toEqual([1, 2, 3]);
        expect(settled.body.entries[2].raw).toBe("€€€");
      },
    );
  });

  // The seek is the reason the cursor carries an offset at all, and its
  // absence is invisible in a page's contents alone. Rewriting the bytes
  // before the offset into an entry a scan would return makes the two
  // strategies disagree.
  test("conversation endpoint: a cursor with a trusted offset seeks past content a full scan would return", async ({
    page,
  }) => {
    const entries = [1, 2, 3, 4, 5].map((seq) => rawEntry(seq));
    await withSeededHistory(entries, async (session, file) => {
      const first = await fetchConversation(page, session, "?limit=3");
      expect(seqsOf(first.body)).toEqual([1, 2, 3]);
      const offset = Number(decodeCursor(first.body.nextCursor).split(":")[2]);
      expect(offset).toBe(Buffer.byteLength(jsonl(entries.slice(0, 3))));

      const rest = fs.readFileSync(file).subarray(offset);
      fs.writeFileSync(
        file,
        Buffer.concat([Buffer.from(decoyLine(90, offset)), rest]),
      );

      const scanned = await fetchConversation(
        page,
        session,
        `?cursor=${encodeURIComponent(makeCursor("v1:3"))}`,
      );
      expect(
        seqsOf(scanned.body),
        "the decoy must be something a full scan returns",
      ).toEqual([90, 4, 5]);

      const seeked = await fetchConversation(
        page,
        session,
        `?cursor=${encodeURIComponent(first.body.nextCursor)}`,
      );
      expect(
        seqsOf(seeked.body),
        "a trusted offset must seek, never rescan from byte 0",
      ).toEqual([4, 5]);
    });
  });

  test("conversation endpoint: a malformed session name is a 400", async ({
    page,
  }) => {
    const { status } = await fetchConversation(page, "not a valid name");
    expect(status).toBe(400);
  });

  test("conversation endpoint: a well-formed name with no history is an empty page with the zero cursor", async ({
    page,
  }) => {
    const session = `nohistory-${process.pid}-${Date.now()}`;
    const { status, body } = await fetchConversation(page, session);
    expect(status).toBe(200);
    expect(body.entries).toEqual([]);
    expect(decodeCursor(body.nextCursor)).toBe("v2:0:0");

    // A supplied cursor does not change that: a file with no content
    // cannot account for a seq, and echoing one would strand the client on
    // a floor no entry reaches if the record later starts over.
    for (const cursor of ["v1:7", "v2:7:0", "v2:7:400"]) {
      const carried = await fetchConversation(
        page,
        session,
        `?cursor=${encodeURIComponent(makeCursor(cursor))}`,
      );
      expect(carried.status, cursor).toBe(200);
      expect(carried.body.entries, cursor).toEqual([]);
      expect(decodeCursor(carried.body.nextCursor), cursor).toBe("v2:0:0");
    }
  });
});
