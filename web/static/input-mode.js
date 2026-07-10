// Mobile input mode: buffered (default upstream) vs stream (live keystrokes to PTY).
//
// Stream mode sends each character as you type so interactive TUIs (slash menus,
// tab completion, prompts) work from the phone input bar.

export const STORAGE_KEY = 'mobux.input.mode';

export function getInputMode() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'buffered' || v === 'stream') return v;
    // Personal fork default: stream so slash menus / tab completion work OOTB.
    return 'stream';
  } catch (_) {
    return 'stream';
  }
}

export function setInputMode(mode) {
  if (mode !== 'buffered' && mode !== 'stream') return;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch (_) {}
}
