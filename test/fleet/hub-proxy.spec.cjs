// Full fleet e2e (issue #176 phase 4): browser → hub mobux → transparent
// SSH proxy → emulated node's tmux. The node is a real throwaway sshd
// (test/fleet/node.cjs); the hub is a real isolated mobux instance
// (test/fleet/hub.cjs) that reaches the node exactly like production —
// its own ssh binary, its own ~/.ssh/config, keys it holds itself.
//
// The session URL is the whole address (issue #185): `#/s/<node>/<name>`
// attaches to that node's tmux, bare `#/s/<name>` to the hub's local one.
// TerminalIsland passes the engine the node from the route — never from the
// server-held selected-node preference — so these specs navigate straight to
// the node-qualified URL with no seeded selection, exactly like a fresh device
// opening a shared link. The picker UI has its own coverage in
// test/spa.spec.cjs.
//
// Run with: make test-fleet

const { test, expect } = require("../fixtures.cjs");
const { createTmuxRunner } = require("../lib/tmux.cjs");
const { startNode } = require("./node.cjs");
const { startHub, HUB_AUTH } = require("./hub.cjs");

const SESSION = "fleet-e2e";

let node, hub, hubTmux;

test.use({ extraHTTPHeaders: { Authorization: HUB_AUTH } });

test.beforeAll(async () => {
  node = await startNode({ name: "remote" });
  hub = await startHub({ nodes: [node] });
  // The hub's own tmux server lives on its scoped test socket; envVar: null
  // because this socket belongs to this hub instance, never the podman lane.
  hubTmux = createTmuxRunner(hub.tmuxSocket, { envVar: null });
  // The session lives on the NODE's tmux server — the hub has no
  // session of this name, so any output we see must have crossed ssh.
  node.ssh(`tmux new-session -d -s ${SESSION} 'bash --norc --noprofile'`);
  node.tmux(["send-keys", "-t", SESSION, "PS1='$ '", "Enter"]);
  node.tmux(["send-keys", "-t", SESSION, "clear", "Enter"]);
});

test.afterAll(async () => {
  try {
    hubTmux?.("kill-server");
  } catch (_) {}
  if (hub) await hub.stop();
  if (node) await node.stop();
});

// The #185 specs below seed the hub's server-held selected-node preference —
// reset it after every test so that state never leaks into the next one (the
// autouse reset in fixtures.cjs only targets MOBUX_URL, never this fleet hub).
test.afterEach(async () => {
  await seedHubSelectedNode("");
});

// Seed the hub's server-held selected-node preference (no client storage).
// Used by the #185 regression specs to prove the URL's node segment wins over
// a stale/foreign selection.
async function seedHubSelectedNode(name) {
  const cur = await (
    await fetch(`${hub.base}/api/settings/preferences`, {
      headers: { Authorization: hub.authHeader },
    })
  ).json();
  const res = await fetch(`${hub.base}/api/settings/preferences`, {
    method: "PUT",
    headers: {
      Authorization: hub.authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...cur, selected_node: name }),
  });
  expect(res.ok).toBe(true);
}

