// Pure preference loader/saver for the Web Speech API listen feature.
//
// Kept side-effect-free: importing this module is safe on any page,
// including session pages that have no listen DOM. `listen-settings.js`
// re-exports + handles all settings-page interactions (voice list,
// voiceschanged listener, slider labels, etc.).
//
// Schema: { voice: string, rate: number, pitch: number }
// Rate/pitch are clamped to the same range the settings sliders expose
// (0.5–2.0). Out-of-range or non-numeric values fall back to defaults
// rather than propagating bad data to SpeechSynthesisUtterance.

const STORAGE_KEY = 'mobux.listen.prefs';
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
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw);
    return {
      voice: typeof parsed.voice === 'string' ? parsed.voice : DEFAULT_PREFS.voice,
      rate: clamp(parsed.rate, RATE_MIN, RATE_MAX, DEFAULT_PREFS.rate),
      pitch: clamp(parsed.pitch, PITCH_MIN, PITCH_MAX, DEFAULT_PREFS.pitch),
    };
  } catch (_) {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(prefs) {
  try {
    const sanitised = {
      voice: typeof prefs.voice === 'string' ? prefs.voice : DEFAULT_PREFS.voice,
      rate: clamp(prefs.rate, RATE_MIN, RATE_MAX, DEFAULT_PREFS.rate),
      pitch: clamp(prefs.pitch, PITCH_MIN, PITCH_MAX, DEFAULT_PREFS.pitch),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitised));
  } catch (_) {}
}

export { loadPrefs, savePrefs, DEFAULT_PREFS };
