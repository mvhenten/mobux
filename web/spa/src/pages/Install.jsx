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

export function InstallPage() {
  const base = origin();
  const apkUrl = base + "/install/mobux.apk";
  const caUrl = base + "/install/mobux-ca.crt";

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
          <a class="install-btn" href="/install/mobux-ca.crt" download>
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
        <div class="install-grid">
          <a class="install-btn" href="/install/mobux.apk" download>
            Download APK
          </a>
          <QrCode url={apkUrl} />
        </div>
        <p class="install-hint">
          If the APK isn't built yet, run <code>make twa</code> on the server.
        </p>
      </section>
    </main>
  );
}
