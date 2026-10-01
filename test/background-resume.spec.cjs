// A terminal tab sent to the background on a phone. Playwright has no
// page-lifecycle API, so a test overrides Document.prototype.visibilityState
// and dispatches the event the browser would.

const { test, expect } = require("./fixtures.cjs");
const { createTmuxRunner } = require("./lib/tmux.cjs");
const terminalPage = require("./lib/terminal-page.cjs");

const BASE = process.env.MOBUX_URL || "https://localhost:5151";
const USER = process.env.MOBUX_USER || "";
const PASS = process.env.MOBUX_PASS || "";
const AUTH =
  USER && PASS
    ? "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64")
    : null;
const SANDBOX_HOME = process.env.MOBUX_TEST_HOME || "/tmp/mobux-smoke/home";
const SHELL_ENV = `-e HISTFILE=/dev/null -e HOME=${SANDBOX_HOME}`;
const tmux = createTmuxRunner("mobux-test");

test.use({
  ...(AUTH ? { extraHTTPHeaders: { Authorization: AUTH } } : {}),
});

// Each test owns a session it creates and kills, so no test depends on a
// session (or a tmux server) an earlier test left behind.
let session = null;
let sessionCount = 0;

test.beforeEach(() => {
  session = `bg-resume-${process.pid}-${++sessionCount}`;
  tmux(`new-session -d -s ${session} ${SHELL_ENV} "bash --norc --noprofile"`);
  terminalPage.resetSession(tmux, session);
});

test.afterEach(async ({ page }) => {
  await page.close();
  tmux(`kill-session -t ${session}`);
});

const bootTerminal = (page) => terminalPage.bootTerminal(page, BASE, session);

function setVisibility(page, state) {
  return page.evaluate((state) => {
    Object.defineProperty(Document.prototype, "visibilityState", {
      configurable: true,
      get: () => state,
    });
    Object.defineProperty(Document.prototype, "hidden", {
      configurable: true,
      get: () => state === "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

// The pane's rows; tmux's status line (the last row) carries a clock and
// the running command, which move on their own.
const screenRows = (page) =>
  page.evaluate(() => {
    const t = window.__mobuxView.test;
    const top = t.viewportY();
    const rows = [];
    for (let y = top; y < top + t.rows() - 1; y++) {
      rows.push((t.lineText(y) || "").trimEnd());
    }
    return rows;
  });

const probe = (page, name) =>
  page.evaluate((name) => window.__mobuxView.test[name](), name);

const openSockets = (sockets) => sockets.filter((ws) => !ws.isClosed());

test("a hidden tab drops its socket and polls, and resumes in place", async ({
  page,
}) => {
  const sockets = [];
  page.on("websocket", (ws) => {
    if (ws.url().includes("/ws/")) sockets.push(ws);
  });
  await bootTerminal(page);
  tmux(`send-keys -t ${session} "seq 1 200" Enter`);
  await expect
    .poll(() => probe(page, "historyRowCount"), { timeout: 8000 })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await screenRows(page)).join("\n"), { timeout: 8000 })
    .toContain("200");
  const before = await screenRows(page);
  const history = await probe(page, "historyRowCount");
  await page.evaluate(() => (window.__bgResumeFlag = "kept"));
  expect(await probe(page, "panesPollActive")).toBe(true);
  expect(await page.evaluate(() => window.__mobuxBuildPollActive())).toBe(true);

  await setVisibility(page, "hidden");
  await expect.poll(() => probe(page, "wsReady")).toBe(false);
  await expect.poll(() => openSockets(sockets).length).toBe(0);
  expect(await probe(page, "suspended")).toBe(true);
  expect(await probe(page, "panesPollActive")).toBe(false);
  expect(await probe(page, "reconnectPending")).toBe(false);
  expect(await page.evaluate(() => window.__mobuxBuildPollActive())).toBe(
    false,
  );
  expect(await probe(page, "historyRowCount")).toBe(history);

  await setVisibility(page, "visible");
  await expect.poll(() => probe(page, "wsReady"), { timeout: 8000 }).toBe(true);
  expect(await probe(page, "panesPollActive")).toBe(true);
  expect(await page.evaluate(() => window.__mobuxBuildPollActive())).toBe(true);
  await expect.poll(() => screenRows(page), { timeout: 8000 }).toEqual(before);
  expect(await probe(page, "historyRowCount")).toBeGreaterThanOrEqual(history);
  expect(sockets).toHaveLength(2);
  expect(await page.evaluate(() => window.__bgResumeFlag)).toBe("kept");
});

test("a socket closing after its replacement opened arms no retry", async ({
  page,
}) => {
  const sockets = [];
  page.on("websocket", (ws) => {
    if (ws.url().includes("/ws/")) sockets.push(ws);
  });
  await bootTerminal(page);

  // An unexpected drop, then a reconnect while that socket is still CLOSING:
  // the old socket's close lands after the new socket replaced it.
  await page.evaluate(() => {
    const t = window.__mobuxView.test;
    t.forceDrop();
    t.reconnect();
  });
  await expect.poll(() => sockets[0].isClosed(), { timeout: 8000 }).toBe(true);
  await expect.poll(() => probe(page, "wsReady"), { timeout: 8000 }).toBe(true);
  expect(await probe(page, "reconnectPending")).toBe(false);
  expect(sockets).toHaveLength(2);
  expect(openSockets(sockets)).toHaveLength(1);
});

test("a new server build with a terminal open offers a reload instead of reloading", async ({
  page,
}) => {
  let hash = "hash-a";
  await page.route("**/api/build-info", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ version: "0.0.0-test", build_hash: hash }),
    }),
  );
  await bootTerminal(page);
  await page.evaluate(() => window.__mobuxCheckBuildHash());
  await page.evaluate(() => (window.__bgResumeFlag = "kept"));

  hash = "hash-b";
  await page.evaluate(() => window.__mobuxCheckBuildHash());
  await expect(page.locator("#updateBar")).toBeVisible();
  await expect(page.locator("#updateBar")).toContainText(
    "New version available",
  );
  expect(await page.evaluate(() => window.__bgResumeFlag)).toBe("kept");

  // The bar sits above the terminal, not over it.
  const bar = await page.locator("#updateBar").boundingBox();
  const terminal = await page.locator("#terminal").boundingBox();
  expect(terminal.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);

  await page.locator("#updateBarDismiss").click();
  await expect(page.locator("#updateBar")).toHaveCount(0);
  await setVisibility(page, "hidden");
  await setVisibility(page, "visible");
  await expect(page.locator("#updateBar")).toBeVisible();

  await Promise.all([
    page.waitForEvent("load"),
    page.locator("#updateBarReload").click(),
  ]);
  await expect(page.locator("#updateBar")).toHaveCount(0);
});
