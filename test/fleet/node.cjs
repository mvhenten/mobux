// Emulated fleet node for e2e tests: a throwaway sshd on a high
// 127.0.0.1 port with generated keys, an isolated HOME, and an
// isolated tmux server. This is what issue #176 calls a "node" —
// sshd + tmux, nothing else — so tests can drive the real
// hub → ssh → tmux pipe without touching the host's ssh config, the
// user's tmux server, or anything system-level. Everything lives in
// one temp dir and is removed by `node.stop()`.
//
// tmux isolation works via TMUX_TMPDIR (pinned per-session through the
// authorized_keys `environment=` option, like HOME): the hub proxy runs
// plain `tmux ...` on the node — no `-L` — so scoping the DEFAULT
// socket's directory is what keeps the node's tmux server away from the
// real /tmp/tmux-<uid>/default one.
//
// Multiple nodes run concurrently: each gets its own temp dir, port,
// and TMUX_TMPDIR, so there is nothing to collide on.
//
//   const { startNode } = require("./node.cjs");
//   const node = await startNode({ name: "alpha" });
//   node.ssh("tmux new-session -d && tmux list-sessions");
//   node.tmux(["list-sessions"]); // same server, local shortcut
//   await node.stop();

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const SSHD = "/usr/sbin/sshd";

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

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline)
          reject(new Error(`port ${port} not accepting after ${timeoutMs}ms`));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function keygen(file) {
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file]);
}

async function startNode({ name = "node" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mobux-fleet-${name}-`));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const tmuxTmpdir = path.join(dir, "tmux");
  fs.mkdirSync(tmuxTmpdir);
  const hostKey = path.join(dir, "host_key");
  const identity = path.join(dir, "client_key");
  keygen(hostKey);
  keygen(identity);

  // The `environment=` options (with PermitUserEnvironment) pin the
  // session's HOME and TMUX_TMPDIR to the node's sandbox, so shells
  // never read the real user's rc files or ~/.tmux.conf, and plain
  // `tmux` — exactly what the hub proxy runs — gets its own server
  // instead of the user's /tmp/tmux-<uid>/default one.
  const authorizedKeys = path.join(dir, "authorized_keys");
  fs.writeFileSync(
    authorizedKeys,
    `environment="HOME=${home}",environment="TMUX_TMPDIR=${tmuxTmpdir}" ` +
      fs.readFileSync(identity + ".pub"),
    { mode: 0o600 },
  );
  const knownHosts = path.join(dir, "known_hosts");
  fs.writeFileSync(knownHosts, "");

  const user = os.userInfo().username;
  const log = path.join(dir, "sshd.log");

  // The free port can be stolen between probe and bind; retry with a
  // fresh port if sshd dies immediately.
  let port, sshd;
  for (let attempt = 0; ; attempt++) {
    port = await freePort();
    fs.writeFileSync(
      path.join(dir, "sshd_config"),
      [
        `Port ${port}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${hostKey}`,
        `PidFile ${path.join(dir, "sshd.pid")}`,
        `AuthorizedKeysFile ${authorizedKeys}`,
        "StrictModes no",
        "UsePAM no",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "PubkeyAuthentication yes",
        "PermitUserEnvironment yes",
        "LogLevel ERROR",
        "",
      ].join("\n"),
    );
    const out = fs.openSync(log, "a");
    sshd = spawn(SSHD, ["-f", path.join(dir, "sshd_config"), "-D", "-e"], {
      stdio: ["ignore", out, out],
    });
    try {
      await waitForPort(port, 5000);
      break;
    } catch (err) {
      sshd.kill("SIGKILL");
      if (attempt >= 2)
        throw new Error(`${err.message}\nsshd log:\n${fs.readFileSync(log)}`);
    }
  }

  const sshArgs = [
    "-o",
    "BatchMode=yes",
    "-o",
    `UserKnownHostsFile=${knownHosts}`,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "IdentitiesOnly=yes",
    "-p",
    String(port),
    "-i",
    identity,
    `${user}@127.0.0.1`,
  ];

  let stopped = false;
  return {
    name,
    dir,
    home,
    tmuxTmpdir,
    port,
    user,
    identity,
    knownHosts,
    sshArgs,
    // Run a command on the node over the real ssh pipe; returns stdout.
    ssh(remoteCmd) {
      return execFileSync("ssh", [...sshArgs, "--", remoteCmd], {
        stdio: "pipe",
      }).toString();
    },
    // Local shortcut to the node's tmux server (same host, so no ssh
    // needed for setup/teardown/inspection) — same TMUX_TMPDIR, same
    // default socket the hub proxy talks to.
    tmux(args) {
      const { TMUX, TMUX_PANE, ...env } = process.env;
      return execFileSync("tmux", args, {
        stdio: "pipe",
        env: {
          ...env,
          HOME: home,
          TMUX_TMPDIR: tmuxTmpdir,
          HISTFILE: "/dev/null",
        },
      }).toString();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        this.tmux(["kill-server"]);
      } catch (_) {}
      if (sshd.exitCode === null) {
        const gone = new Promise((resolve) => sshd.once("exit", resolve));
        sshd.kill("SIGTERM");
        await Promise.race([
          gone,
          new Promise((r) => setTimeout(r, 2000)).then(() =>
            sshd.kill("SIGKILL"),
          ),
        ]);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { startNode };
