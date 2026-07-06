// Sanity spec for the fleet-node emulator (test/fleet/node.cjs): boots
// a throwaway sshd, drives its scoped tmux over the real ssh pipe, and
// tears down. This proves the harness itself — no mobux backend
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

test("ssh into an emulated node and reach its scoped tmux", async () => {
  const node = await startNode({ name: "sanity" });
  try {
    // Single exec channel, exactly what the hub proxy will do:
    // authenticate with the generated key, no agent, no known_hosts
    // pollution, then talk to the node's own tmux server.
    const out = node.ssh(
      `tmux -L ${node.socket} new-session -d && tmux -L ${node.socket} list-sessions`,
    );
    expect(out).toMatch(/^0: \d+ windows/m);
    // The session lives on the node's scoped server, visible locally
    // through the same socket.
    expect(node.tmux(["list-sessions"])).toMatch(/^0: \d+ windows/m);
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
    expect(alpha.socket).not.toBe(beta.socket);
    alpha.ssh(`tmux -L ${alpha.socket} new-session -d -s only-alpha`);
    beta.ssh(`tmux -L ${beta.socket} new-session -d -s only-beta`);
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
