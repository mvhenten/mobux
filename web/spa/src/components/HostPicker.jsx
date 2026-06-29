import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import { ensureMeshClient } from "../lib/mesh.js";

// App-shell host picker (native <select> variant).
// Loads mesh-client.js once (app-wide, deduped via lib/mesh.js), then renders
// a native <select> so Android shows its own bottom-sheet picker instead of a
// custom overlay.
//
// On peer change (and on initial restore from localStorage) dispatches
// 'mobux:peer-changed' on window so Home re-fetches against the correct host.
// Also sets window.refreshSessions for backwards-compat with anything still
// referencing the old host-picker.js.
//
// 401 re-prompt: mesh-client's apiFetch clears the stored cred and throws
// err.meshKind === 'unauthorized'. Callers (e.g. Home's refresh()) can dispatch
// 'mobux:peer-auth-required' on window with { detail: { peer } } to re-surface
// this in-app credential dialog — the HostPicker listens and re-prompts.

function getMesh() {
  return window.MobuxMesh || null;
}

// Credential prompt — shown when switching to a peer that has no stored creds,
// or after a 401 clears the stored cred (re-prompt path).
// Uses a real <dialog> element via showModal() so it is a proper modal overlay
// (backdrop, focus-trap) and the browser never sees a 401 and triggers its own
// native credential UI.
function CredDialog({ peer, note, onConfirm, onCancel }) {
  const dialogRef = useRef(null);
  const userRef = useRef(null);
  const pinRef = useRef(null);

  useEffect(() => {
    // showModal() turns the element into a top-layer modal — this is what
    // prevents the browser from popping its own Basic-auth dialog when a 401
    // response would otherwise go unhandled.
    dialogRef.current?.showModal();
    userRef.current?.focus();
  }, []);

  const submit = (e) => {
    e.preventDefault();
    const user = (userRef.current?.value || "").trim();
    const pin = (pinRef.current?.value || "").trim();
    if (!user || !pin) return;
    onConfirm(user, pin);
  };

  return (
    <dialog
      ref={dialogRef}
      class="session-dialog"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <form method="dialog" onSubmit={submit}>
        <h3>Sign in to {peer}</h3>
        {note && (
          <p class="hint" style="padding:0 0 8px;text-align:left">
            {note}
          </p>
        )}
        <input ref={userRef} placeholder="user" autocomplete="off" required />
        <input
          ref={pinRef}
          placeholder="PIN"
          type="password"
          inputmode="numeric"
          autocomplete="off"
          required
        />
        <div class="dialog-actions">
          <button type="button" class="btn-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" class="btn-create">
            Connect
          </button>
        </div>
      </form>
    </dialog>
  );
}

// Main component — a native <select> in the nav.
export function HostPicker() {
  const [ready, setReady] = useState(false);
  const [selectedPeer, setSelectedPeer] = useState("");
  const [peers, setPeers] = useState([]);
  const [credDialog, setCredDialog] = useState(null);

  // Load mesh-client.js once on mount, then fetch peer list.
  // NOTE: this effect must stay BEFORE notifyPeerChanged is declared so its
  // dep array stays empty — referencing a const before its declaration is a
  // TDZ error that crashes the whole component.
  // Home.refresh() awaits ensureMeshClient() (lib/mesh.js) so it always
  // fetches from the correct peer without needing a dispatch here.
  useEffect(() => {
    ensureMeshClient()
      .then(async () => {
        const m = getMesh();
        if (m) setSelectedPeer(m.getPeer() || "");

        try {
          const res = await fetch("/api/peers");
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
    window.dispatchEvent(new CustomEvent("mobux:peer-changed"));
    if (typeof window.refreshSessions === "function") window.refreshSessions();
  }, []);

  // promptCred: show the in-app CredDialog and resolve with true (creds saved)
  // or false (cancelled). Used both on first select and on 401 re-prompt.
  const promptCred = useCallback((peer, note = null) => {
    return new Promise((resolve) => {
      const m = getMesh();
      setCredDialog({
        peer,
        note,
        onConfirm: (user, pin) => {
          m?.setPeerCred(peer, user, pin);
          setCredDialog(null);
          resolve(true);
        },
        onCancel: () => {
          setCredDialog(null);
          resolve(false);
        },
      });
    });
  }, []);

  const selectPeer = useCallback(
    async (peer) => {
      const m = getMesh();
      if (!m) return;
      if (!peer) {
        m.setPeer("");
        setSelectedPeer("");
        notifyPeerChanged();
        return;
      }
      m.setPeer(peer);
      if (!m.getPeerCred(peer)) {
        const ok = await promptCred(peer);
        if (!ok) {
          m.setPeer("");
          setSelectedPeer("");
          notifyPeerChanged();
          return;
        }
      }
      setSelectedPeer(m.getPeer() || "");
      notifyPeerChanged();
    },
    [notifyPeerChanged, promptCred],
  );

  // Listen for 401-from-peer events dispatched by callers (e.g. Home's refresh)
  // when mesh-client's apiFetch clears the cred and throws meshKind=unauthorized.
  // Re-show the in-app dialog so the user can re-enter creds without ever seeing
  // the browser's native auth prompt.
  useEffect(() => {
    const handler = async (e) => {
      const m = getMesh();
      if (!m) return;
      const peer = e.detail?.peer || m.getPeer();
      if (!peer) return;
      // Tailor the note: a fresh prompt (creds never stored) vs. a re-prompt
      // after a 401 cleared a bad cred.
      const note = m.getPeerCred(peer)
        ? "Authentication failed — please re-enter your PIN."
        : null;
      const ok = await promptCred(peer, note);
      if (ok) {
        // Re-select the peer so the relay carries the fresh cred.
        setSelectedPeer(peer);
        notifyPeerChanged();
        // Let callers awaiting creds (Home's session open/create) proceed.
        window.dispatchEvent(
          new CustomEvent("mobux:peer-cred-stored", { detail: { peer } }),
        );
      } else {
        // Cancelled — drop back to this host.
        m.setPeer("");
        setSelectedPeer("");
        notifyPeerChanged();
        window.dispatchEvent(
          new CustomEvent("mobux:peer-cred-cancelled", { detail: { peer } }),
        );
      }
    };
    window.addEventListener("mobux:peer-auth-required", handler);
    return () =>
      window.removeEventListener("mobux:peer-auth-required", handler);
  }, [promptCred, notifyPeerChanged]);

  const handleChange = useCallback(
    async (e) => {
      await selectPeer(e.target.value);
    },
    [selectPeer],
  );

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
          const label =
            p.reachable === false ? `${p.name} (unreachable)` : p.name;
          return (
            <option
              key={peerId}
              value={peerId}
              disabled={p.reachable === false}
            >
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
