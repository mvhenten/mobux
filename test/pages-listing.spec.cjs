// The SPA lists the host pages mobux serves (issue #334, stage 3): every
// `/files/<name>/` root and `/proxy/<name>/` target from /api/build-info, on
// Home and under Settings → Pages. The smoke instance serves `site` and
// proxies `up` (Makefile smoke-start). A row opens its page in a new tab, so
// the page gets the whole phone screen.
//
// Run with: make test-spa

const http = require("http");
const https = require("https");
const { test, expect } = require("./fixtures.cjs");

const BASE = process.env.MOBUX_URL || "https://localhost:5151";
const USER = process.env.MOBUX_USER || "";
const PASS = process.env.MOBUX_PASS || "";
const AUTH =
  USER && PASS
    ? "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64")
    : null;
const PREFIX = "/proxy/workspace/8080";

test.use({
  ...(AUTH ? { extraHTTPHeaders: { Authorization: AUTH } } : {}),
});

// A path-prefixing reverse proxy: serves only PREFIX, strips it, forwards.
async function startPrefixProxy() {
  const upstream = new URL(BASE);
  const client = upstream.protocol === "https:" ? https : http;
  const server = http.createServer((req, res) => {
    if (req.url !== PREFIX && !req.url.startsWith(`${PREFIX}/`)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(`outside the mount: ${req.url}`);
      return;
    }
    const forwarded = client.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url.slice(PREFIX.length) || "/",
        headers: { ...req.headers, host: upstream.host },
        rejectUnauthorized: false,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    forwarded.on("error", (err) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(String(err));
    });
    req.pipe(forwarded);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    mount: `http://127.0.0.1:${port}${PREFIX}`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

const row = (scope, kind, name) =>
  scope.locator(`[data-page-kind="${kind}"][data-page-name="${name}"]`);

for (const where of ["bare", "prefixed"]) {
  test.describe(`pages listing, ${where}`, () => {
    let proxy;
    let root;
    let prefix;

    test.beforeAll(async () => {
      if (where === "prefixed") proxy = await startPrefixProxy();
      root = proxy ? proxy.mount : BASE;
      prefix = proxy ? PREFIX : "";
    });

    test.afterAll(async () => {
      if (proxy) await proxy.stop();
    });

    test("home lists the served root and the proxy target", async ({
      page,
    }) => {
      await page.goto(`${root}/app#/`, { waitUntil: "networkidle" });
      const card = page.locator("#pagesCard");
      await expect(card.locator("h2")).toHaveText("Pages");
      await expect(row(card, "files", "site")).toContainText("files");
      await expect(row(card, "proxy", "up")).toContainText("proxy");
      await expect(row(card, "files", "site")).toHaveAttribute(
        "href",
        `${prefix}/files/site/`,
      );
      await expect(row(card, "proxy", "up")).toHaveAttribute(
        "href",
        `${prefix}/proxy/up/`,
      );
      const height = await row(card, "files", "site").evaluate(
        (el) => el.getBoundingClientRect().height,
      );
      expect(height).toBeGreaterThanOrEqual(56);
    });

    test("tapping a file root opens the served page in a new tab", async ({
      page,
      context,
    }) => {
      await page.goto(`${root}/app#/`, { waitUntil: "networkidle" });
      const popup = context.waitForEvent("page");
      await row(page, "files", "site").click();
      const opened = await popup;
      await opened.waitForLoadState("domcontentloaded");
      expect(opened.url()).toBe(`${root}/files/site/`);
      await expect(opened.locator("h1")).toHaveText("served from the host");
      expect(page.url()).toBe(`${root}/app#/`);
    });

    test("tapping a proxy target opens it in a new tab", async ({
      page,
      context,
    }) => {
      await page.goto(`${root}/app#/`, { waitUntil: "networkidle" });
      const popup = context.waitForEvent("page");
      await row(page, "proxy", "up").click();
      const opened = await popup;
      await opened.waitForLoadState("domcontentloaded");
      expect(opened.url()).toBe(`${root}/proxy/up/`);
    });

    test("settings shows the same pages on its own sub-page", async ({
      page,
    }) => {
      await page.goto(`${root}/app#/settings`, { waitUntil: "networkidle" });
      const nav = page.locator('[data-row="pages"]');
      await expect(nav.locator(".settings-value")).toHaveText(
        "1 file, 1 proxy",
      );
      await nav.click();
      await expect
        .poll(() => page.evaluate(() => location.hash))
        .toBe("#/settings/pages");
      await expect(page.locator(".settings-header h1")).toHaveText("Pages");
      const sub = page.locator("#pages-settings");
      await expect(sub.locator(".settings-lede")).toContainText("MOBUX_FILES");
      await expect(row(sub, "files", "site")).toHaveAttribute(
        "href",
        `${prefix}/files/site/`,
      );
      await expect(row(sub, "proxy", "up")).toHaveAttribute(
        "href",
        `${prefix}/proxy/up/`,
      );
    });
  });
}

test("with nothing configured the home card is gone and settings says none", async ({
  page,
}) => {
  await page.route(/\/api\/build-info$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, files: [], proxies: [] },
    });
  });
  await page.goto(`${BASE}/app#/`, { waitUntil: "networkidle" });
  await expect(page.locator("#sessionList")).toBeVisible();
  await expect(page.locator("#pagesCard")).toHaveCount(0);

  await page.route(/\/api\/settings\/pages$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, files: [], proxies: [] },
    });
  });
  await page.goto(`${BASE}/app#/settings`, { waitUntil: "networkidle" });
  await expect(page.locator('[data-row="pages"] .settings-value')).toHaveText(
    "none",
  );
  await page.locator('[data-row="pages"]').click();
  await expect(page.locator("#pages-files")).toContainText("No file roots.");
  await expect(page.locator("#pages-proxies")).toContainText(
    "No proxy targets.",
  );
  await expect(page.locator("#pages-settings [data-page-kind]")).toHaveCount(0);
});

test("a failed fetch says so on home and in settings", async ({ page }) => {
  await page.route(/\/api\/(build-info|settings\/pages)$/, (route) =>
    route.fulfill({ status: 500, body: "boom" }),
  );
  await page.goto(`${BASE}/app#/`, { waitUntil: "networkidle" });
  await expect(page.locator("#pagesCard")).toContainText("Couldn't load pages");

  await page.goto(`${BASE}/app#/settings/pages`, { waitUntil: "networkidle" });
  await expect(page.locator("#pages-settings")).toContainText(
    "Couldn't load pages",
  );
});
