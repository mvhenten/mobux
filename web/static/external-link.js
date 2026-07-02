// external-link.js — open a URL in the system browser, not a TWA Custom Tab.
//
// In a TWA (Trusted Web Activity, package id `io.github.mvhenten.mobux`),
// external links should open in the user's system default browser (e.g.
// Firefox, Chrome, whatever the user has configured), not Chrome Custom
// Tabs. Android's intent:// URL scheme with action=VIEW and no package=
// attribute forces the system to resolve through the default browser.
//
// TWA detection: document.referrer starts with 'android-app://' when
// running inside the TWA shell.
//
// On desktop / regular browsers, this uses the standard anchor-click
// new-tab behavior. Shared by terminal.js (tapped URLs in the buffer) and
// mic-overlay.js (the fault overlay's "Report issue" link) so there is one
// external-open path for the whole app.

// Helper for navigation - exposed for test stubbing
export function navigateToUrl(url) {
  window.location.assign(url);
}

export function openExternal(url) {
  const isTWA = document.referrer.startsWith('android-app://');

  if (isTWA && /^https?:\/\//.test(url)) {
    // Build an intent:// URL that opens the link in the system default
    // browser. Format:
    // intent://<url>#Intent;action=android.intent.action.VIEW;scheme=<scheme>;S.browser_fallback_url=<url>;end;
    const urlObj = new URL(url);
    const intentUrl = `intent://${urlObj.host}${urlObj.pathname}${urlObj.search}${urlObj.hash}#Intent;action=android.intent.action.VIEW;scheme=${urlObj.protocol.replace(':', '')};S.browser_fallback_url=${encodeURIComponent(url)};end;`;
    window.__mobuxNavigateToUrl(intentUrl);
    return;
  }

  // Non-TWA or non-http(s) URLs: use anchor-click fallback
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
