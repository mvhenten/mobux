// Shell integration installer. Reads /api/shell-integration/status and
// drives /api/shell-integration/{install,uninstall} per shell card.

(function () {
  'use strict';

  const SHELLS = ['bash', 'zsh', 'fish'];
  const root = document.getElementById('shellIntegrationCards');
  const status = document.getElementById('shellIntegrationStatus');
  if (!root) return;

  function showStatus(text, ok = true) {
    if (!status) return;
    status.textContent = text;
    status.hidden = false;
    status.style.color = ok ? '' : '#f87171';
    clearTimeout(showStatus._t);
    showStatus._t = setTimeout(() => { status.hidden = true; }, 2500);
  }

  function describe(state) {
    if (!state) return { label: '…', tone: '' };
    switch (state.kind) {
      case 'not_present':  return { label: 'rc file missing',     tone: 'muted' };
      case 'not_installed':return { label: 'not installed',       tone: 'muted' };
      case 'installed':    return { label: `installed (v${state.version})`, tone: 'ok' };
      case 'outdated':     return { label: `outdated (v${state.version})`, tone: 'warn' };
      default:             return { label: String(state.kind || '?'), tone: '' };
    }
  }

  function actionsFor(state) {
    const k = state && state.kind;
    if (k === 'installed')    return [{ op: 'install', label: 'Reinstall' }, { op: 'uninstall', label: 'Uninstall' }];
    if (k === 'outdated')     return [{ op: 'install', label: 'Update' },    { op: 'uninstall', label: 'Uninstall' }];
    return [{ op: 'install', label: 'Install' }];
  }

  function render(allStates) {
    for (const shell of SHELLS) {
      const card = root.querySelector(`.shell-card[data-shell="${shell}"]`);
      if (!card) continue;
      const state = allStates[shell];
      const stateEl = card.querySelector('[data-state]');
      const actionsEl = card.querySelector('[data-actions]');
      const d = describe(state);
      stateEl.textContent = d.label;
      stateEl.dataset.tone = d.tone;
      actionsEl.replaceChildren();
      for (const a of actionsFor(state)) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'shell-card-btn';
        btn.dataset.op = a.op;
        btn.textContent = a.label;
        btn.addEventListener('click', () => act(shell, a.op, btn));
        actionsEl.appendChild(btn);
      }
    }
  }

  async function load() {
    try {
      const res = await fetch('/api/shell-integration/status', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('GET ' + res.status);
      render(await res.json());
    } catch (err) {
      showStatus('Status load failed: ' + err.message, false);
    }
  }

  async function act(shell, op, btn) {
    btn.disabled = true;
    try {
      const res = await fetch(`/api/shell-integration/${op}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ shell }),
      });
      if (!res.ok) throw new Error(`${op} ${res.status}`);
      const next = await res.json();
      render(next);
      showStatus(`${shell}: ${op === 'install' ? 'installed' : 'uninstalled'}`);
    } catch (err) {
      showStatus(`${shell} ${op} failed: ` + err.message, false);
    } finally {
      btn.disabled = false;
    }
  }

  load();
})();
