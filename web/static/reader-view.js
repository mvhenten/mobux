// ReaderView — phone-friendly view of the terminal buffer with
// fully synthetic scrolling.
//
// Native overflow scrolling on mobile WebViews has been a steady
// source of pain (engaged-only-after-fresh-touch on iOS Safari,
// occasional locked-state on Android Chrome with large scrollbacks,
// momentum quirks during reflow). Rather than fight the platform
// we render into an inner box and translate it ourselves, driven by
// the same gesture recogniser + physics engine that powers the
// xterm view. This sidesteps every native-scroll edge case at the
// cost of native scrollbars and overscroll bounce, both of which
// we don't need here.
//
// Public surface used by terminal.js:
//   mount(), unmount()
//   scrollBy(dy)      — feed by gesture recogniser onScroll
//   stickToBottom()   — caller can pin to bottom (e.g. on tap)

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
    this._scrollY = 0;
    this._maxScroll = 0;
    this._inner = null;
    this._onData = () => this._scheduleRender();
    this._onHistory = () => this._scheduleRender();
    this._writeSub = null;
  }

  mount() {
    if (this.mounted) return;
    this.mounted = true;
    this.host.classList.remove('hidden');
    if (this.overlay) this.overlay.classList.add('hidden');

    // Build the inner content layer once; subsequent renders just
    // replace its children.
    this._inner = document.createElement('div');
    this._inner.className = 'reader-inner';
    this.host.replaceChildren(this._inner);

    this._scrollY = 0;
    this._maxScroll = 0;

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
    this._renderTimer = null;
  }

  // dy > 0 means content moves up (reveal lines below).
  // dy < 0 means content moves down (reveal lines above).
  // Mirrors the xterm scroll convention so we can reuse the same
  // gesture recogniser + physics.
  scrollBy(dy) {
    if (!this.mounted) return;
    this._setScroll(this._scrollY + dy);
  }

  stickToBottom() {
    if (!this.mounted) return;
    this._setScroll(this._maxScroll);
  }

  _setScroll(y) {
    const clamped = Math.max(0, Math.min(this._maxScroll, y));
    if (clamped === this._scrollY) return;
    this._scrollY = clamped;
    this._applyTransform();
  }

  _applyTransform() {
    if (!this._inner) return;
    this._inner.style.transform = `translate3d(0, ${-this._scrollY}px, 0)`;
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
    if (!this._inner) return;
    const buffer = this.core.getActiveBuffer();
    const cols = this.core.term.cols;

    // Were we pinned to bottom before this render? If so, stay pinned
    // after re-flow; otherwise preserve the absolute scroll offset.
    const wasAtBottom = this._scrollY >= this._maxScroll - STICK_TO_BOTTOM_PX;

    const blocks = tokenize(buffer, cols);
    const frag = document.createDocumentFragment();
    for (const block of blocks) frag.appendChild(renderBlock(block));
    this._inner.replaceChildren(frag);

    // Re-measure after layout.
    const innerH = this._inner.scrollHeight;
    const hostH = this.host.clientHeight;
    this._maxScroll = Math.max(0, innerH - hostH);

    if (wasAtBottom) this._scrollY = this._maxScroll;
    else this._scrollY = Math.min(this._scrollY, this._maxScroll);
    this._applyTransform();
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
  appendLinesWithBubbles(el, block.lines, 'rb-line');
  return el;
}

function renderCodeBlock(block) {
  const wrap = document.createElement('div');
  wrap.className = 'rb rb-code';
  appendLinesWithBubbles(wrap, block.lines, 'rb-codeline');
  return wrap;
}

function appendLinesWithBubbles(parent, lines, lineClass) {
  let i = 0;
  while (i < lines.length) {
    const bg = lines[i].bubbleBg;
    if (bg) {
      const bubble = document.createElement('div');
      bubble.className = 'rb-bubble';
      bubble.style.background = bg;
      bubble.style.borderColor = `color-mix(in srgb, ${bg} 78%, white 22%)`;
      while (i < lines.length && lines[i].bubbleBg === bg) {
        const lineEl = document.createElement('div');
        lineEl.className = `${lineClass} rb-bubble-line`;
        appendRuns(lineEl, lines[i].runs, { skipBg: true });
        bubble.appendChild(lineEl);
        i++;
      }
      parent.appendChild(bubble);
    } else {
      const lineEl = document.createElement('div');
      lineEl.className = lineClass;
      appendRuns(lineEl, lines[i].runs);
      parent.appendChild(lineEl);
      i++;
    }
  }
}

function appendRuns(parent, runs, opts) {
  const skipBg = opts && opts.skipBg;
  if (!runs || runs.length === 0) {
    parent.appendChild(document.createTextNode('\u00a0'));
    return;
  }
  for (const run of runs) {
    if (!run.text) continue;
    const span = document.createElement('span');
    span.textContent = run.text;
    applyAttrs(span, run.attrs, skipBg);
    parent.appendChild(span);
  }
}

function applyAttrs(el, a, skipBg) {
  if (!a) return;
  if (a.fg) el.style.color = a.fg;
  if (a.bg && !skipBg) {
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
  if (a.inverse && !skipBg) {
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
