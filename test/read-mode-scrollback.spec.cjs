// Read mode: reaching the whole recorded conversation, not just its tail.
//
// Read mode mounts on the newest turns and its refresh loop only ever moves
// forward, so without a backward page the mount tail is also the ceiling —
// everything the server still retains before it stays unreachable however
// far you scroll. These tests hold the other direction:
//
//   DOM  — the real module on a throwaway host over a scripted record, so
//          the walk back runs end to end (scroll → fetch → prepend) with no
//          server involved. Fails on a build that never asks for `before`.
//   e2e  — a record seeded straight into the instance's data dir and read
//          back through the real endpoint. No tmux: the conversation record
//          is a file the server reads, and seeding it is the only way to get
//          a history longer than a test can type.

const fs = require("fs");
const path = require("path");
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

// Where the instance under test keeps its conversation record, one JSONL
// file per session. `make test-spa` hands it over; without it the e2e half
// has nowhere to seed and skips.
const DATA_DIR = process.env.MOBUX_DATA_DIR || "";

// Longer than the 200-turn mount tail by enough that one extra page would
// not reach the start either.
const RECORD_LENGTH = 700;

function syntheticRecord(length) {
  return Array.from({ length }, (_, i) => {
    const seq = i + 1;
    return {
      seq,
      command: `sandbox:~$ step-${seq} --report`,
      output: `turn ${seq} first line of prose about what happened\n  col-a    col-b    col-c\nturn ${seq} closing line\n`,
      exitCode: seq % 11 === 0 ? 1 : 0,
      startedAt: 1700000000000 + seq * 1000,
      endedAt: 1700000000000 + seq * 1000 + 400,
    };
  });
}

// ── DOM level ──────────────────────────────────────────────────────
// One read-mode instance fed by a fetcher that answers `tail` and `before`
// out of an in-page array, as the endpoint does. Its cursors are plain
// indices — read mode treats them as opaque, so nothing here depends on the
// server's encoding.
async function mountOverRecord(page, length) {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
  await page.evaluate(async (recordLength) => {
    const { createReadMode } = await import("/static/read-mode.js");

    const record = Array.from({ length: recordLength }, (_, i) => {
      const seq = i + 1;
      return {
        seq,
        command: `sandbox:~$ step-${seq} --report`,
        output: `turn ${seq} first line of prose about what happened\n  col-a    col-b    col-c\nturn ${seq} closing line\n`,
        exitCode: 0,
      };
    });

    const host = document.createElement("div");
    host.id = "readModeScrollbackTest";
    host.style.width = "380px";
    host.style.height = "620px";
    document.body.appendChild(host);

    const requests = [];
    const pageFor = (params) => {
      const tail = params.get("tail");
      const before = params.get("before");
      const limit = Number(params.get("limit") || 50);
      let from;
      let to;
      if (tail !== null) {
        to = record.length;
        from = Math.max(0, to - Number(tail));
      } else if (before !== null) {
        to = Number(before);
        from = Math.max(0, to - limit);
      } else {
        from = 0;
        to = Math.min(record.length, limit);
      }
      return {
        entries: record.slice(from, to),
        nextCursor: String(to),
        prevCursor: String(from),
        hasOlder: from > 0,
      };
    };

    const readMode = createReadMode({
      host,
      session: "spec",
      pollIntervalMs: 100000,
      fetchPage: (url) => {
        const params = new URL(url, location.href).searchParams;
        requests.push({
          tail: params.get("tail"),
          before: params.get("before"),
          cursor: params.get("cursor"),
        });
        return Promise.resolve(pageFor(params));
      },
    });

    window.__rmScroll = {
      host,
      readMode,
      requests,
      seqsOnScreen: () =>
        Array.from(host.querySelectorAll(".cv-turn")).map((el) =>
          Number(el.dataset.seq),
        ),
    };
    readMode.mount();
  }, length);

  await expect
    .poll(() => page.evaluate(() => window.__rmScroll.readMode.entryCount))
    .toBeGreaterThan(0);
}

