// Reader command grouping (issue #219) and chat view (issue #221): OSC 133 C
// (command start) and D (command end + exit code) markers group each
// command with its output into one reader turn, laid out as a dialogue with
// the shell — command left, output/exit status right — with a muted
// pass/fail chip once the exit code is known. Without C/D markers the
// reader falls back to today's heuristic blocks unchanged.
//
// Drives reader.js's real render pipeline (createReader + term-tokenizer's
// tokenize) with a synthetic document snapshot instead of a live tmux/PTY
// session — same approach as reader-font.spec.cjs (issue #218) — so this
// stays decoupled from the terminal engine and OSC 133 attribution. Tests
// that exercise the server-history side (issue #220's
// /api/sessions/{name}/conversation) stub `window.fetch` instead of driving
// a real tmux session — that real end-to-end path (history endpoint +
// pagination + live tail, against a real shell) is covered by
// reader-chat-history.spec.cjs.

const { test, expect } = require("./fixtures.cjs");

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

// One realistic OSC 133 session: a command with two lines of output that
// exits 0, immediately followed by a command with NO output that exits 1
// (its C and D land on the very same row — the zero-output degenerate case),
// immediately followed by the still-open trailing prompt awaiting input.
function oscSnapshotLines() {
  const line = (text, osc) => ({
    runs: [{ text, attrs: {} }],
    text,
    osc: osc || null,
  });

  return [
    line("user@host:~$ ls -la", "A"),
    line("file1.txt", "C"),
    line("file2.txt"),
    line("user@host:~$ false", "D;0|A"),
    line("user@host:~$ ", "C|D;1|A"),
  ];
}

// A session with no OSC 133 markers anywhere, as if the shell integration
// were never installed: two idle prompts (the sigil-ending lines today's
// heuristic classifier recognizes — see term-tokenizer.js's isPrompt)
// bracketing a run of plain output.
function heuristicSnapshotLines() {
  const line = (text) => ({ runs: [{ text, attrs: {} }], text, osc: null });
  return [
    line("~/project$"),
    line("file1.txt"),
    line("file2.txt"),
    line("~/project$"),
  ];
}

function makeDoc(lines) {
  return {
    snapshot: () => ({ lines, status: null }),
    subscribe: () => ({ dispose: () => {} }),
    onOscDetected: () => ({ dispose: () => {} }),
    oscDetected: lines.some((l) => l.osc),
  };
}

// Renders a synthetic document with no `session` (so no history fetch —
// matches reader-font.spec.cjs's approach) and extracts everything the
// grouping/chat-layout tests below assert on, including computed alignment
// (getComputedStyle, not raw classes/attributes — a left/right claim must
// hold on-screen, not just in markup).
async function renderSnapshot(page, snapshotLines) {
  return page.evaluate(async (lines) => {
    const { createReader } = await import("/static/reader.js");

    const host = document.createElement("div");
    host.id = "readerGroupingTest";
    document.body.appendChild(host);

    const doc = {
      snapshot: () => ({ lines, status: null }),
      subscribe: () => ({ dispose: () => {} }),
      onOscDetected: () => ({ dispose: () => {} }),
      oscDetected: lines.some((l) => l.osc),
    };

    const reader = createReader({ host, document: doc });
    reader.mount();
    reader.forceRender();

    const commandBlocks = Array.from(host.querySelectorAll(".rb-command"));
    const out = {
      commandCount: commandBlocks.length,
      promptCount: host.querySelectorAll(".rb-prompt").length,
      textCount: host.querySelectorAll(".rb-text").length,
      commands: commandBlocks.map((el) => {
        const cmdEl = el.querySelector(".rb-command-line");
        const outEl = el.querySelector(".rb-command-output");
        return {
          commandLine: cmdEl?.textContent || "",
          outputLines: Array.from(
            el.querySelectorAll(".rb-command-output .rb-line"),
          ).map((l) => l.textContent),
          hasOutputEl: !!outEl,
          statusText: el.querySelector(".rb-command-status")?.textContent,
          statusOk: !!el.querySelector(".rb-status-ok"),
          statusFail: !!el.querySelector(".rb-status-fail"),
          // Computed visibility, not a raw hidden attribute — the chip must
          // actually render on-screen, not just exist in the DOM.
          statusVisible: (() => {
            const chip = el.querySelector(".rb-command-status");
            if (!chip) return false;
            const style = getComputedStyle(chip);
            return style.display !== "none" && style.visibility !== "hidden";
          })(),
          // Chat layout (issue #221): command docks left, response docks
          // right — computed flex alignment, not a class name, so a CSS
          // regression that leaves the class in place but drops the
          // alignment still fails this.
          commandAlignSelf: cmdEl ? getComputedStyle(cmdEl).alignSelf : null,
          outputAlignSelf: outEl ? getComputedStyle(outEl).alignSelf : null,
          commandWhiteSpace: cmdEl ? getComputedStyle(cmdEl).whiteSpace : null,
          commandOverflowX: cmdEl ? getComputedStyle(cmdEl).overflowX : null,
        };
      }),
    };

    reader.dispose();
    host.remove();
    return out;
  }, snapshotLines);
}

