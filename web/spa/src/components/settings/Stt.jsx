import { useEffect, useRef } from "preact/hooks";
import { signal, computed } from "@preact/signals";
import { apiGet, apiPutJSON, apiPost } from "../../lib/api.js";
import {
  FALLBACK_MODELS,
  kindDefaults,
  parseUrlIntoFields,
  fetchModels,
} from "../../lib/stt.js";

// ── State ────────────────────────────────────────────────────────────
// Per-kind cache of the last-known field values, seeded from GET on mount and
// kept in sync on save — mirrors `providerCache` in the original IIFE.
const cache = signal({}); // { local: {host,port,model,has_key}, ... }
const kind = signal("local");
const host = signal("");
const port = signal("");
const model = signal(FALLBACK_MODELS.local[0]);
const customModel = signal("");
const apiKey = signal("");
const hasKey = signal(false);
const models = signal(FALLBACK_MODELS.local.slice());
const status = signal(null); // { msg, ok }
const action = signal(null); // local model download status line
const sttStatus = signal(null); // { state, message, progress, ... }
const localEngine = signal(true);

const CUSTOM = "__custom__";

const DOWNLOAD_CEILING_MS = 45 * 60 * 1000;
const WARMING_TEXT =
  "Downloading the speech model… this happens once and can take a few minutes.";

