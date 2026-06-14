// Headless verification of the phase-1 SPA against the live dev backend.
//
//   1. /settings — provider switch shows exactly the right fields per kind,
//      and a field change auto-saves (no Save tap), confirmed by reading it
//      back via GET /api/settings/stt.
//   2. /s/:name — the terminal island mounts and the PTY WebSocket connects.
//
// Run with the Vite dev server already up on :5173 (proxying to :5152):
//   npx playwright test verify.spec.mjs --config=playwright.verify.cjs
import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:5173/static/spa';

test('settings: provider switch renders correct fields + auto-saves', async ({ page }) => {
  await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#stt-provider');

  const kind = page.locator('#sttKind');

  // ── network: Host + Port + Model present; no API key. ──
  await kind.selectOption('network');
  await expect(page.locator('#sttHost')).toBeVisible();
  await expect(page.locator('#sttPort')).toBeVisible();
  await expect(page.locator('#sttModelRow')).toBeVisible();
  await expect(page.locator('#sttApiKey')).toHaveCount(0);
  await expect(page.locator('#sttInstallBtn')).toHaveCount(0);

  // ── openai: API key + Model; no Host/Port; no install/toggle. ──
  await kind.selectOption('openai');
  await expect(page.locator('#sttApiKey')).toBeVisible();
  await expect(page.locator('#sttModelRow')).toBeVisible();
  await expect(page.locator('#sttHost')).toHaveCount(0);
  await expect(page.locator('#sttPort')).toHaveCount(0);
  await expect(page.locator('#sttInstallBtn')).toHaveCount(0);

  // ── local: Install + run toggle; nothing else (no host/port/model/key). ──
  await kind.selectOption('local');
  await expect(page.locator('#sttInstallBtn')).toBeVisible();
  await expect(page.locator('#sttToggleBtn')).toBeVisible();
  await expect(page.locator('#sttHost')).toHaveCount(0);
  await expect(page.locator('#sttPort')).toHaveCount(0);
  await expect(page.locator('#sttModelRow')).toHaveCount(0);
  await expect(page.locator('#sttApiKey')).toHaveCount(0);

  // ── auto-save: switch to network, change the port, NO Save tap. ──
  await kind.selectOption('network');
  const probe = String(5290 + Math.floor(Math.random() * 9));
  const portEl = page.locator('#sttPort');
  await portEl.fill(probe);
  await portEl.blur();
  // Debounced fetch (600ms) → save. Confirm the status line flips to Saved.
  await expect(page.locator('#sttStatus')).toContainText('Saved', { timeout: 5000 });

  // ── persistence: read it back through the proxy. ──
  const cfg = await page.evaluate(async () => {
    const r = await fetch('/api/settings/stt');
    return r.json();
  });
  expect(cfg.activeKind).toBe('network');
  expect(cfg.providers.network.port).toBe(probe); // persisted with no Save tap
});

test('terminal island mounts and the PTY websocket connects', async ({ page }) => {
  // Land on the SPA origin first so the session fetch is same-origin (and so
  // it rides the proxy's injected auth).
  await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
  const sessions = await page.evaluate(async () => {
    const r = await fetch('/api/sessions');
    return r.json();
  });
  const list = Array.isArray(sessions) ? sessions : sessions.sessions || [];
  const name = typeof list[0] === 'string' ? list[0] : list[0]?.name;
  test.skip(!name, 'no live session on the backend to attach to');

  const wsConnected = new Promise((resolve) => {
    page.on('websocket', (ws) => {
      if (ws.url().includes(`/ws/${encodeURIComponent(name)}`)) resolve(ws.url());
    });
  });

  await page.goto(`${BASE}/#/s/${encodeURIComponent(name)}`, { waitUntil: 'networkidle' });

  // Island scaffold present.
  await expect(page.locator('#terminal')).toHaveCount(1);

  // Engine global resolved + WebSocket opened.
  const wsUrl = await Promise.race([
    wsConnected,
    new Promise((_, rej) => setTimeout(() => rej(new Error('ws timeout')), 15000)),
  ]);
  expect(wsUrl).toContain('/ws/');

  // Engine actually rendered into the host (xterm/sterk attaches a child).
  await page.waitForFunction(() => {
    const t = document.getElementById('terminal');
    return t && t.childElementCount > 0;
  }, { timeout: 15000 });
});
