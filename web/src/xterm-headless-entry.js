// Headless xterm.js entry point for mobux: the parser and buffer behind the
// engine's text buffer (web/static/terminal-buffer.js). No DOM, no renderer.
import { Terminal } from '@xterm/headless';

window.XtermHeadless = { Terminal };
