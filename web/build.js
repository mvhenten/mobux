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

fs.mkdirSync(VENDOR, { recursive: true });

// Bundle sterk (includes ace-builds as a dependency)
console.log('[build] Bundling sterk...');
execSync([
  'npx esbuild',
  path.join(ROOT, 'web', 'src', 'sterk-entry.js'),
  '--bundle',
  '--format=iife',
  '--minify',
  '--sourcemap',
  '--target=es2020',
  `--outfile=${path.join(VENDOR, 'sterk.bundle.js')}`,
].join(' '), { cwd: ROOT, stdio: 'inherit' });

console.log('[build] Done.');
