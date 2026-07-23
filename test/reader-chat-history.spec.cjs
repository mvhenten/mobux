// Reader chat view (issue #221): end-to-end coverage against a real tmux +
// bash session with OSC 133 shell integration installed — the payoff view
// consuming the real history endpoint (issue #220) plus the live tail, not
// a synthetic document snapshot (see reader-command-grouping.spec.cjs for
// that half). Same real-shell-integration harness as
// session-history.spec.cjs / spa.spec.cjs's OSC 133 coverage.
//
// Rides the same isolated smoke instance as the rest of the suite (see
// Makefile's test-spa target).

const fs = require("fs");
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

async function readerCommandTurns(page) {
  return page.evaluate(() => {
    // Text content excluding the .rb-speaker button's own label (its ▶/■
    // glyph would otherwise land inside the command/output text and break
    // suffix/exact-text assertions — same trap spa.spec.cjs's reader
    // assertions avoid by using .includes()/.startsWith() instead).
    const textWithoutSpeaker = (el) => {
      if (!el) return "";
      const clone = el.cloneNode(true);
      clone.querySelectorAll(".rb-speaker").forEach((s) => s.remove());
      return (clone.textContent || "").trim();
    };
    const els = Array.from(document.querySelectorAll("#reader .rb-command"));
    return els.map((el) => {
      const cmdEl = el.querySelector(".rb-command-line");
      const outEl = el.querySelector(".rb-command-output");
      return {
        command: textWithoutSpeaker(cmdEl),
        output: textWithoutSpeaker(outEl),
        status: el.querySelector(".rb-command-status")?.textContent?.trim(),
        commandAlign: cmdEl ? getComputedStyle(cmdEl).alignSelf : null,
        outputAlign: outEl ? getComputedStyle(outEl).alignSelf : null,
      };
    });
  });
}

// One attempt: real shell + real tmux + real WS attach, several commands,
// then the reader's chat view. Returns `{ ok, detail }` rather than
// asserting directly — same reasoning as session-history.spec.cjs's
// attemptConversationHistory: tmux's own redraw-burst reordering can rarely
// leave a command's text empty or bled into the next entry (a measured,
// low-rate timing gap documented in session_history.rs, not a structural
// bug) — tolerated here by searching a command's text across BOTH the
// command and output side of a turn, never by loosening the *count* of
// turns or the exit-status/layout assertions, which must hold every time.
async function attemptChatView(page) {
  const SESSION = `chatview-${process.pid}-${Date.now()}`;

  await page.goto(`${APP}#/settings`, { waitUntil: "networkidle" });
  await apiUninstall(page, "bash");
  // A plain, sigil-free PS1 so exact-suffix assertions don't depend on the
  // sandbox's ambient default (same reasoning as session-history.spec.cjs).
  fs.writeFileSync(`${SANDBOX_HOME}/.bashrc`, "PS1='chatviewtest: '\n");
  await apiInstall(page, "bash");

  try {
    tmux(`kill-session -t ${SESSION}`);
  } catch (_) {}
  tmux(`new-session -d -s ${SESSION} ${SHELL_ENV} bash`);
  // Cap tmux's own pane history hard — the point of #221 is that the chat
  // view survives this. Any command that scrolls out of THIS gets shown
  // only if it's coming from the server's history endpoint, not from tmux's
  // own replay on the next attach.
  tmux(`set-option -t ${SESSION} history-limit 5`);

  try {
    await page.goto(`${APP}#/s/${SESSION}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => window.__mobuxView && window.__mobuxView.test,
    );
    await waitForClientAttached(tmux, SESSION);

    const runAndWait = async (cmd, expectCount) => {
      tmux(`send-keys -t ${SESSION} '${cmd}' Enter`);
      await expect
        .poll(
          async () => {
            const res = await page.evaluate(async (session) => {
              const r = await fetch(
                `/api/sessions/${encodeURIComponent(session)}/conversation`,
              );
              const body = await r.json();
              return body.entries.filter((e) => "command" in e).length;
            }, SESSION);
            return res;
          },
          { timeout: 8000 },
        )
        .toBeGreaterThanOrEqual(expectCount);
    };

    // Warm-up (unmarked first prompt), then more commands than the pane's
    // history-limit can hold, each waited out individually so the server
    // has recorded it before the next one runs (real usage pacing, same
    // reasoning as session-history.spec.cjs).
    await runAndWait("true", 1);
    await runAndWait("echo alpha", 2);
    await runAndWait("echo beta", 3);
    await runAndWait("false", 4);
    await runAndWait("echo gamma-$?", 5);
    await runAndWait("echo delta", 6);
    await runAndWait("echo epsilon", 7);

    await page.evaluate(() => window.__mobuxView.swap("reader"));

    await expect
      .poll(
        async () => {
          await page.evaluate(() =>
            window.__mobuxView.test.readerForceRender(),
          );
          const turns = await readerCommandTurns(page);
          return turns.filter(
            (t) =>
              t.command.includes("epsilon") || t.output.includes("epsilon"),
          ).length;
        },
        { timeout: 8000 },
      )
      .toBeGreaterThan(0);

    const turns = await readerCommandTurns(page);
    const failures = [];
    const hasFragment = (fragment) =>
      turns.some(
        (t) => t.command.includes(fragment) || t.output.includes(fragment),
      );

    // 7 real command entries (true, alpha, beta, false, gamma, delta,
    // epsilon) plus one repeated "echo delta" the OSC-detected wait below
    // doesn't send — expect at least 7 turns rendered. This count must hold
    // exactly; only individual command TEXT is tolerant of the timing gap.
    if (turns.length < 7) {
      failures.push(
        `expected >= 7 chat turns, got ${turns.length}: ${JSON.stringify(turns.map((t) => t.command))}`,
      );
    }

    // The earliest real commands ("alpha") are long gone from tmux's own
    // 5-line pane history by now — they only show up here if the chat view
    // is genuinely reading the server's conversation history, not tmux
    // scrollback.
    if (!hasFragment("alpha")) {
      failures.push(
        `"echo alpha" missing from the chat view — it should have come ` +
          `from server history, not tmux's own (capped) scrollback`,
      );
    }

    const falseCmd = turns.find((t) => t.command.trim().endsWith("false"));
    if (!falseCmd || falseCmd.status !== "✗ 1") {
      failures.push(
        `expected "false" turn with a fail chip, got ${JSON.stringify(falseCmd)}`,
      );
    }

    if (!hasFragment("gamma-1")) {
      failures.push(
        `"gamma-1" missing anywhere in the rendered turns: ${JSON.stringify(turns)}`,
      );
    }

    for (const t of turns) {
      if (t.commandAlign !== "flex-start") {
        failures.push(
          `command "${t.command}" not left-docked: align-self=${t.commandAlign}`,
        );
      }
      if (t.output && t.outputAlign !== "flex-end") {
        failures.push(
          `output for "${t.command}" not right-docked: align-self=${t.outputAlign}`,
        );
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

test("reader chat view: real tmux+bash session renders turns left (command) / right (output) with exit chip, decoupled from tmux's own scrollback", async ({
  page,
}) => {
  let last = { ok: false, detail: "no attempts run" };
  for (let i = 0; i < 3; i++) {
    last = await attemptChatView(page);
    if (last.ok) return;
  }
  expect(last.ok, `all 3 attempt(s) failed; last: ${last.detail}`).toBe(true);
});