test("reader: OSC 133 C/D group each command with its output into one chat turn", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  const result = await renderSnapshot(page, oscSnapshotLines());

  // Two commands ran; neither leaks out as a bare .rb-prompt (only the
  // still-open trailing prompt does) and no output escapes into .rb-text.
  expect(result.commandCount).toBe(2);
  expect(result.promptCount).toBe(1);
  expect(result.textCount).toBe(0);

  const [ls, falseCmd] = result.commands;

  expect(ls.commandLine).toContain("ls -la");
  expect(ls.outputLines).toEqual(["file1.txt", "file2.txt"]);
  expect(ls.hasOutputEl).toBe(true);

  expect(falseCmd.commandLine).toContain("false");
  // Zero-output command: no output element at all, just the command line
  // and its exit status.
  expect(falseCmd.hasOutputEl).toBe(false);
  expect(falseCmd.outputLines).toEqual([]);
});

test("reader: chat turn docks the command left and the response right", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  const result = await renderSnapshot(page, oscSnapshotLines());
  const [ls] = result.commands;

  expect(ls.commandAlignSelf).toBe("flex-start");
  expect(ls.outputAlignSelf).toBe("flex-end");
});

test("reader: command text stays monospace with horizontal scroll, never reflows to the viewport", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  const result = await renderSnapshot(page, oscSnapshotLines());
  const [ls] = result.commands;

  // Command/code lines keep their own line breaks and scroll horizontally
  // (issue #221 R4) rather than wrapping to the viewport width.
  expect(ls.commandWhiteSpace).toBe("pre");
  expect(ls.commandOverflowX).toBe("auto");
});

test("reader: exit status renders as a muted pass/fail chip", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  const result = await renderSnapshot(page, oscSnapshotLines());
  const [ls, falseCmd] = result.commands;

  expect(ls.statusOk).toBe(true);
  expect(ls.statusFail).toBe(false);
  expect(ls.statusVisible).toBe(true);
  expect(ls.statusText.trim()).toBe("✓");

  expect(falseCmd.statusFail).toBe(true);
  expect(falseCmd.statusOk).toBe(false);
  expect(falseCmd.statusVisible).toBe(true);
  expect(falseCmd.statusText.trim()).toBe("✗ 1");
});

test("reader: falls back to heuristic blocks when OSC 133 is not installed", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  const result = await renderSnapshot(page, heuristicSnapshotLines());

  // No C/D markers at all — nothing groups, and the un-instrumented session
  // renders exactly like today: a heuristic prompt block per prompt-looking
  // line, plain text otherwise. No chat layout applies without at least one
  // grouped command (see reader.js's hasChatContent).
  expect(result.commandCount).toBe(0);
  expect(result.promptCount).toBe(2);
  expect(result.textCount).toBe(1);
});

// ── Chat view: server history + live-tail reconciliation (issue #221) ────
// These stub `window.fetch` to serve canned `/api/sessions/*/conversation`
// responses instead of driving a real tmux session — the real end-to-end
// path (real shell, real pagination) is covered separately by
// reader-chat-history.spec.cjs.
async function renderWithHistory(page, { historyEntries, liveLines }) {
  return page.evaluate(
    async ({ historyEntries, liveLines }) => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("/conversation")) {
          return new Response(
            JSON.stringify({ entries: historyEntries, nextCursor: "stub" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return originalFetch(input, init);
      };

      const { createReader } = await import("/static/reader.js");

      const host = document.createElement("div");
      host.id = "readerHistoryTest";
      document.body.appendChild(host);

      const doc = {
        snapshot: () => ({ lines: liveLines, status: null }),
        subscribe: () => ({ dispose: () => {} }),
        onOscDetected: () => ({ dispose: () => {} }),
        oscDetected: liveLines.some((l) => l.osc),
      };

      const reader = createReader({
        host,
        document: doc,
        session: "stub-session",
      });
      reader.mount();
      // chatHistory.loadAll() is async — wait for it to land, then force a
      // fresh render so the fetched turns are reflected.
      await new Promise((r) => setTimeout(r, 50));
      reader.forceRender();

      const commandBlocks = Array.from(host.querySelectorAll(".rb-command"));
      const out = {
        commandCount: commandBlocks.length,
        rawTextBlocks: host.querySelectorAll(".rb-text").length,
        commands: commandBlocks.map((el) => ({
          commandLine: el.querySelector(".rb-command-line")?.textContent,
          hasOutputEl: !!el.querySelector(".rb-command-output"),
          outputText: el.querySelector(".rb-command-output")?.textContent,
          statusText: el.querySelector(".rb-command-status")?.textContent,
        })),
        loadOlderBtn: host.querySelector(".rb-chat-loadmore")?.textContent,
      };

      reader.dispose();
      host.remove();
      window.fetch = originalFetch;
      return out;
    },
    { historyEntries, liveLines },
  );
}

test("reader: chat view merges server history with a still-open live command, without duplicating a just-completed one", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  const historyEntries = [
    { seq: 1, command: "echo one", output: "one\n", exitCode: 0 },
    { seq: 2, command: "echo two", output: "two\n", exitCode: 0 },
  ];
  // The live buffer's tail replays the SAME "echo two" the history already
  // has (as if the WS feeder recorded it a moment ago) plus a brand new
  // still-open command with no D marker yet.
  const line = (text, osc) => ({
    runs: [{ text, attrs: {} }],
    text,
    osc: osc || null,
  });
  const liveLines = [
    line("user@host:~$ echo two", "A"),
    line("two", "C"),
    line("user@host:~$ echo three", "D;0|A"),
    line("three so far...", "C"),
  ];

  const result = await renderWithHistory(page, { historyEntries, liveLines });

  // Both history turns plus exactly one new (open) live turn — "echo two"
  // must NOT render twice.
  expect(result.commandCount).toBe(3);
  const texts = result.commands.map((c) => c.commandLine);
  expect(texts.filter((t) => t.includes("echo two")).length).toBe(1);
  expect(texts.some((t) => t.includes("echo one"))).toBe(true);
  expect(texts.some((t) => t.includes("echo three"))).toBe(true);

  const openTurn = result.commands.find((c) =>
    c.commandLine.includes("echo three"),
  );
  // Still open (no D yet) — no exit chip, but its partial output already
  // shows (the live tail streams before the server has it).
  expect(openTurn.statusText).toBeFalsy();
  expect(openTurn.outputText).toContain("three so far");
});

