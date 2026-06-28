import { useState, useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import { apiGet, apiPutJSON } from "../../lib/api.js";

const peerPort = signal(5151);
const status = signal(null); // { msg, ok }

function flash(msg, ok) {
  status.value = { msg, ok };
}

async function save() {
  const port = Number(peerPort.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    flash("Port must be 1–65535.", false);
    return;
  }
  try {
    const r = await apiPutJSON("/api/settings/mesh", { peer_port: port });
    flash(r.ok ? "Saved ✓" : "Save failed.", r.ok);
  } catch (_) {
    flash("Save failed.", false);
  }
}

function getMesh() {
  return window.MobuxMesh || null;
}

export function MeshCard() {
  const saveTimer = useRef(null);
  const [manualPeers, setManualPeers] = useState([]);
  const [addHost, setAddHost] = useState("");

  useEffect(() => {
    apiGet("/api/settings/mesh")
      .then((cfg) => {
        peerPort.value = cfg.peer_port ?? 5151;
      })
      .catch(() => {});

    // Load manual peers from mesh-client if available.
    const syncManual = () => {
      const m = getMesh();
      if (m) setManualPeers(m.getManualPeers() || []);
    };
    syncManual();
    // Re-sync whenever a peer-changed event fires.
    window.addEventListener("mobux:peer-changed", syncManual);
    return () => window.removeEventListener("mobux:peer-changed", syncManual);
  }, []);

  const schedSave = () => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(save, 700);
  };

  const handleAddHost = (e) => {
    e.preventDefault();
    const host = addHost.trim();
    if (!host) return;
    const m = getMesh();
    if (!m) return;
    const peerId = m.addManualPeer(host);
    if (!peerId) {
      flash('Invalid host. Use "host" or "host:port".', false);
      return;
    }
    setManualPeers(m.getManualPeers() || []);
    setAddHost("");
    window.dispatchEvent(new CustomEvent("mobux:peer-changed"));
  };

  const handleRemove = (peerId) => {
    const m = getMesh();
    if (!m) return;
    const wasActive = m.getPeer() === peerId;
    m.removeManualPeer(peerId);
    setManualPeers(m.getManualPeers() || []);
    if (wasActive) {
      m.setPeer("");
      window.dispatchEvent(new CustomEvent("mobux:peer-changed"));
    }
  };

  return (
    <section class="settings-card" id="mesh-settings">
      <h2>Mesh</h2>
      <p class="settings-lede">
        Port probed on each tailnet peer when checking which hosts run mobux.
        The fleet standard is <strong>5151</strong>. Change only if your fleet
        uses a different port.
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
          style={{ color: status.value.ok ? "#7ec87e" : "#c87e7e" }}
        >
          {status.value.msg}
        </div>
      )}

      <h3 class="mesh-hosts-heading">Manual hosts</h3>

      {manualPeers.length > 0 ? (
        <ul class="mesh-host-list">
          {manualPeers.map((peerId) => (
            <li key={peerId} class="mesh-host-item">
              <span class="mesh-host-label">{peerId}</span>
              <button
                class="mesh-host-remove"
                type="button"
                aria-label={`Remove ${peerId}`}
                onClick={() => handleRemove(peerId)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p class="hint">No manual hosts added.</p>
      )}

      <form class="mesh-add-host" onSubmit={handleAddHost}>
        <input
          class="settings-input mesh-add-input"
          type="text"
          placeholder="host or host:port"
          value={addHost}
          onInput={(e) => setAddHost(e.target.value)}
          autocomplete="off"
        />
        <button class="btn-create mesh-add-btn" type="submit">
          Add host
        </button>
      </form>
    </section>
  );
}
