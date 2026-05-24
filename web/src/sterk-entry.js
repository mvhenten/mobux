// Sterk terminal emulator entry point for mobux
//
// Bundles @kattebak/sterk (which includes ace-builds as a dependency) into
// a single IIFE for the static site. Pins the constructor to `window.Sterk`
// so terminal-core.js (loaded as an ES module) can import it.
//
// Sterk's API:
// - `createTerminal(options)` → Terminal instance
// - `term.open(container)` → mount to DOM
// - `term.write(data)` → feed VT bytes
// - `term.resize(cols, rows)` → resize terminal
// - `term.onData(cb)` → outbound input
// - `term.onWriteParsed(cb)` → "wrote N bytes" notifications
// - `term.parser.registerOscHandler(133, handler)` → OSC 133 chains
// - `term.buffer.active.cursorX/cursorY/baseY` → buffer access
// - `term.getCellMetrics()` → {width, height} after open()
// - `term.setFont(id)` → swap to a bundled monospace font at runtime
// - `term.dispose()` → cleanup

import { createTerminal, BUILTIN_FONTS, DEFAULT_FONT_ID } from '@kattebak/sterk';

// Pre-register Ace themes used by mobux so `editor.setTheme('ace/theme/X')`
// finds them in the in-memory module registry instead of trying to fetch
// `theme-X.js` over HTTP (which 404s in our bundled deployment and was
// the silent regression that broke real-phone rendering — see PR #71).
// These imports are side-effecting: each theme calls `ace.define(...)`
// at load time. The list must match `THEMES[*].aceTheme` in themes.js.
import 'ace-builds/src-noconflict/theme-tomorrow_night';
import 'ace-builds/src-noconflict/theme-gruvbox';
import 'ace-builds/src-noconflict/theme-nord_dark';
import 'ace-builds/src-noconflict/theme-solarized_dark';

// Override sterk's `BUILTIN_FONTS[*].url` to point at a stable public path
// served by mobux. Why: sterk's source uses
// `new URL('../../assets/fonts/X.woff2', import.meta.url)`, which esbuild
// only rewrites under bundlers that surface `import.meta.url` — IIFE
// output emits `import.meta` as an empty object, so the original URLs
// would resolve to `undefined/.../X.woff2` and 404. web/build.js copies
// the woff2 files to `/static/vendor/fonts/`; the entry script rewrites
// the URLs to match. This MUST stay in sync with build.js's copy target.
//
// BUILTIN_FONTS is frozen by sterk; we rebuild it as a new object that
// shadows the export from this module's vantage point. The original
// `setFont` reads URLs through the frozen map though, so we mutate the
// `url` property on each entry — `Object.freeze` is shallow.
const FONT_BASE = '/static/vendor/fonts';
const FONT_FILES = {
  'jetbrains-mono': 'JetBrainsMono-Regular.woff2',
  'ibm-plex-mono': 'IBMPlexMono-Regular.woff2',
  'cascadia-mono': 'CascadiaMono-Regular.woff2',
  'fira-mono': 'FiraMono-Regular.woff2',
  'source-code-pro': 'SourceCodePro-Regular.woff2',
};
for (const [id, font] of Object.entries(BUILTIN_FONTS)) {
  const file = FONT_FILES[id];
  if (file) font.url = `${FONT_BASE}/${file}`;
}

// Pin to window so terminal-core.js can reach it from the classic script
window.Sterk = { createTerminal, BUILTIN_FONTS, DEFAULT_FONT_ID };