// Scroll upwards the way a thumb does, letting each fetch land, until the
// record says there is nothing older or the budget runs out.
async function scrollToOldest(page, handle, budget = 300) {
  for (let i = 0; i < budget; i++) {
    const done = await page.evaluate((name) => {
      const state = window[name];
      state.readMode.scrollBy(-1500);
      return !state.readMode.hasOlder && state.readMode.scrollY <= 0;
    }, handle);
    if (done) break;
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(150);
}

test("scrolling up reaches the oldest turn in the record", async ({ page }) => {
  await mountOverRecord(page, RECORD_LENGTH);

  const mounted = await page.evaluate(() => window.__rmScroll.seqsOnScreen());
  expect(mounted[mounted.length - 1]).toBe(RECORD_LENGTH);
  expect(mounted[0]).toBeGreaterThan(1);

  await scrollToOldest(page, "__rmScroll");

  const result = await page.evaluate(() => {
    const state = window.__rmScroll;
    const oldest = state.host.querySelector('.cv-turn[data-seq="1"]');
    return {
      seqs: state.seqsOnScreen(),
      oldestPresent: !!oldest,
      oldestText: oldest ? oldest.textContent : null,
      oldestHeight: oldest ? oldest.getBoundingClientRect().height : 0,
      hasOlder: state.readMode.hasOlder,
      olderButton: !!state.host.querySelector(".cv-older-btn"),
      startMarker: !!state.host.querySelector(".cv-older-start"),
      askedBefore: state.requests.filter((r) => r.before !== null).length,
    };
  });

  expect(result.oldestPresent).toBe(true);
  expect(result.oldestText).toContain("step-1 --report");
  expect(result.oldestHeight).toBeGreaterThan(0);
  // Every turn, exactly once, in order.
  expect(result.seqs).toEqual(
    Array.from({ length: RECORD_LENGTH }, (_, i) => i + 1),
  );
  expect(result.askedBefore).toBeGreaterThan(0);
  expect(result.hasOlder).toBe(false);
  expect(result.olderButton).toBe(false);
  expect(result.startMarker).toBe(true);
});

test("paging older turns in leaves the reader where it was", async ({
  page,
}) => {
  await mountOverRecord(page, RECORD_LENGTH);

  const before = await page.evaluate(async () => {
    const state = window.__rmScroll;
    state.readMode.scrollBy(-100000);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const hostTop = state.host.getBoundingClientRect().top;
    const anchor = Array.from(state.host.querySelectorAll(".cv-turn")).find(
      (el) => el.getBoundingClientRect().top - hostTop > 40,
    );
    return {
      seq: anchor.dataset.seq,
      top: anchor.getBoundingClientRect().top - hostTop,
      count: state.readMode.entryCount,
    };
  });

  await page.evaluate(() => window.__rmScroll.readMode.loadOlderNow());
  await expect
    .poll(() => page.evaluate(() => window.__rmScroll.readMode.entryCount))
    .toBeGreaterThan(before.count);

  const after = await page.evaluate((seq) => {
    const state = window.__rmScroll;
    const anchor = state.host.querySelector(`.cv-turn[data-seq="${seq}"]`);
    const hostTop = state.host.getBoundingClientRect().top;
    return anchor.getBoundingClientRect().top - hostTop;
  }, before.seq);

  expect(Math.abs(after - before.top)).toBeLessThan(4);
});

test("a live refresh leaves the earliest turns on screen", async ({ page }) => {
  await mountOverRecord(page, RECORD_LENGTH);
  await scrollToOldest(page, "__rmScroll");

  await page.evaluate(() => window.__rmScroll.readMode.refreshNow());
  await page.waitForTimeout(150);

  const result = await page.evaluate(() => {
    const state = window.__rmScroll;
    return {
      seqs: state.seqsOnScreen(),
      oldestPresent: !!state.host.querySelector('.cv-turn[data-seq="1"]'),
    };
  });

  expect(result.oldestPresent).toBe(true);
  expect(result.seqs[0]).toBe(1);
});

// ── Rendering ──────────────────────────────────────────────────────
// Output is not one typeface: lines whose alignment is the content stay
// monospace, the rest reads as prose.
test("output splits into prose and monospace blocks", async ({ page }) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
  const result = await page.evaluate(async () => {
    const { createReadMode } = await import("/static/read-mode.js");
    const host = document.createElement("div");
    host.style.width = "380px";
    host.style.height = "620px";
    document.body.appendChild(host);
    const readMode = createReadMode({ host, session: "spec" });
    readMode.mount();
    readMode.setEntries([
      {
        seq: 1,
        command: "sandbox:~$ npm audit",
        output: [
          "found 9 vulnerabilities in the dependency tree",
          "run npm audit fix to address them",
          "",
          "  name        severity   fixed in",
          "  lodash      high       4.17.21",
        ].join("\n"),
        exitCode: 0,
      },
    ]);

    const turn = host.querySelector(".cv-turn");
    const prose = turn.querySelector(".cv-prose");
    const code = turn.querySelector(".cv-code");
    const proseLine = prose.querySelector(".cv-line");
    const codeLine = code.querySelector(".cv-codeline");
    const inner = host.querySelector(".cv-inner");
    return {
      hasHead: !!turn.querySelector(".cv-turn-head"),
      headHoldsCommand: !!turn.querySelector(".cv-turn-head .cv-cmd"),
      headHoldsChip: !!turn.querySelector(".cv-turn-head .cv-exit"),
      turnSeparated:
        parseFloat(getComputedStyle(turn).borderTopWidth) > 0 &&
        parseFloat(getComputedStyle(turn).marginBottom) > 0,
      proseLines: prose.querySelectorAll(".cv-line").length,
      codeLines: code.querySelectorAll(".cv-codeline").length,
      proseFont: getComputedStyle(proseLine).fontFamily,
      codeFont: getComputedStyle(codeLine).fontFamily,
      proseLineHeight:
        parseFloat(getComputedStyle(proseLine).lineHeight) /
        parseFloat(getComputedStyle(proseLine).fontSize),
      proseHasMeasure: getComputedStyle(prose).maxWidth !== "none",
      proseWraps: getComputedStyle(proseLine).whiteSpace === "pre-wrap",
      codeWraps: getComputedStyle(codeLine).whiteSpace === "pre-wrap",
      selectable: getComputedStyle(inner).userSelect,
      codeTag: code.tagName,
    };
  });

  expect(result.hasHead).toBe(true);
  expect(result.headHoldsCommand).toBe(true);
  expect(result.headHoldsChip).toBe(true);
  expect(result.turnSeparated).toBe(true);
  expect(result.proseLines).toBe(2);
  expect(result.codeLines).toBe(2);
  expect(result.proseFont).toContain("Inter");
  expect(result.codeFont).toContain("JetBrains Mono");
  expect(result.proseLineHeight).toBeGreaterThan(1.4);
  expect(result.proseHasMeasure).toBe(true);
  expect(result.proseWraps).toBe(true);
  expect(result.codeWraps).toBe(true);
  expect(result.selectable).toBe("text");
  expect(result.codeTag).toBe("PRE");
});

