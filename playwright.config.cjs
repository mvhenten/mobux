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
  // Force a single worker so the xterm and sterk projects don't both
  // try to drive the same tmux test session at once. The suite shares
  // server-side state (the MOBUX_TEST_SESSION tmux session) which
  // each project's beforeAll creates and tears down — running them
  // in parallel races on that resource and the boot tests flake.
  workers: 1,
  use: {
    ignoreHTTPSErrors: true,
  },
  // Visual baselines live next to their spec by default
  // (test/visual.spec.cjs-snapshots/). The default toHaveScreenshot
  // threshold is per-test (see DIFF in visual.spec.cjs); this block
  // sets the floor for any future visual test that forgets to pass
  // options.
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02,
      // Animations would otherwise diff on every run.
      animations: 'disabled',
      // Disable caret blink for snapshots.
      caret: 'hide',
    },
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
