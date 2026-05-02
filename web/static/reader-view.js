// ReaderView — phone-friendly view of the terminal buffer.
//
// Reads xterm.js's already-parsed buffer (so all cursor moves, redraws,
// colors etc. are resolved) and renders each row as a wrapped block of
// proportional text with native browser scroll. No fixed grid, no
// monospace requirement, copy-paste / native text selection work.
//
// v1 is intentionally dumb: full-buffer rerender on every data event,
// debounced. No block segmentation, no chat bubbles. Those land on top.

const RENDER_DEBOUNCE_MS = 50;
const STICK_TO_BOTTOM_PX = 80;

export class ReaderView {
  constructor({ host, core, overlay }) {
    this.host = host;
    this.core = core;
    this.overlay = overlay;
    this.mounted = false;
    this._renderTimer = null;
    this._onData = () => this._scheduleRender();
    this._onHistory = () => this._scheduleRender();
  }

  mount() {
    if (this.mounted) return;
    this.mounted = true;
    this.host.classList.remove('hidden');
    if (this.overlay) this.overlay.classList.add('hidden');
    this.core.addEventListener('data', this._onData);
    this.core.addEventListener('history', this._onHistory);
    this._render();
  }

  unmount() {
    if (!this.mounted) return;
    this.mounted = false;
    this.host.classList.add('hidden');
    if (this.overlay) this.overlay.classList.remove('hidden');
    this.core.removeEventListener('data', this._onData);
    this.core.removeEventListener('history', this._onHistory);
    clearTimeout(this._renderTimer);
  }

  _scheduleRender() {
    if (!this.mounted) return;
    if (this._renderTimer) return;
    this._renderTimer = setTimeout(() => {
      this._renderTimer = null;
      this._render();
    }, RENDER_DEBOUNCE_MS);
  }

  _render() {
    const buffer = this.core.getActiveBuffer();
    const total = buffer.length;
    const stickToBottom =
      this.host.scrollHeight - this.host.scrollTop - this.host.clientHeight
        < STICK_TO_BOTTOM_PX;

    // Coalesce wrapped logical lines: xterm marks continuation rows
    // with isWrapped=true. We join them so the reader can reflow on
    // its own width.
    const lines = [];
    let current = '';
    for (let y = 0; y < total; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped) {
        current += text;
      } else {
        if (current.length > 0 || y > 0) lines.push(current);
        current = text;
      }
    }
    lines.push(current);

    const frag = document.createDocumentFragment();
    for (const text of lines) {
      const div = document.createElement('div');
      div.className = 'reader-line';
      if (text.length === 0) {
        div.classList.add('blank');
        div.textContent = '\u00a0';
      } else {
        div.textContent = text;
      }
      frag.appendChild(div);
    }
    this.host.replaceChildren(frag);

    if (stickToBottom) {
      this.host.scrollTop = this.host.scrollHeight;
    }
  }
}
