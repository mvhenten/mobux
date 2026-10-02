// `/files/<name>/` serves a host directory behind mobux's auth (issue #334,
// stage 1). The smoke instance serves test/assets/files-site as `site`; its
// index.html loads a stylesheet and an image by relative URL, so both only
// resolve when the mount and any proxy prefix survive the redirect.
//
// Run with: make test-critical-path

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

async function expectRendered(page) {
  await expect(page.locator("h1")).toHaveText("served from the host");
  const rendered = await page.evaluate(async () => {
    const img = document.getElementById("dot");
    await img.decode();
    return {
      background: getComputedStyle(document.body).backgroundColor,
      naturalWidth: img.naturalWidth,
    };
  });
  expect(rendered.background).toBe("rgb(1, 2, 3)");
  expect(rendered.naturalWidth).toBeGreaterThan(0);
}

test("files: a served page loads its relative stylesheet and image", async ({
  page,
}) => {
  await page.goto(`${BASE}/files/site/`);
  await expectRendered(page);
});

test("files: the bare mount redirects into the root", async ({ page }) => {
  await page.goto(`${BASE}/files/site`);
  expect(new URL(page.url()).pathname).toBe("/files/site/");
  await expectRendered(page);
});

test("files: under a path prefix the page and its assets keep the prefix", async ({
  page,
}) => {
  const origin = new URL(BASE).origin;
  const seen = [];

  // A path-prefixing proxy: strip the prefix and forward.
  await page.route(`**${PREFIX}/**`, async (route) => {
    const url = new URL(route.request().url());
    seen.push(url.pathname);
    url.pathname = url.pathname.slice(PREFIX.length);
    const response = await route.fetch({ url: url.href });
    await route.fulfill({ response });
  });

  // Chromium does not route the hop after a fulfilled redirect, so resolve
  // the Location the way the browser does: against the prefixed URL it asked
  // for, which the server never saw.
  const bare = await page.request.get(`${BASE}/files/site`, {
    maxRedirects: 0,
  });
  expect(bare.status()).toBe(307);
  const target = new URL(
    bare.headers()["location"],
    `${origin}${PREFIX}/files/site`,
  );
  expect(target.pathname).toBe(`${PREFIX}/files/site/`);

  await page.goto(target.href);
  await expectRendered(page);
  expect(seen).toEqual(
    expect.arrayContaining([
      `${PREFIX}/files/site/`,
      `${PREFIX}/files/site/style.css`,
      `${PREFIX}/files/site/img/dot.png`,
    ]),
  );
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

// The smoke instance turns files.listing on (test/lib/smoke-config.cjs), and
// downloads/ has no index.html, so it renders the listing.
const LISTED = "rapport-ñ.txt";

test("files: Download in the listing saves the file under its name", async ({
  page,
}) => {
  await page.goto(`${BASE}/files/site/downloads/`);
  const link = page.getByRole("link", { name: `Download ${LISTED}` });
  await expect(link).toHaveAttribute("download", "");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    link.tap(),
  ]);
  expect(download.suggestedFilename()).toBe(LISTED);
  expect(new URL(download.url()).search).toBe("?download");
});

test("files: Open in the listing shows the file inline", async ({ page }) => {
  await page.goto(`${BASE}/files/site/downloads/`);
  await page.getByRole("link", { name: `Open ${LISTED}` }).tap();
  await expect(page).toHaveURL(
    `${BASE}/files/site/downloads/${encodeURIComponent(LISTED)}`,
  );
  await expect(page.locator("body")).toHaveText("rapport inline");
});

test("files: a request without credentials gets 401", async () => {
  test.skip(!AUTH, "the instance under test has no auth");
  const response = await fetch(`${BASE}/files/site/`, { redirect: "manual" });
  expect(response.status).toBe(401);
});
