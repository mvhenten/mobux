// Touch selection and long-press links in the live terminal view, under both
// renderers. The touch overlay covers the renderer, so every gesture here is
// a synthetic TouchEvent on #touchOverlay; the selected text comes from the
// engine buffer and a paste is checked where it lands, in the pane.
//
// Run with: make test-touch-select

const { test, expect } = require("./fixtures.cjs");
const fs = require("fs");
const path = require("path");
const { createTmuxRunner } = require("./lib/tmux.cjs");
const terminalPage = require("./lib/terminal-page.cjs");
const { touch } = terminalPage;

const BASE = process.env.MOBUX_URL || "https://localhost:5151";
const USER = process.env.MOBUX_USER || "";
const PASS = process.env.MOBUX_PASS || "";
const AUTH =
  USER && PASS
    ? "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64")
    : null;
const SESSION = process.env.MOBUX_TEST_SESSION || "mobux-touch-select";
const SANDBOX_HOME = process.env.MOBUX_TEST_HOME || "/tmp/mobux-smoke/home";
const SHELL_ENV = `-e HISTFILE=/dev/null -e HOME=${SANDBOX_HOME}`;
const PASTE_SCRIPT = path.join(__dirname, "assets", "paste-capture.sh");
const tmux = createTmuxRunner("mobux-test");

test.use({
  ...(AUTH ? { extraHTTPHeaders: { Authorization: AUTH } } : {}),
});

test.beforeAll(() => {
  try {
    tmux(`kill-session -t ${SESSION}`);
  } catch (_) {}
  tmux(`new-session -d -s ${SESSION} ${SHELL_ENV} "bash --norc --noprofile"`);
});

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(BASE).origin,
  });
  terminalPage.resetSession(tmux, SESSION);
});

// A test that failed mid-paste leaves paste-capture.sh reading raw input;
// a fresh shell keeps the next test's keys out of it.
test.afterEach(() => {
  tmux(`respawn-pane -k ${SHELL_ENV} -t ${SESSION} "bash --norc --noprofile"`);
});

test.afterAll(() => {
  try {
    tmux(`kill-session -t ${SESSION}`);
  } catch (_) {}
});

const bootTerminal = (page) => terminalPage.bootTerminal(page, BASE, SESSION);

// The row (from the viewport's top) and column where `needle` is drawn on
// the row whose text is exactly `line`.
async function findOnScreen(page, line, needle) {
  let found = null;
  await expect
    .poll(
      async () => {
        found = await page.evaluate(
          ({ line, needle }) => {
            const t = window.__mobuxView.test;
            const top = t.viewportY();
            for (let r = 0; r < t.rows(); r++) {
              const text = (t.lineText(top + r) || "").trimEnd();
              if (text === line) return { row: r, col: text.indexOf(needle) };
            }
            return null;
          },
          { line, needle },
        );
        return found;
      },
      { timeout: 8000 },
    )
    .not.toBeNull();
  return found;
}

function cellPoint(page, col, row) {
  return page.evaluate(
    ({ col, row }) => {
      const r = document.getElementById("terminal").getBoundingClientRect();
      const cell = window.__mobuxView.test.cellMetrics();
      return {
        x: r.left + (col + 0.5) * cell.width,
        y: r.top + (row + 0.5) * cell.height,
      };
    },
    { col, row },
  );
}

async function longPress(page, { x, y }) {
  await touch(page, "touchstart", x, y);
  await page.waitForTimeout(750);
  await touch(page, "touchend", x, y);
}

async function tap(page, { x, y }) {
  await touch(page, "touchstart", x, y);
  await touch(page, "touchend", x, y);
}

const selection = (page) =>
  page.evaluate(() => window.__mobuxView.test.touchSelection());

// Every external open goes through the TWA's intent:// path and is recorded
// instead of navigating.
async function recordExternalOpens(page) {
  await page.evaluate(() => {
    window.__opened = [];
    Object.defineProperty(document, "referrer", {
      configurable: true,
      get: () => "android-app://io.github.mvhenten.mobux",
    });
    window.__mobuxNavigateToUrl = (url) => window.__opened.push(url);
  });
}

function echoLine(text) {
  tmux(`send-keys -t ${SESSION} "echo '${text}'" Enter`);
}

test("long-press on a URL opens the link sheet and opens it in the browser", async ({
  page,
}) => {
  await bootTerminal(page);
  await recordExternalOpens(page);
  echoLine("see https://example.com/touch-path.");
  const at = await findOnScreen(
    page,
    "see https://example.com/touch-path.",
    "example",
  );

  await longPress(page, await cellPoint(page, at.col, at.row));

  await expect(page.locator(".link-sheet")).toBeVisible();
  await expect(page.locator(".link-sheet-url")).toHaveText(
    "https://example.com/touch-path",
  );
  expect((await selection(page)).active).toBe(false);
  await expect(page.locator("#cmdPickList")).not.toHaveClass(/visible/);

  await page.locator('.link-sheet [data-action="open"]').click();
  await expect(page.locator(".link-sheet")).toBeHidden();
  const opened = await page.evaluate(() => window.__opened);
  expect(opened).toHaveLength(1);
  expect(opened[0]).toContain("intent://example.com/touch-path#Intent");
});

