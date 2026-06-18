// Standalone Playwright config for the PROD-SERVED SPA verification: a mobux
// binary serving the built SPA at /app over HTTPS (self-signed) on a throwaway
// port, behind HTTP Basic auth. It does NOT start or stop the server — the
// caller runs the binary on :5183 first and kills it after.
const { defineConfig, devices } = require('@playwright/test');

const BASE = process.env.MOBUX_VERIFY_BASE || 'https://localhost:5183';

module.exports = defineConfig({
  testDir: '.',
  testMatch: ['verify.prod.spec.mjs'],
  timeout: 40000,
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: BASE,
    ignoreHTTPSErrors: true,
    headless: true,
    httpCredentials: { username: 'mvhenten', password: '30879' },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
