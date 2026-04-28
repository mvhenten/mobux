import { Terminal } from '@xterm/xterm';
import { WebLinksAddon } from '@xterm/addon-web-links';

// Re-export for use by terminal.js
window.Terminal = Terminal;
window.WebLinksAddon = { WebLinksAddon };
