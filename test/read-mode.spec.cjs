// Read mode: fetch, refresh, and the live loop (issue #236).
//
// The data half of web/static/read-mode.js — the mount fetch, the cursored
// refresh, the hidden-tab stop, the single-flight guard, the error strip and
// teardown. Two levels:
//
//   DOM  — the real module on a throwaway host with a scripted fetcher, no
//          tmux and no server round trip. The poll interval is a factory
//          argument, so the timer itself is exercised in milliseconds rather
//          than slept past.
//   e2e  — the real app against a real tmux+bash/zsh session with the real
//          shell-integration snippet and a real WS attach, driving the real
//          endpoint through the SPA's own apiGet wiring. Same harness as
//          session-history.spec.cjs.
//
// No test here asserts exact command text. The segmenter has a documented,
// measured timing gap that can land a command entry empty or attributed one
// entry off under tmux redraw bursts (#242); those assertions belong to
// session-history.spec.cjs, which owns them and tolerates the gap. Read mode
// asserts turn count, exit chips (driven by the OSC 133 `D;<code>` marker,
// the reliable half) and output text the test itself echoed.

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

const ERROR_TEXT = "can't reach the server — retrying";
const isConversationUrl = (url) => url.pathname.endsWith("/conversation");

function param(request, name) {
  return new URL(request, "http://placeholder").searchParams.get(name);
}

function turn(seq, exitCode = 0) {
  return {
    seq,
    command: `spec$ synthetic-${seq}`,
    output: `output ${seq}\n`,
    exitCode,
  };
}

// ── DOM level ──────────────────────────────────────────────────────
// One read-mode instance on a throwaway host, fed by a fetcher that answers
// from a scripted list: `{ kind: "ok", entries, nextCursor }` resolves,
// `{ kind: "fail" }` rejects with an ApiError-shaped error (what apiGet
// throws), `{ kind: "hang" }` never settles until the test releases it. Steps
// are consumed in order; `fallback` answers every request past the script.
async function installHarness(page) {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    const { createReadMode } = await import("/static/read-mode.js");

    window.__rm = {
      create({ script = [], fallback = null, pollIntervalMs = 3000 }) {
        const host = document.createElement("div");
        host.id = "readModeLoopTest";
        host.style.width = "360px";
        host.style.height = "480px";
        document.body.appendChild(host);

        const state = {
          host,
          requests: [],
          script: script.slice(),
          fallback,
          hangReleases: [],
          timers: new Set(),
        };

        // Read mode's own interval, tracked by its period so nothing else on
        // the page is counted. A poll that stops issuing requests but leaves
        // its timer behind is still a leak, and only this sees it.
        const realSetInterval = window.setInterval.bind(window);
        const realClearInterval = window.clearInterval.bind(window);
        window.setInterval = (fn, ms) => {
          const id = realSetInterval(fn, ms);
          if (ms === pollIntervalMs) state.timers.add(id);
          return id;
        };
        window.clearInterval = (id) => {
          state.timers.delete(id);
          return realClearInterval(id);
        };

        const fetchPage = (path) => {
          state.requests.push(path);
          const step = state.script.shift() || state.fallback;
          if (!step || step.kind === "hang") {
            return new Promise((resolve) => state.hangReleases.push(resolve));
          }
          if (step.kind === "fail") {
            const err = new Error(`GET ${path} -> 500`);
            err.name = "ApiError";
            err.method = "GET";
            err.url = path;
            err.status = 500;
            return Promise.reject(err);
          }
          return Promise.resolve({
            entries: step.entries || [],
            nextCursor: step.nextCursor,
          });
        };

        state.rm = createReadMode({
          host,
          session: "loopspec",
          fetchPage,
          pollIntervalMs,
        });
        window.__rmState = state;
      },
      mount() {
        window.__rmState.rm.mount();
      },
      seed(entries) {
        window.__rmState.rm.setEntries(entries);
      },
      unmount() {
        window.__rmState.rm.unmount();
      },
      refreshNow() {
        return window.__rmState.rm.refreshNow();
      },
      requests() {
        return window.__rmState.requests.slice();
      },
      requestCount() {
        return window.__rmState.requests.length;
      },
      liveTimers() {
        return window.__rmState.timers.size;
      },
      release(payload) {
        for (const resolve of window.__rmState.hangReleases.splice(0)) {
          resolve(payload);
        }
      },
      setVisibility(value) {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => value,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      },
      snapshot() {
        const { host } = window.__rmState;
        const paints = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden";
        };
        const error = host.querySelector(".cv-error");
        const empty = host.querySelector(".cv-empty");
        return {
          seqs: Array.from(host.querySelectorAll(".cv-turn")).map(
            (el) => el.dataset.seq,
          ),
          error: error
            ? { text: error.textContent, visible: paints(error) }
            : null,
          empty: empty
            ? { text: empty.textContent, visible: paints(empty) }
            : null,
        };
      },
    };
  });
}

