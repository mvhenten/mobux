import { useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { getPref, setPref } from "../../lib/prefs.js";

// Listen card. Voice/rate/pitch are the server-held `listen_*` preferences,
// global across devices. Uses the Web Speech API for playback.

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

function savePrefs(prefs) {
  setPref("listen_voice", typeof prefs.voice === "string" ? prefs.voice : "");
  setPref("listen_rate", clamp(prefs.rate, RATE_MIN, RATE_MAX, 1.0));
  setPref("listen_pitch", clamp(prefs.pitch, PITCH_MIN, PITCH_MAX, 1.0));
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

export function ListenCard() {
  useEffect(() => {
    prefs.value = loadPrefs();
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
    const next = { ...prefs.value, voice: e.target.value };
    prefs.value = next;
    savePrefs(next);
  }

  function setRate(e) {
    const next = { ...prefs.value, rate: parseFloat(e.target.value) };
    prefs.value = next;
    savePrefs(next);
  }

  function setPitch(e) {
    const next = { ...prefs.value, pitch: parseFloat(e.target.value) };
    prefs.value = next;
    savePrefs(next);
  }

  function test() {
    window.speechSynthesis.cancel();
    const current = loadPrefs();
    const utt = new SpeechSynthesisUtterance(
      "Mobux listen mode test, one two three",
    );
    if (current.voice) {
      const found = window.speechSynthesis
        .getVoices()
        .find((v) => v.name === current.voice);
      if (found) utt.voice = found;
    }
    utt.rate = current.rate;
    utt.pitch = current.pitch;
    window.speechSynthesis.speak(utt);
  }

  return (
    <section class="settings-group" id="listen-settings">
      <h2>Listen</h2>
      {available.value ? (
        <div id="listenCapable">
          <label class="settings-row settings-row--field">
            <span class="settings-label">Voice</span>
            <select
              id="listenVoice"
              class="settings-select"
              value={prefs.value.voice}
              onChange={setVoice}
            >
              <option value="">Default</option>
              {voices.value.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </select>
          </label>
          <label class="settings-row">
            <span class="settings-label">Rate</span>
            <span class="settings-row-control">
              <input
                type="range"
                id="listenRate"
                min={RATE_MIN}
                max={RATE_MAX}
                step="0.1"
                value={prefs.value.rate}
                onInput={setRate}
              />
              <span class="listen-value" id="listenRateValue">
                {prefs.value.rate.toFixed(1)}
              </span>
            </span>
          </label>
          <label class="settings-row">
            <span class="settings-label">Pitch</span>
            <span class="settings-row-control">
              <input
                type="range"
                id="listenPitch"
                min={PITCH_MIN}
                max={PITCH_MAX}
                step="0.1"
                value={prefs.value.pitch}
                onInput={setPitch}
              />
              <span class="listen-value" id="listenPitchValue">
                {prefs.value.pitch.toFixed(1)}
              </span>
            </span>
          </label>
          <div class="settings-actions">
            <button type="button" id="listenTest" onClick={test}>
              Test
            </button>
          </div>
        </div>
      ) : (
        <div id="listenUnavailable" class="listen-unavailable">
          <p>Web Speech synthesis is not available in this browser.</p>
        </div>
      )}
    </section>
  );
}
