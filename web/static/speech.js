// Reading a block out loud.
//
// Everything the reader wants spoken goes through `/api/tts/speak`, which
// normalizes the text server-side — ANSI stripped, paths humanized, a code
// block announced rather than recited — and then either synthesizes it with
// the local neural voice or hands the words back for the browser to say. The
// normalization runs either way, so the two voices read the same sentences.
//
// Rate comes from the same `listen_*` preferences the settings card writes:
// the local voice honours it as playback rate, the browser voice as utterance
// rate. Pitch only means something to the browser voice; a neural checkpoint
// has no pitch dial.

import { u } from "./base.js";
import { loadPrefs } from "./listen-prefs.js";

const BROWSER_AVAILABLE =
  typeof window !== "undefined" && "speechSynthesis" in window;

/// Whether anything at all can speak. False only in a browser without
/// speechSynthesis talking to a build without the local voice — the reader
/// hides its speaker icons rather than offering a dead button.
export function speechAvailable() {
  return BROWSER_AVAILABLE || localEngineReported !== "unsupported";
}

// What /api/tts/status last said. Seeded optimistically: the reader renders
// before the first status poll lands, and a build with the voice is the case
// where hiding the icons would be wrong.
//
// Only refreshEngineState() writes it. A single speak answering with the
// browser fallback used to latch it to "unsupported" for the life of the page,
// so one blip while the voice was still warming made the client stop believing
// the host had a voice at all.
let localEngineReported = "unknown";

let current = null;

export async function refreshEngineState() {
  const resp = await fetch(u("api/tts/status")).catch(() => null);
  if (!resp || !resp.ok) {
    localEngineReported = "unsupported";
    return {
      state: "unsupported",
      message: "The voice status is unreachable.",
    };
  }
  const status = await resp.json();
  localEngineReported = status.enabled ? status.state : "unsupported";
  return status;
}

/// Stop whatever is speaking. Safe to call when nothing is.
export function stopSpeech() {
  if (BROWSER_AVAILABLE) window.speechSynthesis.cancel();
  if (current) {
    const playing = current;
    current = null;
    playing.stop();
  }
}

/// Speak one block.
///
/// `request` is what the reader knows about it: `{ text, kind, expand,
/// language }`, where `kind` is the reader's own block classification and
/// `expand` is the explicit "read the code, do not just announce it".
///
/// `onEnd` fires once, when the block finishes or fails. `onError` fires with
/// a sentence worth showing before `onEnd` does — a speaker that goes quiet
/// without saying why is indistinguishable from a broken one.
export function speak(request, { onEnd, onError } = {}) {
  stopSpeech();

  const finish = () => {
    current = null;
    if (onEnd) onEnd();
  };
  const fail = (message) => {
    if (onError) onError(message);
    finish();
  };

  const token = { stop: () => {} };
  current = token;

  requestSpeech(request)
    .then((result) => {
      if (current !== token) return;
      if (result.kind === "audio") {
        playClip(result.clip, token, finish, fail);
        return;
      }
      speakInBrowser(result.sentences, token, finish, fail);
    })
    .catch((err) => {
      if (current !== token) return;
      // Deliberately not falling back to the raw block here. Normalization is
      // server-side, so the only text this side holds is the terminal bytes
      // themselves — escape codes, hashes, box drawing. Reading those aloud is
      // the thing this endpoint exists to prevent, and a failed request is
      // exactly when nobody is watching the screen to notice.
      fail(`Nothing was read: ${err.message}`);
    });

  return token;
}

async function requestSpeech(request) {
  const resp = await fetch(u("api/tts/speak"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: request.text || "",
      kind: request.kind || "prose",
      expand: !!request.expand,
      language: request.language || "",
    }),
  }).catch((err) => {
    throw new Error(`the voice could not be reached (${err.message}).`);
  });
  if (!resp.ok) {
    const reason = await resp.text().catch(() => "");
    throw new Error(reason || `the voice answered ${resp.status}`);
  }

  const type = resp.headers.get("content-type") || "";
  if (type.startsWith("audio/")) {
    return { kind: "audio", clip: await resp.blob() };
  }
  const body = await resp.json();
  return { kind: "browser", sentences: body.sentences || [body.text || ""] };
}

function playClip(clip, token, finish, fail) {
  const url = URL.createObjectURL(clip);
  const audio = new Audio(url);
  audio.playbackRate = loadPrefs().rate;

  const release = () => URL.revokeObjectURL(url);
  token.stop = () => {
    audio.pause();
    release();
  };
  audio.addEventListener("ended", () => {
    release();
    finish();
  });
  audio.addEventListener("error", () => {
    release();
    fail("This clip would not play in the browser.");
  });
  audio.play().catch((err) => {
    release();
    fail(`Playback was refused: ${err.message}`);
  });
}

function speakInBrowser(sentences, token, finish, fail) {
  if (!BROWSER_AVAILABLE) {
    fail(
      "This build has no voice and this browser has no speech synthesis, so nothing can read it aloud.",
    );
    return;
  }
  const prefs = loadPrefs();
  const voices = window.speechSynthesis.getVoices();
  const chosen = prefs.voice
    ? voices.find((v) => v.name === prefs.voice)
    : null;

  let index = 0;
  let cancelled = false;
  token.stop = () => {
    cancelled = true;
    window.speechSynthesis.cancel();
  };

  const next = () => {
    if (cancelled) return;
    if (index >= sentences.length) {
      finish();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(sentences[index]);
    utterance.rate = prefs.rate;
    utterance.pitch = prefs.pitch;
    if (chosen) utterance.voice = chosen;
    utterance.onend = () => {
      index++;
      next();
    };
    utterance.onerror = () => {
      if (!cancelled) fail("The browser voice stopped partway through.");
    };
    window.speechSynthesis.speak(utterance);
  };
  next();
}
