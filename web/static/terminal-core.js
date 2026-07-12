// TerminalCore facade — picks the backend at construction time from the
// `renderer` option passed down by the engine factory (terminal.js
// createTerminal), which in turn gets it from the SPA host (TerminalIsland
// resolves the server-held `renderer` preference and loads the matching
// vendor bundle before constructing the engine).
//
// Two backends ship in mobux:
//
//   - `xterm`  — stable default. Wraps @xterm/xterm. See terminal-core-xterm.js.
//   - `sterk`  — experimental. Wraps @kattebak/sterk (libterm + Ace).
//                See terminal-core-sterk.js.
//
// The user toggles between them on the /settings page (the server-held
// `renderer` preference). The host loads the matching vendor bundle
// (xterm.bundle.js or sterk.bundle.js) BEFORE constructing the engine — so
// `window.Terminal` or `window.Sterk` is guaranteed to be present when
// `new TerminalCore({...})` instantiates the chosen backend.
//
// Both backend modules check for their renderer global inside the
// constructor (not at top-level), so importing both here is cheap and
// the unused one never tries to read a global that isn't there.
//
// Both backends expose the same external surface — consumers
// (terminal.js, reader-view.js, the test suite) treat them
// interchangeably. The only visible difference is the renderer DOM
// (.xterm-viewport vs .sterk-viewport).

import { TerminalCoreXterm } from './terminal-core-xterm.js';
import { TerminalCoreSterk } from './terminal-core-sterk.js';

export class TerminalCore {
  constructor(opts) {
    const Impl =
      opts && opts.renderer === 'sterk' ? TerminalCoreSterk : TerminalCoreXterm;
    return new Impl(opts);
  }
}
