// Shared Playwright fixture that seeds `localStorage['mobux:renderer']`
// per project so each spec runs under BOTH the xterm-default and the
// sterk-experimental renderers without inline addInitScript boilerplate
// in every test file.
//
// The seed runs via `context.addInitScript`, which fires on every
// document load in the context — including after a manual
// `localStorage.clear()` + reload (the long-press / per-window-view
// tests both do this). For the xterm project, the seed is a no-op so
// the page boots exactly the way a brand-new device's first hit would.
//
// Selection: each project in playwright.config.cjs sets
// `use.renderer = 'xterm' | 'sterk'`. The fixture reads it via
// `testInfo.project.use.renderer`.

const base = require('@playwright/test');

exports.test = base.test.extend({
  // autouse: every test gets the init script before any nav.
  context: async ({ context }, use, testInfo) => {
    const renderer = testInfo.project.use && testInfo.project.use.renderer;
    if (renderer === 'sterk') {
      await context.addInitScript(() => {
        try { localStorage.setItem('mobux:renderer', 'sterk'); } catch (_) {}
      });
    } else if (renderer === 'xterm') {
      // Belt-and-braces: even if a previous test in the same context
      // wrote `sterk`, force xterm on every doc load. This matches a
      // virgin-device first hit (no key set, boot defaults to xterm).
      await context.addInitScript(() => {
        try { localStorage.removeItem('mobux:renderer'); } catch (_) {}
      });
    }
    await use(context);
  },
});

exports.expect = base.expect;
