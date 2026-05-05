// Theme picker on the settings page. Populates the <select>, saves to
// localStorage on change, and broadcasts to any open terminal tab via
// the 'storage' event (cross-tab) and a same-doc 'mobux:theme' event.

import { THEMES, getStoredThemeId, setStoredThemeId, applyTheme } from './themes.js';

const select = document.getElementById('themeSelect');
if (select) {
  for (const theme of THEMES) {
    const opt = document.createElement('option');
    opt.value = theme.id;
    opt.textContent = theme.label;
    select.appendChild(opt);
  }
  select.value = getStoredThemeId();

  select.addEventListener('change', () => {
    const id = select.value;
    setStoredThemeId(id);
    // Same-doc dispatch — the 'storage' event only fires in OTHER
    // documents, so terminal tabs in OTHER browser tabs pick it up
    // automatically while we ping the current tab explicitly.
    applyTheme(id);
    window.dispatchEvent(new CustomEvent('mobux:theme', { detail: id }));
  });
}
