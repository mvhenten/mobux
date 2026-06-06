// Two-instance relayed-flow test (mesh EDD phase 3).
//
// Spins up a SECOND mobux instance — the "peer" — with its own TLS cert,
// data dir, and tmux socket on a separate high port, then drives it
// THROUGH the smoke instance's relay (`/r/<peer>/api/...`). This proves the
// full phase-3 path: peer selection → relay → upstream-auth header swap →
// TOFU cert pin, exactly as the host picker wires it in the browser.
//
// The peer serves HTTPS (relay dials peers over wss/https). The smoke
// instance under MOBUX_URL is the relay node. If the peer can't be started
// (no built binary, port busy), the suite skips rather than failing — the
// in-browser picker tests in smoke.spec.cjs cover the UI regardless.

const { test, expect } = require('./fixtures.cjs');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RELAY = process.env.MOBUX_URL || 'http://localhost:8281';
const RELAY_USER = process.env.MOBUX_USER || 'smoke';
const RELAY_PASS = process.env.MOBUX_PASS || '00000';
const RELAY_AUTH = 'Basic ' + Buffer.from(`${RELAY_USER}:${RELAY_PASS}`).toString('base64');

// The peer's own credentials (separate per node, per the EDD).
const PEER_PORT = Number(process.env.MOBUX_PEER_PORT || 8282);
const PEER_USER = 'peer';
const PEER_PASS = '99999';
const PEER_AUTH_B64 = Buffer.from(`${PEER_USER}:${PEER_PASS}`).toString('base64');
const PEER = `localhost:${PEER_PORT}`;
const PEER_HOST = `https://localhost:${PEER_PORT}`;

const PEER_DATA = '/tmp/mobux-mesh-peer';
const PEER_TMUX = 'mobux-mesh-peer';
const PEER_SESSION = 'peer-session';

const BIN = path.resolve(__dirname, '..', 'target', 'debug', 'mobux');
const tmux = (args) => execSync(`tmux -L ${PEER_TMUX} ${args}`, { stdio: 'pipe' });

let peerProc = null;

async function waitFor(url, headers, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 1000);
      const res = await fetch(url, { headers, signal: ac.signal });
      clearTimeout(t);
      if (res.ok || res.status === 401) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

