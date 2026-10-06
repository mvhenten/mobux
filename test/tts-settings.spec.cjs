// Settings → Listen picks the voice provider. Switching kind writes the `tts`
// block of config.json, the key stays on the server, and Test plays the clip
// a mock provider answers. Runs its own mobux (test/speech-instance.cjs).
// Rides `make test-stt-per-kind`.

const { test, expect } = require("@playwright/test");
const { startMobux, startMockVoice } = require("./speech-instance.cjs");

const KEY = "tts-secret-key";

let mobux;
let voice;

test.beforeAll(async () => {
  voice = await startMockVoice();
  mobux = await startMobux({});
});

test.afterAll(async () => {
  if (mobux) await mobux.stop();
  if (voice) await voice.stop();
});

async function openListen(page) {
  await page
    .context()
    .setHTTPCredentials({ username: mobux.user, password: mobux.pass });
  await page.goto(`${mobux.base}/app#/settings/listen`);
  await expect(page.locator("#ttsKind")).toBeVisible();
}

async function settings(request) {
  const resp = await request.get(`${mobux.base}/api/settings/tts`, {
    headers: { Authorization: mobux.auth },
  });
  expect(resp.ok()).toBeTruthy();
  return resp.text();
}

test("the local voice is the default", async ({ request }) => {
  const body = JSON.parse(await settings(request));
  expect(body.activeKind).toBe("local");
  for (const kind of ["local", "mistral", "network", "kyutai"]) {
    expect(body.providers).toHaveProperty(kind);
    expect(body.providers[kind]).not.toHaveProperty("api_key");
  }
});

test("switching kind saves it to config.json and hides the key", async ({
  page,
  request,
}) => {
  await openListen(page);
  await page.selectOption("#ttsKind", "network");
  await page.fill("#ttsHost", "http://127.0.0.1");
  await page.fill("#ttsPort", String(voice.port));
  await page.fill("#ttsVoice", "casual_male");
  await page.fill("#ttsApiKey", KEY);
  await page.locator("#ttsApiKey").blur();
  await expect(page.locator("#ttsStatus")).toContainText("Saved", {
    timeout: 5000,
  });

  await expect
    .poll(() => mobux.readConfig().tts?.providers?.network?.api_key)
    .toBe(KEY);
  const file = mobux.readConfig();
  expect(file.tts.active).toBe("network");
  expect(file.tts.providers.network.port).toBe(String(voice.port));
  expect(file.tts.providers.network.voice).toBe("casual_male");

  const text = await settings(request);
  expect(text).not.toContain(KEY);
  const body = JSON.parse(text);
  expect(body.activeKind).toBe("network");
  expect(body.providers.network.has_key).toBe(true);
});

test("Test plays audio from the provider", async ({ page }) => {
  await openListen(page);
  await expect(page.locator("#ttsKind")).toHaveValue("network");
  const before = voice.requests.length;
  const spoken = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/tts/speak") && r.request().method() === "POST",
  );
  await page.click("#ttsTest");
  const resp = await spoken;
  expect(resp.headers()["content-type"]).toBe("audio/wav");
  expect(voice.requests.length).toBe(before + 1);
  expect(voice.requests[before].headers.authorization).toBe(`Bearer ${KEY}`);
});

test("a failing provider is named on the card", async ({ page }) => {
  await openListen(page);
  await expect(page.locator("#ttsKind")).toHaveValue("network");
  voice.state.failWith = 503;
  await page.click("#ttsTest");
  await expect(page.locator("#ttsStatus")).toContainText("503", {
    timeout: 5000,
  });
  voice.state.failWith = 0;
});
