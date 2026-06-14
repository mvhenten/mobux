// STT helpers ported 1:1 from the inline IIFE in src/main.rs. Kept framework-
// free so the behaviour is auditable against the original.

export const FALLBACK_MODELS = {
  openai: ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'],
  local: [
    'Systran/faster-whisper-small',
    'Systran/faster-whisper-small.en',
    'Systran/faster-whisper-medium.en',
  ],
  network: [
    'Systran/faster-whisper-base.en',
    'Systran/faster-whisper-small.en',
    'Systran/faster-whisper-medium.en',
  ],
};

// Defaults a kind falls back to when it has no stored provider row.
export function kindDefaults(kind) {
  if (kind === 'local')
    return { host: 'http://127.0.0.1', port: '5200', model: FALLBACK_MODELS.local[0] };
  if (kind === 'openai')
    return { host: 'https://api.openai.com', port: '443', model: 'whisper-1' };
  return { host: '', port: '', model: FALLBACK_MODELS.network[0] };
}

// Normalise a host string to always carry a scheme (default http://). Accepts a
// bare hostname like "lab" → "http://lab".
export function normalizeHost(h) {
  h = (h || '').trim().replace(/\/$/, '');
  if (!h) return h;
  if (!/^https?:\/\//i.test(h)) return 'http://' + h;
  return h;
}

// Parse a pasted full URL into { host, port } fields. host carries scheme +
// hostname only (no port); port is the explicit port or the scheme default.
// Returns null if the input isn't parseable as a URL with a port/path.
export function parseUrlIntoFields(raw) {
  if (!raw) return null;
  let normalised = raw.trim();
  if (!/^https?:\/\//i.test(normalised)) normalised = 'http://' + normalised;
  let u;
  try {
    u = new URL(normalised);
  } catch (_) {
    return null;
  }
  const host = u.protocol + '//' + u.hostname;
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return { host, port };
}

// Fetch discovered models for a provider; fall back to the static list on any
// failure. Mirrors fetchModels() in the original.
export async function fetchModels(kind, host, port) {
  const query =
    '?kind=' +
    encodeURIComponent(kind) +
    '&host=' +
    encodeURIComponent(normalizeHost(host)) +
    '&port=' +
    encodeURIComponent(port || '');
  try {
    const resp = await fetch('/api/stt/models' + query);
    if (!resp.ok) throw new Error('not ok');
    const data = await resp.json();
    if (!data.models || !data.models.length) throw new Error('empty');
    return data.models;
  } catch (_) {
    return FALLBACK_MODELS[kind] || FALLBACK_MODELS.local;
  }
}
