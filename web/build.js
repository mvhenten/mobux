#!/usr/bin/env node
// Build script: bundle sterk for the browser
//
// Usage: node web/build.js
//
// Bundles @kattebak/sterk (which includes ace-builds) into
// web/static/vendor/sterk.bundle.js. Safe to re-run (idempotent).

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'web', 'static', 'vendor');
const FONTS_OUT = path.join(VENDOR, 'fonts');
const FONTS_SRC = path.join(ROOT, 'node_modules', '@kattebak', 'sterk', 'assets', 'fonts');

fs.mkdirSync(VENDOR, { recursive: true });
fs.mkdirSync(FONTS_OUT, { recursive: true });

// Copy sterk's bundled woff2 fonts to a stable public URL so style.css's
// @font-face rules can resolve them. The corresponding @font-face block
// is in web/static/style.css; the symbol-fallback `SterkTUISymbols.woff2`
// is critical for TUI dingbat coverage (box-drawing + dingbats) under
// the same family names via unicode-range.
if (fs.existsSync(FONTS_SRC)) {
  for (const entry of fs.readdirSync(FONTS_SRC)) {
    if (!entry.endsWith('.woff2') && entry !== 'LICENSES.txt') continue;
    fs.copyFileSync(path.join(FONTS_SRC, entry), path.join(FONTS_OUT, entry));
  }
  const fonts = fs.readdirSync(FONTS_OUT).filter((f) => f.endsWith('.woff2'));
  console.log(`[build] Copied ${fonts.length} woff2 fonts -> web/static/vendor/fonts/`);
} else {
  console.warn(`[build] WARN: sterk fonts dir not found at ${FONTS_SRC}`);
}

// Bundle sterk (includes ace-builds as a dependency).
//
// `--define:import.meta.url='"http://sterk.invalid/"'` is critical for
// sterk v2.6.0+: those versions ship a vendored-fonts module that
// evaluates `new URL('../../assets/fonts/X.woff2', import.meta.url)`
// at module load. Under IIFE (the format we need so a classic
// `<script>` consumer can read `window.Sterk`) esbuild emits
// `import.meta` as an empty object, so the URL constructor throws
// "Invalid URL" and the `BUILTIN_FONTS` initializer aborts —
// `window.Sterk` is then never set and the entire terminal never
// boots (silent regression that crashed all critical-path tests).
//
// The placeholder base URL just lets the URL constructor succeed; we
// do NOT consume the built-in font registry today (mobux doesn't call
// `setFont()` from the runtime), so the placeholder URL is never
// resolved against the network. When the in-flight font-picker work
// lands and mobux starts using `setFont()`, the build will also copy
// the woff2 assets to `web/static/vendor/fonts/` and the consumer
// will overwrite each `BUILTIN_FONTS[id].url` to the real public path
// before any call site reads it.
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
