// `/proxy/<name>/` reverse-proxies a loopback port behind mobux's auth (issue
// #334, stage 2). The smoke instance proxies `up` to MOBUX_PROXY_FIXTURE_PORT,
// where this spec runs test/assets/proxy-upstream.mjs: a page with a relative
// stylesheet and script, and a WebSocket echo the script talks to.
//
// Run with: make test-critical-path

const path = require("path");
const { test, expect } = require("./fixtures.cjs");

const BASE = process.env.MOBUX_URL || "https://localhost:5151";
const USER = process.env.MOBUX_USER || "";
const PASS = process.env.MOBUX_PASS || "";
const AUTH =
  USER && PASS
    ? "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64")
    : null;
const PORT = Number(process.env.MOBUX_PROXY_FIXTURE_PORT || 8291);
const PREFIX = "/proxy/workspace/8080";

test.use({
  ...(AUTH ? { extraHTTPHeaders: { Authorization: AUTH } } : {}),
});

let upstream;

test.beforeAll(async () => {
  const { startUpstream } = await import(
    path.join(__dirname, "assets", "proxy-upstream.mjs")
  );
  upstream = await startUpstream(PORT);
});

test.afterAll(async () => {
  if (upstream) await upstream.close();
});

async function expectRendered(page) {
  await expect(page.locator("h1")).toHaveText("proxied from a local port");
  const background = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );
  expect(background).toBe("rgb(4, 5, 6)");
  await expect(page.locator("#echo")).toHaveText("echo: ping");
}

test("proxy: a local page loads its assets and its WebSocket echoes", async ({
  page,
}) => {
  await page.goto(`${BASE}/proxy/up/`);
  await expectRendered(page);
});

test("proxy: a root-absolute redirect stays under the mount", async ({
  page,
}) => {
  await page.goto(`${BASE}/proxy/up/redirect`);
  expect(new URL(page.url()).pathname).toBe("/proxy/up/");
  await expectRendered(page);
});

test("proxy: under a path prefix the page, its assets and its WebSocket keep the prefix", async ({
  page,
}) => {
  const seen = [];

  // A path-prefixing proxy: strip the prefix and forward.
  await page.route(`**${PREFIX}/**`, async (route) => {
    const url = new URL(route.request().url());
    seen.push(url.pathname);
    url.pathname = url.pathname.slice(PREFIX.length);
    const response = await route.fetch({ url: url.href });
    await route.fulfill({ response });
  });
  await page.routeWebSocket(`**${PREFIX}/**`, (ws) => {
    const url = new URL(ws.url());
    seen.push(url.pathname);
    url.pathname = url.pathname.slice(PREFIX.length);
    const server = new WebSocket(url.href, {
      headers: AUTH ? { Authorization: AUTH } : {},
    });
    const pending = [];
    server.onopen = () => pending.splice(0).forEach((m) => server.send(m));
    server.onmessage = (event) => ws.send(event.data);
    ws.onMessage((message) =>
      server.readyState === WebSocket.OPEN
        ? server.send(message)
        : pending.push(message),
    );
    ws.onClose(() => server.close());
  });

  await page.goto(`${new URL(BASE).origin}${PREFIX}/proxy/up/`);
  await expectRendered(page);
  expect(seen).toEqual(
    expect.arrayContaining([
      `${PREFIX}/proxy/up/`,
      `${PREFIX}/proxy/up/style.css`,
      `${PREFIX}/proxy/up/app.js`,
      `${PREFIX}/proxy/up/ws`,
    ]),
  );
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("proxy: the upstream never sees mobux's credentials", async ({
  request,
}) => {
  const response = await request.get(`${BASE}/proxy/up/headers`);
  expect(response.status()).toBe(200);
  const headers = await response.json();
  expect(headers.authorization).toBeUndefined();
  expect(headers.cookie || "").not.toContain("mobux_session");
  expect(headers["x-forwarded-prefix"]).toBe("/proxy/up");
});

test("proxy: a request without credentials gets 401", async () => {
  test.skip(!AUTH, "the instance under test has no auth");
  const response = await fetch(`${BASE}/proxy/up/`, { redirect: "manual" });
  expect(response.status).toBe(401);
});
