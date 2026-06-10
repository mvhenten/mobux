// Theme bundles. Each bundle pairs:
//   1. an Ace editor theme (sets editor bg/fg/gutter)
//   2. a 16-colour ANSI palette for sterk (sterk.options.theme.palette[0..15])
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
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    aceTheme: 'ace/theme/solarized_light',
    // solarized (Ethan Schoonover). Same 16 accents as solarized-dark;
    // only bg/fg flip — bg = base3 (#fdf6e3), fg = base00.
    background: '#fdf6e3',
    foreground: '#657b83',
    palette: [
      '#073642', '#dc322f', '#859900', '#b58900',
      '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#002b36', '#cb4b16', '#586e75', '#657b83',
      '#839496', '#6c71c4', '#93a1a1', '#fdf6e3',
    ],
  },
  {
    id: 'gruvbox-light',
    label: 'Gruvbox Light',
    aceTheme: 'ace/theme/gruvbox_light_hard',
    // gruvbox light (Pavel Pertsev). bg = bg0_h (#f9f5d7), fg = fg1.
    // ANSI black kept dark so color-0 text stays visible on the light bg.
    background: '#f9f5d7',
    foreground: '#3c3836',
    palette: [
      '#3c3836', '#cc241d', '#98971a', '#d79921',
      '#458588', '#b16286', '#689d6a', '#7c6f64',
      '#928374', '#9d0006', '#79740e', '#b57614',
      '#076678', '#8f3f71', '#427b58', '#282828',
    ],
  },
  {
    id: 'github-light',
    label: 'GitHub Light',
    aceTheme: 'ace/theme/github_light_default',
    // GitHub Light Default. Softened off-white bg (#f6f8fa) per the
    // project's muted/low-contrast preference; fg = #24292e.
    background: '#f6f8fa',
    foreground: '#24292e',
    palette: [
      '#24292e', '#d73a49', '#28a745', '#dbab09',
      '#0366d6', '#5a32a3', '#1b7c83', '#6a737d',
      '#959da5', '#cb2431', '#22863a', '#b08800',
      '#005cc5', '#5a32a3', '#3192aa', '#d1d5da',
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
  reader.style.background = theme.background || theme.palette[0];
  reader.style.color = theme.foreground || theme.palette[7] || '#c5c8c6';
}

// Push the bundle's palette onto the active terminal renderer.
// - sterk: writes into `__sterk.options.theme.palette` in place.
// - xterm: rebuilds `__xterm.options.theme` with the 16 ANSI slots
//   mapped onto xterm.js's named-color keys.
// Returns true if applied.
export function applyTerminalColors(theme) {
  // Sterk first (palette is just an array slot)
  const sterk = window.__sterk;
  if (sterk && sterk.options && sterk.options.theme && Array.isArray(sterk.options.theme.palette)) {
    sterk.options.theme.palette = theme.palette.slice(0, 16);
    sterk.options.theme.background = theme.background || theme.palette[0];
    sterk.options.theme.foreground = theme.foreground || theme.palette[7] || '#c5c8c6';
    return true;
  }

  // Xterm.js uses named keys for the ANSI palette (no `palette` array).
  // The 16 ANSI slots map to: black/red/green/yellow/blue/magenta/cyan/white
  // plus the brightX variants. xterm reads `theme.background`/`theme.foreground`
  // from the same options object.
  const xterm = window.__xterm;
  if (xterm && xterm.options) {
    const p = theme.palette;
    xterm.options.theme = {
      background: theme.background || p[0],
      foreground: theme.foreground || p[7] || '#c5c8c6',
      black: p[0],   red: p[1],     green: p[2],   yellow: p[3],
      blue:  p[4],   magenta: p[5], cyan:  p[6],   white: p[7],
      brightBlack: p[8],  brightRed: p[9],     brightGreen: p[10], brightYellow: p[11],
      brightBlue:  p[12], brightMagenta: p[13], brightCyan: p[14], brightWhite: p[15],
    };
    return true;
  }
  return false;
}

// Apply the Ace editor theme (background, default fg, gutter) live.
// `editor` is the Ace Editor instance accessed via sterk's renderer.
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
