// ── Touch gesture recognizer ────────────────────────────────────────
// State machine that classifies touch input into gestures.
// Emits callbacks — no DOM manipulation, no xterm dependency.
//
// States: IDLE → TAP → SCROLL | HSWIPE | LONGPRESS
//         IDLE → TWO → PINCH | TWOPULL
//
// Usage:
//   const gestures = createGestureRecognizer(overlay, callbacks)
//   gestures.destroy()  // cleanup

import { createScrollPhysics } from './scroll.js';

const TAP_PX = 8;
const TAP_MS = 300;
const DTAP_MS = 400;
const LONGPRESS_MS = 600;
const LONGPRESS_MOVE_PX = 12;
const FLICK_H_PX = 50;
const FLICK_H_VEL = 0.3;    // px/ms
const PINCH_SCALE_THRESHOLD = 0.08;

// callbacks: { onScroll(dy), onFling(), onTap(x,y), onDoubleTap(x,y),
//              onHSwipe(direction), onPinch(scale, startFontSize),
//              onTwoPullMove(pull, vh), onTwoPullEnd(pull, vh),
//              onLongPress(), onReconnect() }
export function createGestureRecognizer(overlay, callbacks) {
  const physics = createScrollPhysics(callbacks.onScroll);

  let state = 'IDLE';
  let startX, startY, startTime;
  let lastY;
  let lastTapTime = 0;
  let longPressTimer = null;

  // Two-finger state
  let pinchStartDist = 0;
  let pinchStartFontSize = 0;
  let twoStartY = 0;

  function clearLongPress() {
    if (longPressTimer !== null) { clearTimeout(longPressTimer); longPressTimer = null; }
  }

  function transition(newState) {
    state = newState;
  }

  function onTouchStart(e) {
    callbacks.onReconnect?.();
    physics.stopMomentum();

    // Two-finger start
    if (e.touches.length === 2) {
      clearLongPress();
      const dx = e.touches[0].pageX - e.touches[1].pageX;
      const dy = e.touches[0].pageY - e.touches[1].pageY;
      pinchStartDist = Math.hypot(dx, dy);
      pinchStartFontSize = callbacks.getFontSize?.() || 14;
      twoStartY = (e.touches[0].pageY + e.touches[1].pageY) / 2;
      transition('TWO');
      return;
    }

    if (e.touches.length !== 1) { transition('IDLE'); clearLongPress(); return; }

    const t = e.touches[0];
    startX = t.pageX;
    startY = t.pageY;
    lastY = t.pageY;
    startTime = performance.now();
    transition('TAP');
    physics.reset();
    physics.addSample(t.pageY, startTime);

    // Start long-press timer
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      if (state === 'TAP') {
        transition('IDLE');
        if (navigator.vibrate) navigator.vibrate(30);
        callbacks.onLongPress?.();
      }
    }, LONGPRESS_MS);
  }

  function onTouchMove(e) {
    e.preventDefault();

    // Two-finger move
    if (e.touches.length === 2 && (state === 'TWO' || state === 'PINCH' || state === 'TWOPULL')) {
      const dx = e.touches[0].pageX - e.touches[1].pageX;
      const dy = e.touches[0].pageY - e.touches[1].pageY;
      const dist = Math.hypot(dx, dy);
      const midY = (e.touches[0].pageY + e.touches[1].pageY) / 2;
      const pull = midY - twoStartY;
      const scale = pinchStartDist > 0 ? dist / pinchStartDist : 1;

      if (state === 'TWO') {
        const scaleAmount = Math.abs(scale - 1.0);
        const deadzone = window.innerHeight * 0.03;
        if (scaleAmount < PINCH_SCALE_THRESHOLD && Math.abs(pull) < deadzone) return;
        transition(scaleAmount >= (pinchStartDist > 0 ? Math.abs(pull) / pinchStartDist : 0) ? 'PINCH' : 'TWOPULL');
      }

      if (state === 'PINCH') {
        callbacks.onPinch?.(scale, pinchStartFontSize);
      }
      if (state === 'TWOPULL') {
        callbacks.onTwoPullMove?.(pull, window.innerHeight);
      }
      return;
    }

    // Single-finger — ignore ghost events after two-finger
    if (e.touches.length !== 1 || state === 'TWO' || state === 'PINCH' || state === 'TWOPULL') return;

    const y = e.touches[0].pageY;
    const x = e.touches[0].pageX;
    const now = performance.now();
    physics.addSample(y, now);

    if (state === 'TAP') {
      const adx = Math.abs(x - startX);
      const ady = Math.abs(y - startY);
      if (ady > TAP_PX && ady >= adx) {
        clearLongPress();
        transition('SCROLL');
      } else if (adx > TAP_PX && adx > ady) {
        clearLongPress();
        transition('HSWIPE');
      } else if (adx > LONGPRESS_MOVE_PX || ady > LONGPRESS_MOVE_PX) {
        clearLongPress();
      }
      return;
    }

    if (state === 'SCROLL') {
      physics.drag(lastY, y);
      lastY = y;
    }
  }

  function onTouchEnd(e) {
    clearLongPress();

    if (state === 'TWO' || state === 'PINCH') {
      transition('IDLE');
      return;
    }

    if (state === 'TWOPULL') {
      const endY = e.changedTouches[0]?.pageY ?? twoStartY;
      callbacks.onTwoPullEnd?.(endY - twoStartY, window.innerHeight);
      transition('IDLE');
      return;
    }

    if (state === 'TAP' && (performance.now() - startTime) < TAP_MS) {
      const now = performance.now();
      if (now - lastTapTime < DTAP_MS) {
        callbacks.onDoubleTap?.(startX, startY);
        lastTapTime = 0;
      } else {
        callbacks.onTap?.(startX, startY);
        lastTapTime = now;
      }
    } else if (state === 'SCROLL') {
      physics.fling();
    } else if (state === 'HSWIPE') {
      const endX = e.changedTouches[0]?.pageX ?? startX;
      const dx = endX - startX;
      const dt = performance.now() - startTime;
      const vel = Math.abs(dx) / dt;
      if (Math.abs(dx) > FLICK_H_PX || vel > FLICK_H_VEL) {
        callbacks.onHSwipe?.(dx < 0 ? 'next' : 'prev');
      }
    }

    transition('IDLE');
  }

  function onTouchCancel() {
    clearLongPress();
    physics.stopMomentum();
    transition('IDLE');
  }

  overlay.addEventListener('touchstart', onTouchStart, { passive: false });
  overlay.addEventListener('touchmove', onTouchMove, { passive: false });
  overlay.addEventListener('touchend', onTouchEnd, { passive: false });
  overlay.addEventListener('touchcancel', onTouchCancel, { passive: false });

  return {
    destroy() {
      overlay.removeEventListener('touchstart', onTouchStart);
      overlay.removeEventListener('touchmove', onTouchMove);
      overlay.removeEventListener('touchend', onTouchEnd);
      overlay.removeEventListener('touchcancel', onTouchCancel);
      physics.stopMomentum();
      clearLongPress();
    }
  };
}