async function bootTerminal(page, hash) {
  await page.goto(`${hub.base}/app#${hash}`, { waitUntil: "load" });
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

async function bootRemoteTerminal(page) {
  await bootTerminal(page, `/s/${node.name}/${SESSION}`);
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

// Regression, issue #185: tmux ≥ 3.4 replaces control characters with `_`
// when writing to a non-tty, so the old tab-separated `-F` list formats
// came back underscore-joined from a newer node (the container runs
// trixie's tmux 3.5a) and parsed to an EMPTY list — Home showed no remote
// sessions at all. The emulated node's tmux is deliberately newer than the
// hub host's, so this pins the printable-separator formats.
test("session and pane listings cross ssh intact", async () => {
  const res = await fetch(`${hub.base}/api/sessions?node=${node.name}`, {
    headers: { Authorization: HUB_AUTH },
  });
  expect(res.status).toBe(200);
  const sessions = await res.json();
  const found = sessions.find((s) => s.name === SESSION);
  expect(found, `sessions: ${JSON.stringify(sessions)}`).toBeTruthy();
  expect(found.windows).toBeGreaterThan(0);

  const pres = await fetch(
    `${hub.base}/api/sessions/${SESSION}/panes?node=${node.name}`,
    { headers: { Authorization: HUB_AUTH } },
  );
  expect(pres.status).toBe(200);
  const panes = await pres.json();
  expect(panes.length).toBeGreaterThan(0);
  expect(panes[0].id).toMatch(/^@/);
});

// Regression: an upload while attached to a remote node used to hardcode
// the HUB's local /tmp/mobux-uploads and hand back that hub-local path —
// pasting it into the remote shell named a file that only ever existed on
// the hub. The hub process in this harness runs directly on the test host
// (not containerized), so /tmp/mobux-uploads here IS the hub's real local
// upload dir; the node's copy lives inside its own container, reachable
// only over node.ssh(). A correct fix writes the bytes on the NODE and
// returns a path that resolves there — nothing should appear under the
// hub's local dir at all.
test("an upload while attached to a remote node lands on the node, not the hub", async () => {
  const fs = require("fs");
  const path = require("path");
  const content = `fleet-upload-${Math.floor(Math.random() * 1e9)}`;
  const form = new FormData();
  form.append("file", new Blob([content], { type: "text/plain" }), "note.txt");

  const res = await fetch(`${hub.base}/api/upload?node=${node.name}`, {
    method: "POST",
    headers: { Authorization: HUB_AUTH },
    body: form,
  });
  expect(res.status).toBe(200);
  const body = await res.json();

  expect(body.path).toMatch(/^\/tmp\/mobux-uploads\/\d+-note\.txt$/);
  expect(node.ssh(`cat ${body.path}`)).toBe(content);

  const hubLocalPath = path.join(
    "/tmp/mobux-uploads",
    path.basename(body.path),
  );
  try {
    expect(fs.existsSync(hubLocalPath)).toBe(false);
  } finally {
    node.ssh(`rm -f ${body.path}`);
    fs.rmSync(hubLocalPath, { force: true });
  }
});

// Regression, issue #185: the route must pin the node even when the stored
// selected-node preference points elsewhere. A stale/foreign `selected_node`
// used to silently re-target the attach — here it names no configured node at
// all, so any fallback to it would fail loudly instead of reaching the remote
// session.
test("the URL's node segment wins over a stale device selection", async ({
  page,
}) => {
  await seedHubSelectedNode("decommissioned-node");
  await bootRemoteTerminal(page);
  const marker = `MOBUX_FLEET_${Math.floor(Math.random() * 1e9)}`;
  await page.evaluate((m) => window.__mobuxView.send(`echo ${m}\r`), marker);
  await expect
    .poll(() => node.tmux(["capture-pane", "-p", "-t", SESSION]), {
      timeout: 10000,
      intervals: [200, 400, 800],
    })
    .toContain(marker);
});

// The other half of the #185 contract: a bare `#/s/<name>` URL means the
// hub's LOCAL tmux, regardless of which node was last selected. Before the fix
// this attach followed the stored selection to the remote node and tmux
// answered "can't find session".
test("a bare session URL attaches to the hub's local tmux", async ({
  page,
}) => {
  const local = "hub-local";
  const res = await fetch(`${hub.base}/api/sessions`, {
    method: "POST",
    headers: {
      Authorization: hub.authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: local }),
  });
  expect(res.ok).toBe(true);

  await seedHubSelectedNode(node.name);
  await bootTerminal(page, `/s/${local}`);
  const marker = `MOBUX_FLEET_${Math.floor(Math.random() * 1e9)}`;
  await page.evaluate((m) => window.__mobuxView.send(`echo ${m}\r`), marker);
  await expect
    .poll(() => hubTmux(`capture-pane -p -t ${local}`).toString(), {
      timeout: 10000,
      intervals: [200, 400, 800],
    })
    .toContain(marker);
  // …and it never leaked to the node the device had selected.
  expect(node.tmux(["list-sessions", "-F", "#{session_name}"])).not.toContain(
    local,
  );
});

// ── bare session-name redirect resolves to the RIGHT tmux (issue #210) ─────
//
// A push notification (push.rs::session_url) and the legacy `/s/{name}`
// route it deep-links to both carry the session name ALONE, with no node
// segment. Before this fix, the server unconditionally redirected to the
// hub-LOCAL hash route regardless of where the session actually lived, so a
// notification for a node-only session silently attached to the wrong (or
// nonexistent) local tmux instead. These hit the real `/s/{name}` redirect
// (the raw legacy route, not `/app#/s/...`) against a real second tmux
// server — the only harness that can prove a wrong resolution as the WRONG
// server's tmux, not just a wrong-looking URL.

test("a bare session-name link resolves to the node that actually owns it", async () => {
  const solo = "fleet-e2e-node-only";
  node.ssh(`tmux new-session -d -s ${solo}`);
  try {
    const res = await fetch(`${hub.base}/s/${solo}`, {
      headers: { Authorization: HUB_AUTH },
      redirect: "manual",
    });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`/app#/s/${node.name}/${solo}`);
  } finally {
    node.ssh(`tmux kill-session -t ${solo} || true`);
  }
});

test("a bare session-name link ambiguous between local and a node lands on Home, never a guess", async () => {
  const dupe = "fleet-e2e-dupe";
  node.ssh(`tmux new-session -d -s ${dupe}`);
  hubTmux(`new-session -d -s ${dupe}`);
  try {
    const res = await fetch(`${hub.base}/s/${dupe}`, {
      headers: { Authorization: HUB_AUTH },
      redirect: "manual",
    });
    expect(res.status).toBe(307);
    // Same name lives in two places — never guess which one the user meant.
    expect(res.headers.get("location")).toBe("/app#/");
  } finally {
    node.ssh(`tmux kill-session -t ${dupe} || true`);
    hubTmux(`kill-session -t ${dupe}`);
  }
});

test("a bare session-name link with no match anywhere lands on Home", async () => {
  const res = await fetch(`${hub.base}/s/fleet-e2e-does-not-exist`, {
    headers: { Authorization: HUB_AUTH },
    redirect: "manual",
  });
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe("/app#/");
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
