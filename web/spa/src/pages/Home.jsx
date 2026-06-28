import { useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import { apiGet, apiSend } from "../lib/api.js";

// Home / session list. Ports the behaviour of the Rust-rendered `/` page
// (render_index + index.js): list tmux sessions with window/attached counts,
// create a session (FAB → dialog), kill, and rename. Tapping a session opens
// the terminal island.
//
// Peer pinning (issue #123): when MobuxMesh has a peer selected, session links
// carry the host in the path (`/s/<host>/<name>`) so the opened terminal drives
// that host for its whole lifetime. With no peer (current node) links stay
// plain (`/s/<name>`), byte-identical to same-origin behaviour. apiGet/apiSend
// already route through the relay when a peer is selected.

const sessions = signal(null);
const error = signal(null);

function currentPeer() {
  try {
    return window.MobuxMesh ? window.MobuxMesh.getPeer() : "";
  } catch (_) {
    return "";
  }
}

// A peer relay 401 reaches us as meshKind=unauthorized (mesh-client has already
// cleared the stored cred). Re-surface the in-app credential dialog rather than
// an alert/text error so the browser's native auth prompt never gets a chance.
// Returns true when the error was an auth failure we handled, so callers can
// bail out of their own error path.
function handlePeerAuthError(e) {
  if (e && e.meshKind === "unauthorized") {
    window.dispatchEvent(
      new CustomEvent("mobux:peer-auth-required", { detail: { peer: e.peer } }),
    );
    return true;
  }
  return false;
}

// Before opening/creating a session on a peer with no stored creds, show the
// in-app dialog first so the very first relayed request already carries them and
// the browser never sees a bare 401. Resolves true once creds are stored (or the
// target is the current node), false if the user cancelled.
function ensurePeerCred(peer) {
  const m = window.MobuxMesh;
  if (!peer || !m) return Promise.resolve(true);
  if (m.getPeerCred(peer)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok) => {
      window.removeEventListener("mobux:peer-cred-stored", onStored);
      window.removeEventListener("mobux:peer-cred-cancelled", onCancel);
      resolve(ok);
    };
    const onStored = (ev) => {
      if (!ev.detail || ev.detail.peer === peer) done(true);
    };
    const onCancel = (ev) => {
      if (!ev.detail || ev.detail.peer === peer) done(false);
    };
    window.addEventListener("mobux:peer-cred-stored", onStored);
    window.addEventListener("mobux:peer-cred-cancelled", onCancel);
    window.dispatchEvent(
      new CustomEvent("mobux:peer-auth-required", { detail: { peer } }),
    );
  });
}

async function refresh() {
  try {
    const data = await apiGet("/api/sessions");
    sessions.value = Array.isArray(data) ? data : data.sessions || [];
    error.value = null;
  } catch (e) {
    // mesh-client clears the cred and throws meshKind=unauthorized on 401.
    // Surface the in-app credential dialog instead of a text error so the
    // browser's native auth prompt never appears.
    if (handlePeerAuthError(e)) return;
    error.value = String(e.message || e);
  }
}