test("a single tap on a URL opens nothing", async ({ page }) => {
  await bootTerminal(page);
  await recordExternalOpens(page);
  echoLine("go https://example.com/no-tap");
  const at = await findOnScreen(page, "go https://example.com/no-tap", "exa");

  await tap(page, await cellPoint(page, at.col, at.row));
  await page.waitForTimeout(600);

  expect(await page.evaluate(() => window.__opened)).toEqual([]);
  await expect(page.locator(".link-sheet")).toBeHidden();
});

test("long-press selects the word and Copy puts exactly it on the clipboard", async ({
  page,
}) => {
  await bootTerminal(page);
  echoLine("alpha bravo charlie");
  const at = await findOnScreen(page, "alpha bravo charlie", "bravo");

  await longPress(page, await cellPoint(page, at.col + 2, at.row));

  const sel = await selection(page);
  expect(sel.active).toBe(true);
  expect(sel.text).toBe("bravo");
  await expect(page.locator(".touch-select-bar")).toBeVisible();
  expect(await page.locator(".touch-select-rect").count()).toBe(1);
  await expect(page.locator("#cmdPickList")).not.toHaveClass(/visible/);

  await page.evaluate(() => navigator.clipboard.writeText("stale"));
  await page.locator('.touch-select-bar [data-action="copy"]').click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("bravo");
  expect((await selection(page)).active).toBe(false);
});

test("dragging the end handle extends the selection by cell", async ({
  page,
}) => {
  await bootTerminal(page);
  echoLine("alpha bravo charlie");
  const at = await findOnScreen(page, "alpha bravo charlie", "bravo");
  await longPress(page, await cellPoint(page, at.col, at.row));
  expect((await selection(page)).text).toBe("bravo");

  const { handles } = await selection(page);
  const cell = await page.evaluate(() => window.__mobuxView.test.cellMetrics());
  const { x, y } = handles.end;
  await touch(page, "touchstart", x, y);
  for (let i = 1; i <= 8; i++) {
    await touch(page, "touchmove", x + i * cell.width, y);
  }
  await touch(page, "touchend", x + 8 * cell.width, y);

  await expect
    .poll(async () => (await selection(page)).text)
    .toBe("bravo charlie");
});

test("a tap outside the selection clears it", async ({ page }) => {
  await bootTerminal(page);
  echoLine("alpha bravo charlie");
  const at = await findOnScreen(page, "alpha bravo charlie", "bravo");
  await longPress(page, await cellPoint(page, at.col, at.row));
  expect((await selection(page)).active).toBe(true);

  await tap(page, await cellPoint(page, at.col, at.row - 1));

  expect((await selection(page)).active).toBe(false);
  await expect(page.locator(".touch-select-bar")).toBeHidden();
});

// The pane runs paste-capture.sh, which writes the bytes it reads to a file:
// the file is what reached the application.
async function pasteInto(page, mode, clip, expected) {
  const out = `${SANDBOX_HOME}/paste-${mode}-${Date.now()}`;
  fs.mkdirSync(SANDBOX_HOME, { recursive: true });
  await bootTerminal(page);
  tmux(
    `send-keys -t ${SESSION} "bash ${PASTE_SCRIPT} ${out} ${mode} ${Buffer.byteLength(expected)}" Enter`,
  );
  const at = await findOnScreen(page, "PASTE-READY", "PASTE");
  if (mode === "on") {
    await expect
      .poll(() => page.evaluate(() => window.__mobuxView.test.bracketedPaste()))
      .toBe(true);
  }

  await page.evaluate((text) => navigator.clipboard.writeText(text), clip);
  await longPress(page, await cellPoint(page, 0, at.row + 2));
  expect((await selection(page)).active).toBe(true);
  await page.locator('.touch-select-bar [data-action="paste"]').click();

  await expect
    .poll(() => (fs.existsSync(out) ? fs.readFileSync(out, "latin1") : ""), {
      timeout: 5000,
    })
    .toBe(expected);
  expect((await selection(page)).active).toBe(false);
}

test("Paste brackets the text when the application enabled bracketed paste", async ({
  page,
}) => {
  await pasteInto(page, "on", "hello\nworld", "\x1b[200~hello\rworld\x1b[201~");
});

test("Paste sends the text raw when bracketed paste is off", async ({
  page,
}) => {
  await pasteInto(page, "off", "one\r\ntwo", "one\rtwo");
});

test("Paste says why it failed when the clipboard cannot be read", async ({
  page,
}) => {
  await bootTerminal(page);
  echoLine("alpha bravo charlie");
  const at = await findOnScreen(page, "alpha bravo charlie", "bravo");
  await longPress(page, await cellPoint(page, at.col, at.row));
  await page.evaluate(() => {
    navigator.clipboard.readText = () =>
      Promise.reject(
        new DOMException("Read permission denied.", "NotAllowedError"),
      );
  });

  await page.locator('.touch-select-bar [data-action="paste"]').click();

  await expect(
    page.locator(".touch-select-bar .touch-select-status"),
  ).toHaveText(/Paste failed: Read permission denied/);
  expect((await selection(page)).active).toBe(true);
});
