// Software-update panel on the settings page (issue #130).
//
// Reads /api/update/status, drives "Check for updates" (POST /api/update/check)
// and "Update now" (POST /api/update/run), then watches /api/identify until the
// version changes (or times out) and prompts a reload.
//
// Deliberately NOT mesh-aware: settings/update always act on the host that
// served this page. Multi-host routing (MobuxMesh.apiFetch) is for terminal
// pages only — routing updates through the selected peer showed the wrong
// version and updated the wrong host.

(function () {
  'use strict';

  const currentEl = document.getElementById('updateCurrent');
  const latestEl = document.getElementById('updateLatest');
  const checkedAtEl = document.getElementById('updateCheckedAt');
  const checkBtn = document.getElementById('updateCheckBtn');
  const runBtn = document.getElementById('updateRunBtn');
  const statusEl = document.getElementById('updateStatus');
  const hostEl = document.getElementById('updateHost');
  if (!currentEl) return; // section not on this page

  // Make it unambiguous which host this panel acts on (the page's own origin,
  // regardless of the host picker).
  if (hostEl) hostEl.textContent = `This running binary on ${location.hostname}.`;

  // Plain same-origin fetch: this panel must always talk to the page's own
  // host, never the peer selected in the host picker.
  function fetchPath(path, opts) {
    return fetch(path, { credentials: 'same-origin', ...(opts || {}) });
  }

  function showStatus(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.hidden = false;
    statusEl.style.color = kind === 'error' ? '#f87171' : '';
  }

  function fmtCheckedAt(iso) {
    if (!iso) return 'Not checked yet.';
    try {
      return 'Last checked ' + new Date(iso).toLocaleString();
    } catch (_) {
      return 'Last checked ' + iso;
    }
  }

  function render(status) {
    currentEl.textContent = status.current || '—';
    if (status.latest) {
      latestEl.textContent = status.latest;
      latestEl.classList.toggle('settings-value--new', !!status.available);
    } else {
      latestEl.textContent = '—';
      latestEl.classList.remove('settings-value--new');
    }
    checkedAtEl.textContent = status.error
      ? 'Check failed: ' + status.error
      : fmtCheckedAt(status.checkedAt);
    runBtn.hidden = !status.available;
    if (status.available) {
      runBtn.textContent = `Update now → ${status.latest}`;
    }
  }

  async function load(force) {
    const path = force ? '/api/update/check' : '/api/update/status';
    const opts = force ? { method: 'POST' } : {};
    try {
      const res = await fetchPath(path, opts);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      render(await res.json());
      if (force) showStatus('Checked crates.io.', 'ok');
    } catch (err) {
      showStatus('Update check failed: ' + err.message, 'error');
    }
  }

  // After a successful run we poll /api/identify until the reported version is
  // no longer the one we started on (or we give up), then prompt a reload.
  async function watchForNewVersion(fromVersion) {
    const deadline = Date.now() + 180000; // 3 min — covers a cargo install build
    showStatus('Updating… the service will restart. Watching for the new version.', 'ok');
    runBtn.disabled = true;
    checkBtn.disabled = true;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const res = await fetchPath('/api/identify', {});
        if (res.ok) {
          const id = await res.json();
          if (id.version && id.version !== fromVersion) {
            showStatus(`Updated to ${id.version}. Reload to pick up the new UI.`, 'ok');
            runBtn.disabled = false;
            checkBtn.disabled = false;
            if (confirm(`mobux updated to ${id.version}. Reload now?`)) {
              location.reload();
            }
            return;
          }
        }
      } catch (_) {
        // expected during the restart window — keep polling
      }
    }
    showStatus(
      'Timed out waiting for the new version. It may still be building, or it ' +
        'rolled back — check the update log on the host (mobux-update.log).',
      'error'
    );
    runBtn.disabled = false;
    checkBtn.disabled = false;
  }

  async function run() {
    const fromVersion = currentEl.textContent;
    runBtn.disabled = true;
    showStatus('Starting update…', 'ok');
    try {
      const res = await fetchPath('/api/update/run', { method: 'POST' });
      if (res.status === 202) {
        await res.json().catch(() => ({}));
        watchForNewVersion(fromVersion);
        return;
      }
      // Structured error: {error: {kind, message}}
      let msg = 'HTTP ' + res.status;
      try {
        const body = await res.json();
        if (body && body.error && body.error.message) msg = body.error.message;
      } catch (_) {}
      showStatus('Update could not start: ' + msg, 'error');
      runBtn.disabled = false;
    } catch (err) {
      showStatus('Update could not start: ' + err.message, 'error');
      runBtn.disabled = false;
    }
  }

  checkBtn.addEventListener('click', () => load(true));
  runBtn.addEventListener('click', run);

  load(false);
})();
