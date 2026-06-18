import { useState, useEffect, useRef, useCallback } from 'preact/hooks';

// App-shell host picker. Loads mesh-client.js once (app-wide), then provides
// the same pick / credential-prompt / peer-discovery flow as the old
// host-picker.js, implemented as a Preact component so it integrates with the
// SPA nav rather than hooking into .app-header DOM nodes.
//
// On peer change this component dispatches a 'mobux:peer-changed' CustomEvent
// on window so Home (and any other page) knows to re-fetch against the new
// host. It also sets window.refreshSessions for backwards-compat with anything
// still referencing the old host-picker.js callback.

// Load mesh-client.js once across the entire SPA lifetime. After the script
// loads, window.MobuxMesh is set and the terminal island's own load attempt
// becomes a no-op (browser skips duplicate src).
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

// ── peer credential prompt ────────────────────────────────────────────────
// Opens a dialog-based prompt for user/PIN, reusing the existing .session-dialog
// CSS class to match the session-create dialog.
function CredDialog({ peer, note, onConfirm, onCancel }) {
  const userRef = useRef(null);
  const pinRef = useRef(null);

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

// ── add-host dialog ───────────────────────────────────────────────────────
function AddHostDialog({ onConfirm, onCancel }) {
  const hostRef = useRef(null);

  useEffect(() => {
    hostRef.current?.focus();
  }, []);

  const submit = (e) => {
    e.preventDefault();
    const host = (hostRef.current?.value || '').trim();
    if (!host) return;
    onConfirm(host);
  };

  return (
    <dialog class="session-dialog" open>
      <form method="dialog" onSubmit={submit}>
        <h3>Add host</h3>
        <input ref={hostRef} placeholder="host or host:port" autocomplete="off" required />
        <div class="dialog-actions">
          <button type="button" class="btn-cancel" onClick={onCancel}>Cancel</button>
          <button type="submit" class="btn-create">Add</button>
        </div>
      </form>
    </dialog>
  );
}

// ── peer list dropdown ────────────────────────────────────────────────────
function PeerList({ peers, errorMsg, selectedPeer, manualPeers, onSelect, onRemoveManual, onAddHost, onClose }) {
  return (
    <div class="peer-list">
      {/* Current node */}
      <button
        class={`peer-option${!selectedPeer ? ' selected' : ''}`}
        type="button"
        onClick={async () => { await onSelect(''); onClose(); }}
      >
        <div class="peer-info">
          <span class="peer-name">This host</span>
          <span class="peer-sub">current node</span>
        </div>
        {!selectedPeer && <span class="peer-check">✓</span>}
      </button>

      {/* Discovered peers */}
      {(peers || []).map((p) => {
        const peerId = `${p.host}:${p.port}`;
        const sub = p.version ? `v${p.version}` : 'unreachable';
        const sel = selectedPeer === peerId;
        return (
          <button
            key={peerId}
            class={`peer-option${sel ? ' selected' : ''}`}
            type="button"
            onClick={async () => { await onSelect(peerId); onClose(); }}
          >
            {p.reachable != null && (
              <span
                class={`peer-status ${p.reachable ? 'peer-up' : 'peer-down'}`}
                title={p.reachable ? 'reachable' : 'unreachable'}
              />
            )}
            <div class="peer-info">
              <span class="peer-name">{p.name}</span>
              <span class="peer-sub">{sub}</span>
            </div>
            {sel && <span class="peer-check">✓</span>}
          </button>
        );
      })}

      {/* Manual peers */}
      {(manualPeers || []).map((peerId) => {
        const sel = selectedPeer === peerId;
        return (
          <button
            key={peerId}
            class={`peer-option${sel ? ' selected' : ''}`}
            type="button"
            onClick={async () => { await onSelect(peerId); onClose(); }}
          >
            <div class="peer-info">
              <span class="peer-name">{peerId}</span>
              <span class="peer-sub">manual</span>
            </div>
            {sel && <span class="peer-check">✓</span>}
            <button
              class="peer-remove"
              type="button"
              aria-label={`Remove ${peerId}`}
              onClick={(e) => { e.stopPropagation(); onRemoveManual(peerId); }}
            >
              ✕
            </button>
          </button>
        );
      })}

      {errorMsg && <div class="peer-error">{errorMsg}</div>}
      {!errorMsg && (!peers || !peers.length) && !(manualPeers || []).length && (
        <p class="hint">No other hosts discovered.</p>
      )}

      <button class="peer-add" type="button" onClick={onAddHost}>+ Add host</button>
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────
export function HostPicker() {
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [selectedPeer, setSelectedPeer] = useState('');
  const [peers, setPeers] = useState([]);
  const [manualPeers, setManualPeers] = useState([]);
  const [peerError, setPeerError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [credDialog, setCredDialog] = useState(null); // { peer, note }
  const [addHostDialog, setAddHostDialog] = useState(false);
  const dropdownRef = useRef(null);

  // Load mesh-client.js once on mount.
  useEffect(() => {
    ensureMeshClient()
      .then(() => {
        const m = getMesh();
        if (m) setSelectedPeer(m.getPeer() || '');
        setReady(true);
      })
      .catch((e) => {
        console.warn('HostPicker: mesh-client.js failed to load:', e.message);
        // Render as "This host" with no picker — same-origin fallback.
        setReady(true);
      });
  }, []);

  // Sync refreshSessions global so old host-picker.js onPeerChange still works.
  const notifyPeerChanged = useCallback(() => {
    window.dispatchEvent(new CustomEvent('mobux:peer-changed'));
    if (typeof window.refreshSessions === 'function') window.refreshSessions();
  }, []);

  // Close dropdown when clicking outside.
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [open]);

  // Load peer list when opening the dropdown.
  const openPicker = useCallback(async () => {
    setOpen(true);
    setLoading(true);
    setPeerError(null);
    try {
      const res = await fetch('/api/peers');
      if (!res.ok) {
        let msg = `Peer discovery failed (${res.status}).`;
        try {
          const body = await res.json();
          if (body?.error?.message) msg = body.error.message;
        } catch (_) {}
        setPeerError(msg);
        setPeers([]);
      } else {
        const body = await res.json();
        setPeers(body.peers || []);
      }
    } catch (e) {
      setPeerError(`Peer discovery failed: ${e.message}`);
      setPeers([]);
    }
    const m = getMesh();
    setManualPeers(m ? m.getManualPeers() : []);
    setLoading(false);
  }, []);

  // Select a peer: set in mesh, prompt for creds if needed.
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
      // Need creds — show the credential dialog.
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
            setCredDialog(null);
            resolve(false);
          },
        });
      });
    }
    setSelectedPeer(m.getPeer() || '');
    notifyPeerChanged();
  }, [notifyPeerChanged]);

  // Remove a manual peer.
  const removeManual = useCallback((peerId) => {
    const m = getMesh();
    if (!m) return;
    const wasActive = m.getPeer() === peerId;
    m.removeManualPeer(peerId);
    setManualPeers(m.getManualPeers());
    if (wasActive) {
      setSelectedPeer('');
      notifyPeerChanged();
    }
  }, [notifyPeerChanged]);

  // Add a manual host.
  const handleAddHost = useCallback(async (rawHost) => {
    const m = getMesh();
    setAddHostDialog(false);
    if (!m) return;
    const peerId = m.addManualPeer(rawHost);
    if (!peerId) {
      alert('Invalid host. Use "host" or "host:port".');
      return;
    }
    setManualPeers(m.getManualPeers());
    await selectPeer(peerId);
    setOpen(false);
  }, [selectPeer]);

  if (!ready) return null;

  const label = selectedPeer || 'This host';

  return (
    <div class="spa-host-picker" ref={dropdownRef}>
      <button
        class="host-trigger"
        type="button"
        onClick={() => (open ? setOpen(false) : openPicker())}
        aria-label={`Active host: ${label}`}
      >
        <span class="host-label">{label}</span>
        <span class="host-caret">▾</span>
      </button>

      {open && (
        <div class="host-dropdown open spa-host-dropdown">
          {loading ? (
            <div class="peer-list"><p class="hint">Loading hosts…</p></div>
          ) : (
            <PeerList
              peers={peers}
              errorMsg={peerError}
              selectedPeer={selectedPeer}
              manualPeers={manualPeers}
              onSelect={selectPeer}
              onRemoveManual={removeManual}
              onAddHost={() => setAddHostDialog(true)}
              onClose={() => setOpen(false)}
            />
          )}
        </div>
      )}

      {credDialog && (
        <CredDialog
          peer={credDialog.peer}
          note={credDialog.note}
          onConfirm={credDialog.onConfirm}
          onCancel={credDialog.onCancel}
        />
      )}

      {addHostDialog && (
        <AddHostDialog
          onConfirm={handleAddHost}
          onCancel={() => setAddHostDialog(false)}
        />
      )}
    </div>
  );
}
