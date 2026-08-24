// Install / onboarding page. Ports the Rust-rendered /install page with
// client-side QR codes (uqr → inline SVG), so a desktop visitor can scan
// download URLs from a phone without switching to the server /install page.
//
// QR codes encode the absolute download URL derived from window.location,
// matching what the server does from the request Host header.

import { useEffect, useState } from "preact/hooks";
import { renderSVG } from "uqr";

function QrCode({ url }) {
  const svg = renderSVG(url, {
    pixelSize: 4,
    whiteColor: "#ffffff",
    blackColor: "#0f1115",
  });
  return (
    <div
      class="install-qr"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted SVG from uqr encoding a same-host URL
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function origin() {
  if (typeof window === "undefined") return "https://localhost";
  return window.location.origin;
}

// APK build is optional (`make twa`) and the file is gitignored, so
// /install/mobux.apk regularly 404s with a plain-text body. Without this
// probe the download button would hand the browser that 404 body, which
// Chrome saves as a garbage file (see the `download` attribute fix above —
// this covers the case where the attribute is correct but the file is
// simply missing). null = still checking, true/false = probed result.
function useApkAvailable() {
  const [available, setAvailable] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/install/mobux.apk", { method: "HEAD" })
      .then((res) => {
        if (!cancelled) setAvailable(res.ok);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return available;
}

export function InstallPage() {
  const base = origin();
  const apkUrl = base + "/install/mobux.apk";
  const caUrl = base + "/install/mobux-ca.crt";
  const apkAvailable = useApkAvailable();

  return (
    <main class="install-page">
      <section class="install-card">
        <h2>1. Install the CA certificate</h2>
        <p class="install-lede">
          Do this <strong>first</strong>. Without the CA, Android won't trust
          this server, the APK download will be blocked, and the installed app
          won't connect.
        </p>
        <div class="install-grid">
          <a
            class="install-btn"
            href="/install/mobux-ca.crt"
            download="mobux-ca.crt"
          >
            Download CA certificate
          </a>
          <QrCode url={caUrl} />
        </div>
        <p class="install-hint">
          After downloading, install it through Android Settings:
        </p>
        <ol class="install-steps">
          <li>Settings → Security &amp; privacy (or just Security)</li>
          <li>More security settings → Encryption &amp; credentials</li>
          <li>Install a certificate → CA certificate</li>
          <li>
            Acknowledge the warning, pick <code>mobux-ca.crt</code> from your
            Downloads
          </li>
        </ol>
        <p class="install-hint">
          Running with ACME / a publicly-trusted cert? Skip this step — there's
          no local CA to install.
        </p>
      </section>

      <section class="install-card">
        <h2>2. Install the app</h2>
        <p class="install-lede">
          Download the Android APK, or scan the QR with your phone.
        </p>
        {apkAvailable === null && <p class="install-hint">Checking…</p>}
        {apkAvailable === false && (
          <div class="install-apk-missing" role="alert">
            <p class="install-apk-missing-title">The APK isn't built yet.</p>
            <p class="install-hint">
              Run <code>make twa</code> on the server to build it.
            </p>
          </div>
        )}
        {apkAvailable === true && (
          <div class="install-grid">
            <a
              class="install-btn"
              href="/install/mobux.apk"
              download="mobux.apk"
            >
              Download APK
            </a>
            <QrCode url={apkUrl} />
          </div>
        )}
      </section>
    </main>
  );
}
