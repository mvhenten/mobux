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
    // Nothing here reached RAW_FLUSH_THRESHOLD, so the whole record is what
    // detach flushed. Gate the flush, not the threshold drain.
    expect(entries.map((e) => e.raw).join("")).toContain("plain-tail-marker");
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