function elapsed(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// The server sends a sentence for every non-ready local state; fall back only
// when an older server is answering a newer bundle.
function stateMessage(s, fallback) {
  return s?.message || fallback;
}

// Which fields a kind exposes — this is the component-model replacement for the
// old visibility toggling. We render only what applies (no [hidden]).
const isLocal = computed(() => kind.value === "local");
const isNetwork = computed(() => kind.value === "network");
const isOpenai = computed(() => kind.value === "openai");
const isCustomModel = computed(() => model.value === CUSTOM);

function flash(sig, msg, ok) {
  sig.value = { msg, ok };
}

// Effective model id sent to the backend (custom box wins when selected).
function effectiveModel() {
  return model.value === CUSTOM ? customModel.value.trim() : model.value;
}

// Every kind switch starts a discovery round trip, and switching twice leaves
// two in flight. They finish in whatever order the server answers — a provider
// with a host to probe takes seconds to time out, a local one answers at once
// — so the slowest write used to win and paint another provider's catalog over
// the current one. Only the newest request may touch the list.
let modelsRequest = 0;

async function loadModels(selected) {
  const ticket = ++modelsRequest;
  const forKind = kind.value;
  const list = await fetchModels(forKind, host.value, port.value);
  if (ticket !== modelsRequest || forKind !== kind.value) return;
  // If the saved model isn't discovered, keep it selectable (don't silently
  // drop to custom) — same as populateModelSelect's insert.
  const withSaved =
    selected && !list.includes(selected) ? [selected, ...list] : list.slice();
  models.value = withSaved;
  if (selected) {
    model.value = withSaved.includes(selected) ? selected : CUSTOM;
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
    const r = await apiPutJSON("/api/settings/stt", body);
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
    flash(status, r.ok ? "Saved ✓" : "Save failed.", r.ok);
  } catch (_) {
    flash(status, "Save failed.", false);
  }
}

function populateFromProvider(k) {
  const def = kindDefaults(k);
  const p = cache.value[k] || {};
  host.value = p.host || def.host;
  port.value = p.port || def.port;
  apiKey.value = "";
  hasKey.value = !!p.has_key;
  // Render this kind's own catalog straight away. Waiting for discovery left
  // the previous provider's models on screen — and pickable — for as long as
  // the round trip took.
  const selected = p.model || def.model;
  const known = (FALLBACK_MODELS[k] || FALLBACK_MODELS.local).slice();
  models.value = known.includes(selected) ? known : [selected, ...known];
  model.value = selected;
  loadModels(selected);
}

async function refreshSttStatus() {
  try {
    sttStatus.value = await apiGet("/api/stt/status");
  } catch (_) {}
}

// ── Component ────────────────────────────────────────────────────────
export function SttCard() {
  const saveTimer = useRef(null);
  const fetchTimer = useRef(null);

  // Load current config on mount (mirrors the original's initial fetch).
  useEffect(() => {
    apiGet("/api/settings/stt")
      .then((cfg) => {
        cache.value = cfg.providers || {};
        localEngine.value = cfg.localEngine !== false;
        const active = cfg.activeKind || "local";
        kind.value = active;
        populateFromProvider(active);
        if (active === "local") refreshSttStatus();
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
    if (kind.value === "local") refreshSttStatus();
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
      let normalised = /^https?:\/\//i.test(raw) ? raw : "http://" + raw;
      try {
        const u = new URL(normalised);
        if (u.port || (u.pathname && u.pathname !== "/")) {
          host.value = parsed.host;
          port.value = parsed.port;
        } else {
          host.value = u.protocol + "//" + u.hostname;
        }
      } catch (_) {}
    }
    schedFetchModels();
  };

  // Fetch the weights now rather than in the middle of a dictation.
  const onDownload = async () => {
    flash(action, WARMING_TEXT, true);
    let r;
    try {
      r = await apiPost("/api/stt/install");
    } catch (_) {
      flash(action, "Download request failed (network).", false);
      return;
    }
    if (!r.ok && r.status !== 202) {
      // A build with no engine is refused with a sentence and the command that
      // fixes it; the bare status code threw that away.
      const body = await r.json().catch(() => null);
      flash(
        action,
        (body && body.error) || "Download request failed: " + r.status,
        false,
      );
      await refreshSttStatus();
      return;
    }
    await waitForModel();
  };

  // The weights arrive on the first run, so the card polls through the
  // download instead of claiming a backend that cannot dictate yet is ready.
  const waitForModel = async () => {
    const began = Date.now();
    let errCount = 0;
    while (Date.now() - began < DOWNLOAD_CEILING_MS) {
      await new Promise((res) => setTimeout(res, 2000));
      let s;
      try {
        s = await apiGet("/api/stt/status");
        errCount = 0;
      } catch (_) {
        if (++errCount >= 5) {
          flash(action, "Model status unavailable.", false);
          return;
        }
        continue;
      }
      sttStatus.value = s;
      if (s.state === "warming") {
        flash(
          action,
          `${stateMessage(s, WARMING_TEXT)} (${elapsed(Date.now() - began)})`,
          true,
        );
        continue;
      }
      if (s.state === "ready") {
        flash(action, "Speech model ready.", true);
        return;
      }
      flash(action, stateMessage(s, "The speech model is not ready."), false);
      return;
    }
    flash(action, "The speech model is still downloading.", true);
  };

  const onProbe = async () => {
    try {
      const s = await apiGet("/api/stt/status");
      sttStatus.value = s;
      if (s.state === "warming") {
        flash(status, stateMessage(s, WARMING_TEXT), true);
        waitForModel();
        return;
      }
      if (s.state === "ready") {
        flash(status, `Provider ready (kind: ${s.kind})`, true);
        return;
      }
      flash(
        status,
        stateMessage(s, `Provider NOT reachable (${s.url || s.kind})`),
        false,
      );
    } catch (_) {
      flash(status, "Status check failed.", false);
    }
  };

  const sttState = sttStatus.value?.state;
  const engineMissing = !localEngine.value || sttState === "unsupported";
  const downloaded = sttState === "ready" || sttState === "warming";

  return (
    <section class="settings-group" id="stt-provider">
      <h2>Speech to text</h2>

      <label class="settings-row">
        <span class="settings-label">Provider</span>
        <select
          id="sttKind"
          class="settings-select"
          value={kind.value}
          onChange={onKindChange}
        >
          <option value="local">On this machine</option>
          <option value="network">Network (self-hosted)</option>
          <option value="openai">OpenAI</option>
        </select>
      </label>

      {/* Host + Port: only the self-hosted Network provider needs an endpoint.
          The local provider runs in this process — there is nothing to point at. */}
      {isNetwork.value && (
        <>
          <label class="settings-row settings-row--field" id="sttHostRow">
            <span class="settings-label">Host</span>
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
          <label class="settings-row settings-row--field" id="sttPortRow">
            <span class="settings-label">Port</span>
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

      <div class="settings-row settings-row--field" id="sttModelRow">
        <span class="settings-label">Model</span>
        <div style="display:flex;gap:0.5rem;flex:1;min-width:0">
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
            {!isLocal.value && <option value={CUSTOM}>custom…</option>}
          </select>
          <button
            type="button"
            id="sttRefreshModels"
            class="settings-btn"
            title="Refresh model list"
            style="flex-shrink:0"
            onClick={() => loadModels(effectiveModel())}
          >
            ↺
          </button>
        </div>
      </div>

      {/* Custom model free-text: only when "custom…" is picked. The local
          engine runs a fixed catalog, so there is nothing to type. */}
      {!isLocal.value && isCustomModel.value && (
        <label class="settings-row settings-row--field" id="sttCustomModelRow">
          <span class="settings-label">Custom model</span>
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
        <label class="settings-row settings-row--field" id="sttApiKeyRow">
          <span class="settings-label">API key</span>
          <input
            type="password"
            id="sttApiKey"
            class="settings-input"
            placeholder={hasKey.value ? "•••• stored" : "sk-…"}
            autocomplete="off"
            value={apiKey.value}
            onInput={(e) => (apiKey.value = e.target.value)}
            onChange={schedSave}
          />
        </label>
      )}

      {status.value && (
        <div
          id="sttStatus"
          class="settings-status"
          style={{ color: status.value.ok ? "#7ec87e" : "#c87e7e" }}
        >
          {status.value.msg}
        </div>
      )}

      {/* What the local engine is actually doing. The first run fetches the
          weights, which is progress, not a fault. */}
      {isLocal.value && sttState === "warming" && (
        <div
          class="settings-status"
          id="sttWarming"
          style={{ color: "#7ec87e" }}
        >
          {stateMessage(sttStatus.value, WARMING_TEXT)}
        </div>
      )}
      {isLocal.value && engineMissing && (
        <div
          class="settings-status"
          id="sttEngineMissing"
          style={{ color: "#c87e7e" }}
        >
          {stateMessage(
            sttStatus.value,
            "This build has no in-process speech engine.",
          )}
        </div>
      )}
      {isLocal.value && sttState === "failed" && (
        <div
          class="settings-status"
          id="sttModelFailed"
          style={{ color: "#c87e7e" }}
        >
          {stateMessage(
            sttStatus.value,
            "The speech model could not be prepared.",
          )}
        </div>
      )}

      <div class="settings-actions">
        <button type="button" id="sttProbeBtn" onClick={onProbe}>
          Check status
        </button>
        {isLocal.value && (
          <button
            type="button"
            id="sttDownloadBtn"
            onClick={onDownload}
            disabled={engineMissing}
          >
            {downloaded ? "Re-check model" : "Download speech model"}
          </button>
        )}
      </div>

      {action.value && (
        <div
          class="settings-status"
          id="sttActionStatus"
          style={{ color: action.value.ok ? "#7ec87e" : "#c87e7e" }}
        >
          {action.value.msg}
        </div>
      )}
    </section>
  );
}
