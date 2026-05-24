#!/usr/bin/env node
// Build script: bundle sterk for the browser
//
// Usage: node web/build.js
//
// Bundles @kattebak/sterk (which includes ace-builds) into
// web/static/vendor/sterk.bundle.js. Also copies sterk's bundled woff2
// fonts to web/static/vendor/fonts/ so the runtime
// `setFont()` API can fetch them at a stable URL.
//
// Why we copy fonts ourselves rather than letting esbuild rewrite the
// `new URL('../../assets/fonts/X.woff2', import.meta.url)` pattern in
// sterk's source: we bundle to IIFE so terminal-core.js (a classic
// script-tag consumer) can read `window.Sterk`. In IIFE, esbuild emits
// `import.meta` as an empty object, so the URL constructor would resolve
// against `undefined` and 404. Copying to a known path + monkey-patching
// `BUILTIN_FONTS[*].url` in sterk-entry.js is the smallest fix and keeps
// the public asset URL stable (`/static/vendor/fonts/<file>.woff2`).
//
// Safe to re-run (idempotent).

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'web', 'static', 'vendor');
const FONTS_OUT = path.join(VENDOR, 'fonts');
const FONTS_SRC = path.join(ROOT, 'node_modules', '@kattebak', 'sterk', 'assets', 'fonts');

fs.mkdirSync(VENDOR, { recursive: true });
fs.mkdirSync(FONTS_OUT, { recursive: true });

// Copy sterk's bundled woff2 fonts to a stable public URL.
console.log('[build] Copying sterk fonts...');
if (fs.existsSync(FONTS_SRC)) {
  for (const entry of fs.readdirSync(FONTS_SRC)) {
    if (!entry.endsWith('.woff2') && entry !== 'LICENSES.txt') continue;
    const src = path.join(FONTS_SRC, entry);
    const dst = path.join(FONTS_OUT, entry);
    fs.copyFileSync(src, dst);
  }
  const fonts = fs.readdirSync(FONTS_OUT).filter((f) => f.endsWith('.woff2'));
  console.log(`[build]   ${fonts.length} woff2 fonts -> web/static/vendor/fonts/`);
} else {
  console.warn(`[build] WARN: sterk fonts dir not found at ${FONTS_SRC}`);
}

// Bundle sterk (includes ace-builds as a dependency).
//
// `--define:import.meta.url='"http://sterk.invalid/"'` is critical:
// sterk's fonts/index.ts evaluates `new URL('../../assets/fonts/X.woff2',
// import.meta.url)` at module load. Under IIFE esbuild emits
// `import.meta` as `{}`, so the URL constructor throws "Invalid URL"
// and the entire `BUILTIN_FONTS` initializer aborts — `window.Sterk`
// is then never set and every consumer load fails. The define gives
// the URL constructor a valid base so the freeze succeeds;
// sterk-entry.js overwrites each `BUILTIN_FONTS[id].url` to the real
// public path (/static/vendor/fonts/...) before any consumer reads it.
console.log('[build] Bundling sterk...');
execSync([
  'npx esbuild',
  path.join(ROOT, 'web', 'src', 'sterk-entry.js'),
  '--bundle',
  '--format=iife',
  '--minify',
  '--sourcemap',
  '--target=es2020',
  `--define:import.meta.url='"http://sterk.invalid/"'`,
  `--outfile=${path.join(VENDOR, 'sterk.bundle.js')}`,
].join(' '), { cwd: ROOT, stdio: 'inherit' });

console.log('[build] Done.');
