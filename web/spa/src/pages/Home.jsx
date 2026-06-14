import { useEffect, useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import { useLocation } from 'wouter-preact';
import { apiGet, apiSend } from '../lib/api.js';

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
    return window.MobuxMesh ? window.MobuxMesh.getPeer() : '';
  } catch (_) {
    return '';
  }
}

async function refresh() {
  try {
    const data = await apiGet('/api/sessions');
    sessions.value = Array.isArray(data) ? data : data.sessions || [];
    error.value = null;
  } catch (e) {
    error.value = String(e.message || e);
  }
}

export function HomePage() {
  const [, navigate] = useLocation();
  const dialogRef = useRef(null);
  const nameRef = useRef(null);

  useEffect(() => {
    refresh();
  }, []);

  const open = (name) => {
    const peer = currentPeer();
    const href = peer
      ? `/s/${encodeURIComponent(peer)}/${encodeURIComponent(name)}`
      : `/s/${encodeURIComponent(name)}`;
    navigate(href);
  };

  const create = async (e) => {
    e.preventDefault();
    const name = (nameRef.current?.value || '').trim();
    if (!name) return;
    try {
      await apiSend('/api/sessions', { method: 'POST', body: JSON.stringify({ name }) });
      nameRef.current.value = '';
      dialogRef.current?.close();
      await refresh();
    } catch (err) {
      alert(`Create failed: ${err.message}`);
    }
  };

  const kill = async (name) => {
    if (!confirm(`Kill session '${name}'?`)) return;
    try {
      await apiSend(`/api/sessions/${encodeURIComponent(name)}/kill`, { method: 'POST' });
      await refresh();
    } catch (err) {
      alert(`Kill failed: ${err.message}`);
    }
  };

  const rename = async (oldName) => {
    const newName = prompt(`Rename '${oldName}' to:`, oldName);
    if (!newName || newName === oldName) return;
    try {
      await apiSend(`/api/sessions/${encodeURIComponent(oldName)}/rename`, {
        method: 'POST',
        body: JSON.stringify({ name: newName }),
      });
      await refresh();
    } catch (err) {
      alert(`Rename failed: ${err.message}`);
    }
  };

  const list = sessions.value;

  return (
    <>
      <div id="sessionList" class="session-list">
        {error.value && <p class="hint">Failed to load sessions: {error.value}</p>}
        {list == null && !error.value && <p class="hint">Loading…</p>}
        {list && list.length === 0 && <p class="hint">No tmux sessions. Tap + to create one.</p>}
        {(list || []).map((s) => {
          const name = typeof s === 'string' ? s : s.name;
          const meta =
            typeof s === 'object'
              ? `${s.windows ?? '?'} win · ${s.attached ?? 0} attached`
              : '';
          return (
            <div class="swipe-row" data-name={name} key={name}>
              <div class="swipe-action swipe-left">
                <button class="swipe-btn rename-btn" onClick={() => rename(name)}>
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
          <input ref={nameRef} id="sessionName" placeholder="session-name" autocomplete="off" required />
          <div class="dialog-actions">
            <button type="button" class="btn-cancel" onClick={() => dialogRef.current?.close()}>
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
