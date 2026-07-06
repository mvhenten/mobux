import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

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

export default defineConfig({
  plugins: [preact()],
  server: {
    port: 5173,
    strictPort: true,
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
  // Build output lands in web/static/spa so the Rust backend can serve it from
  // the existing /static handler in a later phase (NOT wired this phase). The
  // SPA's own asset base is /static/spa/ to match that future mount point.
  base: '/static/spa/',
  build: {
    outDir: '../static/spa',
    emptyOutDir: true,
  },
});
