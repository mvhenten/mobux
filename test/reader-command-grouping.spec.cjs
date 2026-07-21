// Reader command grouping (issue #219): OSC 133 C (command start) and D
// (command end + exit code) markers group each command with its output into
// one reader block, with a muted pass/fail chip for the exit status. Without
// C/D markers the reader falls back to today's heuristic blocks unchanged.
//
// Drives reader.js's real render pipeline (createReader + term-tokenizer's
// tokenize) with a synthetic document snapshot instead of a live tmux/PTY
// session — same approach as reader-font.spec.cjs (issue #218) — so this
// stays decoupled from the terminal engine and OSC 133 attribution.

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
      commands: commandBlocks.map((el) => ({
        commandLine: el.querySelector(".rb-command-line")?.textContent || "",
        outputLines: Array.from(
          el.querySelectorAll(".rb-command-output .rb-line"),
        ).map((l) => l.textContent),
        hasOutputEl: !!el.querySelector(".rb-command-output"),
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
      })),
    };

    reader.dispose();
    host.remove();
    return out;
  }, snapshotLines);
}

test("reader: OSC 133 C/D group each command with its output into one block", async ({
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
  // line, plain text otherwise.
  expect(result.commandCount).toBe(0);
  expect(result.promptCount).toBe(2);
  expect(result.textCount).toBe(1);
});