// ── e2e level ──────────────────────────────────────────────────────
// The real endpoint, the real cursors, a record the server itself reads.

const SEEDED_SESSION = `readback-${process.pid}`;

test.describe("against the real endpoint", () => {
  test.skip(
    DATA_DIR === "",
    "needs MOBUX_DATA_DIR to seed the instance's record",
  );

  test.beforeAll(() => {
    const dir = path.join(DATA_DIR, "history");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${SEEDED_SESSION}.jsonl`),
      syntheticRecord(RECORD_LENGTH)
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
  });

  test.afterAll(() => {
    fs.rmSync(path.join(DATA_DIR, "history", `${SEEDED_SESSION}.jsonl`), {
      force: true,
    });
  });

  test("the endpoint pages backwards to the start of the record", async ({
    request,
  }) => {
    const url = `${BASE}/api/sessions/${SEEDED_SESSION}/conversation`;
    let body = await (await request.get(`${url}?tail=200`)).json();
    let seqs = body.entries.map((entry) => entry.seq);
    expect(seqs[seqs.length - 1]).toBe(RECORD_LENGTH);
    expect(body.hasOlder).toBe(true);

    let guard = 0;
    while (body.hasOlder && guard++ < 20) {
      const res = await request.get(
        `${url}?before=${encodeURIComponent(body.prevCursor)}&limit=200`,
      );
      expect(res.ok()).toBe(true);
      body = await res.json();
      expect(body.entries.length).toBeGreaterThan(0);
      seqs = body.entries.map((entry) => entry.seq).concat(seqs);
    }

    expect(body.hasOlder).toBe(false);
    expect(seqs).toEqual(
      Array.from({ length: RECORD_LENGTH }, (_, i) => i + 1),
    );
  });

  test("tail, cursor and before are mutually exclusive", async ({
    request,
  }) => {
    const url = `${BASE}/api/sessions/${SEEDED_SESSION}/conversation`;
    const tail = await (await request.get(`${url}?tail=5`)).json();

    const withTail = await request.get(
      `${url}?tail=5&before=${encodeURIComponent(tail.prevCursor)}`,
    );
    expect(withTail.status()).toBe(400);

    const withCursor = await request.get(
      `${url}?cursor=${encodeURIComponent(tail.nextCursor)}&before=${encodeURIComponent(tail.prevCursor)}`,
    );
    expect(withCursor.status()).toBe(400);

    const bogus = await request.get(`${url}?before=not-a-cursor`);
    expect(bogus.status()).toBe(400);
  });

  test("read mode walks back through the seeded record", async ({ page }) => {
    await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
    await page.evaluate(async (session) => {
      const { createReadMode } = await import("/static/read-mode.js");
      const host = document.createElement("div");
      host.id = "readModeE2E";
      host.style.width = "380px";
      host.style.height = "620px";
      document.body.appendChild(host);

      const readMode = createReadMode({
        host,
        session,
        pollIntervalMs: 100000,
        fetchPage: async (url) => {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        },
      });
      window.__rmE2E = { host, readMode, seqsOnScreen: () => [] };
      readMode.mount();
    }, SEEDED_SESSION);

    await expect
      .poll(() => page.evaluate(() => window.__rmE2E.readMode.entryCount))
      .toBeGreaterThan(0);

    await scrollToOldest(page, "__rmE2E");

    const result = await page.evaluate(() => {
      const state = window.__rmE2E;
      const oldest = state.host.querySelector('.cv-turn[data-seq="1"]');
      return {
        count: state.readMode.entryCount,
        oldestText: oldest ? oldest.textContent : null,
        hasOlder: state.readMode.hasOlder,
        startMarker: !!state.host.querySelector(".cv-older-start"),
      };
    });

    expect(result.count).toBe(RECORD_LENGTH);
    expect(result.oldestText).toContain("step-1 --report");
    expect(result.hasOlder).toBe(false);
    expect(result.startMarker).toBe(true);
  });
});
