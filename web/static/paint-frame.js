const SYNC_HOLD_MS = 200;
const HIDDEN_FALLBACK_MS = 100;

export function createPaintScheduler(buffer, paint) {
  let waiting = null;
  let paintedThisFrame = false;
  let requestedThisFrame = false;
  let requestedLastFrame = false;
  let frame = null;
  let fallback = null;
  let holdTimer = null;
  let holdMs = SYNC_HOLD_MS;
  let disposed = false;

  function nextFrame() {
    cancelAnimationFrame(frame);
    clearTimeout(fallback);
    frame = null;
    fallback = null;
    paintedThisFrame = false;
    requestedLastFrame = requestedThisFrame;
    requestedThisFrame = false;
    if (requestedLastFrame) awaitFrame();
    if (waiting) run(true);
  }

  function awaitFrame() {
    if (frame !== null) return;
    frame = requestAnimationFrame(nextFrame);
    fallback = setTimeout(nextFrame, HIDDEN_FALLBACK_MS);
  }

  // Outside a frame callback a paint goes out at once only when the previous
  // frame saw no chunk: a lone echo, not the first piece of a redraw.
  function run(framed) {
    clearTimeout(holdTimer);
    holdTimer = null;
    if (!waiting) return;
    const flowing = !framed && requestedLastFrame;
    if (!disposed && (paintedThisFrame || flowing)) {
      awaitFrame();
      return;
    }
    const held = buffer.synchronizedFor();
    if (!disposed && held !== null && held < holdMs) {
      holdTimer = setTimeout(() => run(true), holdMs - held);
      return;
    }
    const { resolve } = waiting;
    waiting = null;
    if (disposed) {
      resolve(undefined);
      return;
    }
    paintedThisFrame = true;
    awaitFrame();
    resolve(paint());
  }

  return {
    request() {
      if (disposed) return Promise.resolve();
      if (!waiting) {
        let resolve;
        const promise = new Promise((r) => (resolve = r));
        waiting = { promise, resolve };
      }
      const { promise } = waiting;
      requestedThisFrame = true;
      awaitFrame();
      run(false);
      return promise;
    },
    pending() {
      return waiting?.promise ?? null;
    },
    setSyncHold(ms) {
      holdMs = ms;
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      clearTimeout(fallback);
      run(true);
    },
  };
}
