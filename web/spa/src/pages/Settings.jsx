import { useEffect, useRef } from 'preact/hooks';
import { signal, computed } from '@preact/signals';
import { apiGet, apiPutJSON, apiPost } from '../lib/api.js';
import {
  FALLBACK_MODELS,
  kindDefaults,
  normalizeHost,
  parseUrlIntoFields,
  fetchModels,
} from '../lib/stt.js';

// ── State ────────────────────────────────────────────────────────────
// Per-kind cache of the last-known field values, seeded from GET on mount and
// kept in sync on save — mirrors `providerCache` in the original IIFE.
const cache = signal({}); // { local: {host,port,model,has_key}, ... }
const kind = signal('local');
const host = signal('http://127.0.0.1');
const port = signal('5200');
const model = signal(FALLBACK_MODELS.local[0]);
const customModel = signal('');
const apiKey = signal('');
const hasKey = signal(false);
const models = signal(FALLBACK_MODELS.local.slice());
const status = signal(null); // { msg, ok }
const action = signal(null); // local install/run status line
const sttStatus = signal(null); // { installed, local_process_running }

const CUSTOM = '__custom__';

// Which fields a kind exposes — this is the component-model replacement for the
// old visibility toggling. We render only what applies (no [hidden]).
const isLocal = computed(() => kind.value === 'local');
const isNetwork = computed(() => kind.value === 'network');
const isOpenai = computed(() => kind.value === 'openai');
const isCustomModel = computed(() => model.value === CUSTOM);

function flash(sig, msg, ok) {
  sig.value = { msg, ok };
}

// Effective model id sent to the backend (custom box wins when selected).
function effectiveModel() {
  return model.value === CUSTOM ? customModel.value.trim() : model.value;
}

async function loadModels(selected) {
  const list = await fetchModels(kind.value, host.value, port.value);
  // If the saved model isn't discovered, keep it selectable (don't silently
  // drop to custom) — same as populateModelSelect's insert.
  const withSaved =
    selected && !list.includes(selected) ? [selected, ...list] : list.slice();
  models.value = withSaved;
  if (selected) {
    model.value = list.includes(selected) || withSaved.includes(selected) ? selected : CUSTOM;
    if (model.value === CUSTOM) customModel.value = selected;
  }
}

async function save() {
  const k = kind.value;
  const body = {
    kind: k,
    host: host.value.trim(),
    port: port.value.trim(),
    model: effectiveModel(),
  };
  if (apiKey.value) body.api_key = apiKey.value;
  try {
    const r = await apiPutJSON('/api/settings/stt', body);
    if (r.ok) {
      const prev = cache.value[k] || {};
      cache.value = {
        ...cache.value,
        [k]: {
          ...prev,
          host: body.host,
          port: body.port,
          model: body.model,
          has_key: body.api_key ? true : prev.has_key,
        },
      };
    }
    flash(status, r.ok ? 'Saved ✓' : 'Save failed.', r.ok);
  } catch (_) {
    flash(status, 'Save failed.', false);
  }
}

function populateFromProvider(k) {
  const def = kindDefaults(k);
  const p = cache.value[k] || {};
  host.value = p.host || def.host;
  port.value = p.port || def.port;
  apiKey.value = '';
  hasKey.value = !!p.has_key;
  loadModels(p.model || def.model);
}

async function refreshSttStatus() {
  try {
    sttStatus.value = await apiGet('/api/stt/status');
  } catch (_) {}
}

