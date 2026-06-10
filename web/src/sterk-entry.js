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
// - `term.dispose()` → cleanup

import { createTerminal } from '@kattebak/sterk';

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
import 'ace-builds/src-noconflict/theme-solarized_light';
import 'ace-builds/src-noconflict/theme-gruvbox_light_hard';
import 'ace-builds/src-noconflict/theme-github_light_default';

// Pin to window so terminal-core.js can reach it from the classic script
window.Sterk = { createTerminal };
