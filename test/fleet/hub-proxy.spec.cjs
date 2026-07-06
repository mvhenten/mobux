// Full fleet e2e (issue #176 phase 4): browser → hub mobux → transparent
// SSH proxy → emulated node's tmux. The node is a real throwaway sshd
// (test/fleet/node.cjs); the hub is a real isolated mobux instance
// (test/fleet/hub.cjs) that reaches the node exactly like production —
// its own ssh binary, its own ~/.ssh/config, keys it holds itself.
//
// The SPA picks the node the way a user does: the Home picker persists
// `localStorage["mobux:node"]`, TerminalIsland pins window.MOBUX_NODE
// from it, and every PTY/tmux call carries ?node=<name>. The spec seeds
// that key instead of clicking through the picker — the picker UI has
// its own coverage in test/spa.spec.cjs.
//
// Run with: make test-fleet

const { test, expect } = require("../fixtures.cjs");
const { startNode } = require("./node.cjs");
const { startHub, HUB_AUTH } = require("./hub.cjs");

const SESSION = "fleet-e2e";

let node, hub;

test.use({ extraHTTPHeaders: { Authorization: HUB_AUTH } });

test.beforeAll(async () => {
  node = await startNode({ name: "remote" });
  hub = await startHub({ nodes: [node] });
  // The session lives on the NODE's tmux server — the hub has no
  // session of this name, so any output we see must have crossed ssh.
  node.ssh(`tmux new-session -d -s ${SESSION} 'bash --norc --noprofile'`);
  node.tmux(["send-keys", "-t", SESSION, "PS1='$ '", "Enter"]);
  node.tmux(["send-keys", "-t", SESSION, "clear", "Enter"]);
});

test.afterAll(async () => {
  if (hub) await hub.stop();
  if (node) await node.stop();
});

async function bootRemoteTerminal(page) {
  await page.addInitScript((name) => {
    try {
      localStorage.setItem("mobux:node", name);
    } catch (_) {}
  }, node.name);
  await page.goto(`${hub.base}/app#/s/${SESSION}`, { waitUntil: "load" });
  await page.waitForFunction(
    () => {
      const t = document.getElementById("terminal");
      if (!t || t.classList.contains("hidden")) return false;
      const r = t.getBoundingClientRect();
      return r.width > 50 && r.height > 50;
    },
    { timeout: 8000 },
  );
  await page.waitForFunction(
    () => window.__mobuxView?.test?.wsReady?.() === true,
    { timeout: 8000 },
  );
  await page.waitForTimeout(500);
}

test("terminal I/O round-trips through the ssh proxy", async ({ page }) => {
  await bootRemoteTerminal(page);
  const marker = `MOBUX_FLEET_${Math.floor(Math.random() * 1e9)}`;
  await page.evaluate((m) => window.__mobuxView.send(`echo ${m}\r`), marker);
  // Painted in the browser…
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (document.getElementById("terminal")?.innerText || "")
            .replace(/\s+/g, " ")
            .trim(),
        ),
      { timeout: 10000, intervals: [200, 400, 800] },
    )
    .toContain(marker);
  // …and really executed on the remote node's tmux, not some hub-local
  // session of the same name.
  const pane = node.tmux(["capture-pane", "-p", "-t", SESSION]);
  expect(pane).toContain(marker);
});

// Exit condition 2 of #176: the 3-prompt bug is unreproducible — a
// whole hub → remote-node session costs at most one auth challenge.
// The Authorization header is set up-front, so ANY 401 here means the
// proxy leaked a second auth boundary.
test("no extra auth challenge crossing to the node", async ({ page }) => {
  const challenges = [];
  page.on("response", (res) => {
    if (res.status() === 401) challenges.push(res.url());
  });
  await bootRemoteTerminal(page);
  const marker = `MOBUX_FLEET_${Math.floor(Math.random() * 1e9)}`;
  await page.evaluate((m) => window.__mobuxView.send(`echo ${m}\r`), marker);
  await expect
    .poll(() => node.tmux(["capture-pane", "-p", "-t", SESSION]), {
      timeout: 10000,
      intervals: [200, 400, 800],
    })
    .toContain(marker);
  expect(challenges, "unexpected 401s during fleet session").toEqual([]);
});

test("resize reaches the remote PTY", async ({ page }) => {
  await bootRemoteTerminal(page);
  const dims = () =>
    node
      .tmux([
        "display",
        "-p",
        "-t",
        SESSION,
        "#{window_width}x#{window_height}",
      ])
      .trim();
  const before = dims();
  await page.setViewportSize({ width: 400, height: 500 });
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await expect
    .poll(dims, { timeout: 5000, intervals: [200, 400] })
    .not.toBe(before);
});
