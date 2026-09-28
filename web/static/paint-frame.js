const SYNC_HOLD_MS = 200;
const HIDDEN_FALLBACK_MS = 100;

export function createPaintScheduler(buffer, paint) {
  let waiting = null;
  let paintedThisFrame = false;
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
    if (waiting) run();
  }

  function awaitFrame() {
    if (frame !== null) return;
    frame = requestAnimationFrame(nextFrame);
    fallback = setTimeout(nextFrame, HIDDEN_FALLBACK_MS);
  }

  function run() {
    clearTimeout(holdTimer);
    holdTimer = null;
    if (!waiting) return;
    if (paintedThisFrame && !disposed) {
      awaitFrame();
      return;
    }
    const held = buffer.synchronizedFor();
    if (!disposed && held !== null && held < holdMs) {
      holdTimer = setTimeout(run, holdMs - held);
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
      run();
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
      run();
    },
  };
}
