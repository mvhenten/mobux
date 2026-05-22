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

// Pin to window so terminal-core.js can reach it from the classic script
window.Sterk = { createTerminal };
