// Preference loader/saver for the Web Speech API listen feature.
//
// The voice/rate/pitch settings are server-held preferences (prefs.js
// `listen_voice` / `listen_rate` / `listen_pitch`), global across devices.
// This module is the {voice, rate, pitch} adapter over prefs.js: importing it
// is safe on any page, including session pages that have no listen DOM.
//
// Schema: { voice: string, rate: number, pitch: number }
// Rate/pitch are clamped to the settings-slider range (0.5–2.0); out-of-range
// or non-numeric values fall back to defaults rather than propagating bad data
// to SpeechSynthesisUtterance.

import * as prefs from './prefs.js';

const DEFAULT_PREFS = Object.freeze({ voice: '', rate: 1.0, pitch: 1.0 });

const RATE_MIN = 0.5;
const RATE_MAX = 2.0;
const PITCH_MIN = 0.5;
const PITCH_MAX = 2.0;

function clamp(n, lo, hi, fallback) {
  const v = typeof n === 'number' ? n : parseFloat(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}

function loadPrefs() {
  const voice = prefs.get('listen_voice');
  return {
    voice: typeof voice === 'string' ? voice : DEFAULT_PREFS.voice,
    rate: clamp(prefs.get('listen_rate'), RATE_MIN, RATE_MAX, DEFAULT_PREFS.rate),
    pitch: clamp(prefs.get('listen_pitch'), PITCH_MIN, PITCH_MAX, DEFAULT_PREFS.pitch),
  };
}

function savePrefs(p) {
  prefs.set('listen_voice', typeof p.voice === 'string' ? p.voice : DEFAULT_PREFS.voice);
  prefs.set('listen_rate', clamp(p.rate, RATE_MIN, RATE_MAX, DEFAULT_PREFS.rate));
  prefs.set('listen_pitch', clamp(p.pitch, PITCH_MIN, PITCH_MAX, DEFAULT_PREFS.pitch));
}

export { loadPrefs, savePrefs, DEFAULT_PREFS };
