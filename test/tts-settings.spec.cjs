// Speech providers live in config.json. Against the smoke instance: a file
// edit applies without a restart and keeps the key on the server, Settings →
// Listen writes the `tts` block, and Test plays what a mock provider answers.
// The spec reads and rewrites the smoke instance's config.json under
// MOBUX_SMOKE_DATA and puts back what it found. Rides `make test-stt-per-kind`.

const fs = require("fs");
const http = require("http");
const path = require("path");
const { test, expect } = require("@playwright/test");

const BASE = process.env.MOBUX_STT_URL || process.env.MOBUX_URL || "";
const USER = process.env.MOBUX_STT_USER || process.env.MOBUX_USER || "";
const PASS = process.env.MOBUX_STT_PASS || process.env.MOBUX_PASS || "";
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
const DATA = process.env.MOBUX_SMOKE_DATA || process.env.MOBUX_DATA_DIR || "";
const CONFIG = path.join(DATA, "home/.config/mobux/config.json");
const STT_KEY = "file-mistral-key";
const TTS_KEY = "tts-secret-key";

test.skip(!BASE || !DATA, "needs the smoke instance and its data dir");

function readConfig() {
  if (!fs.existsSync(CONFIG)) return {};
  return JSON.parse(fs.readFileSync(CONFIG, "utf8"));
}

function writeConfig(doc) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(doc, null, 2), { mode: 0o600 });
}

// 0.1 s of 24 kHz mono silence.
function wavClip() {
  const data = 4800;
  const buf = Buffer.alloc(44 + data);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + data, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(24000, 24);
  buf.writeUInt32LE(48000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(data, 40);
  return buf;
}

const voice = { port: 0, requests: [], failWith: 0, server: null };
let original;

test.beforeAll(async () => {
  voice.server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      voice.requests.push({ url: req.url, headers: req.headers });
      if (voice.failWith) {
        res.writeHead(voice.failWith, { "content-type": "text/plain" });
        res.end("mock voice refused");
        return;
      }
      res.writeHead(200, { "content-type": "audio/wav" });
      res.end(wavClip());
    });
  });
  await new Promise((resolve) => voice.server.listen(0, "127.0.0.1", resolve));
  voice.port = voice.server.address().port;

  original = readConfig();
  const start = { ...original };
  delete start.stt;
  delete start.tts;
  writeConfig(start);
});

test.afterAll(async () => {
  writeConfig(original);
  await new Promise((resolve) => voice.server.close(resolve));
});

async function settings(request, block) {
  const resp = await request.get(`${BASE}/api/settings/${block}`, {
    headers: { Authorization: AUTH },
  });
  expect(resp.ok()).toBeTruthy();
  return resp.text();
}

async function openListen(page) {
  await page.context().setHTTPCredentials({ username: USER, password: PASS });
  await page.goto(`${BASE}/app#/settings/listen`);
  await expect(page.locator("#ttsKind")).toBeVisible();
}

test("a file edit applies without a restart and the key never comes back", async ({
  request,
}) => {
  const tts = JSON.parse(await settings(request, "tts"));
  expect(tts.activeKind).toBe("local");
  for (const kind of ["local", "mistral", "network", "kyutai"]) {
    expect(tts.providers[kind]).not.toHaveProperty("api_key");
  }

  writeConfig({
    ...readConfig(),
    stt: { active: "mistral", providers: { mistral: { api_key: STT_KEY } } },
  });
  const text = await settings(request, "stt");
  expect(text).not.toContain(STT_KEY);
  const stt = JSON.parse(text);
  expect(stt.activeKind).toBe("mistral");
  expect(stt.providers.mistral.has_key).toBe(true);
  expect(stt.providers.mistral.host).toBe("https://api.mistral.ai");
  expect(stt.providers.openai.has_key).toBe(false);

  const edited = readConfig();
  edited.stt.active = "kyutai";
  writeConfig(edited);
  const again = JSON.parse(await settings(request, "stt"));
  expect(again.activeKind).toBe("kyutai");
  expect(again.providers.kyutai.host).toBe("ws://localhost");
  expect(again.providers.mistral.has_key).toBe(true);
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
  await page.fill("#ttsApiKey", TTS_KEY);
  await page.locator("#ttsApiKey").blur();

  await expect
    .poll(() => readConfig().tts?.providers?.network?.api_key)
    .toBe(TTS_KEY);
  const file = readConfig();
  expect(file.tts.active).toBe("network");
  expect(file.tts.providers.network.port).toBe(String(voice.port));
  expect(file.tts.providers.network.voice).toBe("casual_male");

  const text = await settings(request, "tts");
  expect(text).not.toContain(TTS_KEY);
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
  expect(voice.requests[before].url).toBe("/v1/audio/speech");
  expect(voice.requests[before].headers.authorization).toBe(
    `Bearer ${TTS_KEY}`,
  );
});

test("a failing provider is named on the card", async ({ page }) => {
  await openListen(page);
  await expect(page.locator("#ttsKind")).toHaveValue("network");
  voice.failWith = 503;
  await page.click("#ttsTest");
  await expect(page.locator("#ttsStatus")).toContainText("503", {
    timeout: 5000,
  });
  voice.failWith = 0;
});
