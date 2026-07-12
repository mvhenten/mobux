import { useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import { getPref, setPref } from "../../lib/prefs.js";

// Terminal renderer picker. Reads + writes the server-held `renderer`
// preference ('xterm' | 'sterk', default 'xterm'), global across devices. The
// terminal island reads this on boot, so a change applies only after an open
// terminal reloads — we surface that hint.

const VALID = new Set(["xterm", "sterk"]);
const DEFAULT = "xterm";

function read() {
  const v = getPref("renderer");
  return VALID.has(v) ? v : DEFAULT;
}

const renderer = signal(read());
const status = signal(null);

export function RendererCard() {
  const t = useRef(null);

  const onChange = (e) => {
    const v = VALID.has(e.target.value) ? e.target.value : DEFAULT;
    renderer.value = v;
    setPref("renderer", v);
    status.value = `Saved. Reload any open terminal tab to switch to ${v}.`;
    clearTimeout(t.current);
    t.current = setTimeout(() => (status.value = null), 3000);
  };

  return (
    <section class="settings-group" id="renderer-picker">
      <h2>Terminal renderer</h2>
      <p class="settings-lede">
        The browser-side terminal emulator. <strong>xterm.js</strong> is the
        stable default. <strong>sterk</strong> is an experimental renderer
        (libterm + Ace) still catching up to xterm parity — switch back if it
        breaks. Reload the terminal tab after changing it.
      </p>
      <label class="settings-row">
        <span class="settings-label">
          <strong>Renderer</strong>
          <small>
            Synced to this mobux server. Reload the terminal page after
            switching.
          </small>
        </span>
        <select
          class="settings-select"
          value={renderer.value}
          onChange={onChange}
        >
          <option value="xterm">xterm.js (stable, default)</option>
          <option value="sterk">sterk (experimental)</option>
        </select>
      </label>
      {status.value && <div class="settings-status">{status.value}</div>}
    </section>
  );
}
