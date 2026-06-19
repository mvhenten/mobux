import { useEffect, useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import { apiGet, apiPutJSON } from '../../lib/api.js';

const peerPort = signal(5151);
const status = signal(null); // { msg, ok }

function flash(msg, ok) {
  status.value = { msg, ok };
}

async function save() {
  const port = Number(peerPort.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    flash('Port must be 1–65535.', false);
    return;
  }
  try {
    const r = await apiPutJSON('/api/settings/mesh', { peer_port: port });
    flash(r.ok ? 'Saved ✓' : 'Save failed.', r.ok);
  } catch (_) {
    flash('Save failed.', false);
  }
}

export function MeshCard() {
  const saveTimer = useRef(null);

  useEffect(() => {
    apiGet('/api/settings/mesh')
      .then((cfg) => {
        peerPort.value = cfg.peer_port ?? 5151;
      })
      .catch(() => {});
  }, []);

  const schedSave = () => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(save, 700);
  };

  return (
    <section class="settings-card" id="mesh-settings">
      <h2>Mesh</h2>
      <p class="settings-lede">
        Port probed on each tailnet peer when checking which hosts run mobux. The fleet
        standard is <strong>5151</strong>. Change only if your fleet uses a different port.
      </p>

      <label class="settings-row">
        <span>Peer port</span>
        <input
          type="number"
          id="meshPeerPort"
          class="settings-input"
          placeholder="5151"
          min="1"
          max="65535"
          value={peerPort.value}
          onInput={(e) => (peerPort.value = Number(e.target.value))}
          onChange={schedSave}
        />
      </label>

      {status.value && (
        <div
          class="settings-status"
          style={{ color: status.value.ok ? '#7ec87e' : '#c87e7e' }}
        >
          {status.value.msg}
        </div>
      )}
    </section>
  );
}
