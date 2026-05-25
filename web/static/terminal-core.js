// TerminalCore facade — picks the backend at construction time based on
// the page-level boot script's `window.__mobuxRenderer` choice.
//
// Two backends ship in mobux:
//
//   - `xterm`  — stable default. Wraps @xterm/xterm. See terminal-core-xterm.js.
//   - `sterk`  — experimental. Wraps @kattebak/sterk (libterm + Ace).
//                See terminal-core-sterk.js.
//
// The user toggles between them on the /settings page (key:
// `mobux:renderer`, persisted in localStorage). The choice is consumed
// by the inline boot script in `render_terminal_page()` which:
//   1. Reads `localStorage.getItem('mobux:renderer')` (default 'xterm').
//   2. Sets `window.__mobuxRenderer` to the resolved value.
//   3. document.write()s the matching `<script>` (xterm.bundle.js or
//      sterk.bundle.js) BEFORE this module loads — so `window.Terminal`
//      or `window.Sterk` is guaranteed to be present when this module's
//      `new TerminalCore({...})` call instantiates the chosen backend.
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

function resolveRenderer() {
  const r = (typeof window !== 'undefined' && window.__mobuxRenderer) || 'xterm';
  return (r === 'sterk') ? 'sterk' : 'xterm';
}

export class TerminalCore {
  constructor(opts) {
    const renderer = resolveRenderer();
    const Impl = renderer === 'sterk' ? TerminalCoreSterk : TerminalCoreXterm;
    return new Impl(opts);
  }
}
