import { useEffect, useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import { localFetch } from '../../lib/api.js';

// Software update card. Ports update.js (issue #130). Reads
// /api/update/status, drives Check (POST /api/update/check) and Update now
// (POST /api/update/run), then polls /api/identify until the version changes
// (or times out) and prompts a reload.
//
// Deliberately NOT mesh-aware: update always acts on the host that served the
// page — uses the host-pinned helper (localFetch), never the mesh peer.

const info = signal(null); // /api/update/status payload
const status = signal(null); // { msg, kind }
const busy = signal(false);

function fmtCheckedAt(iso) {
  if (!iso) return 'Not checked yet.';
  try {
    return 'Last checked ' + new Date(iso).toLocaleString();
  } catch (_) {
    return 'Last checked ' + iso;
  }
}

export function UpdateCard() {
  const fromRef = useRef('');

  useEffect(() => {
    load(false);
  }, []);

  const show = (msg, kind) => (status.value = { msg, kind });

  async function load(force) {
    const path = force ? '/api/update/check' : '/api/update/status';
    try {
      const res = await localFetch(path, force ? { method: 'POST' } : {});
      if (!res.ok) throw new Error('HTTP ' + res.status);
      info.value = await res.json();
      if (force) show('Checked crates.io.', 'ok');
    } catch (err) {
      show('Update check failed: ' + err.message, 'error');
    }
  }

  async function watchForNewVersion(fromVersion, logPath) {
    const deadline = Date.now() + 600000; // 10 min — cargo install builds take minutes
    show('Updating… the service will restart. Watching for the new version.', 'ok');
    busy.value = true;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const res = await localFetch('/api/identify', {});
        if (res.ok) {
          const id = await res.json();
          if (id.version && id.version !== fromVersion) {
            show(`Updated to ${id.version}. Reload to pick up the new UI.`, 'ok');
            busy.value = false;
            if (confirm(`mobux updated to ${id.version}. Reload now?`)) location.reload();
            return;
          }
        }
      } catch (_) {
        // expected during the restart window — keep polling
      }
    }
    show(
      'Timed out after 10 minutes waiting for the new version. It may still be building, or it ' +
        'rolled back — check the update log on the host: ' + (logPath || 'mobux-update.log'),
      'error',
    );
    busy.value = false;
  }

  async function run() {
    const fromVersion = info.value?.current || fromRef.current;
    busy.value = true;
    show('Starting update…', 'ok');
    try {
      const res = await localFetch('/api/update/run', { method: 'POST' });
      if (res.status === 202) {
        const body = await res.json().catch(() => ({}));
        watchForNewVersion(fromVersion, body.log);
        return;
      }
      let msg = 'HTTP ' + res.status;
      try {
        const body = await res.json();
        if (body && body.error && body.error.message) msg = body.error.message;
      } catch (_) {}
      show('Update could not start: ' + msg, 'error');
      busy.value = false;
    } catch (err) {
      show('Update could not start: ' + err.message, 'error');
      busy.value = false;
    }
  }

  const s = info.value || {};
  const available = !!s.available;

  return (
    <section class="settings-card" id="update">
      <h2>Software update</h2>
      <p class="settings-lede">
        mobux checks crates.io for newer published versions. Updating installs the new version with{' '}
        <code>cargo install</code>, restarts the systemd service, health-checks it, and rolls back
        automatically if the new version doesn't come up. This acts on <strong>this host only</strong>{' '}
        — to update a peer, open its own settings page.
      </p>
      <div class="settings-row">
        <span class="settings-label">
          <strong>Current version</strong>
          <small>This running binary on {typeof location !== 'undefined' ? location.hostname : ''}.</small>
        </span>
        <span class="settings-value">{s.current || '…'}</span>
      </div>
      <div class="settings-row">
        <span class="settings-label">
          <strong>Latest version</strong>
          <small>{s.error ? 'Check failed: ' + s.error : fmtCheckedAt(s.checkedAt)}</small>
        </span>
        <span class={'settings-value' + (available ? ' settings-value--new' : '')}>
          {s.latest || '…'}
        </span>
      </div>
      <div class="shell-card-actions">
        <button type="button" disabled={busy.value} onClick={() => load(true)}>
          Check for updates
        </button>
        {available && (
          <button type="button" disabled={busy.value} onClick={run}>
            Update now → {s.latest}
          </button>
        )}
      </div>
      {status.value && (
        <div class="settings-status" style={{ color: status.value.kind === 'error' ? '#f87171' : '' }}>
          {status.value.msg}
        </div>
      )}
    </section>
  );
}
