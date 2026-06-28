// Playwright spec: STT settings UX improvements (self-discovering, low-effort).
//
// Requires a throwaway server running on PORT 5198.
// Run: MOBUX_STT_URL=http://localhost:5198 MOBUX_STT_USER=testuser MOBUX_STT_PASS=testpin
//      npx playwright test stt-ux.spec.cjs

const { test, expect } = require("./fixtures.cjs");

const BASE = process.env.MOBUX_STT_URL || "https://localhost:5198";
const USER = process.env.MOBUX_STT_USER || "testuser";
const PASS = process.env.MOBUX_STT_PASS || "testpin";

async function openSettings(page) {
  await page.context().setHTTPCredentials({ username: USER, password: PASS });
  await page.goto(`${BASE}/app#/settings`, { ignoreHTTPSErrors: true });
  await page.waitForSelector("#sttKind", { timeout: 5000 });
  // Allow JS fetch/populate to complete.
  await page.waitForTimeout(800);
}

async function selectKind(page, kind) {
  await page.selectOption("#sttKind", kind);
  await page.waitForTimeout(400);
}

// Helper: assert an element is NOT rendered in the SPA (conditional render = not in DOM).
async function expectHidden(page, selector) {
  expect(
    await page.locator(selector).count(),
    `${selector} should not be in DOM`,
  ).toBe(0);
}

// Helper: assert an element IS rendered in the SPA.
async function expectVisible(page, selector) {
  expect(
    await page.locator(selector).count(),
    `${selector} should be in DOM`,
  ).toBeGreaterThan(0);
}

// 1. Local kind hides model picker and custom-model row.
test("local kind hides model row and custom-model row", async ({ page }) => {
  await openSettings(page);
  await selectKind(page, "local");

  // SPA conditionally renders these — not in DOM when kind=local.
  await expectHidden(page, "#sttModelRow");
  await expectHidden(page, "#sttCustomModelRow");

  // Host and port rows also not rendered for local.
  await expectHidden(page, "#sttHostRow");
  await expectHidden(page, "#sttPortRow");
});

// 2. Network kind shows model dropdown (not hidden).
test("network kind shows model dropdown", async ({ page }) => {
  await openSettings(page);
  await selectKind(page, "network");

  await expectVisible(page, "#sttModelRow");

  // Host+port visible, key hidden.
  await expectVisible(page, "#sttHostRow");
  await expectHidden(page, "#sttApiKeyRow");
});

// 3. Bare hostname composes to http://lab:8081/v1/audio/transcriptions on save.
test("bare hostname is saved with http:// scheme", async ({ page }) => {
  await openSettings(page);
  await selectKind(page, "network");

  await page.fill("#sttHost", "lab");
  await page.fill("#sttPort", "8081");
  // Blur triggers onHostBlur → schedFetchModels (600 ms debounce) → save.
  await page.dispatchEvent("#sttHost", "blur");
  // Wait for schedFetchModels (600ms) + save round-trip.
  await page.waitForTimeout(1000);

  // Read back via API to confirm the stored URL.
  const authHeader = `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;
  const resp = await page.request.get(`${BASE}/api/settings/stt`, {
    headers: { Authorization: authHeader },
  });
  const body = await resp.json();
  const network = body.providers && body.providers.network;
  expect(network).toBeTruthy();
  // The host field should have been normalized to include http://.
  expect(network.host).toMatch(/^https?:\/\//);
  // Port should be stored.
  expect(network.port).toBe("8081");
});

// 4. Switch network→local→network restores each kind's saved values.
test("switch between kinds restores per-kind values", async ({ page }) => {
  await openSettings(page);

  // Save a network provider first.
  await selectKind(page, "network");
  await page.fill("#sttHost", "http://lab.example");
  await page.fill("#sttPort", "9090");
  // Trigger save via host blur (schedFetchModels → save after 600ms).
  await page.dispatchEvent("#sttHost", "blur");
  await page.waitForTimeout(1000);

  // Switch to local.
  await selectKind(page, "local");
  // SPA: #sttHost and #sttPort are not rendered for local kind (conditional
  // render). Skip the direct field-value check; the round-trip below covers it.

  // Switch back to network — should restore lab.example.
  await selectKind(page, "network");
  const networkHost = await page.$eval("#sttHost", (el) => el.value);
  expect(networkHost).toContain("lab.example");
  const networkPort = await page.$eval("#sttPort", (el) => el.value);
  expect(networkPort).toBe("9090");
});

// 5. Reset button restores current kind's defaults.
test.fixme("reset button restores defaults for current kind", async ({
  page,
}) => {
  // PARITY GAP: SPA Stt.jsx has no #sttResetBtn — reset-to-defaults is not
  // implemented in the SPA settings. Add a Reset button to SttCard to unblock.
  await openSettings(page);

  // Set network to non-default values.
  await selectKind(page, "network");
  await page.fill("#sttHost", "http://custom.host");
  await page.fill("#sttPort", "1234");

  // Click reset (without saving).
  await page.click("#sttResetBtn");
  await page.waitForTimeout(400);

  // Network default host is '' (empty) and port is ''.
  const host = await page.$eval("#sttHost", (el) => el.value);
  const port = await page.$eval("#sttPort", (el) => el.value);
  expect(host).toBe("");
  expect(port).toBe("");

  // Status message should confirm reset.
  await expect(page.locator("#sttStatus")).toBeVisible({ timeout: 2000 });
});

// 5b. Reset for local kind restores 127.0.0.1:5200.
test.fixme("reset on local kind restores local defaults", async ({ page }) => {
  // PARITY GAP: SPA Stt.jsx has no #sttResetBtn — same gap as test 5.
  await openSettings(page);
  await selectKind(page, "local");
  await page.click("#sttResetBtn");
  await page.waitForTimeout(400);

  // Even though host/port rows are hidden, the values should be the defaults.
  const host = await page.$eval("#sttHost", (el) => el.value);
  const port = await page.$eval("#sttPort", (el) => el.value);
  expect(host).toBe("http://127.0.0.1");
  expect(port).toBe("5200");
});

// 6. Saved model not in discovered list appears as selectable option (not "custom…").
test("saved model not in list appears as selectable option", async ({
  page,
}) => {
  await openSettings(page);

  // Save openai with a model unlikely to be in the fallback list but should
  // appear as an option after populateModelSelect adds it.
  await selectKind(page, "openai");

  // Directly set the stored model via API to something unusual.
  const authHeader = `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;
  await page.request.put(`${BASE}/api/settings/stt`, {
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    data: JSON.stringify({
      kind: "openai",
      host: "https://api.openai.com",
      port: "443",
      model: "my-custom-deployed-model",
    }),
  });

  // Reload to let the page fetch the saved config.
  await page.reload();
  await page.waitForSelector("#sttKind", { timeout: 5000 });
  await page.waitForTimeout(800);

  // The dropdown should have the model selected (not "__custom__").
  const selectedValue = await page.$eval("#sttModel", (el) => el.value);
  expect(selectedValue).toBe("my-custom-deployed-model");

  // Custom-model free-text row should not be in DOM (since it's a selectable option).
  await expectHidden(page, "#sttCustomModelRow");
});
