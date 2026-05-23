// Theme bundles. Each bundle pairs:
//   1. an Ace editor theme (sets editor bg/fg/gutter)
//   2. a 16-colour ANSI palette for libterm (Terminal.colors[0..15])
//   3. a matching reader-mode --ansi-* CSS variable set on #reader.
//
// Storage key: localStorage['mobux:theme']. Default: tomorrow-night-soft.
//
// Apply on page load and on user selection. The picker lives in the
// settings page; selection broadcasts via the 'storage' event so an
// open terminal tab swaps live without a page reload.
//
// All palettes are deliberately muted/low-contrast — a phone screen at
// night doesn't tolerate saturated bgs (see PR #57). The luminance
// contrast pick in aceterm/aceterm.js works against any palette by
// design (#60), so we don't need per-theme threshold tuning.

const STORAGE_KEY = 'mobux:theme';
const DEFAULT_THEME = 'tomorrow-night-soft';

// Ordered for the dropdown — first entry is the default.
export const THEMES = [
  {
    id: 'tomorrow-night-soft',
    label: 'Tomorrow Night Soft',
    aceTheme: 'ace/theme/tomorrow_night',
    palette: [
      '#1e1e1e', '#cc6666', '#b5bd68', '#f0c674',
      '#81a2be', '#b294bb', '#8abeb7', '#c5c8c6',
      '#5c6370', '#e06c75', '#98c379', '#e5c07b',
      '#61afef', '#c678dd', '#56b6c2', '#ffffff',
    ],
  },
  {
    id: 'gruvbox-dark-soft',
    label: 'Gruvbox Dark Soft',
    aceTheme: 'ace/theme/gruvbox',
    // gruvbox dark soft (Pavel Pertsev). bg0_s = 32302f, fg = ebdbb2.
    palette: [
      '#32302f', '#cc241d', '#98971a', '#d79921',
      '#458588', '#b16286', '#689d6a', '#a89984',
      '#928374', '#fb4934', '#b8bb26', '#fabd2f',
      '#83a598', '#d3869b', '#8ec07c', '#ebdbb2',
    ],
  },
  {
    id: 'nord',
    label: 'Nord',
    aceTheme: 'ace/theme/nord_dark',
    // nord (arcticicestudio/nord). bg = nord0 (#2e3440).
    palette: [
      '#2e3440', '#bf616a', '#a3be8c', '#ebcb8b',
      '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0',
      '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b',
      '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4',
    ],
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    aceTheme: 'ace/theme/solarized_dark',
    // solarized (Ethan Schoonover). bg = base03 (#002b36), fg = base0.
    palette: [
      '#073642', '#dc322f', '#859900', '#b58900',
      '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#002b36', '#cb4b16', '#586e75', '#657b83',
      '#839496', '#6c71c4', '#93a1a1', '#fdf6e3',
    ],
  },
];

const BY_ID = Object.fromEntries(THEMES.map((t) => [t.id, t]));

export function getStoredThemeId() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && BY_ID[v]) return v;
  } catch (_) {}
  return DEFAULT_THEME;
}

export function setStoredThemeId(id) {
  if (!BY_ID[id]) return;
  try { localStorage.setItem(STORAGE_KEY, id); } catch (_) {}
}

export function getTheme(id) {
  return BY_ID[id] || BY_ID[DEFAULT_THEME];
}

// Push the bundle's --ansi-* vars onto #reader so the reader-mode
// tokenizer (term-tokenizer.js, which emits `var(--ansi-N)`) renders
// the same SGR codes the same way as the live terminal view.
export function applyReaderVars(theme) {
  const reader = document.getElementById('reader');
  if (!reader) return;
  for (let i = 0; i < 16; i++) {
    reader.style.setProperty(`--ansi-${i}`, theme.palette[i]);
  }
}

// Push the bundle's palette onto an active libterm Terminal class —
// the constructor copied Terminal.colors into defAttr at instantiation,
// but updating Terminal.colors[i] in-place still affects all rendered
// cells via the colour-lookup path (libterm reads colors[i] each frame
// when computing inline styles). Returns true if applied.
export function applyTerminalColors(theme) {
  const Terminal = window.__Aceterm && window.__Aceterm.Terminal;
  if (!Terminal) return false;
  if (typeof Terminal.setColors === 'function') {
    // setColors replaces 16/256/special slots — pass undefined for the
    // 240-entry 256-colour block and the special block so we only
    // touch the 16 we care about.
    Terminal.setColors(undefined, undefined, theme.palette.slice(0, 16));
    return true;
  }
  // Fallback: direct mutation. Some libterm builds expose an array.
  if (Array.isArray(Terminal.colors)) {
    for (let i = 0; i < 16; i++) Terminal.colors[i] = theme.palette[i];
    return true;
  }
  return false;
}

// Apply the Ace editor theme (background, default fg, gutter) live.
// `editor` is the Ace VirtualRenderer-backed Editor returned by
// Aceterm.createEditor in terminal-core.js.
export function applyEditorTheme(theme, editor) {
  if (!editor || typeof editor.setTheme !== 'function') return false;
  editor.setTheme(theme.aceTheme);
  return true;
}

// Apply all three layers. Editor is optional (the settings page has no
// terminal mounted; the terminal page passes its editor in).
export function applyTheme(id, { editor } = {}) {
  const theme = getTheme(id);
  applyReaderVars(theme);
  applyTerminalColors(theme);
  if (editor) applyEditorTheme(theme, editor);
  return theme;
}