test.beforeAll(async () => {
  if (!fs.existsSync(BIN)) {
    test.skip(true, `peer binary not built at ${BIN}`);
    return;
  }
  // Node 18+ fetch rejects self-signed certs; the peer serves one. Relax it
  // for this process only (we're a test reaching the peer directly to seed it).
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  fs.rmSync(PEER_DATA, { recursive: true, force: true });
  fs.mkdirSync(path.join(PEER_DATA, 'home'), { recursive: true });

  // Seed a tmux session on the peer's dedicated server so the relayed
  // /api/sessions has something to return.
  try { tmux(`kill-session -t ${PEER_SESSION}`); } catch (_) {}
  tmux(`new-session -d -s ${PEER_SESSION} -e HISTFILE=/dev/null -e HOME=${PEER_DATA}/home "bash --norc --noprofile"`);

  peerProc = spawn(BIN, [], {
    env: {
      ...process.env,
      PORT: String(PEER_PORT),
      MOBUX_DATA_DIR: PEER_DATA,
      MOBUX_TMUX_SOCKET: PEER_TMUX,
      MOBUX_AUTH_USER: PEER_USER,
      MOBUX_PIN: PEER_PASS,
      HOME: `${PEER_DATA}/home`,
      HISTFILE: '/dev/null',
      // Default TLS (self-signed CA + leaf) so the relay can dial https.
      MOBUX_TLS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  const log = fs.createWriteStream(path.join(PEER_DATA, 'peer.log'));
  peerProc.stdout.pipe(log);
  peerProc.stderr.pipe(log);

  const up = await waitFor(`${PEER_HOST}/api/identify`, {});
  if (!up) {
    test.skip(true, `peer did not come up on ${PEER_HOST} (see ${PEER_DATA}/peer.log)`);
  }

  // The relay node's pin DB persists across runs (and across the xterm/sterk
  // project pair). Each beforeAll wipes PEER_DATA → a fresh peer cert, so drop
  // any stale relay pin first; the next relayed call re-pins via TOFU.
  await fetch(`${RELAY}/api/peers/${encodeURIComponent(PEER)}/pin`, {
    method: 'DELETE',
    headers: { Authorization: RELAY_AUTH },
  }).catch(() => {});
});

test.afterAll(() => {
  if (peerProc) { try { peerProc.kill('SIGKILL'); } catch (_) {} }
  try { tmux(`kill-session -t ${PEER_SESSION}`); } catch (_) {}
  fs.rmSync(PEER_DATA, { recursive: true, force: true });
});

test('peer is directly reachable and identifies as mobux', async () => {
  const res = await fetch(`${PEER_HOST}/api/identify`);
  expect(res.ok).toBeTruthy();
  const id = await res.json();
  expect(id.app).toBe('mobux');
  expect(typeof id.version).toBe('string');
});

test('relayed /api/sessions returns the PEER\'s sessions, not the relay\'s', async () => {
  // Through the relay node, with the relay's own auth + the peer's upstream
  // auth — exactly what mesh-client.js sends for a selected peer.
  const res = await fetch(`${RELAY}/r/${encodeURIComponent(PEER)}/api/sessions`, {
    headers: {
      Authorization: RELAY_AUTH,
      'X-Mobux-Upstream-Authorization': `Basic ${PEER_AUTH_B64}`,
    },
  });
  expect(res.ok).toBeTruthy();
  const sessions = await res.json();
  const names = sessions.map((s) => s.name);
  expect(names).toContain(PEER_SESSION);
});

test('relay without upstream auth is rejected by the peer (401)', async () => {
  const res = await fetch(`${RELAY}/r/${encodeURIComponent(PEER)}/api/sessions`, {
    headers: { Authorization: RELAY_AUTH },
  });
  // No X-Mobux-Upstream-Authorization → relay forwards no Authorization →
  // the peer's auth middleware rejects.
  expect(res.status).toBe(401);
});

const relayCall = () =>
  fetch(`${RELAY}/r/${encodeURIComponent(PEER)}/api/sessions`, {
    headers: {
      Authorization: RELAY_AUTH,
      'X-Mobux-Upstream-Authorization': `Basic ${PEER_AUTH_B64}`,
    },
  });

// The reinstall scenario the pin-mismatch UX exists for: the peer comes back
// with a brand-new self-signed cert, the relay's stored pin no longer matches,
// and the UI must surface a structured 409 with a one-tap re-trust.
test('pin mismatch surfaces 409, and re-trust (DELETE pin) recovers', async () => {
  // 1. First contact pins the peer's current cert.
  const ok = await relayCall();
  expect(ok.ok).toBeTruthy();

  // 2. Simulate a peer reinstall: drop its cert material and restart so it
  //    regenerates a different self-signed leaf. The relay keeps the old pin.
  peerProc.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500));
  const certDir = path.join(PEER_DATA, 'home', '.config', 'mobux');
  for (const f of ['leaf.crt', 'leaf.key', 'leaf.meta', 'leaf.expiry', 'ca.crt', 'ca.key']) {
    fs.rmSync(path.join(certDir, f), { force: true });
  }
  peerProc = spawn(BIN, [], {
    env: {
      ...process.env,
      PORT: String(PEER_PORT),
      MOBUX_DATA_DIR: PEER_DATA,
      MOBUX_TMUX_SOCKET: PEER_TMUX,
      MOBUX_AUTH_USER: PEER_USER,
      MOBUX_PIN: PEER_PASS,
      HOME: `${PEER_DATA}/home`,
      HISTFILE: '/dev/null',
      MOBUX_TLS: '1',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  expect(await waitFor(`${PEER_HOST}/api/identify`, {})).toBeTruthy();

  // 3. Relay now sees a fingerprint that differs from its pin → 409 pin_mismatch.
  const mism = await relayCall();
  expect(mism.status).toBe(409);
  const body = await mism.json();
  expect(body.error).toBe('pin_mismatch');
  expect(body.message).toContain('fingerprint');

  // 4. One-tap re-trust: drop the pin, then the next contact re-pins and works.
  const del = await fetch(`${RELAY}/api/peers/${encodeURIComponent(PEER)}/pin`, {
    method: 'DELETE',
    headers: { Authorization: RELAY_AUTH },
  });
  expect(del.ok).toBeTruthy();
  expect((await del.json()).deleted).toBe(true);

  const recovered = await relayCall();
  expect(recovered.ok).toBeTruthy();
});
