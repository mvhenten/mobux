// Settings → Pages edits the file roots and proxy targets. The smoke instance
// sets both through MOBUX_FILES and MOBUX_PROXY, so there the sub-page is
// read-only with the server's note. Adding, the second-tap remove and a
// refused change run against stubbed GET/PUT responses; src/pages_settings.rs
// covers the real write and the live routes. Runs with `make test-spa`.

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

const PAGES = /\/api\/settings\/pages$/;

const editable = (files, proxies) => ({
  files,
  proxies,
  managed_by: { files: null, proxies: null },
  managed_note: { files: null, proxies: null },
});

async function stub(page, onPut, initial) {
  let current = initial;
  const puts = [];
  await page.route(PAGES, async (route) => {
    const req = route.request();
    if (req.method() === "PUT") {
      const body = JSON.parse(req.postData());
      puts.push(body);
      const answer = onPut(body, current);
      if (answer.status !== 200) return route.fulfill(answer);
      current = answer.json;
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(current),
    });
  });
  return puts;
}

const accept = (body, current) => ({
  status: 200,
  json: { ...current, ...body },
});

const row = (page, kind, name) =>
  page.locator(`[data-page-kind="${kind}"][data-page-name="${name}"]`);

test("sections the environment sets are read-only with the server's note", async ({
  page,
  request,
}) => {
  const live = await (await request.get(`${BASE}/api/settings/pages`)).json();
  expect(live.managed_by).toEqual({ files: "env", proxies: "env" });
  expect(live.files.map((f) => f.name)).toEqual(["site"]);

  await page.goto(`${APP}#/settings/pages`, { waitUntil: "networkidle" });
  await expect(page.locator("#pages-files .page-managed")).toHaveText(
    live.managed_note.files,
  );
  await expect(page.locator("#pages-proxies .page-managed")).toHaveText(
    live.managed_note.proxies,
  );
  await expect(row(page, "files", "site")).toBeVisible();
  await expect(row(page, "proxy", "up")).toBeVisible();
  await expect(page.locator(".page-add")).toHaveCount(0);
  await expect(page.locator(".page-remove")).toHaveCount(0);
});

test("adding a file root and a proxy target sends the full section list", async ({
  page,
}) => {
  const puts = await stub(
    page,
    accept,
    editable([{ name: "site", path: "/srv/site" }], []),
  );
  await page.goto(`${APP}#/settings/pages`, { waitUntil: "networkidle" });

  const files = page.locator('.page-add[data-section="files"]');
  await files.locator(".page-add-name").fill("docs");
  await files.locator(".page-add-value").fill("/srv/docs");
  const add = files.locator(".page-add-btn");
  const height = await add.evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBeGreaterThanOrEqual(48);
  await add.click();
  await expect(row(page, "files", "docs")).toHaveAttribute(
    "href",
    /\/files\/docs\/$/,
  );
  await expect(page.locator("#pagesStatus")).toHaveText("Saved ✓");
  await expect(files.locator(".page-add-name")).toHaveValue("");

  const proxies = page.locator('.page-add[data-section="proxies"]');
  await proxies.locator(".page-add-name").fill("vite");
  await proxies.locator(".page-add-value").fill("5173");
  await proxies.locator(".page-add-btn").click();
  await expect(row(page, "proxy", "vite")).toBeVisible();

  expect(puts).toEqual([
    {
      files: [
        { name: "site", path: "/srv/site" },
        { name: "docs", path: "/srv/docs" },
      ],
    },
    { proxies: [{ name: "vite", port: 5173 }] },
  ]);
  const rowHeight = await page
    .locator("#pages-files .page-row")
    .first()
    .evaluate((el) => el.getBoundingClientRect().height);
  expect(rowHeight).toBeGreaterThanOrEqual(56);
});

test("removing takes a second tap", async ({ page }) => {
  const puts = await stub(
    page,
    accept,
    editable(
      [
        { name: "site", path: "/srv/site" },
        { name: "docs", path: "/srv/docs" },
      ],
      [{ name: "up", port: 8000 }],
    ),
  );
  await page.goto(`${APP}#/settings/pages`, { waitUntil: "networkidle" });

  const remove = page.locator('.page-remove[aria-label="Remove site"]');
  await remove.click();
  await expect(remove).toHaveText("Remove?");
  expect(puts).toEqual([]);
  await remove.click();
  await expect(row(page, "files", "site")).toHaveCount(0);
  await expect(row(page, "files", "docs")).toBeVisible();

  const removeUp = page.locator('.page-remove[aria-label="Remove up"]');
  await removeUp.click();
  await removeUp.click();
  await expect(page.locator("#pages-proxies")).toContainText(
    "No proxy targets.",
  );
  expect(puts).toEqual([
    { files: [{ name: "docs", path: "/srv/docs" }] },
    { proxies: [] },
  ]);
});

test("a refused change shows the server's reason and keeps the list", async ({
  page,
}) => {
  const reason =
    "files.roots.docs: /srv/missing: No such file or directory (os error 2)";
  await stub(
    page,
    () => ({ status: 400, body: reason }),
    editable([{ name: "site", path: "/srv/site" }], []),
  );
  await page.goto(`${APP}#/settings/pages`, { waitUntil: "networkidle" });

  const files = page.locator('.page-add[data-section="files"]');
  await files.locator(".page-add-name").fill("docs");
  await files.locator(".page-add-value").fill("/srv/missing");
  await files.locator(".page-add-btn").click();
  await expect(page.locator("#pagesStatus .settings-status-line")).toHaveText(
    reason,
  );
  await expect(row(page, "files", "docs")).toHaveCount(0);
  await expect(files.locator(".page-add-name")).toHaveValue("docs");
});

test("a bad name, path or port is refused before anything is sent", async ({
  page,
}) => {
  const puts = await stub(page, accept, editable([], []));
  await page.goto(`${APP}#/settings/pages`, { waitUntil: "networkidle" });

  const files = page.locator('.page-add[data-section="files"]');
  await files.locator(".page-add-name").fill("a/b");
  await files.locator(".page-add-value").fill("/srv/x");
  await files.locator(".page-add-btn").click();
  await expect(page.locator("#pagesStatus")).toHaveText(
    "Name must be letters, digits, - or _.",
  );

  await files.locator(".page-add-name").fill("docs");
  await files.locator(".page-add-value").fill("srv/x");
  await files.locator(".page-add-btn").click();
  await expect(page.locator("#pagesStatus")).toHaveText(
    "Path must be absolute.",
  );

  const proxies = page.locator('.page-add[data-section="proxies"]');
  await proxies.locator(".page-add-name").fill("vite");
  await proxies.locator(".page-add-value").fill("70000");
  await proxies.locator(".page-add-btn").click();
  await expect(page.locator("#pagesStatus")).toHaveText(
    "Port must be a whole number from 1 to 65535.",
  );
  expect(puts).toEqual([]);
});
