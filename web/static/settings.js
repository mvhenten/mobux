// Notification preferences page. Reads + writes /api/settings/notifications.

(function () {
  'use strict';

  const FIELDS = ['bell', 'bell_emoji', 'program_exit', 'program_exit_nonzero'];
  const status = document.getElementById('settingsStatus');

  function showStatus(text, ok = true) {
    if (!status) return;
    status.textContent = text;
    status.hidden = false;
    status.style.color = ok ? '' : '#f87171';
    clearTimeout(showStatus._t);
    showStatus._t = setTimeout(() => {
      status.hidden = true;
    }, 1500);
  }

  async function load() {
    try {
      const res = await fetch('/api/settings/notifications', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('GET ' + res.status);
      const prefs = await res.json();
      for (const k of FIELDS) {
        const cb = document.querySelector(`input[name="${k}"]`);
        if (cb) cb.checked = !!prefs[k];
      }
    } catch (err) {
      showStatus('Load failed: ' + err.message, false);
    }
  }

  async function save() {
    const body = {};
    for (const k of FIELDS) {
      const cb = document.querySelector(`input[name="${k}"]`);
      body[k] = !!(cb && cb.checked);
    }
    try {
      const res = await fetch('/api/settings/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('PUT ' + res.status);
      showStatus('Saved.');
    } catch (err) {
      showStatus('Save failed: ' + err.message, false);
    }
  }

  for (const k of FIELDS) {
    const cb = document.querySelector(`input[name="${k}"]`);
    if (cb) cb.addEventListener('change', save);
  }

  load();
})();