export function HomePage() {
  const dialogRef = useRef(null);
  const nameRef = useRef(null);

  useEffect(() => {
    refresh();
    // Re-fetch sessions when the host picker switches peers.
    window.addEventListener("mobux:peer-changed", refresh);
    // Also expose as a global so the legacy host-picker.js onPeerChange can call it.
    window.refreshSessions = refresh;
    return () => {
      window.removeEventListener("mobux:peer-changed", refresh);
      if (window.refreshSessions === refresh) delete window.refreshSessions;
    };
  }, []);

  const open = async (name) => {
    const peer = currentPeer();
    // Opening a peer session deep-links to /s/<peer>/<name>; the terminal then
    // connects a relayed WS. With no stored creds that WS would 401 → silent
    // close-loop. Prompt in-app first so navigation only happens with creds.
    if (peer && !(await ensurePeerCred(peer))) return;
    const href = peer
      ? `/s/${encodeURIComponent(peer)}/${encodeURIComponent(name)}`
      : `/s/${encodeURIComponent(name)}`;
    // Hard-load so terminal.js and host-picker.js always get a fresh execution
    // context. Client-side navigation re-uses the module map, leaving #terminal
    // empty and triggering "already been declared" errors on the second open.
    window.location.href = `/app#${href}`;
    window.location.reload();
  };

  const create = async (e) => {
    e.preventDefault();
    const name = (nameRef.current?.value || "").trim();
    if (!name) return;
    const peer = currentPeer();
    if (peer && !(await ensurePeerCred(peer))) return;
    try {
      await apiSend("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      nameRef.current.value = "";
      dialogRef.current?.close();
      await refresh();
    } catch (err) {
      if (handlePeerAuthError(err)) return;
      alert(`Create failed: ${err.message}`);
    }
  };

  const kill = async (name) => {
    if (!confirm(`Kill session '${name}'?`)) return;
    try {
      await apiSend(`/api/sessions/${encodeURIComponent(name)}/kill`, {
        method: "POST",
      });
      await refresh();
    } catch (err) {
      if (handlePeerAuthError(err)) return;
      alert(`Kill failed: ${err.message}`);
    }
  };

  const rename = async (oldName) => {
    const newName = prompt(`Rename '${oldName}' to:`, oldName);
    if (!newName || newName === oldName) return;
    try {
      await apiSend(`/api/sessions/${encodeURIComponent(oldName)}/rename`, {
        method: "POST",
        body: JSON.stringify({ name: newName }),
      });
      await refresh();
    } catch (err) {
      if (handlePeerAuthError(err)) return;
      alert(`Rename failed: ${err.message}`);
    }
  };

  // Swipe-to-reveal on a session row, ported from the old index.js
  // initSwipeRows. The rename/kill buttons sit behind the .session-item
  // (z-index), so without this gesture they're unreachable — drag the row to
  // reveal them (right → rename, left → kill), tap elsewhere to snap back.
  const swipeRow = (row) => {
    if (!row) return;
    const item = row.querySelector(".session-item");
    if (!item || item.dataset.swipeWired) return;
    item.dataset.swipeWired = "1";

    let startX = 0;
    let currentX = 0;
    let swiping = false;

    item.addEventListener(
      "touchstart",
      (e) => {
        startX = e.touches[0].clientX;
        currentX = 0;
        swiping = true;
        item.style.transition = "none";
      },
      { passive: true },
    );
    item.addEventListener(
      "touchmove",
      (e) => {
        if (!swiping) return;
        currentX = Math.max(-100, Math.min(100, e.touches[0].clientX - startX));
        item.style.transform = `translateX(${currentX}px)`;
      },
      { passive: true },
    );
    item.addEventListener("touchend", () => {
      swiping = false;
      item.style.transition = "transform 0.2s ease";
      if (currentX < -60) item.style.transform = "translateX(-100px)";
      else if (currentX > 60) item.style.transform = "translateX(100px)";
      else item.style.transform = "translateX(0)";
    });
    row.addEventListener("click", (e) => {
      if (e.target.closest(".swipe-btn")) return;
      if (
        item.style.transform !== "translateX(0px)" &&
        item.style.transform !== ""
      ) {
        item.style.transition = "transform 0.2s ease";
        item.style.transform = "translateX(0)";
      }
    });
  };

  const list = sessions.value;

  return (
    <>
      <div id="sessionList" class="session-list">
        {error.value && (
          <p class="hint">Failed to load sessions: {error.value}</p>
        )}
        {list == null && !error.value && <p class="hint">Loading…</p>}
        {list && list.length === 0 && (
          <p class="hint">No tmux sessions. Tap + to create one.</p>
        )}
        {(list || []).map((s) => {
          const name = typeof s === "string" ? s : s.name;
          const meta =
            typeof s === "object"
              ? `${s.windows ?? "?"} win · ${s.attached ?? 0} attached`
              : "";
          return (
            <div class="swipe-row" data-name={name} key={name} ref={swipeRow}>
              <div class="swipe-action swipe-left">
                <button
                  class="swipe-btn rename-btn"
                  onClick={() => rename(name)}
                >
                  Rename
                </button>
              </div>
              <a
                class="session-item"
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  open(name);
                }}
              >
                <div class="session-info">
                  <span class="session-name">{name}</span>
                  {meta && <span class="session-meta">{meta}</span>}
                </div>
                <span class="session-arrow">›</span>
              </a>
              <div class="swipe-action swipe-right">
                <button class="swipe-btn kill-btn" onClick={() => kill(name)}>
                  Kill
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <button
        id="fabNew"
        class="fab"
        aria-label="New session"
        onClick={() => {
          dialogRef.current?.showModal();
          nameRef.current?.focus();
        }}
      >
        +
      </button>

      <dialog ref={dialogRef} id="newSessionDialog" class="session-dialog">
        <form id="newSessionForm" method="dialog" onSubmit={create}>
          <h3>New session</h3>
          <input
            ref={nameRef}
            id="sessionName"
            placeholder="session-name"
            autocomplete="off"
            required
          />
          <div class="dialog-actions">
            <button
              type="button"
              class="btn-cancel"
              onClick={() => dialogRef.current?.close()}
            >
              Cancel
            </button>
            <button type="submit" class="btn-create">
              Create
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