async function createReadMode(page, opts) {
  await page.evaluate((o) => window.__rm.create(o), opts);
}

// mount() kicks the first fetch itself; refreshNow() returns that in-flight
// request (single flight), so awaiting it awaits the mount render.
async function mountAndSettle(page) {
  await page.evaluate(() => {
    window.__rm.mount();
    return window.__rm.refreshNow();
  });
}

test("read mode: the mount fetch carries tail, every refresh carries the cursor", async ({
  page,
}) => {
  await installHarness(page);
  await createReadMode(page, {
    pollIntervalMs: 60000,
    script: [
      { kind: "ok", entries: [turn(1), turn(2)], nextCursor: "CUR-1" },
      { kind: "ok", entries: [turn(3)], nextCursor: "CUR-2" },
      { kind: "ok", entries: [], nextCursor: "CUR-2" },
    ],
    fallback: { kind: "ok", entries: [], nextCursor: "CUR-2" },
  });

  await mountAndSettle(page);
  await page.evaluate(() => window.__rm.refreshNow());
  await page.evaluate(() => window.__rm.refreshNow());

  const requests = await page.evaluate(() => window.__rm.requests());
  expect(requests).toHaveLength(3);

  expect(new URL(requests[0], "http://placeholder").pathname).toBe(
    "/api/sessions/loopspec/conversation",
  );
  expect(param(requests[0], "tail")).toBe("200");
  expect(param(requests[0], "cursor")).toBe(null);

  for (const request of requests.slice(1)) {
    expect(param(request, "tail")).toBe(null);
    expect(param(request, "cursor")).not.toBe(null);
    expect(param(request, "limit")).toBe("500");
  }
  // The held cursor is the previous response's, so it advances page by page.
  expect(param(requests[1], "cursor")).toBe("CUR-1");
  expect(param(requests[2], "cursor")).toBe("CUR-2");

  // Appended, not rebuilt: the turns the mount drew keep their seq and the
  // refresh's turn lands after them.
  const { seqs } = await page.evaluate(() => window.__rm.snapshot());
  expect(seqs).toEqual(["1", "2", "3"]);
});

test("read mode: a failed fetch shows the strip and keeps the turns; the next success clears it", async ({
  page,
}) => {
  await installHarness(page);
  await createReadMode(page, {
    pollIntervalMs: 60000,
    script: [
      { kind: "ok", entries: [turn(1), turn(2)], nextCursor: "CUR-1" },
      { kind: "fail" },
      { kind: "ok", entries: [turn(3)], nextCursor: "CUR-2" },
    ],
    fallback: { kind: "ok", entries: [], nextCursor: "CUR-2" },
  });

  await mountAndSettle(page);
  expect(await page.evaluate(() => window.__rm.snapshot())).toMatchObject({
    seqs: ["1", "2"],
    error: null,
  });

  await page.evaluate(() => window.__rm.refreshNow());
  const failed = await page.evaluate(() => window.__rm.snapshot());
  expect(failed.error).toEqual({ text: ERROR_TEXT, visible: true });
  expect(failed.seqs).toEqual(["1", "2"]);

  await page.evaluate(() => window.__rm.refreshNow());
  const recovered = await page.evaluate(() => window.__rm.snapshot());
  expect(recovered.error).toBe(null);
  expect(recovered.seqs).toEqual(["1", "2", "3"]);
});

