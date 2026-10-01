// What a phone's tab discard would lose, kept in sessionStorage: it is per
// tab and survives the discard. Saved as a terminal tab suspends, cleared as
// it resumes, and taken once by the next boot of the same route.
const KEY = "mobux:tab-state";

export function saveTabState(state) {
  try {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ route: location.hash, ...state }),
    );
  } catch (_) {
    // Storage blocked: a discard then boots in the default view.
  }
}

export function clearTabState() {
  try {
    sessionStorage.removeItem(KEY);
  } catch (_) {
    // Storage blocked: nothing was saved.
  }
}

export function takeTabState() {
  let raw = null;
  try {
    raw = sessionStorage.getItem(KEY);
  } catch (_) {
    return null;
  }
  clearTabState();
  if (!raw) return null;
  const saved = parse(raw);
  if (!saved || saved.route !== location.hash) return null;
  return saved;
}

function parse(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}
