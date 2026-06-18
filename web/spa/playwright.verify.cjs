// Standalone Playwright config for the phase-1 SPA verification run. Assumes
// the Vite dev server is already up on :5173 (proxying to the live :5152
// backend) — it does NOT start or stop any server.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  testMatch: ['verify.spec.mjs'],
  timeout: 30000,
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    ignoreHTTPSErrors: true,
    headless: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