test("reader: an empty command text still renders its output turn", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  // Known server-side limitation (issue #220's review): a command's text
  // can rarely land empty (tmux redraw-burst timing). The turn must still
  // render — command side as an empty placeholder, output side intact —
  // never dropped and never breaking layout.
  const historyEntries = [
    { seq: 1, command: "", output: "mystery output\n", exitCode: 0 },
  ];

  const result = await renderWithHistory(page, {
    historyEntries,
    liveLines: [],
  });

  expect(result.commandCount).toBe(1);
  const [turn] = result.commands;
  expect(turn.hasOutputEl).toBe(true);
  expect(turn.outputText).toContain("mystery output");
  expect(turn.statusText.trim()).toBe("✓");
});

test("reader: raw (un-instrumented) history entries render as plain text, not a chat turn", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  const historyEntries = [
    { seq: 1, raw: "some unattributed output\n", ts: 1 },
    { seq: 2, command: "echo hi", output: "hi\n", exitCode: 0 },
  ];

  const result = await renderWithHistory(page, {
    historyEntries,
    liveLines: [],
  });

  expect(result.commandCount).toBe(1);
  expect(result.rawTextBlocks).toBe(1);
});

test("reader: load older reveals more of the already-fetched history without breaking layout", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  const historyEntries = Array.from({ length: 30 }, (_, i) => ({
    seq: i + 1,
    command: `echo turn-${i}`,
    output: `turn-${i}\n`,
    exitCode: 0,
  }));

  const result = await page.evaluate(async (historyEntries) => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/conversation")) {
        return new Response(
          JSON.stringify({ entries: historyEntries, nextCursor: "stub" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(input);
    };

    const { createReader } = await import("/static/reader.js");
    const host = document.createElement("div");
    host.id = "readerLoadOlderTest";
    document.body.appendChild(host);
    Object.assign(host.style, { height: "400px", width: "300px" });
    document.body.appendChild(host);

    const doc = {
      snapshot: () => ({ lines: [], status: null }),
      subscribe: () => ({ dispose: () => {} }),
      onOscDetected: () => ({ dispose: () => {} }),
      oscDetected: false,
    };

    const reader = createReader({
      host,
      document: doc,
      session: "stub-session-loadmore",
    });
    reader.mount();
    await new Promise((r) => setTimeout(r, 50));
    reader.forceRender();

    const before = {
      commandCount: host.querySelectorAll(".rb-command").length,
      loadOlderText: host.querySelector(".rb-chat-loadmore")?.textContent,
    };

    const btn = host.querySelector(".rb-chat-loadmore");
    btn?.click();

    const after = {
      commandCount: host.querySelectorAll(".rb-command").length,
      hasLoadOlder: !!host.querySelector(".rb-chat-loadmore"),
    };

    reader.dispose();
    host.remove();
    window.fetch = originalFetch;
    return { before, after };
  }, historyEntries);

  // 30 turns fetched, only CHAT_WINDOW_SIZE (24) rendered initially.
  expect(result.before.commandCount).toBe(24);
  expect(result.before.loadOlderText).toContain("6");

  // One click reveals everything — already resident in memory from the
  // single history fetch, no further network call needed.
  expect(result.after.commandCount).toBe(30);
  expect(result.after.hasLoadOlder).toBe(false);
});
