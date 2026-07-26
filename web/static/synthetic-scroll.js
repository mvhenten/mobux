// createSyntheticScroller — a scrollable viewport that translates its own
// content box instead of relying on native scrolling.
//
// Native `overflow: auto` on the target mobile WebViews has failed repeatedly
// (engaged-only-after-fresh-touch on iOS Safari, locked state on Android
// Chrome with large scrollbacks). Components render into an inner box and this
// module translates it, driven by the gesture recogniser + physics engine that
// powers the terminal view. `scrollY` is positive-down in CSS pixels:
//   scrollY = 0         → top of content visible
//   scrollY = maxScroll → bottom of content visible
// The inner box is translated by `translate3d(0, -scrollY, 0)`. `scrollBy(dy)`
// adds `dy`, matching the terminal's convention so finger-DOWN reveals content
// above (dy < 0 from the recogniser), preserving muscle memory between views.
//
// ── Factory ─────────────────────────────────────────────────────────────
//   createSyntheticScroller({ host, inner, footerEl }) → scroller handle
//     host      the clipping element whose height bounds the viewport.
//     inner     the translated content box.
//     footerEl  optional bottom-pinned element (a status bar) whose height is
//               subtracted from the viewport.
//
// The host's own size changes (orientation, virtual keyboard, parent layout)
// are observed here; the owner does not wire resize handling.
//
// Content mutation goes through `contentChanged(mutateFn)` rather than a
// separate recompute + re-pin pair: whether the viewport was following the
// bottom must be read before the DOM changes and applied after, and splitting
// that into two calls loses the ordering without failing loudly.

// A scroll counts as "at the bottom" (and so keeps following live output) only
// when it reaches the very bottom edge. Streaming keeps the viewport exactly
// there via the re-pin in contentChanged(); an explicit scroll away — even a
// little — drops the follow so the content holds position (R2). The epsilon
// only absorbs sub-pixel rounding, not a real scroll-up.
const BOTTOM_EPSILON_PX = 2;

export function createSyntheticScroller({ host, inner, footerEl = null } = {}) {
  let disposed = false;
  let scrollY = 0;
  let maxScroll = 0;
  // True when the viewport is at the bottom edge (following live output).
  // Captured at the most recent scroll/content change so the re-pin doesn't
  // re-derive it from the about-to-change maxScroll.
  let atBottom = true;

  let resizeObserver = null;
  const onWindowResize = () => handleResize();

  function applyTransform() {
    inner.style.transform = `translate3d(0, ${-scrollY}px, 0)`;
  }

  function setScroll(y) {
    const clamped = Math.max(0, Math.min(maxScroll, y));
    atBottom = clamped >= maxScroll - BOTTOM_EPSILON_PX;
    if (clamped === scrollY) return;
    scrollY = clamped;
    applyTransform();
  }

  function recomputeBounds() {
    const innerH = inner.scrollHeight;
    const footerH = footerEl ? footerEl.offsetHeight : 0;
    const hostH = host.clientHeight - footerH;
    maxScroll = Math.max(0, innerH - hostH);
  }

  function repin(wasAtBottom) {
    if (wasAtBottom) scrollY = maxScroll;
    else scrollY = Math.min(scrollY, maxScroll);
    applyTransform();
  }

  function handleResize() {
    if (disposed) return;
    // Host height changed (orientation, virtual keyboard, parent layout).
    // Re-measure and re-pin if we were at the bottom.
    recomputeBounds();
    repin(atBottom);
  }

  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => handleResize());
    resizeObserver.observe(host);
  }
  window.addEventListener("resize", onWindowResize);

  return {
    contentChanged(mutate) {
      const wasAtBottom = atBottom;
      mutate();
      recomputeBounds();
      repin(wasAtBottom);
    },
    scrollBy(dy) {
      setScroll(scrollY + dy);
    },
    stickToBottom() {
      atBottom = true;
      setScroll(maxScroll);
    },
    scrollToTop() {
      atBottom = false;
      scrollY = 0;
      applyTransform();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
      window.removeEventListener("resize", onWindowResize);
    },
    get scrollY() {
      return scrollY;
    },
    get maxScroll() {
      return maxScroll;
    },
    get atBottom() {
      return atBottom;
    },
    get innerHeight() {
      return inner.scrollHeight;
    },
  };
}
