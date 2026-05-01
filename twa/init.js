#!/usr/bin/env node
//
// Non-interactive bootstrap of the bubblewrap project skeleton from
// twa/twa-manifest.json. Replaces `bubblewrap init`, which is interactive-only
// and treats `--manifest` as a remote Web App Manifest URL — neither of which
// fits a one-command `make twa` flow.
//
// Calls @bubblewrap/core's TwaGenerator.createTwaProject() directly with the
// pre-rendered TWA manifest.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NPM_PREFIX = process.env.NPM_PREFIX || `${process.env.HOME}/.local`;
const CORE_PATH = path.join(
  NPM_PREFIX,
  'lib/node_modules/@bubblewrap/cli/node_modules/@bubblewrap/core',
);

if (!fs.existsSync(CORE_PATH)) {
  console.error(
    `[twa-init] @bubblewrap/core not found at ${CORE_PATH}.\n` +
    `Run bin/setup-twa first.`,
  );
  process.exit(1);
}

const { TwaManifest, TwaGenerator, ConsoleLog } = require(CORE_PATH);

const manifestPath = path.resolve(__dirname, 'twa-manifest.json');
const targetDir = path.resolve(__dirname, 'app');

if (!fs.existsSync(manifestPath)) {
  console.error(`[twa-init] Missing ${manifestPath}. Render it from the template first.`);
  process.exit(1);
}

const json = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const twaManifest = new TwaManifest(json);

const log = new ConsoleLog('twa-init');

(async () => {
  fs.mkdirSync(targetDir, { recursive: true });
  const generator = new TwaGenerator();
  await generator.createTwaProject(targetDir, twaManifest, log);

  // createTwaProject saves the manifest into the target dir as part of its
  // template processing. Re-write it from our source-of-truth so any
  // stripped/normalised fields don't drift, then write the matching
  // checksum file (sha1 of the manifest bytes) so `bubblewrap build` doesn't
  // prompt about a stale or missing checksum.
  const savedManifestPath = path.join(targetDir, 'twa-manifest.json');
  const body = JSON.stringify(json, null, 2) + '\n';
  fs.writeFileSync(savedManifestPath, body);
  fs.writeFileSync(
    path.join(targetDir, 'manifest-checksum.txt'),
    crypto.createHash('sha1').update(fs.readFileSync(savedManifestPath)).digest('hex'),
  );

  log.info(`TWA project created at ${targetDir}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
