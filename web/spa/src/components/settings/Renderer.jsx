import { useRef } from 'preact/hooks';
import { signal } from '@preact/signals';

// Terminal renderer picker. Ports settings-renderer.js: reads + writes
// localStorage['mobux:renderer'] ('xterm' | 'sterk', default 'xterm'). The
// terminal island reads this on boot, so a change applies only after an open
// terminal reloads — we surface that hint.

const VALID = new Set(['xterm', 'sterk']);
const DEFAULT = 'xterm';

function read() {
  try {
    const v = localStorage.getItem('mobux:renderer');
    if (VALID.has(v)) return v;
  } catch (_) {}
  return DEFAULT;
}

const renderer = signal(read());
const status = signal(null);

export function RendererCard() {
  const t = useRef(null);

  const onChange = (e) => {
    const v = VALID.has(e.target.value) ? e.target.value : DEFAULT;
    renderer.value = v;
    try {
      localStorage.setItem('mobux:renderer', v);
    } catch (_) {}
    status.value = `Saved. Reload any open terminal tab to switch to ${v}.`;
    clearTimeout(t.current);
    t.current = setTimeout(() => (status.value = null), 3000);
  };

  return (
    <section class="settings-card" id="renderer-picker">
      <h2>Terminal renderer</h2>
      <p class="settings-lede">
        The browser-side terminal emulator. <strong>xterm.js</strong> is the stable default.{' '}
        <strong>sterk</strong> is an experimental renderer (libterm + Ace) still catching up to
        xterm parity — switch back if it breaks. Per-device; reload the terminal tab after changing
        it.
      </p>
      <label class="settings-row">
        <span class="settings-label">
          <strong>Renderer</strong>
          <small>
            Stored locally as <code>mobux:renderer</code>. Per-device. Reload the terminal page after
            switching.
          </small>
        </span>
        <select class="settings-select" value={renderer.value} onChange={onChange}>
          <option value="xterm">xterm.js (stable, default)</option>
          <option value="sterk">sterk (experimental)</option>
        </select>
      </label>
      {status.value && <div class="settings-status">{status.value}</div>}
    </section>
  );
}
