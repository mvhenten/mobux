import { useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { u } from "../../lib/base.js";
import { getPref, setPref } from "../../lib/prefs.js";
import {
  Actions,
  Button,
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
// Two voices can read the terminal. The local one runs a neural checkpoint in
// the mobux process and is what the reader uses whenever it is ready; the
// browser's Web Speech voice is the fallback, and its voice list and pitch
// dial only apply there. Test speaks through the same endpoint the reader
// does, so what it plays is what a tap on a speaker icon plays.

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
  if (lv.enabled && lv.state === "ready") return "Host voice";
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
  useEffect(() => {
    prefs.value = loadPrefs();
    loadLocalVoice();
  }, []);

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
        The reader speaks through the voice on this host when it is ready, and
        falls back to this browser's voice. Voice and pitch apply to the browser
        voice only.
      </Lede>
      <Group title="Voice on this host">
        <div class="settings-row" id="listenLocalVoice">
          <span class="settings-label">
            <span class="settings-title">Host voice</span>
          </span>
          <span class="settings-trail">
            <span class="settings-value listen-value" data-state={lv.state}>
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
