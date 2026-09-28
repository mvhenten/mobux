// Opens a settings screen from the terminal view without leaving the
// document: the terminal is a hash route of the same SPA (/app#/s/<name>), so
// pushing the settings hash swaps the route in place, keeps whatever path
// prefix the app is mounted under, and leaves the terminal as the previous
// history entry for the settings back chevron. `mobuxBack` is the marker the
// SPA's back control reads (web/spa/src/components/settings/ui.jsx).
export function openSettings(path = '/settings') {
  const oldURL = location.href;
  history.pushState({ mobuxBack: true }, '', '#' + path);
  window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: location.href }));
}

export function linkToSettings(anchor, path) {
  anchor.href = '#' + path;
  anchor.addEventListener('click', (e) => {
    e.preventDefault();
    openSettings(path);
  });
  return anchor;
}
