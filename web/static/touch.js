// ── Touch gesture recognizer ────────────────────────────────────────
// State machine that classifies touch input into gestures.
// Emits callbacks — no DOM manipulation, no xterm dependency.
//
// States: IDLE → TAP → SCROLL | HSWIPE | LONGPRESS
//         any → RELEASED (release(): the browser owns the touch until it ends)
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
const FLICK_H_PX = 50;
const FLICK_H_VEL = 0.3;    // px/ms
const PINCH_SCALE_THRESHOLD = 0.08;

// Swipe-up-from-bottom: a discoverable "drawer" gesture for opening the
// command menu without conflicting with normal terminal scroll.
//   - Must START within the bottom EDGE_PX of the overlay viewport.
//   - Must travel SWIPE_UP_PX upward within SWIPE_UP_MS.
//   - Must be vertical-dominant (|dx| < dy/2).
// The recogniser fires it from inside the TAP state (so it pre-empts
// the SCROLL transition); started-from-the-middle vertical drags still
// scroll the terminal as before.
const SWIPE_UP_EDGE_PX = 80;
const SWIPE_UP_PX = 60;
const SWIPE_UP_MS = 400;

// callbacks: { onScroll(dy), onScrollStart(x,y), onFling(), onTap(x,y), onDoubleTap(x,y),
//              holdsTap(target), onSingleTap(target),
//              onHSwipe(direction), onPinch(scale, startFontSize),
//              onTwoPullMove(pull, vh), onTwoPullEnd(pull, vh),
//              onLongPress(), onSwipeUp(), onReconnect() }
export function createGestureRecognizer(overlay, callbacks, options = {}) {
  const { passiveScroll = false } = options;
  const physics = createScrollPhysics(callbacks.onScroll);

  let state = 'IDLE';
  let startX, startY, startTime;
  let startClientX, startClientY;
  let lastY;
  let lastTapTime = 0;
  let longPressTimer = null;
  let singleTapTimer = null;
  let startedAtBottomEdge = false;

  // Two-finger state
  let pinchStartDist = 0;
  let pinchStartFontSize = 0;
  let twoStartY = 0;

  function clearLongPress() {
    if (longPressTimer !== null) { clearTimeout(longPressTimer); longPressTimer = null; }
  }

  // A tap on a target the caller holds gets no compatibility click and waits
  // out the double-tap window before it counts as a single tap.
  function clearSingleTap() {
    if (singleTapTimer !== null) { clearTimeout(singleTapTimer); singleTapTimer = null; }
  }

  function holdTap(e) {
    if (!callbacks.holdsTap?.(e.target)) return;
    e.preventDefault();
    const target = e.target;
    singleTapTimer = setTimeout(() => {
      singleTapTimer = null;
      callbacks.onSingleTap?.(target);
    }, DTAP_MS);
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
    startClientX = t.clientX;
    startClientY = t.clientY;
    lastY = t.pageY;
    startTime = performance.now();
    // Bottom-edge bookkeeping for swipe-up. `clientY` is viewport-relative,
    // which is what we want — the overlay covers the visual viewport. Use
    // visualViewport height when available so on-screen keyboards don't
    // throw the edge calculation off.
    const vh = window.visualViewport?.height ?? window.innerHeight;
    startedAtBottomEdge = (vh - t.clientY) <= SWIPE_UP_EDGE_PX;
    transition('TAP');
    physics.reset();
    physics.addSample(t.pageY, startTime);

    if (!callbacks.onLongPress) return;
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
    if (state === 'RELEASED') return;
    // In passiveScroll mode we let native scroll handle vertical drags
    // (so e.g. ReaderView can scroll its overflow box). We still detect
    // long-press, h-swipe, and tap classification.
    if (!passiveScroll) e.preventDefault();

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

    // Swipe-up-from-bottom-edge → open command menu. Checked across
    // both TAP and SCROLL states because the first ~8-12px of upward
    // travel transitions TAP→SCROLL before we've accumulated the full
    // SWIPE_UP_PX. Bounded by elapsed time + startedAtBottomEdge so it
    // can't fire mid-gesture for a long ordinary scroll that happens
    // to start near the bottom edge.
    if (
      (state === 'TAP' || state === 'SCROLL') &&
      startedAtBottomEdge &&
      callbacks.onSwipeUp
    ) {
      const dy = y - startY;             // negative = upward
      const adx = Math.abs(x - startX);
      const ady = Math.abs(y - startY);
      const elapsed = now - startTime;
      if (
        dy < -SWIPE_UP_PX &&
        ady > adx * 2 &&
        elapsed <= SWIPE_UP_MS
      ) {
        clearLongPress();
        // Rewind any scroll deltas this gesture already pushed (we may
        // have leaked one drag frame between TAP→SCROLL transition and
        // hitting the swipe-up threshold).
        physics.stopMomentum();
        transition('IDLE');
        startedAtBottomEdge = false;
        if (navigator.vibrate) navigator.vibrate(20);
        callbacks.onSwipeUp();
        return;
      }
      // Once we've passed the time budget without crossing the swipe
      // threshold, this gesture can't be a swipe-up — disarm the flag
      // so further checks become cheap no-ops.
      if (elapsed > SWIPE_UP_MS) startedAtBottomEdge = false;
    }

    if (state === 'TAP') {
      const adx = Math.abs(x - startX);
      const ady = Math.abs(y - startY);
      if (ady > TAP_PX && ady >= adx) {
        clearLongPress();
        // In passive mode we hand vertical scroll to the browser and
        // stop classifying — no momentum/fling injection.
        transition(passiveScroll ? 'IDLE' : 'SCROLL');
        if (!passiveScroll) callbacks.onScrollStart?.(startClientX, startClientY);
      } else if (adx > TAP_PX && adx > ady) {
        clearLongPress();
        transition('HSWIPE');
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

    if (state === 'RELEASED') {
      if (e.touches.length === 0) transition('IDLE');
      return;
    }

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
      if (now - lastTapTime < DTAP_MS && callbacks.onDoubleTap) {
        // The double-tap is consumed here: no compatibility mouse events,
        // so the click cannot land on whatever the callback just revealed
        // under the finger.
        e.preventDefault();
        clearSingleTap();
        callbacks.onDoubleTap(startX, startY);
        lastTapTime = 0;
      } else {
        callbacks.onTap?.(startX, startY);
        lastTapTime = now;
        clearSingleTap();
        holdTap(e);
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
  overlay.addEventListener('touchmove', onTouchMove, { passive: passiveScroll });
  overlay.addEventListener('touchend', onTouchEnd, { passive: false });
  overlay.addEventListener('touchcancel', onTouchCancel, { passive: false });

  return {
    // Leaves the touch in progress to the browser: no gesture, no
    // preventDefault, until every finger lifts.
    release() {
      clearLongPress();
      physics.stopMomentum();
      transition('RELEASED');
    },
    stopMomentum() {
      physics.stopMomentum();
    },
    destroy() {
      overlay.removeEventListener('touchstart', onTouchStart);
      overlay.removeEventListener('touchmove', onTouchMove);
      overlay.removeEventListener('touchend', onTouchEnd);
      overlay.removeEventListener('touchcancel', onTouchCancel);
      physics.stopMomentum();
      clearLongPress();
      clearSingleTap();
    }
  };
}
