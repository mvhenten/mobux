// The speech providers live in config.json: an install that ships a
// preseeded file starts with its keys, a hand edit applies without a restart,
// and Listen speaks through the provider the file names. Runs its own mobux
// (test/speech-instance.cjs), so the smoke instance's config is never touched.
// Rides `make test-stt-per-kind`.

const { test, expect } = require("@playwright/test");
const { startMobux, startMockVoice } = require("./speech-instance.cjs");

const KEY = "preseeded-mistral-key";

let mobux;
let voice;

test.beforeAll(async () => {
  voice = await startMockVoice();
  mobux = await startMobux({
    stt: {
      active: "mistral",
      providers: { mistral: { api_key: KEY } },
    },
    tts: {
      active: "network",
      providers: {
        network: {
          host: "http://127.0.0.1",
          port: String(voice.port),
          voice: "casual_female",
          api_key: "tts-key",
        },
      },
    },
  });
});

test.afterAll(async () => {
  if (mobux) await mobux.stop();
  if (voice) await voice.stop();
});

async function get(request, path) {
  const resp = await request.get(`${mobux.base}${path}`, {
    headers: { Authorization: mobux.auth },
  });
  expect(resp.ok()).toBeTruthy();
  return resp;
}

async function speak(request) {
  return request.post(`${mobux.base}/api/tts/speak`, {
    headers: { Authorization: mobux.auth },
    data: { text: "Build finished.", kind: "prose" },
  });
}

test("a preseeded file is read with its key, which never comes back", async ({
  request,
}) => {
  const resp = await get(request, "/api/settings/stt");
  const text = await resp.text();
  expect(text).not.toContain(KEY);
  const body = JSON.parse(text);
  expect(body.activeKind).toBe("mistral");
  expect(body.providers.mistral.has_key).toBe(true);
  expect(body.providers.mistral.host).toBe("https://api.mistral.ai");
  expect(body.providers.mistral.model).toBe("voxtral-mini-latest");
  expect(body.providers.openai.has_key).toBe(false);

  const tts = JSON.parse(
    await (await get(request, "/api/settings/tts")).text(),
  );
  expect(tts.activeKind).toBe("network");
  expect(tts.providers.network.has_key).toBe(true);
  expect(JSON.stringify(tts)).not.toContain("tts-key");
});

test("a hand edit applies without a restart", async ({ request }) => {
  const doc = mobux.readConfig();
  doc.stt.active = "kyutai";
  mobux.writeConfig(doc);
  const body = await (await get(request, "/api/settings/stt")).json();
  expect(body.activeKind).toBe("kyutai");
  expect(body.providers.kyutai.host).toBe("ws://localhost");
  expect(body.providers.mistral.has_key).toBe(true);
});

test("Listen speaks through the configured provider", async ({ request }) => {
  voice.state.failWith = 0;
  const before = voice.requests.length;
  const resp = await speak(request);
  expect(resp.ok()).toBeTruthy();
  expect(resp.headers()["content-type"]).toBe("audio/wav");
  const body = await resp.body();
  expect(body.subarray(0, 4).toString()).toBe("RIFF");

  const sent = voice.requests.slice(before);
  expect(sent).toHaveLength(1);
  expect(sent[0].url).toBe("/v1/audio/speech");
  expect(sent[0].headers.authorization).toBe("Bearer tts-key");
  const payload = JSON.parse(sent[0].body);
  expect(payload.voice).toBe("casual_female");
  expect(payload.response_format).toBe("wav");

  const status = await (await get(request, "/api/tts/status")).json();
  expect(status.kind).toBe("network");
  expect(status.voice).toBe("casual_female");
  expect(status.state).toBe("ready");
});

test("a failing provider falls back to the browser and says why", async ({
  request,
}) => {
  voice.state.failWith = 500;
  const resp = await speak(request);
  voice.state.failWith = 0;
  expect(resp.ok()).toBeTruthy();
  const body = await resp.json();
  expect(body.engine).toBe("browser");
  expect(body.reason).toContain("network");
  expect(body.reason).toContain("500");
  expect(body.text).toContain("Build finished");
});
