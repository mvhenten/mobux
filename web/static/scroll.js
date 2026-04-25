// ── Scroll physics engine ───────────────────────────────────────────
// Pure computation: no DOM dependencies. Feed it touch samples,
// get back scroll deltas via a callback.

export function createScrollPhysics(onScroll) {
  const AMP = 2.5;
  const VEL_WINDOW = 100;    // ms of samples for velocity averaging
  const MIN_VEL = 0.15;      // px/ms threshold for momentum
  const MAX_MOM_MS = 2500;
  const IOS_DECAY = 0.998;   // per-ms (UIScrollViewDecelerationRateNormal)
  const DECEL = 0.0015;      // px/ms² (BetterScroll)

  let samples = [];
  let momId = null;

  function reset() {
    samples = [];
    stopMomentum();
  }

  function addSample(y, t) {
    samples.push({ y, t });
    // trim old samples
    const cutoff = t - VEL_WINDOW * 2;
    while (samples.length > 2 && samples[0].t < cutoff) samples.shift();
  }

  function drag(prevY, currY) {
    onScroll((prevY - currY) * AMP);
  }

  function calcVelocity() {
    if (samples.length < 2) return 0;
    const last = samples[samples.length - 1];
    const cutoff = last.t - VEL_WINDOW;
    let i = samples.length - 1;
    while (i > 0 && samples[i - 1].t >= cutoff) i--;
    const first = samples[i];
    const dt = last.t - first.t;
    if (dt < 10) return 0;
    return (first.y - last.y) / dt;
  }

  function stopMomentum() {
    if (momId !== null) { cancelAnimationFrame(momId); momId = null; }
  }

  function fling() {
    const v0 = calcVelocity();
    if (Math.abs(v0) < MIN_VEL) return;
    const speed = Math.abs(v0);
    const dir = v0 > 0 ? 1 : -1;
    const totalMs = Math.min(MAX_MOM_MS, (speed * 2) / DECEL);
    const t0 = performance.now();
    let prevT = t0;

    function tick(now) {
      const elapsed = now - t0;
      if (elapsed >= totalMs) { momId = null; return; }
      const dt = now - prevT;
      prevT = now;
      const vNow = speed * Math.pow(IOS_DECAY, elapsed);
      if (vNow < 0.03) { momId = null; return; }
      onScroll(vNow * dt * dir * AMP);
      momId = requestAnimationFrame(tick);
    }
    momId = requestAnimationFrame(tick);
  }

  return { reset, addSample, drag, fling, stopMomentum };
}
