// Playwright config — runs every spec under BOTH renderer projects so
// the xterm-default (real-user) path and the sterk-experimental path
// both get CI coverage. The previous attempt (PR #94 → reverted in
// PR #96) only exercised sterk and shipped a regression that bricked
// the TWA on first load. See PR #95 / the relanding PR for context.
//
// How renderer selection works:
//   1. The page-level boot script in `render_terminal_page()` reads
//      `localStorage['mobux:renderer']` (default 'xterm') and
//      synchronously injects the matching bundle script tag.
//   2. The shared fixture in `test/fixtures.cjs` reads
//      `testInfo.project.use.renderer` and seeds the localStorage key
//      via `context.addInitScript` so the boot script picks the right
//      bundle. The 'xterm' project actively REMOVES the key so the
//      first-time boot defaults to xterm — i.e. the path real users
//      hit on a fresh device.

const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.cjs',
  timeout: 30000,
  retries: 0,
  use: {
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'xterm',
      use: {
        browserName: 'chromium',
        ...devices['Pixel 7'],
        // Read by test/fixtures.cjs to seed localStorage['mobux:renderer'].
        renderer: 'xterm',
      },
    },
    {
      name: 'sterk',
      use: {
        browserName: 'chromium',
        ...devices['Pixel 7'],
        renderer: 'sterk',
      },
    },
  ],
});
