// Isolated hub instance for fleet e2e: spawns ./target/debug/mobux on
// a random free 127.0.0.1 port with its own MOBUX_DATA_DIR and HOME in
// a temp dir, so it can never touch the live :5151 server, the :8281
// smoke instance, or the shared sqlite config. Mirrors the env of
// `make smoke-start` minus the fixed port and /tmp/mobux-smoke paths.
//
//   const { startHub } = require("./hub.cjs");
//   const hub = await startHub({ nodes: [node] });
//   hub.base; // http://127.0.0.1:<port>
//   await hub.stop();

const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const BINARY = path.join(__dirname, "..", "..", "target", "debug", "mobux");
const HUB_USER = "fleet";
const HUB_PIN = "00000";

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
        throw new Error(`hub not answering at ${base} after ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

// TODO(feat/node-inventory-ssh-proxy): translate the emulated nodes
// into whatever the backend reads its inventory from (env / config
// file / DB seed). This seam is the only place the wiring lands; each
// node exposes { name, port, user, identity, socket } — enough for a
// `ssh -p <port> -i <identity> <user>@127.0.0.1` target definition.
function nodeInventoryEnv(nodes) {
  void nodes;
  return {};
}

async function startHub({ nodes = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mobux-fleet-hub-"));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
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
      MOBUX_DATA_DIR: dir,
      MOBUX_TLS: "0",
      MOBUX_TMUX_SOCKET: `mobux-fleet-hub-${port}`,
      MOBUX_UPDATE_DISABLE_RUN: "1",
      PORT: String(port),
      MOBUX_AUTH_USER: HUB_USER,
      MOBUX_PIN: HUB_PIN,
      ...nodeInventoryEnv(nodes),
    },
  });
  await waitForHttp(base, 10000);

  let stopped = false;
  return {
    base,
    port,
    dir,
    log,
    user: HUB_USER,
    pass: HUB_PIN,
    authHeader:
      "Basic " + Buffer.from(`${HUB_USER}:${HUB_PIN}`).toString("base64"),
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

module.exports = { startHub };
