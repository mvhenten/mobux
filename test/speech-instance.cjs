// An isolated mobux for the speech settings specs: ./target/debug/mobux on a
// free loopback port with its own data dir, HOME and MOBUX_CONFIG_DIR, started
// on a config.json the spec writes first. The speech blocks are file-only, so
// a preseeded file is the only way to test what an install ships with.
//
//   const mobux = await startMobux({ stt: {...}, tts: {...} });
//   mobux.base; mobux.configPath; mobux.readConfig();
//   await mobux.stop();
//
// Also a mock voice: an HTTP server answering the OpenAI-shaped
// /v1/audio/speech and Pocket TTS's /tts with a WAV clip, or an error status.

const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const BINARY = path.join(__dirname, "..", "target", "debug", "mobux");
const USER = "speech";
const PIN = "00000";
const AUTH = "Basic " + Buffer.from(`${USER}:${PIN}`).toString("base64");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHttp(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(base + "/");
      return;
    } catch (_) {
      if (Date.now() > deadline)
        throw new Error(`mobux not answering at ${base} after ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

async function startMobux(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mobux-speech-"));
  const home = path.join(dir, "home");
  const configDir = path.join(dir, "config");
  fs.mkdirSync(home);
  fs.mkdirSync(configDir);
  const configPath = path.join(configDir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const log = path.join(dir, "mobux.log");
  const out = fs.openSync(log, "a");
  const proc = spawn(BINARY, [], {
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      HOME: home,
      HISTFILE: "/dev/null",
      MOBUX_CONFIG_DIR: configDir,
      MOBUX_DATA_DIR: dir,
      MOBUX_TLS: "0",
      MOBUX_TMUX_SOCKET: `mobux-speech-${port}`,
      MOBUX_UPDATE_DISABLE_RUN: "1",
      MOBUX_PORT: String(port),
      MOBUX_AUTH_USER: USER,
      MOBUX_PIN: PIN,
    },
  });
  await waitForHttp(base, 10000);

  let stopped = false;
  return {
    base,
    configPath,
    user: USER,
    pass: PIN,
    auth: AUTH,
    readConfig: () => JSON.parse(fs.readFileSync(configPath, "utf8")),
    writeConfig: (doc) =>
      fs.writeFileSync(configPath, JSON.stringify(doc, null, 2)),
    async stop() {
      if (stopped) return;
      stopped = true;
      if (proc.exitCode === null) {
        const gone = new Promise((resolve) => proc.once("exit", resolve));
        proc.kill("SIGTERM");
        await Promise.race([
          gone,
          new Promise((r) => setTimeout(r, 2000)).then(() =>
            proc.kill("SIGKILL"),
          ),
        ]);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// 0.1 s of 24 kHz mono silence.
function wavClip() {
  const samples = 2400;
  const data = samples * 2;
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

// `failWith` set to a status makes every request answer it.
async function startMockVoice() {
  const requests = [];
  const state = { failWith: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (state.failWith) {
        res.writeHead(state.failWith, { "content-type": "text/plain" });
        res.end("mock voice refused");
        return;
      }
      res.writeHead(200, { "content-type": "audio/wav" });
      res.end(wavClip());
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    requests,
    state,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startMobux, startMockVoice };
