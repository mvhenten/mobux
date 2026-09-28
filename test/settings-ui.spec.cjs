// Settings screens: the top-level row list, the hash-routed sub-pages and
// their back chevron, the notification switches, and the terminal gear that
// opens settings in place (no document reload) and returns to the terminal.
// Runs on the smoke instance with the rest of `make test-spa`.

const { test, expect } = require("./fixtures.cjs");
const { createTmuxRunner } = require("./lib/tmux.cjs");

const BASE = process.env.MOBUX_URL || "https://localhost:5151";
const APP = `${BASE}/app`;
const USER = process.env.MOBUX_USER || "";
const PASS = process.env.MOBUX_PASS || "";
const AUTH =
  USER && PASS
    ? "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64")
    : null;

const SANDBOX_HOME = process.env.MOBUX_TEST_HOME || "/tmp/mobux-smoke/home";
const tmux = createTmuxRunner("mobux-test");
const SESSION = `settings-ui-${process.pid}`;

test.use({
  ...(AUTH ? { extraHTTPHeaders: { Authorization: AUTH } } : {}),
});

test.beforeAll(() => {
  try {
    tmux(`kill-session -t ${SESSION}`);
  } catch (_) {}
  tmux(
    `new-session -d -s ${SESSION} -e HISTFILE=/dev/null -e HOME=${SANDBOX_HOME} "bash --norc --noprofile"`,
  );
});

test.afterAll(() => {
  try {
    tmux(`kill-session -t ${SESSION}`);
  } catch (_) {}
});

const hash = (page) => page.evaluate(() => location.hash);

const notificationsPut = (page) =>
  page.waitForRequest(
    (r) =>
      r.method() === "PUT" &&
      new URL(r.url()).pathname === "/api/settings/notifications",
  );

const SUB_PAGES = [
  ["update", "Software update", "#update"],
  ["shell", "Shell integration", "#shell-integration"],
  ["nodes", "Nodes", "#nodes-settings"],
  ["stt", "Speech to text", "#stt-provider"],
  ["listen", "Listen", "#listen-settings"],
  ["about", "About", "#build-info"],
];

test("settings top level lists the ten rows and no search or reload", async ({
  page,
}) => {
  await page.goto(`${APP}#/settings`, { waitUntil: "networkidle" });
  await expect(page.locator(".settings-header h1")).toHaveText("Settings");
  for (const row of [
    "update",
    "install",
    "notifications",
    "renderer",
    "theme",
    "shell",
    "nodes",
    "stt",
    "listen",
    "about",
  ]) {
    await expect(page.locator(`[data-row="${row}"]`)).toHaveCount(1);
  }
  await expect(
    page.locator('#notifications input[type="checkbox"][role="switch"]'),
  ).toHaveCount(4);
  await expect(page.locator(".settings-search")).toHaveCount(0);
  await expect(
    page.locator(".settings-header [aria-label='Reload']"),
  ).toHaveCount(0);

  const heights = await page
    .locator(".settings-card > .settings-row")
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  expect(heights.length).toBeGreaterThan(9);
  for (const h of heights) expect(h).toBeGreaterThanOrEqual(56);
});

test("each chevron row opens its sub-page and back returns to the list", async ({
  page,
}) => {
  await page.goto(`${APP}#/settings`, { waitUntil: "networkidle" });
  for (const [section, title, root] of SUB_PAGES) {
    await page.locator(`[data-row="${section}"]`).click();
    await expect.poll(() => hash(page)).toBe(`#/settings/${section}`);
    await expect(page.locator(".settings-header h1")).toHaveText(title);
    await expect(page.locator(root)).toBeVisible();

    await page.locator(".settings-back").click();
    await expect.poll(() => hash(page)).toBe("#/settings");
    await expect(page.locator(`[data-row="${section}"]`)).toBeVisible();
  }
});

test("a deep-linked sub-page's back goes to the settings list, then home", async ({
  page,
}) => {
  await page.goto(`${APP}#/settings/shell`, { waitUntil: "networkidle" });
  await page.locator(".settings-back").click();
  await expect.poll(() => hash(page)).toBe("#/settings");
  await page.locator(".settings-back").click();
  await expect.poll(() => hash(page)).toBe("#/");
});

test("a notification switch saves through PUT /api/settings/notifications", async ({
  page,
}) => {
  await page.goto(`${APP}#/settings`, { waitUntil: "networkidle" });
  const sw = page.locator('input[name="bell"]');
  const before = await sw.isChecked();

  const put = notificationsPut(page);
  await page.locator('[data-switch="bell"]').click();
  expect(JSON.parse((await put).postData()).bell).toBe(!before);
  await expect(sw).toBeChecked({ checked: !before });

  const restore = notificationsPut(page);
  await page.locator('[data-switch="bell"]').click();
  expect(JSON.parse((await restore).postData()).bell).toBe(before);
});

test("the terminal gear opens settings without a reload and back returns to the terminal", async ({
  page,
}) => {
  await page.goto(`${APP}#/s/${SESSION}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => window.__mobuxView?.test?.wsReady?.() === true,
    null,
    { timeout: 15000 },
  );
  await page.evaluate(() => {
    window.__settingsNoReload = true;
    document.getElementById("inputBar").classList.remove("hidden");
  });

  await page.locator("#settingsBtn").click();
  await expect.poll(() => hash(page)).toBe("#/settings");
  await expect(page.locator('[data-row="about"]')).toBeVisible();
  expect(await page.evaluate(() => window.__settingsNoReload)).toBe(true);

  await page.locator(".settings-back").click();
  await expect.poll(() => hash(page)).toBe(`#/s/${SESSION}`);
  expect(await page.evaluate(() => window.__settingsNoReload)).toBe(true);
  await page.waitForFunction(
    () => window.__mobuxView?.test?.wsReady?.() === true,
    null,
    { timeout: 15000 },
  );
});
