import { useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import { u } from "../../lib/base.js";
import { getPref, setPref } from "../../lib/prefs.js";
import { apiGet, apiPutJSON } from "../../lib/api.js";
import { TTS_KINDS, TTS_KIND_SHORT, ttsFields } from "../../lib/tts.js";
import {
  Actions,
  Button,
  FieldRow,
  Group,
  Lede,
  NavRow,
  SelectRow,
  SliderRow,
  Status,
} from "./ui.jsx";

// Listen card. Rate and pitch are the server-held `listen_*` preferences,
// global across devices.
//
// The reader speaks through the voice provider picked here: the neural
// checkpoint in the mobux process, Mistral Voxtral, a self-hosted
// OpenAI-compatible voice, or Kyutai Pocket TTS. The browser's Web Speech voice
// is the fallback, and its voice list and pitch dial only apply there. Test
// speaks through the same endpoint the reader does, so what it plays is what a
// tap on a speaker icon plays.

const RATE_MIN = 0.5;
const RATE_MAX = 2.0;
const PITCH_MIN = 0.5;
const PITCH_MAX = 2.0;

function clamp(n, lo, hi, fallback) {
  const v = typeof n === "number" ? n : parseFloat(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}

function loadPrefs() {
  const voice = getPref("listen_voice");
  return {
    voice: typeof voice === "string" ? voice : "",
    rate: clamp(getPref("listen_rate"), RATE_MIN, RATE_MAX, 1.0),
    pitch: clamp(getPref("listen_pitch"), PITCH_MIN, PITCH_MAX, 1.0),
  };
}

const available = signal(
  typeof window !== "undefined" && "speechSynthesis" in window,
);
const voices = signal([]);
// Seeded empty, not loadPrefs() — this module evaluates as part of the static
// import chain (main.jsx -> app.jsx -> Settings.jsx -> this file), which runs
// before main.jsx's boot() has awaited prefs.hydrate(). Reading the server
// value happens in the mount effect below instead, exactly like Theme.jsx: by
// the time ListenCard mounts, App has already rendered, which only happens
// after hydrate() resolved.
const prefs = signal({ voice: "", rate: 1.0, pitch: 1.0 });
const localVoice = signal({ enabled: false, state: "unknown", message: "" });
const preparing = signal(false);

// The provider picker, seeded from GET /api/settings/tts. The key itself never
// comes back; `has_key` says one is stored.
const providers = signal({});
const ttsKind = signal("local");
const ttsHost = signal("");
const ttsPort = signal("");
const ttsModel = signal("");
const ttsVoice = signal("");
const ttsKey = signal("");
const ttsHasKey = signal(false);
const ttsSaved = signal(null);

function showProvider(kind) {
  const p = providers.value[kind] || {};
  ttsHost.value = p.host || "";
  ttsPort.value = p.port || "";
  ttsModel.value = p.model || "";
  ttsVoice.value = p.voice || "";
  ttsKey.value = "";
  ttsHasKey.value = !!p.has_key;
}

async function loadProviders() {
  try {
    const cfg = await apiGet("/api/settings/tts");
    providers.value = cfg.providers || {};
    ttsKind.value = cfg.activeKind || "local";
  } catch (_) {
    ttsSaved.value = {
      msg: "The voice provider settings are unreachable.",
      ok: false,
    };
  }
  showProvider(ttsKind.value);
}

async function saveProvider() {
  const kind = ttsKind.value;
  const body = {
    kind,
    host: ttsHost.value.trim(),
    port: String(ttsPort.value).trim(),
    model: ttsModel.value.trim(),
    voice: ttsVoice.value.trim(),
  };
  if (ttsKey.value) body.api_key = ttsKey.value;
  let r;
  try {
    r = await apiPutJSON("/api/settings/tts", body);
  } catch (_) {
    ttsSaved.value = {
      msg: "Save failed: the server did not answer.",
      ok: false,
    };
    return;
  }
  if (!r.ok) {
    const reason = await r.text().catch(() => "");
    ttsSaved.value = { msg: `Save failed: ${reason || r.status}`, ok: false };
    return;
  }
  const prev = providers.value[kind] || {};
  providers.value = {
    ...providers.value,
    [kind]: { ...prev, ...body, has_key: body.api_key ? true : !!prev.has_key },
  };
  ttsHasKey.value = providers.value[kind].has_key;
  ttsKey.value = "";
  ttsSaved.value = { msg: "Saved ✓", ok: true };
  await loadLocalVoice();
}

async function loadLocalVoice() {
  const resp = await fetch(u("/api/tts/status")).catch(() => null);
  if (!resp || !resp.ok) {
    localVoice.value = {
      enabled: false,
      state: "unsupported",
      message: "The voice status is unreachable.",
    };
    return;
  }
  localVoice.value = await resp.json();
}

function voiceSummary() {
  const lv = localVoice.value;
  if (lv.enabled && lv.state === "ready")
    return TTS_KIND_SHORT[lv.kind] || "Host voice";
  return prefs.value.voice || "Browser default";
}

export function ListenRow() {
  useEffect(() => {
    prefs.value = loadPrefs();
    loadLocalVoice();
  }, []);
  return (
    <NavRow
      row="listen"
      to="/settings/listen"
      label="Listen"
      secondary="Read the terminal aloud"
      value={voiceSummary()}
    />
  );
}

export function ListenCard() {
  const saveTimer = useRef(null);
  useEffect(() => {
    prefs.value = loadPrefs();
    loadLocalVoice();
    loadProviders();
  }, []);

  const schedSave = () => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(saveProvider, 700);
  };

  const onKindChange = (e) => {
    ttsKind.value = e.target.value;
    showProvider(ttsKind.value);
    saveProvider();
  };

  const field = (sig) => ({
    value: sig.value,
    onInput: (e) => (sig.value = e.target.value),
    onChange: schedSave,
  });

  // Populate voice list; Chrome fires voiceschanged asynchronously.
  useEffect(() => {
    if (!available.value) return;

    function populate() {
      voices.value = window.speechSynthesis.getVoices();
    }
    populate();
    window.speechSynthesis.addEventListener("voiceschanged", populate);
    return () =>
      window.speechSynthesis.removeEventListener("voiceschanged", populate);
  }, []);

  function setVoice(e) {
    const voice = e.target.value;
    prefs.value = { ...prefs.value, voice };
    setPref("listen_voice", voice);
  }

  const dial = (key, min, max) => ({
    onInput: (e) => {
      prefs.value = { ...prefs.value, [key]: parseFloat(e.target.value) };
    },
    onCommit: (e) => {
      const v = clamp(parseFloat(e.target.value), min, max, 1.0);
      prefs.value = { ...prefs.value, [key]: v };
      setPref(`listen_${key}`, v);
    },
  });

  async function prepare() {
    preparing.value = true;
    const resp = await fetch(u("/api/tts/prepare"), { method: "POST" }).catch(
      () => null,
    );
    preparing.value = false;
    if (!resp || !resp.ok) {
      localVoice.value = {
        ...localVoice.value,
        state: "failed",
        message: resp
          ? await resp.text()
          : "The voice could not be prepared: the server did not answer.",
      };
      return;
    }
    await loadLocalVoice();
  }

  async function test() {
    if (available.value) window.speechSynthesis.cancel();
    const line = "Mobux listen mode test, one two three.";
    const resp = await fetch(u("/api/tts/speak"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: line, kind: "prose" }),
    }).catch(() => null);

    const current = loadPrefs();
    if (
      resp &&
      resp.ok &&
      (resp.headers.get("content-type") || "").startsWith("audio/")
    ) {
      const audio = new Audio(URL.createObjectURL(await resp.blob()));
      audio.playbackRate = current.rate;
      audio.play();
      loadLocalVoice();
      return;
    }
    // A provider that failed still answers 200 with the words and why, so the
    // card can say which voice failed instead of quietly using the browser.
    const fallback =
      resp && resp.ok ? await resp.json().catch(() => null) : null;
    if (fallback && fallback.reason) {
      ttsSaved.value = {
        msg: `Spoken by the browser voice: ${fallback.reason}`,
        ok: false,
      };
    }
    if (!available.value) {
      localVoice.value = {
        ...localVoice.value,
        state: "failed",
        message: "Nothing on this host or in this browser can read text aloud.",
      };
      return;
    }
    const utt = new SpeechSynthesisUtterance(line);
    if (current.voice) {
      const found = window.speechSynthesis
        .getVoices()
        .find((v) => v.name === current.voice);
      if (found) utt.voice = found;
    }
    utt.rate = current.rate;
    utt.pitch = current.pitch;
    window.speechSynthesis.speak(utt);
    loadLocalVoice();
  }

  const lv = localVoice.value;
  const fields = ttsFields(ttsKind.value);
  const voiceOptions = [
    { value: "", label: "Default" },
    ...voices.value.map((v) => ({
      value: v.name,
      label: `${v.name} (${v.lang})`,
    })),
  ];

  return (
    <div id="listen-settings">
      <Lede>
        The reader speaks through the voice provider below when it is ready, and
        falls back to this browser's voice. Voice and pitch apply to the browser
        voice only.
      </Lede>
      <Group title="Voice provider" id="ttsProvider">
        <SelectRow
          id="ttsKind"
          label="Provider"
          value={ttsKind.value}
          options={TTS_KINDS}
          onChange={onKindChange}
        />
        {fields.endpoint && (
          <FieldRow rowId="ttsHostRow" label="Host">
            <input
              type="text"
              id="ttsHost"
              class="settings-input"
              placeholder="http://127.0.0.1"
              {...field(ttsHost)}
            />
          </FieldRow>
        )}
        {fields.endpoint && (
          <FieldRow rowId="ttsPortRow" label="Port">
            <input
              type="number"
              id="ttsPort"
              class="settings-input"
              placeholder="8000"
              min="1"
              max="65535"
              {...field(ttsPort)}
            />
          </FieldRow>
        )}
        {fields.model && (
          <FieldRow rowId="ttsModelRow" label="Model">
            <input
              type="text"
              id="ttsModel"
              class="settings-input"
              {...field(ttsModel)}
            />
          </FieldRow>
        )}
        {fields.voice && (
          <FieldRow rowId="ttsVoiceRow" label="Voice">
            <input
              type="text"
              id="ttsVoice"
              class="settings-input"
              {...field(ttsVoice)}
            />
          </FieldRow>
        )}
        {fields.apiKey && (
          <FieldRow rowId="ttsApiKeyRow" label="API key">
            <input
              type="password"
              id="ttsApiKey"
              class="settings-input"
              autocomplete="off"
              placeholder={ttsHasKey.value ? "•••• stored" : "API key"}
              {...field(ttsKey)}
            />
          </FieldRow>
        )}
      </Group>
      <Status id="ttsStatus" status={ttsSaved.value} />
      <Actions>
        <Button id="ttsTest" variant="secondary" onClick={test}>
          Test voice
        </Button>
      </Actions>
      <Group title="Voice status">
        <div class="settings-row" id="listenLocalVoice">
          <span class="settings-label">
            <span class="settings-title">
              {TTS_KINDS.find((k) => k.value === (lv.kind || "local"))?.label ||
                "Host voice"}
            </span>
          </span>
          <span class="settings-trail">
            <span class="settings-value" data-state={lv.state}>
              {lv.state}
            </span>
          </span>
        </div>
        {lv.enabled && lv.state !== "ready" ? (
          <Actions>
            <Button
              id="listenPrepare"
              variant="primary"
              disabled={preparing.value}
              onClick={prepare}
            >
              {preparing.value ? "Preparing…" : "Prepare voice"}
            </Button>
          </Actions>
        ) : null}
      </Group>
      {lv.message && (
        <Status
          id="listenLocalVoiceMessage"
          kind={lv.state === "ready" || lv.state === "warming" ? "ok" : "error"}
          status={lv.message}
        />
      )}
      {available.value ? (
        <div id="listenCapable">
          <Group title="Browser voice">
            <SelectRow
              id="listenVoice"
              label="Voice"
              value={prefs.value.voice}
              options={voiceOptions}
              onChange={setVoice}
            />
            <SliderRow
              id="listenRate"
              valueId="listenRateValue"
              label="Rate"
              min={RATE_MIN}
              max={RATE_MAX}
              step="0.1"
              value={prefs.value.rate}
              {...dial("rate", RATE_MIN, RATE_MAX)}
            />
            <SliderRow
              id="listenPitch"
              valueId="listenPitchValue"
              label="Pitch"
              min={PITCH_MIN}
              max={PITCH_MAX}
              step="0.1"
              value={prefs.value.pitch}
              {...dial("pitch", PITCH_MIN, PITCH_MAX)}
            />
          </Group>
          <Actions>
            <Button id="listenTest" variant="secondary" onClick={test}>
              Test voice
            </Button>
          </Actions>
        </div>
      ) : (
        <div id="listenUnavailable">
          <Status
            kind="error"
            status="This browser has no speech synthesis, so only the voice on this host can read aloud."
          />
        </div>
      )}
    </div>
  );
}
