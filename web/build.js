#!/usr/bin/env node
// Build script: apply patch to @xterm/xterm, bundle with esbuild
//
// Usage: node web/build.js
//
// Patches node_modules/@xterm/xterm in-place, then bundles into
// web/static/vendor/xterm.bundle.js. Safe to re-run (idempotent).

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PATCH = path.join(ROOT, 'patches', 'xterm-composition-helper.patch');
const TARGET = path.join(ROOT, 'node_modules', '@xterm', 'xterm', 'src',
  'browser', 'input', 'CompositionHelper.ts');
const VENDOR = path.join(ROOT, 'web', 'static', 'vendor');

// 1. Apply patch (idempotent — reverse first if already applied, then apply)
console.log('[build] Applying xterm patch...');
try {
  // Check if already applied
  execSync(`patch --dry-run --forward --reject-file=- -p0 -i "${PATCH}" "${TARGET}"`, {
    cwd: ROOT, stdio: 'pipe',
  });
  // Not yet applied — apply it
  execSync(`patch --forward --reject-file=- -p0 -i "${PATCH}" "${TARGET}"`, {
    cwd: ROOT, stdio: 'pipe',
  });
  console.log('[build] Patch applied.');
} catch (e) {
  const out = (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
  if (out.includes('Reversed') || out.includes('previously applied')) {
    console.log('[build] Patch already applied.');
  } else {
    console.error('[build] Patch failed:', out.trim());
    process.exit(1);
  }
}

// 2. Bundle with esbuild
console.log('[build] Bundling xterm...');
fs.mkdirSync(VENDOR, { recursive: true });

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

// 3. Bundle the aceterm driver. The libterm + Ace adapter lives at
//    web/static/vendor/aceterm/aceterm.js but uses CommonJS-style
//    requires; bundle through esbuild so `terminal-core.js` can pick
//    up `window.__Aceterm` from a single global script. Without this
//    CI runs without aceterm.bundle.js and the page never mounts the
//    renderer (404 on the bundle URL → throws on load).
const ACETERM_ENTRY = path.join(ROOT, 'web', 'static', 'aceterm-globals-entry.js');
if (fs.existsSync(ACETERM_ENTRY)) {
  console.log('[build] Bundling aceterm...');
  execSync([
    'npx esbuild',
    ACETERM_ENTRY,
    '--bundle',
    '--format=iife',
    '--target=es2020',
    `--outfile=${path.join(VENDOR, 'aceterm.bundle.js')}`,
  ].join(' '), { cwd: ROOT, stdio: 'inherit' });
}

// 4. Copy CSS
const cssSource = path.join(ROOT, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css');
const cssDest = path.join(VENDOR, 'xterm.css');
fs.copyFileSync(cssSource, cssDest);

console.log('[build] Done.');