test("read mode: a session with no history renders the empty state", async ({
  page,
}) => {
  await installHarness(page);
  await createReadMode(page, {
    pollIntervalMs: 60000,
    script: [
      { kind: "ok", entries: [], nextCursor: "CUR-0" },
      { kind: "ok", entries: [turn(1)], nextCursor: "CUR-1" },
    ],
    fallback: { kind: "ok", entries: [], nextCursor: "CUR-1" },
  });

  // Mount paints whatever the component already holds, so a host that starts
  // blank would show the empty state whether or not anything was ever fetched.
  // Put a turn on screen first: the empty state can then only be what the
  // first page — zero entries — produced.
  await page.evaluate(() => window.__rm.seed([{ seq: 9, command: "a$ x" }]));
  await mountAndSettle(page);
  const empty = await page.evaluate(() => window.__rm.snapshot());
  expect(empty.seqs).toEqual([]);
  expect(empty.empty).not.toBe(null);
  expect(empty.empty.visible).toBe(true);
  expect(empty.empty.text).toContain("Nothing recorded yet");

  // The first turn to arrive replaces it.
  await page.evaluate(() => window.__rm.refreshNow());
  const filled = await page.evaluate(() => window.__rm.snapshot());
  expect(filled.seqs).toEqual(["1"]);
  expect(filled.empty).toBe(null);
});

test("read mode: no request goes out while the tab is hidden, and the timer restarts on visible", async ({
  page,
}) => {
  await installHarness(page);
  await createReadMode(page, {
    pollIntervalMs: 50,
    fallback: { kind: "ok", entries: [], nextCursor: "CUR" },
  });

  // Hidden before the mount, so nothing — not even the first fetch — goes out,
  // and no timer is left ticking to produce one.
  await page.evaluate(() => window.__rm.setVisibility("hidden"));
  await page.evaluate(() => window.__rm.mount());
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__rm.requestCount())).toBe(0);
  expect(await page.evaluate(() => window.__rm.liveTimers())).toBe(0);

  await page.evaluate(() => window.__rm.setVisibility("visible"));
  await expect
    .poll(() => page.evaluate(() => window.__rm.requestCount()), {
      timeout: 5000,
      message: "waiting for the poll to resume on a visible tab",
    })
    .toBeGreaterThanOrEqual(3);
});

test("read mode: becoming visible fetches immediately rather than waiting out the interval", async ({
  page,
}) => {
  await installHarness(page);
  // An interval long enough that no tick can fire during this test: the only
  // thing that can produce a request is the visibility change itself.
  await createReadMode(page, {
    pollIntervalMs: 60000,
    fallback: { kind: "ok", entries: [turn(1)], nextCursor: "CUR" },
  });

  await page.evaluate(() => window.__rm.setVisibility("hidden"));
  await page.evaluate(() => window.__rm.mount());
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__rm.requestCount())).toBe(0);

  await page.evaluate(() => window.__rm.setVisibility("visible"));
  await expect
    .poll(() => page.evaluate(() => window.__rm.requestCount()), {
      timeout: 5000,
      message: "waiting for the immediate fetch on becoming visible",
    })
    .toBe(1);

  const requests = await page.evaluate(() => window.__rm.requests());
  expect(param(requests[0], "tail")).toBe("200");
  const { seqs } = await page.evaluate(() => window.__rm.snapshot());
  expect(seqs).toEqual(["1"]);
});

test("read mode: a tick arriving on a pending fetch is skipped, and the loop resumes after it lands", async ({
  page,
}) => {
  await installHarness(page);
  await createReadMode(page, {
    pollIntervalMs: 50,
    script: [{ kind: "hang" }],
    fallback: { kind: "ok", entries: [], nextCursor: "CUR-1" },
  });

  await page.evaluate(() => window.__rm.mount());
  // Ten intervals' worth of ticks, all of them dropped on the floor: one
  // request in flight means no second request, no queue and no cancellation.
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__rm.requestCount())).toBe(1);

  // Skipping is not stalling: the held request landing lets the next tick go.
  await page.evaluate(() =>
    window.__rm.release({ entries: [], nextCursor: "CUR-1" }),
  );
  await expect
    .poll(() => page.evaluate(() => window.__rm.requestCount()), {
      timeout: 5000,
      message: "waiting for the poll to resume once the held fetch lands",
    })
    .toBeGreaterThanOrEqual(3);

  const requests = await page.evaluate(() => window.__rm.requests());
  expect(param(requests[1], "cursor")).toBe("CUR-1");
});

