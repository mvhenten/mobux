// ReaderView — phone-friendly view of the terminal buffer.
//
// Reads xterm.js's already-parsed buffer, runs it through the
// streaming tokenizer to extract semantic blocks (prompt, code, text,
// rule, header, blank) with per-run colour, and renders each block
// with its own DOM/CSS styling. Colours are preserved.

import { tokenize } from './term-tokenizer.js';

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
    this._writeSub = null;
  }

  mount() {
    if (this.mounted) return;
    this.mounted = true;
    this.host.classList.remove('hidden');
    if (this.overlay) this.overlay.classList.add('hidden');
    this.core.addEventListener('data', this._onData);
    this.core.addEventListener('history', this._onHistory);
    this._writeSub = this.core.term.onWriteParsed(() => this._scheduleRender());
    this._render();
  }

  unmount() {
    if (!this.mounted) return;
    this.mounted = false;
    this.host.classList.add('hidden');
    if (this.overlay) this.overlay.classList.remove('hidden');
    this.core.removeEventListener('data', this._onData);
    this.core.removeEventListener('history', this._onHistory);
    if (this._writeSub) { this._writeSub.dispose(); this._writeSub = null; }
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
    const cols = this.core.term.cols;
    const stickToBottom =
      this.host.scrollHeight - this.host.scrollTop - this.host.clientHeight
        < STICK_TO_BOTTOM_PX;

    const blocks = tokenize(buffer, cols);
    const frag = document.createDocumentFragment();
    for (const block of blocks) frag.appendChild(renderBlock(block));
    this.host.replaceChildren(frag);

    if (stickToBottom) this.host.scrollTop = this.host.scrollHeight;
  }
}

// ── Block rendering ────────────────────────────────────────────────
function renderBlock(block) {
  switch (block.type) {
    case 'blank':  return makeEl('div', 'rb rb-blank', '\u00a0');
    case 'rule':   return makeEl('hr',  'rb rb-rule');
    case 'header': return renderInlineBlock('rb rb-header', block.runs);
    case 'prompt': return renderInlineBlock('rb rb-prompt', block.runs);
    case 'text':   return renderTextBlock(block);
    case 'code':   return renderCodeBlock(block);
    default:       return makeEl('div', 'rb', block.text || '');
  }
}

function renderInlineBlock(className, runs) {
  const el = document.createElement('div');
  el.className = className;
  appendRuns(el, runs);
  return el;
}

function renderTextBlock(block) {
  const el = document.createElement('div');
  el.className = 'rb rb-text';
  for (const line of block.lines) {
    const lineEl = document.createElement('div');
    lineEl.className = 'rb-line';
    appendRuns(lineEl, line.runs);
    el.appendChild(lineEl);
  }
  return el;
}

function renderCodeBlock(block) {
  const wrap = document.createElement('div');
  wrap.className = 'rb rb-code';
  for (const line of block.lines) {
    const lineEl = document.createElement('div');
    lineEl.className = 'rb-codeline';
    appendRuns(lineEl, line.runs);
    wrap.appendChild(lineEl);
  }
  return wrap;
}

function appendRuns(parent, runs) {
  if (!runs || runs.length === 0) {
    parent.appendChild(document.createTextNode('\u00a0'));
    return;
  }
  for (const run of runs) {
    if (!run.text) continue;
    const span = document.createElement('span');
    span.textContent = run.text;
    applyAttrs(span, run.attrs);
    parent.appendChild(span);
  }
}

function applyAttrs(el, a) {
  if (!a) return;
  if (a.fg) el.style.color = a.fg;
  if (a.bg) {
    // Render backgrounded runs as a contiguous chip: small padding,
    // rounded, with a 1px border one shade lighter than the fill so
    // adjacent same-bg runs across glyphs read as one block instead
    // of a tight per-glyph highlight.
    el.style.background = a.bg;
    el.style.padding = '0 3px';
    el.style.borderRadius = '3px';
    el.style.border = `1px solid color-mix(in srgb, ${a.bg} 78%, white 22%)`;
    el.classList.add('rb-chip');
  }
  if (a.bold) el.style.fontWeight = '600';
  if (a.italic) el.style.fontStyle = 'italic';
  if (a.underline) el.style.textDecoration = 'underline';
  if (a.dim) el.style.opacity = '0.6';
  if (a.inverse) {
    const fg = el.style.color || 'currentColor';
    const bg = el.style.background || 'transparent';
    el.style.color = bg;
    el.style.background = fg;
  }
}

function makeEl(tag, className, text) {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
