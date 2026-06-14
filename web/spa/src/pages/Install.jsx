// Install / onboarding page. Ports the content of the Rust-rendered `/install`
// page (install_page in src/main.rs): the CA-certificate step and the APK
// install step, with the same download links and Android instructions.
//
// The server page also renders QR codes (built from the request Host) so a
// desktop visitor can scan from a phone. QR generation is server-side only; the
// SPA's audience is the phone itself (where the download buttons are what's
// used), so we link to the server `/install` page for the scan-from-desktop
// case rather than bundle a QR encoder. The download endpoints are unchanged:
// /install/mobux-ca.crt and /install/mobux.apk (both public, served from disk).

export function InstallPage() {
  return (
    <main class="install-page">
      <section class="install-card">
        <h2>1. Install the CA certificate</h2>
        <p class="install-lede">
          Do this <strong>first</strong>. Without the CA, Android won't trust this server, the APK
          download will be blocked, and the installed app won't connect.
        </p>
        <div class="install-grid">
          <a class="install-btn" href="/install/mobux-ca.crt" download>
            Download CA certificate
          </a>
        </div>
        <p class="install-hint">After downloading, install it through Android Settings:</p>
        <ol class="install-steps">
          <li>Settings → Security &amp; privacy (or just Security)</li>
          <li>More security settings → Encryption &amp; credentials</li>
          <li>Install a certificate → CA certificate</li>
          <li>
            Acknowledge the warning, pick <code>mobux-ca.crt</code> from your Downloads
          </li>
        </ol>
        <p class="install-hint">
          Running with ACME / a publicly-trusted cert? Skip this step — there's no local CA to
          install.
        </p>
      </section>

      <section class="install-card">
        <h2>2. Install the app</h2>
        <p class="install-lede">Download the Android APK to install Mobux as a standalone app.</p>
        <div class="install-grid">
          <a class="install-btn" href="/install/mobux.apk" download>
            Download APK
          </a>
        </div>
        <p class="install-hint">
          If the APK isn't built yet, run <code>make twa</code> on the server.
        </p>
      </section>

      <section class="install-card">
        <h2>Scan from a desktop?</h2>
        <p class="install-lede">
          To scan a QR with your phone instead of downloading here, open the server's install page.
        </p>
        <div class="install-grid">
          <a class="install-btn" href="/install">
            Open install page (with QR codes) →
          </a>
        </div>
      </section>
    </main>
  );
}
