// Install / onboarding page. Ports the Rust-rendered /install page with
// client-side QR codes (uqr → inline SVG), so a desktop visitor can scan
// download URLs from a phone without switching to the server /install page.
//
// QR codes encode the absolute download URL derived from window.location,
// matching what the server does from the request Host header.
//
// The APK is built by the server on demand (POST /api/install/apk/build,
// polled via GET /api/install/apk/status), which also reports whether one
// exists — so the download button is never handed a 404 body to save. The
// build takes minutes, so the running state shows the tail of the build
// output rather than a spinner.
//
// The first build on a host also installs the JDK, Node and Android SDK it
// needs; that runs as its own phase so the wait is named. The only thing the
// server cannot install for itself is a couple of OS packages, and it reports
// those as the single command that fixes them.

import { useEffect, useRef, useState } from "preact/hooks";
import { renderSVG } from "uqr";
import { localFetch, localGet } from "../lib/api.js";

const POLL_MS = 2000;
const IDLE_MS = 10000;
const TAIL_LINES = 12;

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

function BuildLog({ output }) {
  const lines = output.slice(-TAIL_LINES);
  if (lines.length === 0) return null;
  return <pre class="install-log">{lines.join("\n")}</pre>;
}

// A command the user runs in a terminal, with a tap-to-copy affordance. The
// clipboard API is missing on an insecure origin, so a failure says so and
// leaves the text selectable rather than doing nothing.
function CopyCommand({ command }) {
  const [copyState, setCopyState] = useState("idle");

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 2000);
    } catch (_) {
      setCopyState("failed");
    }
  };

  return (
    <div class="install-command">
      <code>{command}</code>
      <button type="button" class="install-copy" onClick={onCopy}>
        {copyState === "copied"
          ? "Copied"
          : copyState === "failed"
            ? "Select it to copy"
            : "Copy"}
      </button>
    </div>
  );
}

function ApkSection({ apkUrl }) {
  const [status, setStatus] = useState(null);
  const [requestError, setRequestError] = useState(null);
  const [starting, setStarting] = useState(false);
  const poll = useRef(null);

  useEffect(() => {
    let live = true;
    let timer = null;

    const tick = async () => {
      const next = await localGet("/api/install/apk/status").catch((e) => {
        if (live)
          setRequestError(
            `Can't reach the server for build status: ${e.message}`,
          );
        return null;
      });
      if (!live) return;
      if (next) {
        setRequestError(null);
        setStatus(next);
      }
      timer = setTimeout(tick, next?.phase === "running" ? POLL_MS : IDLE_MS);
    };

    // Called right after a build is started so the running state appears at
    // once instead of at the end of the current idle interval.
    poll.current = () => {
      clearTimeout(timer);
      tick();
    };
    tick();

    return () => {
      live = false;
      poll.current = null;
      clearTimeout(timer);
    };
  }, []);

  const onBuild = async () => {
    setStarting(true);
    setRequestError(null);
    const res = await localFetch("/api/install/apk/build", {
      method: "POST",
    }).catch((e) => {
      setRequestError(`Couldn't start the build: ${e.message}`);
      return null;
    });
    setStarting(false);
    if (!res) return;
    // 409 means a build was already running, 400 that the server recorded why
    // it refused (missing OS packages, unusable domain) — the poll below picks
    // either up and renders it.
    if (!res.ok && res.status !== 409 && res.status !== 400) {
      const body = await res.text().catch(() => "");
      setRequestError(
        `Couldn't start the build (HTTP ${res.status}). ${body}`.trim(),
      );
      return;
    }
    poll.current?.();
  };

  const phase = status?.phase;
  const installingTools = phase === "installing_tools";
  const running = phase === "running" || installingTools;
  const available = !!status?.apk_available;
  const output = Array.isArray(status?.output) ? status.output : [];
  const domain = status?.domain;
  const missingPackages = Array.isArray(status?.missing_host_packages)
    ? status.missing_host_packages
    : [];
  const failed = phase === "failed" && missingPackages.length === 0;

  return (
    <section class="install-card">
      <h2>2. Install the app</h2>

      {status === null && !requestError && (
        <p class="install-hint">Checking…</p>
      )}

      {available && (
        <>
          <p class="install-lede">
            Download the Android APK, or scan the QR with your phone.
          </p>
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
        </>
      )}

      {status !== null && !available && !running && (
        <div class="install-apk-missing" role="alert">
          <p class="install-apk-missing-title">
            No package has been built for this server yet.
          </p>
          <p class="install-hint">
            Building one takes a few minutes and signs it for{" "}
            <code>{domain || "this server"}</code>. The first build installs the
            Android build tools too.
          </p>
        </div>
      )}

      {installingTools && (
        <p class="install-lede">
          Installing the Android build tools — a JDK, Node and the Android SDK.
          This happens once and takes several minutes; the package build starts
          straight after. You can leave this page open.
        </p>
      )}

      {running && !installingTools && (
        <p class="install-lede">
          Building the package for <code>{domain || "this server"}</code>. This
          takes a few minutes — you can leave this page open.
        </p>
      )}

      {missingPackages.length > 0 && (
        <div class="install-error" role="alert">
          <strong>This host is missing {missingPackages.join(", ")}.</strong>
          <p>
            The build tools unpack their downloads with{" "}
            {missingPackages.length === 1 ? "it" : "them"}, and only your system
            package manager can install{" "}
            {missingPackages.length === 1 ? "it" : "them"}. Run this, then press
            the button again.
          </p>
          {status?.install_command && (
            <CopyCommand command={status.install_command} />
          )}
        </div>
      )}

      {failed && (
        <div class="install-error" role="alert">
          <strong>The package build failed.</strong>
          <p>{status?.error || "The build exited without an error message."}</p>
          <BuildLog output={output} />
        </div>
      )}

      {requestError && (
        <div class="install-error" role="alert">
          <strong>{requestError}</strong>
        </div>
      )}

      {status?.domain_error && (
        <p class="install-hint">
          The server can't work out which address to sign the package for:{" "}
          {status.domain_error}. Set <code>MOBUX_DOMAIN</code> on the service.
        </p>
      )}

      {status !== null && (
        <div class="install-grid install-build-row">
          <button
            type="button"
            class="install-btn"
            onClick={onBuild}
            disabled={running || starting || !!status?.domain_error}
          >
            {installingTools
              ? "Installing build tools…"
              : running
                ? "Building…"
                : available
                  ? "Rebuild package"
                  : "Generate package"}
          </button>
          {available && !running && (
            <span class="install-hint">
              Rebuild if you reach this server on a different address.
            </span>
          )}
        </div>
      )}

      {running && <BuildLog output={output} />}
    </section>
  );
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

      <ApkSection apkUrl={apkUrl} />
    </main>
  );
}
