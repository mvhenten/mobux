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

// Permissions Bubblewrap can't express via twa-manifest.json. In a TWA, Chrome
// delegates OS permission prompts (mic, camera, …) to the host app, so
// getUserMedia({audio:true}) is denied unless the APK itself holds the
// permission. Bubblewrap only emits permissions for its known features
// (notifications, location, …); there is no manifest field for an arbitrary
// uses-permission. So we patch the rendered AndroidManifest.xml here. This
// runs on every `make twa` (which does `rm -rf twa/app` first), so a manifest
// regen can never silently drop it. Idempotent: skips perms already present.
const EXTRA_PERMISSIONS = ['android.permission.RECORD_AUDIO'];

function injectPermissions(targetDir, log) {
  const manifestXmlPath = path.join(targetDir, 'app/src/main/AndroidManifest.xml');
  if (!fs.existsSync(manifestXmlPath)) {
    throw new Error(`[twa-init] expected generated manifest at ${manifestXmlPath}`);
  }
  let xml = fs.readFileSync(manifestXmlPath, 'utf8');
  const missing = EXTRA_PERMISSIONS.filter(
    (p) => !xml.includes(`android:name="${p}"`),
  );
  if (missing.length === 0) {
    log.info('Extra permissions already present in AndroidManifest.xml');
    return;
  }
  const lines = missing
    .map((p) => `    <uses-permission android:name="${p}"/>`)
    .join('\n');
  // Insert right after the opening <manifest ...> tag.
  const re = /(<manifest\b[^>]*>)/;
  if (!re.test(xml)) {
    throw new Error('[twa-init] could not locate <manifest> tag to inject permissions');
  }
  xml = xml.replace(re, `$1\n\n${lines}`);
  fs.writeFileSync(manifestXmlPath, xml);
  log.info(`Injected permissions into AndroidManifest.xml: ${missing.join(', ')}`);
}

(async () => {
  fs.mkdirSync(targetDir, { recursive: true });
  const generator = new TwaGenerator();
  await generator.createTwaProject(targetDir, twaManifest, log);

  injectPermissions(targetDir, log);

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