test("read mode: unmounting stops the poll", async ({ page }) => {
  await installHarness(page);
  await createReadMode(page, {
    pollIntervalMs: 50,
    fallback: { kind: "ok", entries: [], nextCursor: "CUR" },
  });

  await page.evaluate(() => window.__rm.mount());
  await expect
    .poll(() => page.evaluate(() => window.__rm.requestCount()), {
      timeout: 5000,
      message: "waiting for the poll to run before unmounting",
    })
    .toBeGreaterThanOrEqual(3);
  expect(await page.evaluate(() => window.__rm.liveTimers())).toBe(1);

  const atUnmount = await page.evaluate(() => {
    window.__rm.unmount();
    return window.__rm.requestCount();
  });
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__rm.requestCount())).toBe(atUnmount);
  // Nothing is left ticking either: a timer that only no-ops is still a leak.
  expect(await page.evaluate(() => window.__rm.liveTimers())).toBe(0);
});

// ── e2e level ──────────────────────────────────────────────────────
// Real tmux, real shell integration, real WS attach, real endpoint, real
// apiGet wiring — the same harness session-history.spec.cjs uses.

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

// What the server has recorded so far. Goes through Playwright's own request
// context rather than the page, so it is not caught by the route that watches
// what read mode itself asks for.
async function recordedCommands(page, session) {
  const res = await page.request.get(
    `${BASE}/api/sessions/${encodeURIComponent(session)}/conversation`,
  );
  if (!res.ok()) return [];
  const body = await res.json();
  return body.entries.filter((e) => "command" in e);
}

function readModeView(page) {
  return page.evaluate(() => {
    const host = document.querySelector("#readmode");
    const turns = Array.from(host.querySelectorAll(".cv-turn"));
    return {
      seqs: turns.map((el) => el.dataset.seq),
      chips: turns.map(
        (el) => el.querySelector(".cv-exit")?.textContent ?? null,
      ),
      outputs: turns.map(
        (el) => el.querySelector(".cv-out")?.textContent ?? "",
      ),
      errorStrip: !!host.querySelector(".cv-error"),
    };
  });
}

function refreshReadMode(page) {
  return page.evaluate(() => window.__mobuxView.test.readModeRefreshNow());
}

