// external-link.js — open a URL outside the app shell, not inside it.
//
// In a TWA (Trusted Web Activity, package id `io.github.mvhenten.mobux`),
// a link to another origin would otherwise open inside the installed app
// shell (or a Chrome Custom Tab that looks like it). External links should
// leave the shell and open in the user's system default browser (Firefox,
// Chrome, whatever they configured). Android's intent:// URL scheme with
// action=VIEW and no package= attribute forces the system to resolve
// through the default browser.
//
// TWA detection: document.referrer starts with 'android-app://' when
// running inside the TWA shell.
//
// On desktop / regular browsers, this uses the standard anchor-click
// new-tab behavior.
//
// One external-open path for the whole app, across both frontends: the
// classic terminal (tapped URLs in the buffer, mic-overlay's report link,
// xterm's own link clicks) and the Preact SPA (any rendered anchor to
// another origin). `installExternalLinkHandler` wires a single delegated
// click handler so every SPA anchor to a non-mobux origin escapes the
// shell without each call site having to opt in.

// Helper for navigation - exposed for test stubbing via
// window.__mobuxNavigateToUrl (see terminal.js).
export function navigateToUrl(url) {
  window.location.assign(url);
}

// True when `url` resolves to an origin other than the page's own — i.e. a
// link that should leave the app shell. Relative and same-origin URLs
// (in-app navigation, `/settings`, download links under `/install/…`) stay
// in-shell. Only http(s) is treated as external here; mailto:/tel:/intent:
// and other schemes are left to the platform's own handling.
export function isExternalUrl(url) {
  try {
    const u = new URL(url, window.location.href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return u.origin !== window.location.origin;
  } catch (_) {
    return false;
  }
}

export function openExternal(url) {
  const isTWA = document.referrer.startsWith('android-app://');

  if (isTWA && /^https?:\/\//.test(url)) {
    // Build an intent:// URL that opens the link in the system default
    // browser. Format:
    // intent://<url>#Intent;action=android.intent.action.VIEW;scheme=<scheme>;S.browser_fallback_url=<url>;end;
    const urlObj = new URL(url);
    const intentUrl = `intent://${urlObj.host}${urlObj.pathname}${urlObj.search}${urlObj.hash}#Intent;action=android.intent.action.VIEW;scheme=${urlObj.protocol.replace(':', '')};S.browser_fallback_url=${encodeURIComponent(url)};end;`;
    // window.__mobuxNavigateToUrl is the test stub seam; fall back to the
    // real navigate so this module works standalone in the SPA too.
    const navigate = window.__mobuxNavigateToUrl || navigateToUrl;
    navigate(intentUrl);
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

// Delegated, capture-phase click handler: any left-click on an anchor whose
// href points to another origin is routed through openExternal (system
// browser in the TWA, new tab elsewhere) instead of navigating the shell.
// Idempotent across both frontends via a window flag — the classic engine
// and the SPA both call it, but only the first install takes effect.
export function installExternalLinkHandler(target) {
  if (window.__mobuxExternalLinkHandlerInstalled) return;
  window.__mobuxExternalLinkHandlerInstalled = true;

  (target || document).addEventListener(
    'click',
    (e) => {
      // Modified clicks (new tab/window) and downloads keep the browser's
      // own default behavior. `e.defaultPrevented` here can only reflect a
      // listener that already ran earlier in the *capture* phase (e.g. on
      // `window`, or another document-level capture listener registered
      // before this one) — a listener on the anchor itself fires later
      // (deeper in capture, or during bubble), so this isn't a general
      // "handled elsewhere" guard.
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      )
        return;
      const anchor = e.target.closest && e.target.closest('a[href]');
      if (!anchor) return;
      if (anchor.hasAttribute('download')) return;
      const href = anchor.getAttribute('href');
      if (!href || !isExternalUrl(href)) return;
      e.preventDefault();
      openExternal(anchor.href);
    },
    true,
  );
}
