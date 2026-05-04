// Shell integration installer. Reads /api/shell-integration/status and
// drives Install/Uninstall buttons per shell card.

(function () {
  'use strict';

  const SHELLS = ['bash', 'zsh', 'fish'];
  const status = document.getElementById('shellIntegrationStatus');

  function showStatus(text, ok = true) {
    if (!status) return;
    status.textContent = text;
    status.hidden = false;
    status.style.color = ok ? '' : '#f87171';
    clearTimeout(showStatus._t);
    showStatus._t = setTimeout(() => {
      status.hidden = true;
    }, 2000);
  }

  function describe(s) {
    if (!s || !s.state) return { label: 'unknown', cls: '' };
    switch (s.state) {
      case 'not_present':
        return { label: 'rc file not present', cls: 'shell-state--missing' };
      case 'not_installed':
        return { label: 'not installed', cls: 'shell-state--off' };
      case 'installed':
        return { label: `installed v${s.version}`, cls: 'shell-state--on' };
      case 'outdated':
        return { label: `outdated (v${s.version}\u2192current)`, cls: 'shell-state--warn' };
      default:
        return { label: s.state, cls: '' };
    }
  }

  function applyStatus(payload) {
    for (const sh of SHELLS) {
      const card = document.querySelector(`.shell-card[data-shell="${sh}"]`);
      if (!card) continue;
      const stateEl = card.querySelector('[data-role="state"]');
      const installBtn = card.querySelector('button[data-action="install"]');
      const uninstallBtn = card.querySelector('button[data-action="uninstall"]');
      const s = payload[sh];
      const d = describe(s);
      stateEl.textContent = d.label;
      stateEl.className = 'shell-state ' + d.cls;
      const isInstalled = s && s.state === 'installed';
      const isOutdated = s && s.state === 'outdated';
      installBtn.textContent = isInstalled ? 'Reinstall' : isOutdated ? 'Update' : 'Install';
      installBtn.disabled = isInstalled;
      uninstallBtn.disabled = !(isInstalled || isOutdated);
    }
  }

  async function load() {
    try {
      const res = await fetch('/api/shell-integration/status', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('GET ' + res.status);
      applyStatus(await res.json());
    } catch (err) {
      showStatus('Load failed: ' + err.message, false);
    }
  }

  async function act(action, shell) {
    try {
      const res = await fetch(`/api/shell-integration/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ shell }),
      });
      if (!res.ok) throw new Error(`${action} ${res.status}: ${await res.text()}`);
      applyStatus(await res.json());
      showStatus(`${shell}: ${action} ok`);
    } catch (err) {
      showStatus(`${shell} ${action} failed: ${err.message}`, false);
    }
  }

  document.querySelectorAll('.shell-card').forEach((card) => {
    const shell = card.getAttribute('data-shell');
    card.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => act(btn.getAttribute('data-action'), shell));
    });
  });

  load();
})();