// ── Component ────────────────────────────────────────────────────────
export function SettingsPage() {
  const saveTimer = useRef(null);
  const fetchTimer = useRef(null);

  // Load current config on mount (mirrors the original's initial fetch).
  useEffect(() => {
    apiGet('/api/settings/stt')
      .then((cfg) => {
        cache.value = cfg.providers || {};
        const active = cfg.activeKind || 'local';
        kind.value = active;
        populateFromProvider(active);
        if (active === 'local') refreshSttStatus();
      })
      .catch(() => {
        populateFromProvider(kind.value);
      });
  }, []);

  const schedSave = () => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(save, 700);
  };

  // Debounced re-fetch on host/port change, then save with the discovered model.
  const schedFetchModels = () => {
    clearTimeout(fetchTimer.current);
    fetchTimer.current = setTimeout(async () => {
      await loadModels(effectiveModel());
      save();
    }, 600);
  };

  const onKindChange = (e) => {
    kind.value = e.target.value;
    populateFromProvider(kind.value);
    if (kind.value === 'local') refreshSttStatus();
    schedSave();
  };

  const onModelChange = (e) => {
    model.value = e.target.value;
    save();
  };

  // Host paste/blur: split a full URL into fields, else ensure a scheme.
  const onHostBlur = () => {
    const raw = host.value.trim();
    if (!raw) return;
    const parsed = parseUrlIntoFields(raw);
    if (parsed) {
      // Re-split only when there was a port or a real path component.
      let normalised = /^https?:\/\//i.test(raw) ? raw : 'http://' + raw;
      try {
        const u = new URL(normalised);
        if (u.port || (u.pathname && u.pathname !== '/')) {
          host.value = parsed.host;
          port.value = parsed.port;
        } else {
          host.value = u.protocol + '//' + u.hostname;
        }
      } catch (_) {}
    }
    schedFetchModels();
  };

  const onInstall = async () => {
    flash(action, 'Installing… (this may take a minute)', true);
    let r;
    try {
      r = await apiPost('/api/stt/install');
    } catch (_) {
      flash(action, 'Install failed (network).', false);
      return;
    }
    if (!r.ok && r.status !== 202 && r.status !== 409) {
      flash(action, 'Install request failed: ' + r.status, false);
      return;
    }
    // Poll install status to completion.
    let errCount = 0;
    for (;;) {
      await new Promise((res) => setTimeout(res, 2000));
      let s;
      try {
        s = await apiGet('/api/stt/status');
        errCount = 0;
      } catch (_) {
        if (++errCount >= 5) {
          flash(action, 'Install status unavailable.', false);
          break;
        }
        continue;
      }
      const tail = Array.isArray(s.install_output) ? s.install_output.slice(-3).join(' | ') : '';
      if (s.install_phase === 'success') {
        flash(action, 'Installed.' + (tail ? ' ' + tail : ''), true);
        sttStatus.value = s;
        break;
      } else if (s.install_phase === 'failed') {
        flash(action, 'Install failed: ' + (s.install_error || 'unknown'), false);
        break;
      } else if (s.install_phase === 'running') {
        flash(action, 'Installing… ' + (tail || ''), true);
      }
    }
  };

  const onToggle = async () => {
    const running = !!sttStatus.value?.local_process_running;
    const ep = running ? '/api/stt/stop' : '/api/stt/start';
    try {
      const r = await apiPost(ep);
      flash(action, r.ok ? (running ? 'Server stopped.' : 'Server started.') : 'Action failed.', r.ok);
    } catch (_) {
      flash(action, 'Action failed.', false);
    }
    refreshSttStatus();
  };

  const onProbe = async () => {
    try {
      const s = await apiGet('/api/stt/status');
      flash(
        status,
        s.reachable ? `Provider reachable (kind: ${s.kind})` : `Provider NOT reachable (${s.url})`,
        s.reachable,
      );
    } catch (_) {
      flash(status, 'Status check failed.', false);
    }
  };

  const installed = !!sttStatus.value?.installed;
  const running = !!sttStatus.value?.local_process_running;

  return (
    <section class="settings-card" id="stt-provider">
      <h2>Speech to text</h2>

      <label class="settings-row">
        <span>Provider</span>
        <select id="sttKind" class="settings-select" value={kind.value} onChange={onKindChange}>
          <option value="local">Local server</option>
          <option value="network">Network (self-hosted)</option>
          <option value="openai">OpenAI</option>
        </select>
      </label>

      {/* Host + Port: only the self-hosted Network provider needs an endpoint. */}
      {isNetwork.value && (
        <>
          <label class="settings-row" id="sttHostRow">
            <span>Host</span>
            <input
              type="text"
              id="sttHost"
              class="settings-input"
              placeholder="http://127.0.0.1"
              value={host.value}
              onInput={(e) => (host.value = e.target.value)}
              onBlur={onHostBlur}
            />
          </label>
          <label class="settings-row" id="sttPortRow">
            <span>Port</span>
            <input
              type="number"
              id="sttPort"
              class="settings-input"
              placeholder="5200"
              min="1"
              max="65535"
              value={port.value}
              onInput={(e) => (port.value = e.target.value)}
              onChange={schedFetchModels}
            />
          </label>
        </>
      )}

      {/* Model picker: hidden for local (auto-selected). */}
      {!isLocal.value && (
        <div class="settings-row" id="sttModelRow">
          <span>Model</span>
          <div style="display:flex;gap:0.5rem;flex:1">
            <select
              id="sttModel"
              class="settings-input settings-select"
              style="flex:1"
              value={model.value}
              onChange={onModelChange}
            >
              {models.value.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              <option value={CUSTOM}>custom…</option>
            </select>
            <button
              type="button"
              id="sttRefreshModels"
              title="Refresh model list"
              style="flex-shrink:0"
              onClick={() => loadModels(effectiveModel())}
            >
              ↺
            </button>
          </div>
        </div>
      )}

      {/* Custom model free-text: only when "custom…" is picked (never local). */}
      {!isLocal.value && isCustomModel.value && (
        <label class="settings-row" id="sttCustomModelRow">
          <span>Custom model</span>
          <input
            type="text"
            id="sttCustomModel"
            class="settings-input"
            placeholder="enter model id"
            value={customModel.value}
            onInput={(e) => (customModel.value = e.target.value)}
            onChange={save}
          />
        </label>
      )}

      {/* API key: OpenAI only. */}
      {isOpenai.value && (
        <label class="settings-row" id="sttApiKeyRow">
          <span>API key</span>
          <input
            type="password"
            id="sttApiKey"
            class="settings-input"
            placeholder={hasKey.value ? '•••• stored' : 'sk-…'}
            autocomplete="off"
            value={apiKey.value}
            onInput={(e) => (apiKey.value = e.target.value)}
            onChange={schedSave}
          />
        </label>
      )}

      {status.value && (
        <div id="sttStatus" class="settings-status" style={{ color: status.value.ok ? '#7ec87e' : '#c87e7e' }}>
          {status.value.msg}
        </div>
      )}

      <div class="settings-actions">
        <button type="button" id="sttProbeBtn" onClick={onProbe}>
          Check status
        </button>
        {/* Install + single run toggle: local only. */}
        {isLocal.value && (
          <>
            <button type="button" id="sttInstallBtn" onClick={onInstall}>
              {installed ? 'Reinstall' : 'Install local server'}
            </button>
            <button type="button" id="sttToggleBtn" onClick={onToggle} disabled={!installed}>
              {running ? 'Stop' : 'Start'}
            </button>
          </>
        )}
      </div>

      {action.value && (
        <div class="settings-status" id="sttActionStatus" style={{ color: action.value.ok ? '#7ec87e' : '#c87e7e' }}>
          {action.value.msg}
        </div>
      )}
    </section>
  );
}
