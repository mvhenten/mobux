#!/usr/bin/env node
// Build script: bundle the two terminal renderers mobux supports.
//
// Usage: node web/build.js
//
// 1. Patches @xterm/xterm in-place (idempotent) and bundles it +
//    @xterm/addon-web-links into web/static/vendor/xterm.bundle.js,
//    plus copies xterm.css alongside.
// 2. Bundles @kattebak/sterk (which includes ace-builds) into
//    web/static/vendor/sterk.bundle.js.
//
// Both bundles are emitted unconditionally; the page-level boot script
// decides which one to load at runtime based on the user's
// `mobux:renderer` localStorage choice. Safe to re-run.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'web', 'static', 'vendor');
const FONTS_OUT = path.join(VENDOR, 'fonts');
const FONTS_SRC = path.join(ROOT, 'node_modules', '@kattebak', 'sterk', 'assets', 'fonts');

fs.mkdirSync(VENDOR, { recursive: true });
fs.mkdirSync(FONTS_OUT, { recursive: true });

// ── 1. xterm.js ──────────────────────────────────────────────────────
const XTERM_PATCH = path.join(ROOT, 'patches', 'xterm-composition-helper.patch');
const XTERM_TARGET = path.join(ROOT, 'node_modules', '@xterm', 'xterm', 'src',
  'browser', 'input', 'CompositionHelper.ts');
const XTERM_PKG = path.join(ROOT, 'node_modules', '@xterm', 'xterm');

if (fs.existsSync(XTERM_PKG)) {
  // Apply patch (idempotent — reverse-dry-run first; skip if already applied).
  console.log('[build] Applying xterm patch...');
  try {
    execSync(`patch --dry-run --forward --reject-file=- -p0 -i "${XTERM_PATCH}" "${XTERM_TARGET}"`, {
      cwd: ROOT, stdio: 'pipe',
    });
    execSync(`patch --forward --reject-file=- -p0 -i "${XTERM_PATCH}" "${XTERM_TARGET}"`, {
      cwd: ROOT, stdio: 'pipe',
    });
    console.log('[build] xterm patch applied.');
  } catch (e) {
    const out = (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
    if (out.includes('Reversed') || out.includes('previously applied')) {
      console.log('[build] xterm patch already applied.');
    } else {
      console.error('[build] xterm patch failed:', out.trim());
      process.exit(1);
    }
  }

  console.log('[build] Bundling xterm...');
  execSync([
    'npx esbuild',
    path.join(ROOT, 'web', 'src', 'xterm-entry.js'),
    '--bundle',
    '--format=iife',
    '--minify',
    '--sourcemap',
    '--target=es2020',
    `--outfile=${path.join(VENDOR, 'xterm.bundle.js')}`,
  ].join(' '), { cwd: ROOT, stdio: 'inherit' });

  const xtermCssSrc = path.join(XTERM_PKG, 'css', 'xterm.css');
  const xtermCssDest = path.join(VENDOR, 'xterm.css');
  if (fs.existsSync(xtermCssSrc)) {
    fs.copyFileSync(xtermCssSrc, xtermCssDest);
    console.log('[build] xterm.css copied.');
  } else {
    console.warn(`[build] WARN: xterm.css not found at ${xtermCssSrc}`);
  }
} else {
  console.warn(`[build] WARN: @xterm/xterm not installed at ${XTERM_PKG}; skipping xterm bundle. Run \`npm install\` first.`);
}

// ── 2. sterk ─────────────────────────────────────────────────────────
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

// ── 3. Client SPA (web/spa → web/static/spa) ──────────────────────────
// Build the Vite/Preact SPA so its assets exist for the Rust `/app` route
// (served by serve_spa_index + serve_static, embedded via RustEmbed). Output
// goes to web/static/spa/ (vite.config.js `outDir`/`base`). Idempotent.
//
// The SPA has its own npm project + lockfile, so ensure its node_modules
// exist (npm ci with a lockfile, else npm install) before building. If web/spa
// is absent the step is skipped with a warning so the vendor-bundle build above
// still succeeds.
const SPA_DIR = path.join(ROOT, 'web', 'spa');
if (fs.existsSync(path.join(SPA_DIR, 'package.json'))) {
  if (!fs.existsSync(path.join(SPA_DIR, 'node_modules'))) {
    const hasLock = fs.existsSync(path.join(SPA_DIR, 'package-lock.json'));
    console.log(`[build] Installing SPA deps (${hasLock ? 'npm ci' : 'npm install'})...`);
    execSync(hasLock ? 'npm ci' : 'npm install', { cwd: SPA_DIR, stdio: 'inherit' });
  }
  console.log('[build] Building client SPA (web/spa)...');
  execSync('npm run build', { cwd: SPA_DIR, stdio: 'inherit' });
  console.log('[build] SPA built -> web/static/spa/');
} else {
  console.warn(`[build] WARN: web/spa not found at ${SPA_DIR}; skipping SPA build.`);
}

// ── 4. Build hash ─────────────────────────────────────────────────────
const crypto = require('crypto');
const STATIC = path.join(ROOT, 'web', 'static');

const xtermBundle = path.join(VENDOR, 'xterm.bundle.js');
const sterkBundle = path.join(VENDOR, 'sterk.bundle.js');

const xtermContents = fs.existsSync(xtermBundle) ? fs.readFileSync(xtermBundle) : Buffer.alloc(0);
const sterkContents = fs.existsSync(sterkBundle) ? fs.readFileSync(sterkBundle) : Buffer.alloc(0);

const hash = crypto
  .createHash('sha256')
  .update(xtermContents)
  .update(sterkContents)
  .digest('hex')
  .slice(0, 8);

const builtAt = new Date().toISOString();

fs.writeFileSync(
  path.join(STATIC, 'build-info.json'),
  JSON.stringify({ hash, builtAt }, null, 2) + '\n',
);

fs.writeFileSync(
  path.join(STATIC, 'build-info.js'),
  `// Auto-generated by web/build.js — do not edit.\nwindow.MOBUX_BUILD_FE = '${hash}';\n`,
);

console.log(`[build] Build hash: ${hash} (written to web/static/build-info.{json,js})`);
console.log('[build] Done.');
