// Sanity spec for the fleet-node emulator (test/fleet/node.cjs): boots
// a throwaway sshd, drives its isolated tmux over the real ssh pipe,
// and tears down. This proves the harness itself — no mobux backend
// involved — so the hub-proxy e2e (hub-proxy.spec.cjs) only has to
// assert the proxy, not debug sshd plumbing.
//
// Run with: make test-fleet
//
// No browser and no renderer, so run on the xterm project only —
// running it again under sterk would just boot the same sshd twice.

const { test, expect } = require("@playwright/test");
const { startNode } = require("./node.cjs");

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "xterm", "renderer-independent");
});

test("ssh into an emulated node and reach its isolated tmux", async () => {
  const node = await startNode({ name: "sanity" });
  try {
    // Single exec channel, exactly what the hub proxy does: authenticate
    // with the generated key, no agent, no known_hosts pollution, then
    // plain `tmux` — the node's TMUX_TMPDIR keeps its default socket
    // away from the user's real /tmp/tmux-<uid>/default server.
    const out = node.ssh("tmux new-session -d && tmux list-sessions");
    expect(out).toMatch(/^0: \d+ windows/m);
    // The session lives on the node's own server, visible locally
    // through the same TMUX_TMPDIR…
    expect(node.tmux(["list-sessions"])).toMatch(/^0: \d+ windows/m);
    // …whose socket really sits inside the node's sandbox.
    const socketPath = node.ssh("tmux display -p '#{socket_path}'").trim();
    expect(socketPath.startsWith(node.dir)).toBe(true);
  } finally {
    await node.stop();
  }
});

test("node sessions get the sandboxed HOME, not the real one", async () => {
  const node = await startNode({ name: "home" });
  try {
    expect(node.ssh("echo $HOME").trim()).toBe(node.home);
  } finally {
    await node.stop();
  }
});

test("two nodes run concurrently without colliding", async () => {
  const [alpha, beta] = await Promise.all([
    startNode({ name: "alpha" }),
    startNode({ name: "beta" }),
  ]);
  try {
    expect(alpha.port).not.toBe(beta.port);
    expect(alpha.tmuxTmpdir).not.toBe(beta.tmuxTmpdir);
    alpha.ssh("tmux new-session -d -s only-alpha");
    beta.ssh("tmux new-session -d -s only-beta");
    const alphaSessions = alpha.tmux(["list-sessions"]);
    const betaSessions = beta.tmux(["list-sessions"]);
    expect(alphaSessions).toContain("only-alpha");
    expect(alphaSessions).not.toContain("only-beta");
    expect(betaSessions).toContain("only-beta");
    expect(betaSessions).not.toContain("only-alpha");
  } finally {
    await Promise.all([alpha.stop(), beta.stop()]);
  }
});

test("stop() removes the temp dir and frees the port", async () => {
  const fs = require("fs");
  const net = require("net");
  const node = await startNode({ name: "teardown" });
  const { dir, port } = node;
  await node.stop();
  expect(fs.existsSync(dir)).toBe(false);
  await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => srv.close(resolve));
  });
});
