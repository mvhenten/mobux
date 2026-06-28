// Playwright spec: per-kind STT provider persistence.
//
// Requires a throwaway server running on PORT 5198.
// Launched externally before this suite runs (see Makefile / CI).
//
// Tests run against MOBUX_STT_URL (default http://localhost:5198).
// Each test gets its own fresh browser context and data dir so they
// are fully isolated from :5151.

const { test, expect } = require("./fixtures.cjs");

const BASE = process.env.MOBUX_STT_URL || "https://localhost:5198";
const USER = process.env.MOBUX_STT_USER || process.env.MOBUX_USER || "";
const PASS = process.env.MOBUX_STT_PASS || process.env.MOBUX_PASS || "";

// Helper: navigate to /app#/settings and wait for the STT section to hydrate.
async function openSettings(page) {
  // Set HTTP credentials so the browser sends Basic auth on all requests in
  // this context, including the JS fetch('/api/settings/stt') inside the page.
  if (USER && PASS) {
    await page.context().setHTTPCredentials({ username: USER, password: PASS });
  }
  await page.goto(`${BASE}/app#/settings`);
  // Wait for the kind dropdown to appear — rendered by the SPA component.
  await page.waitForSelector("#sttKind", { timeout: 5000 });
  // Give the initial fetch/populate a moment.
  await page.waitForTimeout(600);
}

// Helper: select a kind from the dropdown and wait for repopulation.
async function selectKind(page, kind) {
  await page.selectOption("#sttKind", kind);
  await page.waitForTimeout(200);
}

// Helper: fill host+port and model (by visible option text or value).
async function fillFields(page, { host, port, model, apiKey } = {}) {
  if (host !== undefined) await page.fill("#sttHost", host);
  if (port !== undefined) await page.fill("#sttPort", String(port));
  if (model !== undefined) {
    // Try to select the exact value; fall back to custom.
    const opts = await page.$$eval("#sttModel option", (els) =>
      els.map((o) => o.value),
    );
    if (opts.includes(model)) {
      await page.selectOption("#sttModel", model);
    } else {
      await page.selectOption("#sttModel", "__custom__");
      await page.fill("#sttCustomModel", model);
    }
  }
  if (apiKey !== undefined) await page.fill("#sttApiKey", apiKey);
}

// SPA uses auto-save (debounced 700 ms on most fields, immediate on model
// change). Replace the old explicit save-button click with a short wait.
// If host was filled, blur it first to trigger schedFetchModels → save.
async function triggerSave(page, { withHostBlur = false } = {}) {
  if (withHostBlur) {
    await page.dispatchEvent("#sttHost", "blur");
  }
  // 800 ms covers the 700 ms debounce and the save round-trip.
  await page.waitForTimeout(800);
}

// Verify the GET /api/settings/stt response never includes an api_key value.
test("GET /api/settings/stt never returns api_key", async ({ page }) => {
  const authHeader =
    USER && PASS
      ? {
          Authorization:
            "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64"),
        }
      : {};
  const resp = await page.request.get(`${BASE}/api/settings/stt`, {
    headers: authHeader,
    ignoreHTTPSErrors: true,
  });
  expect(resp.ok()).toBeTruthy();
  const body = await resp.json();

  // Top-level: no api_key field.
  expect(body).not.toHaveProperty("api_key");

  // Per-provider: each entry has has_key (boolean) but no api_key.
  if (body.providers) {
    for (const [_kind, prov] of Object.entries(body.providers)) {
      expect(prov).not.toHaveProperty("api_key");
      expect(typeof prov.has_key).toBe("boolean");
    }
  }
});

