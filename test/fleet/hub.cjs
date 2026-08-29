// Isolated hub instance for fleet e2e: spawns ./target/debug/mobux on
// a random free 127.0.0.1 port with its own MOBUX_DATA_DIR and HOME in
// a temp dir, so it can never touch the live :5151 server, the :8281
// smoke instance, or the shared sqlite config. Mirrors the env of
// `make smoke-start` minus the fixed port and /tmp/mobux-smoke paths.
//
// Fleet wiring: the backend dials nodes with plain `ssh <target>`
// (src/nodes.rs, src/tmux.rs), so each emulated node becomes a Host
// alias in the hub's sandboxed ~/.ssh/config carrying the port,
// identity and known-hosts scoping — then the node's inventory target
// is just the alias. The inventory itself goes in through the real
// surface, PUT /api/settings/nodes, after boot.
//
//   const { startHub } = require("./hub.cjs");
//   const hub = await startHub({ nodes: [node] });
//   hub.base; // http://127.0.0.1:<port>
//   await hub.stop();

const { spawn, execFileSync } = require("child_process");
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

// OpenSSH resolves "~/.ssh/config" from the passwd entry (pw_dir), NOT from
// $HOME — so the hub's sandboxed HOME alone leaves its node aliases silently
// unresolvable ("Could not resolve hostname <node>"). Give the hub a `ssh`
// wrapper on PATH that pins -F to the sandbox's config; the backend spawns
// plain `ssh <alias> ...` via PATH (src/nodes.rs, src/tmux.rs), so this is
// transparent to it.
function writeSshWrapper(dir, home) {
  const realSsh = execFileSync("sh", ["-c", "command -v ssh"])
    .toString()
    .trim();
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "ssh"),
    `#!/bin/sh\nexec ${realSsh} -F ${home}/.ssh/config "$@"\n`,
    { mode: 0o755 },
  );
  return bin;
}

function writeSshConfig(home, nodes) {
  const sshDir = path.join(home, ".ssh");
  fs.mkdirSync(sshDir, { mode: 0o700 });
  const blocks = nodes.map((node) =>
    [
      `Host ${node.name}`,
      "  HostName 127.0.0.1",
      `  Port ${node.port}`,
      `  User ${node.user}`,
      `  IdentityFile ${node.identity}`,
      `  UserKnownHostsFile ${node.knownHosts}`,
      "  StrictHostKeyChecking no",
      "  IdentitiesOnly yes",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(sshDir, "config"), blocks.join("\n"), {
    mode: 0o600,
  });
}

async function startHub({ nodes = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mobux-fleet-hub-"));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  writeSshConfig(home, nodes);
  const sshBin = writeSshWrapper(dir, home);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const tmuxSocket = `mobux-fleet-hub-${port}`;
  const log = path.join(dir, "mobux.log");
  const out = fs.openSync(log, "a");

  const proc = spawn(BINARY, [], {
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      PATH: `${sshBin}:${process.env.PATH}`,
      HOME: home,
      HISTFILE: "/dev/null",
      MOBUX_DATA_DIR: dir,
      MOBUX_TLS: "0",
      MOBUX_TMUX_SOCKET: tmuxSocket,
      MOBUX_UPDATE_DISABLE_RUN: "1",
      MOBUX_PORT: String(port),
      MOBUX_AUTH_USER: HUB_USER,
      MOBUX_PIN: HUB_PIN,
    },
  });
  await waitForHttp(base, 10000);

  const authHeader =
    "Basic " + Buffer.from(`${HUB_USER}:${HUB_PIN}`).toString("base64");

  if (nodes.length > 0) {
    const res = await fetch(base + "/api/settings/nodes", {
      method: "PUT",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        nodes: nodes.map((node) => ({ name: node.name, target: node.name })),
      }),
    });
    if (!res.ok) throw new Error(`PUT /api/settings/nodes -> ${res.status}`);
  }

  let stopped = false;
  return {
    base,
    port,
    tmuxSocket,
    dir,
    log,
    user: HUB_USER,
    pass: HUB_PIN,
    authHeader,
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

const HUB_AUTH =
  "Basic " + Buffer.from(`${HUB_USER}:${HUB_PIN}`).toString("base64");

module.exports = { startHub, HUB_AUTH };
