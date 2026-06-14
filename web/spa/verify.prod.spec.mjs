// Headless verification of the PROD-SERVED SPA: the Rust binary serving the
// built SPA at /app on a throwaway port (no Vite). Confirms the phase-2
// deliverables: the /app route serves the SPA behind auth, Home lists sessions,
// every ported Settings card renders + hits the right endpoints, and the
// terminal island mounts + the PTY WebSocket connects.
//
// Run against a binary started on :5183 with basic auth mvhenten:30879:
//   npx playwright test verify.prod.spec.mjs --config=playwright.prod.cjs
import { test, expect } from '@playwright/test';

const BASE = process.env.MOBUX_VERIFY_BASE || 'https://localhost:5183';
const APP = `${BASE}/app`;

test('app route serves the SPA and Home lists sessions', async ({ page }) => {
  await page.goto(`${APP}#/`, { waitUntil: 'networkidle' });
  // App mounted.
  await expect(page.locator('#app')).toHaveCount(1);
  await expect(page.locator('.spa-nav')).toBeVisible();

  // Sessions known to the backend.
  const sessions = await page.evaluate(async () => (await fetch('/api/sessions')).json());
  const list = Array.isArray(sessions) ? sessions : sessions.sessions || [];

  if (list.length) {
    // The list renders a row per session.
    await expect(page.locator('#sessionList .session-item').first()).toBeVisible({ timeout: 5000 });
    const names = await page.locator('#sessionList .session-name').allTextContents();
    expect(names.length).toBeGreaterThan(0);
  } else {
    await expect(page.locator('#sessionList')).toContainText('No tmux sessions');
  }
  // FAB present (create path).
  await expect(page.locator('#fabNew')).toBeVisible();
});

test('settings: every ported card renders and hits the right endpoints', async ({ page }) => {
  // Track the GET requests the cards fire on mount.
  const seen = new Set();
  page.on('request', (r) => {
    const u = new URL(r.url()).pathname;
    if (u.startsWith('/api/')) seen.add(`${r.method()} ${u}`);
  });

  await page.goto(`${APP}#/settings`, { waitUntil: 'networkidle' });

  // Cards present.
  await expect(page.locator('#update h2')).toHaveText('Software update');
  await expect(page.locator('#renderer-picker')).toBeVisible();
  await expect(page.locator('#theme-picker')).toBeVisible();
  await expect(page.locator('#shell-integration')).toBeVisible();
  await expect(page.locator('#stt-provider')).toBeVisible();
  await expect(page.locator('section#install-app')).toBeVisible();

  // Notifications card (4 checkboxes).
  await expect(page.locator('input[name="bell"]')).toHaveCount(1);
  await expect(page.locator('input[name="program_exit_nonzero"]')).toHaveCount(1);

  // Theme picker populated from /static/themes.js.
  await page.waitForFunction(
    () => document.querySelectorAll('#theme-picker option').length > 0,
    { timeout: 5000 },
  );

  // Shell-integration state resolved (not the initial "…").
  await expect(page.locator('#shell-integration .shell-card[data-shell="bash"] [data-role="state"]'))
    .not.toHaveText('…', { timeout: 5000 });

  // Update card showed a current version (from /api/update/status).
  await expect(page.locator('#update .settings-value').first()).not.toHaveText('…', { timeout: 8000 });

  // Confirm the cards consumed their endpoints.
  for (const want of [
    'GET /api/update/status',
    'GET /api/settings/notifications',
    'GET /api/shell-integration/status',
    'GET /api/settings/stt',
  ]) {
    expect(seen.has(want), `expected ${want}`).toBeTruthy();
  }
});

test('settings: STT provider switch + auto-save persists', async ({ page }) => {
  await page.goto(`${APP}#/settings`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#stt-provider');
  const kind = page.locator('#sttKind');

  await kind.selectOption('network');
  await expect(page.locator('#sttHost')).toBeVisible();
  await expect(page.locator('#sttPort')).toBeVisible();

  const probe = String(5290 + Math.floor(Math.random() * 9));
  const portEl = page.locator('#sttPort');
  await portEl.fill(probe);
  await portEl.blur();
  await expect(page.locator('#sttStatus')).toContainText('Saved', { timeout: 6000 });

  const cfg = await page.evaluate(async () => (await fetch('/api/settings/stt')).json());
  expect(cfg.activeKind).toBe('network');
  expect(cfg.providers.network.port).toBe(probe);
});

test('terminal island mounts and the PTY websocket connects', async ({ page }) => {
  await page.goto(`${APP}#/`, { waitUntil: 'domcontentloaded' });
  const sessions = await page.evaluate(async () => (await fetch('/api/sessions')).json());
  const list = Array.isArray(sessions) ? sessions : sessions.sessions || [];
  const name = typeof list[0] === 'string' ? list[0] : list[0]?.name;
  test.skip(!name, 'no live session on the backend to attach to');

  const wsConnected = new Promise((resolve) => {
    page.on('websocket', (ws) => {
      if (ws.url().includes(`/ws/${encodeURIComponent(name)}`)) resolve(ws.url());
    });
  });

  await page.goto(`${APP}#/s/${encodeURIComponent(name)}`, { waitUntil: 'networkidle' });
  await expect(page.locator('#terminal')).toHaveCount(1);

  const wsUrl = await Promise.race([
    wsConnected,
    new Promise((_, rej) => setTimeout(() => rej(new Error('ws timeout')), 15000)),
  ]);
  expect(wsUrl).toContain('/ws/');

  await page.waitForFunction(
    () => {
      const t = document.getElementById('terminal');
      return t && t.childElementCount > 0;
    },
    { timeout: 15000 },
  );
});
