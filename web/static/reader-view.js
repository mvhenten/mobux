// ReaderView — phone-friendly view of the terminal buffer with a
// fully synthetic scroller.
//
// Why synthetic: native `overflow: auto` on mobile WebViews has been
// a steady source of grief — engaged-only-after-fresh-touch on iOS
// Safari, occasional locked state on Android Chrome with large
// scrollbacks, momentum quirks during reflow. We render into an
// inner box and translate it ourselves, driven by the same gesture
// recogniser + physics engine that powers the xterm view. No native
// scrollbars, no overscroll bounce — neither of which we want here.
//
// ── Coordinate system ─────────────────────────────────────────────
// `_scrollY` is positive-down, in CSS pixels.
//   _scrollY = 0          → top of content visible
//   _scrollY = _maxScroll → bottom of content visible
// The inner box is translated by `translate3d(0, -_scrollY, 0)`.
// `scrollBy(dy)` adds `dy` to `_scrollY`. This matches xterm's
// convention so finger-DOWN reveals content above (dy < 0 from the
// gesture recogniser), preserving muscle memory between views.
//
// ── Public surface (used by terminal.js) ──────────────────────────
//   mount(), unmount()
//   scrollBy(dy)        — fed by gesture recogniser onScroll
//   stickToBottom()     — pin to latest output
//   scrollY, maxScroll, innerHeight (read-only getters for tests)

import { tokenize } from './term-tokenizer.js';

const RENDER_THROTTLE_MS = 50;
const STICK_TO_BOTTOM_PX = 80;

export class ReaderView {
  constructor({ host, core, overlay }) {
    this.host = host;
    this.core = core;
    this.overlay = overlay;
    this.mounted = false;

    /** @type {HTMLDivElement|null} */
    this._inner = null;
    this._scrollY = 0;
    this._maxScroll = 0;
    // True when the viewport was within STICK_TO_BOTTOM_PX of the
    // bottom at the most recent _setScroll/_render. Drives the
    // pin-to-latest-output behaviour without re-deriving from the
    // (about-to-change) maxScroll on every render.
    this._atBottom = true;

    this._renderTimer = null;
    this._writeSub = null;
    this._resizeObserver = null;
    this._onWindowResize = () => this._handleResize();
    this._onWriteParsed = () => this._scheduleRender();
  }

  get scrollY() { return this._scrollY; }
  get maxScroll() { return this._maxScroll; }
  get innerHeight() { return this._inner ? this._inner.scrollHeight : 0; }

  mount() {
    if (this.mounted) return;
    this.mounted = true;
    this.host.classList.remove('hidden');
    if (this.overlay) this.overlay.classList.add('hidden');

    this._inner = document.createElement('div');
    this._inner.className = 'reader-inner';
    this.host.replaceChildren(this._inner);

    this._scrollY = 0;
    this._maxScroll = 0;
    this._atBottom = true;

    // onWriteParsed is the single source of truth for "buffer
    // changed". xterm fires it after every write — history reload,
    // WS data, and synthetic test injects all flow through here.
    this._writeSub = this.core.term.onWriteParsed(this._onWriteParsed);

    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this._handleResize());
      this._resizeObserver.observe(this.host);
    }
    window.addEventListener('resize', this._onWindowResize);

    this._render();
  }

  unmount() {
    if (!this.mounted) return;
    this.mounted = false;
    this.host.classList.add('hidden');
    if (this.overlay) this.overlay.classList.remove('hidden');

    if (this._writeSub) { this._writeSub.dispose(); this._writeSub = null; }
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
    window.removeEventListener('resize', this._onWindowResize);
    if (this._renderTimer !== null) {
      clearTimeout(this._renderTimer);
      this._renderTimer = null;
    }
    this._inner = null;
  }

  scrollBy(dy) {
    if (!this.mounted) return;
    this._setScroll(this._scrollY + dy);
  }

  stickToBottom() {
    if (!this.mounted) return;
    this._atBottom = true;
    this._setScroll(this._maxScroll);
  }

  _setScroll(y) {
    const clamped = Math.max(0, Math.min(this._maxScroll, y));
    this._atBottom = clamped >= this._maxScroll - STICK_TO_BOTTOM_PX;
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
    if (this._renderTimer !== null) return;
    this._renderTimer = setTimeout(() => {
      this._renderTimer = null;
      this._render();
    }, RENDER_THROTTLE_MS);
  }

  _handleResize() {
    if (!this.mounted || !this._inner) return;
    // Host height changed (orientation, virtual keyboard, parent
    // layout). Re-measure and re-pin if we were at the bottom.
    this._recomputeBounds();
    if (this._atBottom) this._scrollY = this._maxScroll;
    else this._scrollY = Math.min(this._scrollY, this._maxScroll);
    this._applyTransform();
  }

  _recomputeBounds() {
    if (!this._inner) { this._maxScroll = 0; return; }
    const innerH = this._inner.scrollHeight;
    const hostH = this.host.clientHeight;
    this._maxScroll = Math.max(0, innerH - hostH);
  }

  _render() {
    if (!this._inner) return;
    const buffer = this.core.getActiveBuffer();
    const cols = this.core.term.cols;

    // Snapshot stickiness BEFORE the DOM swap so a re-flow that
    // grows the content doesn't accidentally yank the user away
    // from the bottom (or strand them mid-page on growth).
    const wasAtBottom = this._atBottom;

    const blocks = tokenize(buffer, cols);
    const frag = document.createDocumentFragment();
    for (const block of blocks) frag.appendChild(renderBlock(block));
    this._inner.replaceChildren(frag);

    this._recomputeBounds();
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
      continue;
    }
    const lineEl = document.createElement('div');
    lineEl.className = lineClass;
    appendRuns(lineEl, lines[i].runs);
    parent.appendChild(lineEl);
    i++;
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
