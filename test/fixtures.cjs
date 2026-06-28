// Shared Playwright fixture that seeds `localStorage['mobux:renderer']`
// per project so each spec runs under BOTH the xterm-default and the
// sterk-experimental renderers without inline addInitScript boilerplate
// in every test file.
//
// The seed runs via `context.addInitScript`, which fires on every
// document load in the context — including after a manual
// `localStorage.clear()` + reload (the long-press / per-window-view
// tests both do this). For the xterm project, the seed actively
// REMOVES the key so the page boots exactly the way a brand-new
// device's first hit would.
//
// Selection: each project in playwright.config.cjs sets
// `use.renderer = 'xterm' | 'sterk'`. The fixture reads it via
// `testInfo.project.use.renderer`.
//
// `sterkOnly(test)` is a sibling helper for tests that poke
// sterk-internal DOM (`.ace_*`, `window.__sterk._sterk`, etc.). These
// can't be made renderer-agnostic cheaply and we explicitly want
// them to keep running against the experimental backend — they're
// guards for sterk-specific behaviour, not the user-facing contract.
// Renderer-agnostic boot/PTY/settings tests should NOT use this
// helper so they run on the xterm project too.

const base = require("@playwright/test");

exports.test = base.test.extend({
  // autouse: every test gets the init script before any nav.
  context: async ({ context }, use, testInfo) => {
    const renderer = testInfo.project.use && testInfo.project.use.renderer;
    if (renderer === "sterk") {
      await context.addInitScript(() => {
        try {
          localStorage.setItem("mobux:renderer", "sterk");
        } catch (_) {}
      });
    } else if (renderer === "xterm") {
      // Belt-and-braces: even if a previous test in the same context
      // wrote `sterk`, force xterm on every doc load. This matches a
      // virgin-device first hit (no key set, boot defaults to xterm).
      await context.addInitScript(() => {
        try {
          localStorage.removeItem("mobux:renderer");
        } catch (_) {}
      });
    }
    await use(context);
  },
});

exports.expect = base.expect;

// Skip the current test unless we're running under the sterk project.
// Call this as the FIRST line inside any test that pokes
// sterk-internal DOM (`.ace_scroller`, `.ace_line`, `window.__sterk`,
// `getCellMetrics`, etc.). On the xterm project these would assert
// against DOM that doesn't exist — but the behaviour they cover is
// genuinely sterk-only and worth keeping around for that backend.
exports.sterkOnly = (test, testInfo) => {
  const renderer = testInfo.project.use && testInfo.project.use.renderer;
  test.skip(renderer !== "sterk", "sterk-specific renderer assertion");
};