// Per-kind values persist across kind-switch and page reload.
test("per-kind settings persist across switch and reload", async ({ page }) => {
  await openSettings(page);

  // --- Save network provider ---
  await selectKind(page, "network");
  await fillFields(page, {
    host: "http://lab.tailfa81e6.ts.net",
    port: "8081",
    model: "Systran/faster-whisper-medium.en",
  });
  // Model selection triggers an immediate save; blur host to also capture
  // any host/port changes via schedFetchModels.
  await triggerSave(page, { withHostBlur: true });

  // --- Save openai provider ---
  await selectKind(page, "openai");
  await fillFields(page, { apiKey: "sk-test-key", model: "whisper-1" });
  // apiKey onChange fires schedSave (700 ms); wait for it.
  await triggerSave(page);

  // Switch network → openai → network and assert each kind shows its own values.

  await selectKind(page, "network");
  const networkHost = await page.$eval("#sttHost", (el) => el.value);
  const networkPort = await page.$eval("#sttPort", (el) => el.value);
  expect(networkHost).toContain("lab.tailfa81e6.ts.net");
  expect(networkPort).toBe("8081");

  await selectKind(page, "openai");
  const oaiPlaceholder = await page.$eval("#sttApiKey", (el) => el.placeholder);
  // After saving a key, the placeholder should show the "stored" indicator.
  expect(oaiPlaceholder).toContain("stored");

  await selectKind(page, "network");
  const networkHostAgain = await page.$eval("#sttHost", (el) => el.value);
  expect(networkHostAgain).toContain("lab.tailfa81e6.ts.net");

  // Reload the page and confirm active kind + its values persist.
  // The last save was for openai, which sets it as active.
  // The last selectKind was network — but we haven't saved, so active is still openai.
  // Reload should restore openai.
  await page.reload();
  await page.waitForSelector("#sttKind", { timeout: 5000 });
  await page.waitForTimeout(400);

  const activeKind = await page.$eval("#sttKind", (el) => el.value);
  // We last saved openai, so that should be active.
  expect(activeKind).toBe("openai");

  const afterReloadPlaceholder = await page.$eval(
    "#sttApiKey",
    (el) => el.placeholder,
  );
  expect(afterReloadPlaceholder).toContain("stored");
});

// GET payload structure: activeKind + providers map with has_key per kind.
test("GET response has activeKind and per-kind providers map", async ({
  page,
}) => {
  const authHeader =
    USER && PASS
      ? {
          Authorization:
            "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64"),
        }
      : {};
  const resp = await page.request.get(`${BASE}/api/settings/stt`, {
    headers: authHeader,
    ignoreHTTPSErrors: true,
  });
  expect(resp.ok()).toBeTruthy();
  const body = await resp.json();

  expect(body).toHaveProperty("activeKind");
  expect(typeof body.activeKind).toBe("string");
  expect(["local", "network", "openai"]).toContain(body.activeKind);

  expect(body).toHaveProperty("providers");
  const providers = body.providers;

  // All three kinds must be represented.
  for (const kind of ["local", "network", "openai"]) {
    expect(providers).toHaveProperty(kind);
    const p = providers[kind];
    expect(p).toHaveProperty("has_key");
    expect(typeof p.has_key).toBe("boolean");
    expect(p).toHaveProperty("host");
    expect(p).toHaveProperty("port");
    expect(p).toHaveProperty("model");
    // Confirm no api_key field.
    expect(p).not.toHaveProperty("api_key");
  }
});

// Switching to local kind shows local defaults (127.0.0.1:5200) from the cache.
test("switching to local kind shows local defaults", async ({ page }) => {
  await openSettings(page);

  await selectKind(page, "local");
  // SPA: #sttHost and #sttPort are conditionally rendered — not in DOM for
  // local kind. Verify local defaults via API instead of DOM field access.
  const authHeader =
    USER && PASS
      ? {
          Authorization:
            "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64"),
        }
      : {};
  const resp = await page.request.get(`${BASE}/api/settings/stt`, {
    headers: authHeader,
    ignoreHTTPSErrors: true,
  });
  const body = await resp.json();
  const localProv = body.providers && body.providers.local;
  // Local defaults or previously saved values.
  expect(localProv).toBeTruthy();
  expect(localProv.host || "").toMatch(/127\.0\.0\.1/);
  expect(localProv.port || "").toBe("5200");
});
