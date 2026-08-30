import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Mobile browsers force HTTPS, so the dev server needs TLS. Reuse the leaf
// cert mobux already issued from its own CA (~/.config/mobux) — a phone that
// trusts that CA gets no warning. MOBUX_DEV_CERT/MOBUX_DEV_KEY override.
// Serve-only: `vite build` has no cert and must not need one.
function devHttps() {
  const dir = join(homedir(), '.config', 'mobux');
  const cert = process.env.MOBUX_DEV_CERT || join(dir, 'leaf.crt');
  const key = process.env.MOBUX_DEV_KEY || join(dir, 'leaf.key');
  try {
    return { cert: readFileSync(cert), key: readFileSync(key) };
  } catch (err) {
    console.warn(
      `[vite] serving over plain HTTP — dev TLS cert unreadable (${cert}): ${err.message}`,
    );
    return undefined;
  }
}

// The Rust backend (PTY / WebSocket / API) runs separately. In dev it is the
// `make dev-watch` instance on :5152 — HTTPS with a self-signed cert and HTTP
// Basic auth. We never start or touch that process; we only proxy to it.
//
//   MOBUX_BACKEND       full origin to proxy to   (default https://localhost:5152)
//   MOBUX_DEV_AUTH      "user:pass" injected as Basic auth on proxied requests
//
// The browser running the SPA at :5173 has no credentials of its own, so the
// proxy attaches the Authorization header server-side. This keeps the SPA a
// pure client: it never sees or stores the backend password.
const BACKEND = process.env.MOBUX_BACKEND || 'https://localhost:5152';
const DEV_AUTH = process.env.MOBUX_DEV_AUTH || '';

function withAuth(proxy) {
  if (!DEV_AUTH) return;
  const header = 'Basic ' + Buffer.from(DEV_AUTH).toString('base64');
  proxy.on('proxyReq', (proxyReq) => {
    if (!proxyReq.getHeader('authorization')) {
      proxyReq.setHeader('authorization', header);
    }
  });
  proxy.on('proxyReqWs', (proxyReq) => {
    if (!proxyReq.getHeader('authorization')) {
      proxyReq.setHeader('authorization', header);
    }
  });
}

// One proxy entry shape reused for every backend route. `secure:false` accepts
// the self-signed dev cert; `changeOrigin` rewrites Host so the backend's
// origin checks pass.
const target = (ws = false) => ({
  target: BACKEND,
  changeOrigin: true,
  secure: false,
  ws,
  configure: withAuth,
});

export default defineConfig(({ command }) => ({
  plugins: [preact()],
  server: {
    port: 5173,
    strictPort: true,
    // Reached over the tailnet from a phone, not just localhost.
    allowedHosts: ['.ts.net', '.local', 'sandbox'],
    https: command === 'serve' ? devHttps() : undefined,
    proxy: {
      // PTY WebSocket. ws:true so the upgrade is forwarded.
      '/ws': target(true),
      // REST API surface.
      '/api': target(),
      // STT transcription (OpenAI-compatible) + legacy upload/transcribe.
      '/v1': target(),
      '/transcribe': target(),
      '/upload': target(),
      // Service worker + existing static assets (vendor bundles, css, js)
      // served straight from the Rust backend so the terminal island can
      // load the real engine bundle unchanged.
      '/sw.js': target(),
      // Vite's dev HTML transform prefixes absolute asset hrefs with the base,
      // so index.html's /static/style.css arrives as /static/spa/static/... and
      // would otherwise hit the SPA fallback and come back as HTML.
      '/static/spa/static': {
        ...target(),
        rewrite: (path) => path.replace('/static/spa/static', '/static'),
      },
      // The SPA's own assets live under /static/spa/ (its base). Everything
      // else under /static/ (vendor bundles, terminal.js, style.css, …) is
      // the backend's — proxy it, but let Vite serve its own base. `bypass`
      // returning the path tells the proxy to skip forwarding.
      '/static': {
        ...target(),
        bypass(req) {
          if (req.url.startsWith('/static/spa/')) return req.url;
        },
      },
    },
  },
  // Build output lands in web/static/spa, served by the Rust backend's /static
  // handler. The dev server keeps the absolute base so the SPA is reachable at
  // /static/spa/ on :5173 and lib/base.js finds its marker in dev too.
  base: '/static/spa/',
  build: {
    outDir: '../static/spa',
    emptyOutDir: true,
  },
  // The built document is served at <prefix>/app behind a path-prefixing proxy
  // that strips its prefix before mobux sees the request, so a root-absolute
  // asset URL walks the browser out of the mount. `./static/spa/…` resolves
  // against the document's directory — <prefix>/ for /app — and lands inside it
  // at every mount, the bare root included. Vite rejects a relative `base` that
  // is not exactly `./`, so the relative form is applied here instead.
  experimental: {
    renderBuiltUrl: (filename) => `./static/spa/${filename}`,
  },
}));
