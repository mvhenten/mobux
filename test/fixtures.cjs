// Shared Playwright fixture that seeds the terminal renderer per project so
// each spec runs under BOTH the xterm-default and the sterk-experimental
// renderers without inline boilerplate in every test file.
//
// The renderer is a server-held preference now (#211), not a per-device
// localStorage key, so the seed is a PUT to /api/settings/preferences against
// the instance under test. It writes a clean default blob with the project's
// renderer, giving every test a known preferences baseline (the old
// localStorage.clear() + reseed, moved server-side). The suite runs workers=1,
// so this global row is never raced.
//
// Only seeds when MOBUX_URL is set (the smoke/spa/critical-path runs). The STT
// runs use MOBUX_STT_URL and never exercise the terminal, so they skip it —
// which also guarantees we never PUT to the default https://localhost:5151
// live server. The `request` fixture inherits the spec's extraHTTPHeaders
// (basic auth) and ignoreHTTPSErrors from playwright.config.cjs.
//
// Selection: each project in playwright.config.cjs sets
// `use.renderer = 'xterm' | 'sterk'`. The fixture reads it via
// `testInfo.project.use.renderer`.
//
// `sterkOnly(test)` is a sibling helper for tests that poke sterk-internal DOM
// (`.ace_*`, `window.__sterk._sterk`, etc.). These can't be made
// renderer-agnostic cheaply and we explicitly want them to keep running
// against the experimental backend.

const base = require("@playwright/test");

const PREF_DEFAULTS = {
  renderer: "xterm",
  theme: "tomorrow-night-soft",
  default_view: "xterm",
  osc133_hint_dismissed: false,
  listen_voice: "",
  listen_rate: 1.0,
  listen_pitch: 1.0,
};

exports.test = base.test.extend({
  // autouse: every test gets a clean preferences baseline (with the project's
  // renderer) before it navigates.
  context: async ({ context, request }, use, testInfo) => {
    const renderer =
      (testInfo.project.use && testInfo.project.use.renderer) || "xterm";
    const serverUrl = process.env.MOBUX_URL;
    if (serverUrl) {
      await request.put(`${serverUrl}/api/settings/preferences`, {
        data: { ...PREF_DEFAULTS, renderer },
      });
    }
    await use(context);
  },
});

exports.expect = base.expect;
exports.PREF_DEFAULTS = PREF_DEFAULTS;

// Skip the current test unless we're running under the sterk project.
// Call this as the FIRST line inside any test that pokes sterk-internal DOM
// (`.ace_scroller`, `.ace_line`, `window.__sterk`, `getCellMetrics`, etc.).
exports.sterkOnly = (test, testInfo) => {
  const renderer = testInfo.project.use && testInfo.project.use.renderer;
  test.skip(renderer !== "sterk", "sterk-specific renderer assertion");
};
