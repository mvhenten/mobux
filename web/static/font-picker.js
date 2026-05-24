// Font picker — settings page UI + storage helper for terminal-core.
//
// Sterk 2.6.0 ships five vendored monospace fonts and a `setFont(id)` API.
// mobux stores the chosen id in `localStorage['mobux:font']` and passes it
// to the sterk constructor on next session boot. We deliberately do NOT
// hot-swap the live terminal from the settings page — the settings tab is
// a separate document and the terminal tab picks up the new id on its next
// load (matches the theme-picker contract).
//
// The font list is hardcoded here rather than read from sterk's
// `BUILTIN_FONTS` because (a) the settings page does not load the sterk
// bundle and (b) we want display labels that are friendlier than the
// kebab-case ids. The id list MUST stay in sync with sterk's registry.

export const STORAGE_KEY = 'mobux:font';
export const DEFAULT_FONT_ID = 'jetbrains-mono';

export const FONTS = [
  { id: 'jetbrains-mono', label: 'JetBrains Mono' },
  { id: 'ibm-plex-mono', label: 'IBM Plex Mono' },
  { id: 'cascadia-mono', label: 'Cascadia Mono' },
  { id: 'fira-mono', label: 'Fira Mono' },
  { id: 'source-code-pro', label: 'Source Code Pro' },
];

const KNOWN_IDS = new Set(FONTS.map((f) => f.id));

export function getStoredFontId() {
  try {
    const id = localStorage.getItem(STORAGE_KEY);
    if (id && KNOWN_IDS.has(id)) return id;
  } catch (_) {}
  return DEFAULT_FONT_ID;
}

export function setStoredFontId(id) {
  if (!KNOWN_IDS.has(id)) return;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch (_) {}
}

// Wire the settings-page `<select id="fontSelect">`. Idempotent —
// safe to call on pages that don't have the element (returns early).
function initFontPicker() {
  const select = document.getElementById('fontSelect');
  if (!select) return;

  // Build options from FONTS (skip if already populated to avoid dupes
  // on hot-reload during dev).
  if (!select.options.length) {
    for (const font of FONTS) {
      const opt = document.createElement('option');
      opt.value = font.id;
      opt.textContent = font.label;
      select.appendChild(opt);
    }
  }
  select.value = getStoredFontId();

  select.addEventListener('change', () => {
    setStoredFontId(select.value);
    // Try to hot-swap the live terminal if this document happens to host
    // one (it doesn't, on /settings — but harmless and future-proof).
    const sterk = typeof window !== 'undefined' && window.__sterk
      ? window.__sterk._sterk
      : null;
    if (sterk && typeof sterk.setFont === 'function') {
      try { sterk.setFont(select.value); } catch (_) {}
    }
  });
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFontPicker);
  } else {
    initFontPicker();
  }
}
