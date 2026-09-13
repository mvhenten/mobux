#!/usr/bin/env node
// Maintainer tool for the vendored voice.
//
// This is the ONLY place Hugging Face appears. mobux never contacts it at
// runtime: the voice rides in the release tarball, and the `cargo install`
// path pulls that same tarball from the GitHub release and checks it against
// the hashes recorded here.
//
//   node scripts/tts-voice.mjs fetch <dir>   download the checkpoint + dictionary
//   node scripts/tts-voice.mjs lock  <dir>   rewrite src/local_tts/voice.lock.json
//   node scripts/tts-voice.mjs verify <dir>  check a directory against the lock
//   node scripts/tts-voice.mjs ensure <dir>  verify, and fetch only if it fails
//
// Three files land in <dir>:
//   voice.onnx        the Piper VITS checkpoint
//   voice.onnx.json   its phoneme id map, sample rate and inference scales
//   cmudict.json      the pronunciation dictionary the g2p reads, built from
//                     the pinned cmudict revision

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = path.join(ROOT, "src/local_tts/voice.lock.json");
const HF_BASE = "https://huggingface.co";
const CMUDICT_BASE = "https://raw.githubusercontent.com/cmusphinx/cmudict";

const die = (msg) => {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
};

const readLock = () => JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function download(url) {
  const resp = await fetch(url);
  if (!resp.ok) die(`GET ${url} -> ${resp.status} ${resp.statusText}`);
  return Buffer.from(await resp.arrayBuffer());
}

// The dictionary the phonemizer wants is a flat word -> ARPAbet map. cmudict
// ships one pronunciation per line with `word(2)` for the alternates; the
// first spelling is the one a reader means.
function toDictionary(text) {
  const words = {};
  for (const raw of text.split("\n")) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const split = line.indexOf(" ");
    if (split < 0) continue;
    const word = line.slice(0, split);
    if (/\(\d+\)$/.test(word)) continue;
    if (words[word]) continue;
    words[word] = line.slice(split + 1).trim();
  }
  return words;
}

async function fetchVoice(dir) {
  const lock = readLock();
  fs.mkdirSync(dir, { recursive: true });

  const base = `${HF_BASE}/${lock.repo}/resolve/${lock.revision}`;
  for (const [name, source] of Object.entries(lock.sources)) {
    process.stdout.write(`fetching ${name}\n`);
    const buf = await download(`${base}/${source}`);
    fs.writeFileSync(path.join(dir, name), buf);
    process.stdout.write(`  ${sha256(buf)}  ${buf.length} bytes\n`);
  }

  process.stdout.write("fetching cmudict.json\n");
  const raw = await download(
    `${CMUDICT_BASE}/${lock.cmudict_revision}/cmudict.dict`,
  );
  const words = toDictionary(raw.toString("utf8"));
  if (Object.keys(words).length < 100000) {
    die(`cmudict.dict yielded only ${Object.keys(words).length} words`);
  }
  const dictionary = Buffer.from(JSON.stringify(words), "utf8");
  fs.writeFileSync(path.join(dir, "cmudict.json"), dictionary);
  process.stdout.write(
    `  ${sha256(dictionary)}  ${dictionary.length} bytes  ${Object.keys(words).length} words\n`,
  );
}

function describe(dir) {
  const lock = readLock();
  const files = {};
  for (const name of Object.keys(lock.files)) {
    const buf = fs.readFileSync(path.join(dir, name));
    files[name] = { sha256: sha256(buf), bytes: buf.length };
  }
  return { ...lock, files };
}

function lockVoice(dir) {
  fs.writeFileSync(LOCK_PATH, JSON.stringify(describe(dir), null, 2) + "\n");
  process.stdout.write(`wrote ${path.relative(ROOT, LOCK_PATH)}\n`);
}

function verifyVoice(dir, { quiet = false } = {}) {
  const lock = readLock();
  for (const [name, want] of Object.entries(lock.files)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      if (!quiet) process.stderr.write(`missing: ${file}\n`);
      return false;
    }
    const got = sha256(fs.readFileSync(file));
    if (got !== want.sha256) {
      if (!quiet) {
        process.stderr.write(`sha256 mismatch for ${name}\n`);
        process.stderr.write(`  want ${want.sha256}\n  got  ${got}\n`);
      }
      return false;
    }
  }
  return true;
}

const [command, dir] = process.argv.slice(2);
if (!command || !dir) {
  die("usage: tts-voice.mjs <fetch|lock|verify|ensure> <dir>");
}

switch (command) {
  case "fetch":
    await fetchVoice(dir);
    break;
  case "lock":
    lockVoice(dir);
    break;
  case "verify":
    if (!verifyVoice(dir)) die(`${dir} does not match the lock`);
    process.stdout.write(`${dir} matches the lock\n`);
    break;
  case "ensure":
    if (verifyVoice(dir, { quiet: true })) {
      process.stdout.write(`${dir} matches the lock\n`);
      break;
    }
    await fetchVoice(dir);
    if (!verifyVoice(dir)) die(`${dir} does not match the lock after fetching`);
    process.stdout.write(`${dir} matches the lock\n`);
    break;
  default:
    die(`unknown command: ${command}`);
}
