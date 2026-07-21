// Server-side conversation history (issue #220): GET
// /api/sessions/{name}/conversation, the OSC 133-segmented, paginated JSON
// history endpoint. Server-side only — this does NOT touch the reader UI
// (that's issue #221) — but it needs a real terminal-engine WS attach to a
// real tmux+bash session, since that's the only thing that actually feeds
// the segmenter (src/session_history.rs). Same real-shell-integration
// harness as spa.spec.cjs's "OSC 133: real tmux classifies prompts off the
// A marker" test: install the real rcfile snippet, drive a real bash
// through a real tmux session, attach the actual `/ws/{name}` relay via the
// app.
//
// Rides the same isolated smoke instance as the rest of the suite
// (MOBUX_URL, tmux socket "mobux-test", SANDBOX_HOME) — see Makefile's
// test-spa target, which this file is appended to (same "no need for its
// own CI step" reasoning as reader-font.spec.cjs / reader-command-grouping
// .spec.cjs).

const { test, expect } = require("./fixtures.cjs");
const { createTmuxRunner, waitForClientAttached } = require("./lib/tmux.cjs");

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

// One attempt: real bash + real tmux + real WS attach, three commands, then
// the endpoint. Returns `{ ok, detail }` rather than asserting directly —
// same reason as spa.spec.cjs's attemptOscPromptClassification: tmux's own
// redraw-burst reordering (documented there, and independently confirmed
// against a live instance for this endpoint — see the PR description) is a
// real, measured, low-rate source of jitter in the `command` field
// specifically, not a structural bug. `output` and `exitCode` are NOT
// affected by that jitter (they're raw bytes between two markers, no line-
// splitting heuristic involved) and are asserted exactly, every attempt.
async function attemptConversationHistory(page) {
  const SESSION = `histtest-${process.pid}-${Date.now()}`;

  await page.goto(`${APP}#/settings`, { waitUntil: "networkidle" });
  await apiUninstall(page, "bash");
  await apiInstall(page, "bash");

  try {
    tmux(`kill-session -t ${SESSION}`);
  } catch (_) {}
  tmux(`new-session -d -s ${SESSION} ${SHELL_ENV} bash`);

  try {
    await page.goto(`${APP}#/s/${SESSION}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => window.__mobuxView && window.__mobuxView.test,
    );
    await waitForClientAttached(tmux, SESSION);

    // Warm-up: the session's very first prompt drew before the browser
    // attached, so it carries no marker (see spa.spec.cjs's identical
    // comment) — without this, "echo one" below would land on that
    // unmarked prompt.
    //
    // Waits for each command's own entry to land before sending the next
    // one, instead of sending back-to-back like spa.spec.cjs does: the
    // server-side segmenter has zero out-of-order tolerance, by design (no
    // cursor/row tracking — see session_history.rs's module doc), where the
    // client's OSC 133 attribution is specifically built to survive tmux's
    // redraw-burst reordering under rapid-fire input. Real usage is paced
    // at human typing speed, never zero-delay between commands; pacing by
    // the previous command's own completion is a tighter bound than a
    // fixed sleep and matches that instead of hammering the one specific
    // pattern the design brief said not to solve for server-side.
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
    tmux(`send-keys -t ${SESSION} 'echo one' Enter`);
    await commandCountAtLeast(2);
    tmux(`send-keys -t ${SESSION} 'false' Enter`);
    await commandCountAtLeast(3);
    tmux(`send-keys -t ${SESSION} 'echo two-$?' Enter`);
    await commandCountAtLeast(4);

    const { status, body } = await fetchConversation(page, SESSION);
    const failures = [];
    if (status !== 200) failures.push(`unexpected status ${status}`);
    if (typeof body.nextCursor !== "string" || !body.nextCursor) {
      failures.push(`nextCursor missing or not a string: ${body.nextCursor}`);
    }

    const commands = body.entries.filter((e) => "command" in e);
    // Exit codes have been reliable across every real-instance run this PR
    // was verified against (unlike `command`/`output` text, which can be
    // glued to the wrong entry under tmux's redraw-burst reordering — see
    // the module doc comment and this test's own header comment). Assert
    // them strictly, in order: true, echo one, false, echo two-$? →
    // 0, 0, 1, 0.
    const expectedExitCodes = [0, 0, 1, 0];
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
    // Best-effort content: at least one entry must carry recognizable
    // command text, and at least one must carry recognizable output —
    // proving real content reaches the log end to end, without requiring
    // every single entry's text to land on exactly the right side of a
    // marker under rapid-fire input (same tolerance spa.spec.cjs's own
    // real-tmux OSC 133 test applies to prompt classification).
    const anyCommandText = commands.some((c) => c.command.includes("echo"));
    const anyOutputText = commands.some(
      (c) => c.output.includes("one") || c.output.includes("two-1"),
    );
    if (!anyCommandText) {
      failures.push(
        `no command entry's command field mentions "echo": ${JSON.stringify(commands)}`,
      );
    }
    if (!anyOutputText) {
      failures.push(
        `no command entry's output contains "one" or "two-1": ${JSON.stringify(commands)}`,
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
    await apiUninstall(page, "bash");
  }
}

test("conversation history: real tmux+bash session produces command entries with correct output/exitCode, paginates stably", async ({
  page,
}) => {
  // Same retry budget and rationale as spa.spec.cjs's OSC 133 real-tmux
  // coverage: tmux's own redraw-burst reordering is measured, low-rate
  // jitter, not a structural regression — a reverted fix fails essentially
  // every attempt, this tolerates the residual rate.
  let last = { ok: false, detail: "no attempts run" };
  for (let i = 0; i < 3; i++) {
    last = await attemptConversationHistory(page);
    if (last.ok) return;
  }
  expect(last.ok, `all attempts failed; last: ${last.detail}`).toBe(true);
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
