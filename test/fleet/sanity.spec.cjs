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
    // plain `tmux` — the node's own container is the isolation boundary,
    // so there is no TMUX_TMPDIR trick to rely on.
    const out = node.ssh("tmux new-session -d && tmux list-sessions");
    expect(out).toMatch(/^0: \d+ windows/m);
    // The session lives on the node's own server, visible locally
    // through the same container/user…
    expect(node.tmux(["list-sessions"])).toMatch(/^0: \d+ windows/m);
    // …whose socket sits inside the container's own filesystem — a
    // normal default tmux path, but namespaced away from the host's
    // (the container has its own /tmp, own PID 1, own everything). We
    // deliberately don't probe this path from the host to "prove" that:
    // the container's uid can coincidentally match the host's, in which
    // case the string would collide with the host's REAL default socket
    // (e.g. /tmp/tmux-1000/default) — exactly the live server this whole
    // harness exists to never touch.
    const socketPath = node.ssh("tmux display -p '#{socket_path}'").trim();
    expect(socketPath).toMatch(/^\/tmp\/tmux-\d+\/default$/);
  } finally {
    await node.stop();
  }
});

test("node sessions run as the container's own user, not the host's", async () => {
  const node = await startNode({ name: "home" });
  try {
    expect(node.ssh("whoami").trim()).toBe(node.user);
    expect(node.ssh("echo $HOME").trim()).toBe(`/home/${node.user}`);
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
    expect(alpha.container).not.toBe(beta.container);
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
