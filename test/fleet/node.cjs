// Emulated fleet node for e2e tests: a throwaway sshd + tmux container
// on a random 127.0.0.1 port, reached with a generated keypair. This is
// what issue #176 calls a "node" — sshd + tmux, nothing else — so tests
// can drive the real hub → ssh → tmux pipe without touching the host's
// ssh config, the user's tmux server, or anything system-level.
//
// Isolation is structural, not env-based: each node is its own podman
// container (test/fleet/Containerfile.fleet-node), so its tmux server
// sits behind a real PID/mount-namespace boundary. Issue #183: the
// previous host-native sshd used TMUX_TMPDIR (pinned via authorized_keys
// `environment=`) to keep the node's tmux server away from the real
// /tmp/tmux-<uid>/default one — but tmux prefers $TMUX over TMUX_TMPDIR,
// and $TMUX leaks in from the caller's shell when the harness runs
// inside a real tmux pane, so a teardown `kill-server` hit the host's
// live session. A container has no path to the host's tmux socket at
// all, so there is nothing to leak regardless of inherited env.
//
// Multiple nodes run concurrently: each gets its own container and
// published port, so there is nothing to collide on.
//
//   const { startNode } = require("./node.cjs");
//   const node = await startNode({ name: "alpha" });
//   node.ssh("tmux new-session -d && tmux list-sessions");
//   node.tmux(["list-sessions"]); // same server, local shortcut
//   await node.stop();

const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const IMAGE = "localhost/mobux-fleet-node:dev";
const FLEET_DIR = __dirname;
const CONTAINERFILE = path.join(FLEET_DIR, "Containerfile.fleet-node");
const NODE_USER = "node";

// A raw TCP connect against the published port succeeds as soon as
// podman's rootless port-forward is up, which can be well ahead of
// sshd actually accepting inside the container — so instead of
// sniffing the socket directly (which needs its own careful timeout
// bookkeeping), just retry the real `ssh` invocation the caller is
// going to use anyway. It's synchronous like every other setup step
// here, and it proves the whole path — forward, sshd, and auth — not
// just a banner.
function waitForSsh(sshArgs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      execFileSync(
        "ssh",
        [...sshArgs, "-o", "ConnectTimeout=2", "--", "true"],
        { stdio: "pipe" },
      );
      return;
    } catch (err) {
      if (Date.now() > deadline)
        throw new Error(
          `ssh not ready after ${timeoutMs}ms: ${err.stderr || err.message}`,
        );
    }
  }
}

function keygen(file) {
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file]);
}

// Built once per test process and reused by every node — podman's own
// layer cache makes repeat calls cheap, so this just guarantees the
// image exists before the first container run.
let imageReady;
function ensureImage() {
  if (!imageReady) {
    imageReady = Promise.resolve().then(() => {
      try {
        execFileSync(
          "podman",
          ["build", "-t", IMAGE, "-f", CONTAINERFILE, FLEET_DIR],
          { stdio: "pipe" },
        );
      } catch (err) {
        throw new Error(
          `podman build (fleet-node image) failed:\n${err.stderr}`,
        );
      }
    });
  }
  return imageReady;
}

async function startNode({ name = "node" } = {}) {
  await ensureImage();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mobux-fleet-${name}-`));
  const identity = path.join(dir, "client_key");
  keygen(identity);
  const authorizedKeys = path.join(dir, "authorized_keys");
  fs.copyFileSync(identity + ".pub", authorizedKeys);
  const knownHosts = path.join(dir, "known_hosts");
  fs.writeFileSync(knownHosts, "");

  const container = `mobux-fleet-${name}-${process.pid}-${crypto
    .randomBytes(4)
    .toString("hex")}`;

  execFileSync(
    "podman",
    [
      "run",
      "-d",
      "--name",
      container,
      "-p",
      "127.0.0.1::22",
      "-v",
      `${authorizedKeys}:/home/${NODE_USER}/.ssh/authorized_keys:ro`,
      IMAGE,
    ],
    { stdio: "pipe" },
  );

  function abort(err) {
    const logs = execFileSync("podman", ["logs", container], {
      stdio: "pipe",
    }).toString();
    execFileSync("podman", ["rm", "-f", container], { stdio: "ignore" });
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`${err.message}\ncontainer logs:\n${logs}`);
  }

  let port;
  try {
    const portOut = execFileSync("podman", ["port", container, "22"], {
      stdio: "pipe",
    })
      .toString()
      .trim();
    port = Number(portOut.split(":").pop());
    if (!port) throw new Error(`could not parse published port: ${portOut}`);
  } catch (err) {
    abort(err);
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
    `${NODE_USER}@127.0.0.1`,
  ];

  try {
    waitForSsh(sshArgs, 10000);
  } catch (err) {
    abort(err);
  }

  let stopped = false;
  return {
    name,
    dir,
    container,
    port,
    user: NODE_USER,
    identity,
    knownHosts,
    sshArgs,
    // Run a command on the node over the real ssh pipe; returns stdout.
    ssh(remoteCmd) {
      return execFileSync("ssh", [...sshArgs, "--", remoteCmd], {
        stdio: "pipe",
      }).toString();
    },
    // Local shortcut to the node's tmux server: `podman exec` into the
    // same container as the same user, so it lands on the same default
    // socket the ssh session (and the hub proxy) talks to. Stripping
    // TMUX/TMUX_PANE is cheap insurance — the container boundary is
    // what actually keeps this off the host's tmux, not the env.
    tmux(args) {
      const { TMUX, TMUX_PANE, ...env } = process.env;
      return execFileSync(
        "podman",
        ["exec", "-u", NODE_USER, container, "tmux", ...args],
        { stdio: "pipe", env },
      ).toString();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        execFileSync("podman", ["rm", "-f", container], { stdio: "ignore" });
      } catch (_) {}
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { startNode };
