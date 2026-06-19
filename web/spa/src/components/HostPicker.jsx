import { useState, useEffect, useCallback } from 'preact/hooks';

// App-shell host picker (native <select> variant).
// Loads mesh-client.js once (app-wide), then renders a native <select> so
// Android shows its own bottom-sheet picker instead of a custom overlay.
//
// On peer change dispatches 'mobux:peer-changed' on window so Home (and any
// other page) re-fetches against the new host. Also sets window.refreshSessions
// for backwards-compat with anything still referencing the old host-picker.js.

let meshLoaded = false;
let meshLoadPromise = null;

function ensureMeshClient() {
  if (meshLoaded) return Promise.resolve();
  if (meshLoadPromise) return meshLoadPromise;
  meshLoadPromise = new Promise((resolve, reject) => {
    if (window.MobuxMesh) {
      meshLoaded = true;
      return resolve();
    }
    const s = document.createElement('script');
    s.src = '/static/mesh-client.js';
    s.async = false;
    s.onload = () => {
      meshLoaded = true;
      resolve();
    };
    s.onerror = () => reject(new Error('Failed to load mesh-client.js'));
    document.body.appendChild(s);
  });
  return meshLoadPromise;
}

function getMesh() {
  return window.MobuxMesh || null;
}

// Credential prompt — shown when switching to a peer that has no stored creds.
function CredDialog({ peer, note, onConfirm, onCancel }) {
  const userRef = { current: null };
  const pinRef = { current: null };

  useEffect(() => {
    userRef.current?.focus();
  }, []);

  const submit = (e) => {
    e.preventDefault();
    const user = (userRef.current?.value || '').trim();
    const pin = (pinRef.current?.value || '').trim();
    if (!user || !pin) return;
    onConfirm(user, pin);
  };

  return (
    <dialog class="session-dialog" open>
      <form method="dialog" onSubmit={submit}>
        <h3>Sign in to {peer}</h3>
        {note && <p class="hint" style="padding:0 0 8px;text-align:left">{note}</p>}
        <input ref={userRef} placeholder="user" autocomplete="off" required />
        <input ref={pinRef} placeholder="PIN" type="password" inputmode="numeric" autocomplete="off" required />
        <div class="dialog-actions">
          <button type="button" class="btn-cancel" onClick={onCancel}>Cancel</button>
          <button type="submit" class="btn-create">Connect</button>
        </div>
      </form>
    </dialog>
  );
}

// Main component — a native <select> in the nav.
export function HostPicker() {
  const [ready, setReady] = useState(false);
  const [selectedPeer, setSelectedPeer] = useState('');
  const [peers, setPeers] = useState([]);
  const [credDialog, setCredDialog] = useState(null);

  // Load mesh-client.js once on mount, then fetch peer list.
  useEffect(() => {
    ensureMeshClient()
      .then(async () => {
        const m = getMesh();
        if (m) setSelectedPeer(m.getPeer() || '');

        try {
          const res = await fetch('/api/peers');
          if (res.ok) {
            const body = await res.json();
            setPeers(body.peers || []);
          }
        } catch (_) {}

        setReady(true);
      })
      .catch(() => {
        // Mesh unavailable — show just "This host".
        setReady(true);
      });
  }, []);

  const notifyPeerChanged = useCallback(() => {
    window.dispatchEvent(new CustomEvent('mobux:peer-changed'));
    if (typeof window.refreshSessions === 'function') window.refreshSessions();
  }, []);

  const selectPeer = useCallback(async (peer) => {
    const m = getMesh();
    if (!m) return;
    if (!peer) {
      m.setPeer('');
      setSelectedPeer('');
      notifyPeerChanged();
      return;
    }
    m.setPeer(peer);
    if (!m.getPeerCred(peer)) {
      await new Promise((resolve) => {
        setCredDialog({
          peer,
          note: null,
          onConfirm: (user, pin) => {
            m.setPeerCred(peer, user, pin);
            setCredDialog(null);
            resolve(true);
          },
          onCancel: () => {
            m.setPeer('');
            setSelectedPeer('');
            setCredDialog(null);
            resolve(false);
          },
        });
      });
    }
    setSelectedPeer(m.getPeer() || '');
    notifyPeerChanged();
  }, [notifyPeerChanged]);

  const handleChange = useCallback(async (e) => {
    await selectPeer(e.target.value);
  }, [selectPeer]);

  if (!ready) return null;

  return (
    <div class="spa-host-picker">
      <select
        class="host-select"
        value={selectedPeer}
        onChange={handleChange}
        aria-label="Active host"
      >
        <option value="">This host</option>
        {peers.map((p) => {
          const peerId = `${p.host}:${p.port}`;
          const label = p.reachable === false
            ? `${p.name} (unreachable)`
            : p.name;
          return (
            <option key={peerId} value={peerId} disabled={p.reachable === false}>
              {label}
            </option>
          );
        })}
      </select>

      {credDialog && (
        <CredDialog
          peer={credDialog.peer}
          note={credDialog.note}
          onConfirm={credDialog.onConfirm}
          onCancel={credDialog.onCancel}
        />
      )}
    </div>
  );
}
