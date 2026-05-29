// install-hint.js — injects a thin, dismissible banner linking to /install on
// the home screen. Auto-hides when running as the installed TWA (display-mode
// standalone / minimal-ui / fullscreen, or android-app:// referrer) and stays
// hidden once dismissed (persisted in localStorage). Dependency-free IIFE.
(function () {
  'use strict';

  var installed =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    (document.referrer || '').startsWith('android-app://') ||
    window.navigator.standalone === true;
  if (installed) return;

  try {
    if (localStorage.getItem('mobux:install-hint') === 'dismissed') return;
  } catch (e) {
    // localStorage may throw (private mode, blocked cookies) — ignore and show.
  }

  var banner = document.createElement('div');
  banner.className = 'install-hint';

  var link = document.createElement('a');
  link.className = 'install-hint-link';
  link.href = '/install';
  link.textContent = 'Install Mobux as an app';

  var dismiss = document.createElement('button');
  dismiss.className = 'install-hint-x';
  dismiss.type = 'button';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.textContent = '✕';

  dismiss.addEventListener('click', function () {
    try {
      localStorage.setItem('mobux:install-hint', 'dismissed');
    } catch (e) {
      // ignore persistence failure — still remove for this session.
    }
    if (banner.parentNode) banner.parentNode.removeChild(banner);
  });

  banner.appendChild(link);
  banner.appendChild(dismiss);

  var header = document.querySelector('.app-header');
  if (header && header.parentNode) {
    header.parentNode.insertBefore(banner, header.nextSibling);
  } else {
    document.body.insertBefore(banner, document.body.firstChild);
  }
})();
