// Host picker (EDD phase 3): pick which mobux node the session list and
// terminal talk to.
//
// Fed by GET /api/peers (tailnet-discovered + configured peers). The current
// node is always listed first and is the default selection — with zero peers
// and no selection the UI behaves exactly as before. Picking a peer routes
// everything through the relay (see mesh-client.js); the first selection
// prompts for that peer's user/PIN and remembers it per device.

const mesh = window.MobuxMesh;

// ── small DOM helpers (match the existing dialog look) ────────────────
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

// A modal dialog styled like the existing new-session dialog. Resolves with
// the form values, or null if cancelled.
function showDialog({ title, fields, confirmLabel = 'OK', body }) {
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: 'session-dialog' });
    const form = el('form', { method: 'dialog' });
    form.appendChild(el('h3', { text: title }));
    if (body) form.appendChild(body);

    const inputs = {};
    for (const f of fields || []) {
      const input = el('input', {
        placeholder: f.placeholder || '',
        autocomplete: 'off',
        ...(f.type ? { type: f.type } : {}),
        ...(f.value ? { value: f.value } : {}),
        ...(f.inputmode ? { inputmode: f.inputmode } : {}),
      });
      if (f.required) input.required = true;
      inputs[f.name] = input;
      form.appendChild(input);
    }

    const actions = el('div', { class: 'dialog-actions' });
    const cancel = el('button', { type: 'button', class: 'btn-cancel', text: 'Cancel' });
    const confirm = el('button', { type: 'submit', class: 'btn-create', text: confirmLabel });
    actions.appendChild(cancel);
    actions.appendChild(confirm);
    form.appendChild(actions);
    dialog.appendChild(form);
    document.body.appendChild(dialog);

    const done = (val) => {
      dialog.close();
      dialog.remove();
      resolve(val);
    };
    cancel.addEventListener('click', () => done(null));
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      done(null);
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const out = {};
      for (const [name, input] of Object.entries(inputs)) out[name] = input.value;
      done(out);
    });
    dialog.showModal();
    const first = fields && fields[0] && inputs[fields[0].name];
    if (first) first.focus();
  });
}

// Prompt for a peer's Basic-auth creds. Returns true if creds were saved.
async function promptPeerCred(peer, opts = {}) {
  const note = opts.note
    ? el('p', { class: 'hint', text: opts.note, style: 'padding:0 0 8px;text-align:left' })
    : null;
  const vals = await showDialog({
    title: `Sign in to ${peer}`,
    body: note,
    fields: [
      { name: 'user', placeholder: 'user', required: true },
      { name: 'pin', placeholder: 'PIN', type: 'password', inputmode: 'numeric', required: true },
    ],
    confirmLabel: 'Connect',
  });
  if (!vals || !vals.user || !vals.pin) return false;
  mesh.setPeerCred(peer, vals.user.trim(), vals.pin.trim());
  return true;
}

// ── peer selection flow ───────────────────────────────────────────────
let onPeerChange = () => {};

async function selectPeer(peer) {
  if (!peer) {
    // Back to the current node — plain non-relayed paths, zero change.
    mesh.setPeer('');
    onPeerChange();
    return;
  }
  mesh.setPeer(peer);
  // Prompt for creds on first selection (none stored yet).
  if (!mesh.getPeerCred(peer)) {
    const ok = await promptPeerCred(peer);
    if (!ok) {
      // Cancelled — fall back to the current node rather than a dead peer.
      mesh.setPeer('');
    }
  }
  onPeerChange();
}

// ── rendering ──────────────────────────────────────────────────────────
function statusDot(reachable) {
  return el('span', {
    class: `peer-status ${reachable ? 'peer-up' : 'peer-down'}`,
    title: reachable ? 'reachable' : 'unreachable',
  });
}

function peerOption(label, sublabel, selected, reachable) {
  const opt = el('button', {
    class: `peer-option${selected ? ' selected' : ''}`,
    type: 'button',
  });
  if (reachable != null) opt.appendChild(statusDot(reachable));
  const info = el('div', { class: 'peer-info' });
  info.appendChild(el('span', { class: 'peer-name', text: label }));
  if (sublabel) info.appendChild(el('span', { class: 'peer-sub', text: sublabel }));
  opt.appendChild(info);
  if (selected) opt.appendChild(el('span', { class: 'peer-check', text: '✓' }));
  return opt;
}

// Render the picker dropdown listing the current node + peers.
async function openPicker(container) {
  const list = el('div', { class: 'peer-list' });
  list.appendChild(el('p', { class: 'hint', text: 'Loading hosts…' }));
  container.replaceChildren(list);

  // Current node is always first and always available.
  const selected = mesh.getPeer();
  const renderList = (peers, errorMsg) => {
    list.replaceChildren();

    const current = peerOption('This host', 'current node', !selected, null);
    current.addEventListener('click', async () => {
      await selectPeer('');
      container.replaceChildren();
    });
    list.appendChild(current);

    for (const p of peers || []) {
      const peerId = `${p.host}:${p.port}`;
      const sub = p.version ? `v${p.version}` : 'unreachable';
      const opt = peerOption(p.name, sub, selected === peerId, p.reachable);
      opt.addEventListener('click', async () => {
        await selectPeer(peerId);
        container.replaceChildren();
      });
      list.appendChild(opt);
    }

    if (errorMsg) {
      // Tailscale unavailable: show the operator hint, never an empty picker.
      list.appendChild(el('div', { class: 'peer-error', text: errorMsg }));
    } else if (!peers || !peers.length) {
      list.appendChild(el('p', { class: 'hint', text: 'No other hosts discovered.' }));
    }
  };

  try {
    const res = await fetch('/api/peers');
    if (!res.ok) {
      // Structured MeshError: { error: { kind, message } }
      let msg = `Peer discovery failed (${res.status}).`;
      try {
        const body = await res.json();
        if (body && body.error && body.error.message) msg = body.error.message;
      } catch (_) {}
      renderList([], msg);
      return;
    }
    const body = await res.json();
    renderList(body.peers || [], null);
  } catch (e) {
    renderList([], `Peer discovery failed: ${e.message}`);
  }
}

// The header trigger button label reflects the current selection.
function triggerLabel() {
  const peer = mesh.getPeer();
  return peer || 'This host';
}

function mount() {
  const header = document.querySelector('.app-header');
  if (!header) return;

  const trigger = el('button', { class: 'host-trigger', type: 'button' });
  const refreshTrigger = () => {
    trigger.replaceChildren(
      el('span', { class: 'host-label', text: triggerLabel() }),
      el('span', { class: 'host-caret', text: '▾' }),
    );
  };
  refreshTrigger();

  const dropdown = el('div', { class: 'host-dropdown' });

  // Insert the trigger before the settings icon.
  const settings = header.querySelector('.header-icon');
  if (settings) header.insertBefore(trigger, settings);
  else header.appendChild(trigger);
  header.parentNode.insertBefore(dropdown, header.nextSibling);

  let open = false;
  const close = () => {
    open = false;
    dropdown.replaceChildren();
    dropdown.classList.remove('open');
  };
  trigger.addEventListener('click', () => {
    if (open) {
      close();
    } else {
      open = true;
      dropdown.classList.add('open');
      openPicker(dropdown);
    }
  });

  onPeerChange = () => {
    refreshTrigger();
    close();
    // Re-render the session list against the newly selected host.
    if (typeof window.refreshSessions === 'function') window.refreshSessions();
  };
}

window.MobuxHostPicker = { mount, promptPeerCred, showDialog };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