// One attempt: a warm-up plus three commands with known exit codes, then read
// mode over the top of them. Returns `{ ok, detail }` rather than asserting,
// for the same reason session-history.spec.cjs does — tmux's redraw-burst
// reordering can rarely leave the segmenter one entry off, and a retry
// tolerates that without masking a structural failure (a read mode that never
// fetches, or fetches wrong, fails every attempt).
//
// Rendered output text is asserted against what the server actually recorded,
// not against what was typed. The same redraw burst that can empty a command
// entry can swallow that command's output too (measured here at roughly one
// echo in four under zsh) — that gap is the segmenter's, filed as #242, and
// inheriting it would make this spec flaky about something it does not test.
// Read mode's contract is that every recorded marker reaches the screen, and
// at least one of the two must have been recorded for the attempt to count.
async function attemptReadModeE2E(
  page,
  { shell, rcPath, seedRc, shellCommand },
) {
  const session = `readmode-${shell}-${process.pid}-${Date.now()}`;
  const marker = `mk${Date.now().toString(36)}`;
  const laterMarker = `lm${Date.now().toString(36)}`;
  const requests = [];
  const record = (route) => {
    requests.push(route.request().url());
    return route.continue();
  };

  await page.goto(`${APP}#/settings`, { waitUntil: "networkidle" });
  await apiUninstall(page, shell);
  fs.writeFileSync(rcPath, seedRc);
  await apiInstall(page, shell);

  try {
    tmux(`kill-session -t ${session}`);
  } catch (_) {}
  tmux(`new-session -d -s ${session} ${SHELL_ENV} ${shellCommand}`);

  try {
    await page.goto(`${APP}#/s/${session}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => window.__mobuxView && window.__mobuxView.test,
    );
    await waitForClientAttached(tmux, session);

    // Swapping views persists `default_view`, so a previous attempt can leave
    // the island booting straight into read mode — mounting, and fetching,
    // before the route below is watching. Every attempt starts on the terminal.
    await page.evaluate(() => window.__mobuxView.swap("xterm"));
    await expect
      .poll(() => page.evaluate(() => window.__mobuxView.current), {
        timeout: 5000,
        message: "waiting for the island to settle on the terminal view",
      })
      .toBe("xterm");

    // The session's very first prompt drew before the browser attached, so it
    // carries no marker — the warm-up gives the first asserted command a
    // marked prompt to land on. It is a turn like any other, so it is counted.
    // Pacing on the previous command's own entry, plus a beat, matches how a
    // session is really driven and keeps the sends out of tmux's redraw bursts.
    const entriesAtLeast = async (n) => {
      await expect
        .poll(async () => (await recordedCommands(page, session)).length, {
          timeout: 8000,
          message: `waiting for ${n} command entries`,
        })
        .toBeGreaterThanOrEqual(n);
      await page.waitForTimeout(250);
    };
    const commands = ["true", "true", "false", `echo ${marker}`];
    for (let i = 0; i < commands.length; i++) {
      tmux(`send-keys -t ${session} '${commands[i]}' Enter`);
      await entriesAtLeast(i + 1);
    }

    const recorded = await recordedCommands(page, session);
    if (recorded.length !== commands.length) {
      return {
        ok: false,
        detail: `expected ${commands.length} recorded command entries before swapping, got ${recorded.length}`,
      };
    }
    const markerRecorded = recorded.some((e) => e.output.includes(marker));

    // From here on, read mode is the only thing asking the endpoint for pages.
    await page.route(isConversationUrl, record);
    await page.evaluate(() => window.__mobuxView.swap("read"));
    await refreshReadMode(page);

    const failures = [];
    const view = await readModeView(page);
    if (view.errorStrip)
      failures.push("error strip showing on a healthy fetch");
    if (view.seqs.length !== 4) {
      failures.push(`expected 4 turns, got ${view.seqs.length}`);
    } else if (view.chips.join("|") !== ["✓", "✓", "✗ 1", "✓"].join("|")) {
      failures.push(`unexpected exit chips: ${JSON.stringify(view.chips)}`);
    }
    if (markerRecorded && !view.outputs.some((t) => t.includes(marker))) {
      failures.push(`recorded output ${marker} is not on screen`);
    }

    // A command finishing while read mode is showing appends a turn. The swap
    // resized the terminal, so let tmux finish repainting before typing into
    // it.
    await page.waitForTimeout(600);
    tmux(`send-keys -t ${session} 'echo ${laterMarker}' Enter`);
    await entriesAtLeast(5);
    const laterRecorded = (await recordedCommands(page, session)).some((e) =>
      e.output.includes(laterMarker),
    );

    await expect
      .poll(
        async () => {
          await refreshReadMode(page);
          return page.evaluate(
            () => document.querySelectorAll("#readmode .cv-turn").length,
          );
        },
        { timeout: 10000, message: "waiting for the fifth turn to append" },
      )
      .toBeGreaterThanOrEqual(5);

    const after = await readModeView(page);
    if (after.seqs.length !== 5) {
      failures.push(
        `expected 5 turns after the refresh, got ${after.seqs.length}`,
      );
    }
    if (new Set(after.seqs).size !== after.seqs.length) {
      failures.push(`duplicated data-seq: ${JSON.stringify(after.seqs)}`);
    }
    if (after.seqs.slice(0, 4).join("|") !== view.seqs.join("|")) {
      failures.push("the turns already on screen were rebuilt, not kept");
    }
    if (laterRecorded && !after.outputs.some((t) => t.includes(laterMarker))) {
      failures.push(`recorded output ${laterMarker} is not on screen`);
    }
    if (!markerRecorded && !laterRecorded) {
      failures.push("the recording caught neither echo, so nothing was proven");
    }

    if (requests.length < 2) {
      failures.push(`expected at least 2 requests, got ${requests.length}`);
    } else {
      if (param(requests[0], "tail") === null) {
        failures.push(`mount request carries no tail: ${requests[0]}`);
      }
      if (param(requests[0], "cursor") !== null) {
        failures.push(`mount request carries a cursor: ${requests[0]}`);
      }
      for (const request of requests.slice(1)) {
        if (param(request, "cursor") === null) {
          failures.push(`refresh carries no cursor: ${request}`);
        }
        if (param(request, "tail") !== null) {
          failures.push(`refresh carries a tail: ${request}`);
        }
      }
    }

    return { ok: failures.length === 0, detail: failures.join("; ") };
  } finally {
    await page.unroute(isConversationUrl, record);
    try {
      tmux(`kill-session -t ${session}`);
    } catch (_) {}
    await apiUninstall(page, shell);
  }
}

async function verifyReadModeE2E(page, opts, attempts = 3) {
  const details = [];
  for (let i = 0; i < attempts; i++) {
    const result = await attemptReadModeE2E(page, opts);
    if (result.ok) return;
    details.push(`attempt ${i + 1}: ${result.detail}`);
  }
  expect(
    false,
    `all ${attempts} attempt(s) failed — ${details.join(" | ")}`,
  ).toBe(true);
}

test("read mode: a real bash session's finished commands render as turns, and a new one appends", async ({
  page,
}) => {
  test.setTimeout(90000);
  await verifyReadModeE2E(page, {
    shell: "bash",
    // A known, seeded PS1: SANDBOX_HOME is shared with every other spec in the
    // same run, so a stray prompt from an earlier test must not decide this
    // one's shape.
    rcPath: `${SANDBOX_HOME}/.bashrc`,
    seedRc: "PS1='readmodetest: '\n",
    shellCommand: "bash",
  });
});

test.describe("read mode: zsh", () => {
  let zshBin;

  test.beforeAll(() => {
    zshBin = resolveZshBin();
  });

  test("read mode: a real zsh session's finished commands render as turns, and a new one appends", async ({
    page,
  }) => {
    test.setTimeout(90000);
    await verifyReadModeE2E(page, {
      shell: "zsh",
      rcPath: `${SANDBOX_HOME}/.zshrc`,
      seedRc: "PROMPT='readmodetest: '\n",
      shellCommand: zshBin,
    });
  });
});

test("read mode: a failing conversation fetch never takes the app over", async ({
  page,
}) => {
  const session = `readmodeerr-${process.pid}-${Date.now()}`;
  let failing = true;
  const answer = (route) =>
    failing
      ? route.fulfill({
          status: 500,
          contentType: "text/plain",
          body: "conversation unavailable",
        })
      : route.continue();

  try {
    tmux(`kill-session -t ${session}`);
  } catch (_) {}
  tmux(`new-session -d -s ${session} ${SHELL_ENV} bash`);

  try {
    await page.route(isConversationUrl, answer);
    await page.goto(`${APP}#/s/${session}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => window.__mobuxView && window.__mobuxView.test,
    );

    await page.evaluate(() => window.__mobuxView.swap("read"));
    await refreshReadMode(page);

    const strip = page.locator("#readmode .cv-error");
    await expect(strip).toBeVisible();
    await expect(strip).toHaveText(ERROR_TEXT);

    // apiGet throws an ApiError; read mode catches it here. Uncaught, it would
    // reach lib/fatalError.js's unhandledrejection hook and replace the whole
    // app with the fail-hard page — a stale conversation is not a dead app.
    // The listener fires on a later task, so give it one before asserting.
    await page.waitForTimeout(250);
    await expect(page.locator(".fatal-error-page")).toHaveCount(0);
    expect(await page.evaluate(() => window.__mobuxView.current)).toBe("read");

    failing = false;
    await refreshReadMode(page);
    await expect(strip).toHaveCount(0);
    await expect(page.locator("#readmode .cv-empty")).toBeVisible();
  } finally {
    await page.unroute(isConversationUrl, answer);
    try {
      tmux(`kill-session -t ${session}`);
    } catch (_) {}
  }
});
