// Paints the display at most once per screen refresh, so one app redraw that
// tmux relays as several WebSocket frames is not painted half-done several
// times.
//
// While the screen is inside a synchronized update (DECSET 2026) nothing is
// painted until it ends. SYNC_HOLD_MS caps the hold so a lost `?2026l` costs
// one short hitch rather than a frozen display: an update wraps one redraw,
// which tmux writes in one burst, so its end lands within a frame or two even
// over a phone link. xterm's own 1000 ms cap would read as a hang on a phone.
//
// requestAnimationFrame does not run in a hidden tab; the timeout keeps the
// promises that wait on a paint (history syncs, clear) moving there.
const SYNC_HOLD_MS = 200;
const HIDDEN_FALLBACK_MS = 100;

export function createPaintScheduler(buffer, paint) {
  let waiting = null;
  let frame = null;
  let fallback = null;
  let holdTimer = null;
  let disposed = false;

  function run() {
    cancelAnimationFrame(frame);
    clearTimeout(fallback);
    frame = null;
    fallback = null;
    if (!waiting) return;
    const held = buffer.synchronizedFor();
    if (!disposed && held !== null && held < SYNC_HOLD_MS) {
      holdTimer = setTimeout(arm, SYNC_HOLD_MS - held);
      return;
    }
    const { resolve } = waiting;
    waiting = null;
    resolve(disposed ? undefined : paint());
  }

  function arm() {
    clearTimeout(holdTimer);
    holdTimer = null;
    if (frame !== null) return;
    frame = requestAnimationFrame(run);
    fallback = setTimeout(run, HIDDEN_FALLBACK_MS);
  }

  return {
    // Resolves with the paint's result once the display shows the buffer as
    // it is now.
    request() {
      if (disposed) return Promise.resolve();
      if (!waiting) {
        let resolve;
        const promise = new Promise((r) => (resolve = r));
        waiting = { promise, resolve };
      }
      arm();
      return waiting.promise;
    },
    // The paint that is due, or null.
    pending() {
      return waiting?.promise ?? null;
    },
    dispose() {
      disposed = true;
      clearTimeout(holdTimer);
      run();
    },
  };
}
