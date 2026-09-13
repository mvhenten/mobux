#!/usr/bin/env node
// Maintainer tool for the vendored speech model.
//
// This is the ONLY place Hugging Face appears. mobux never contacts it at
// runtime: the weights ride in the release tarball, and the `cargo install`
// path pulls that same tarball from the GitHub release and checks it against
// the hashes recorded here.
//
//   node scripts/stt-model.mjs fetch <dir>   download, convert to f16, write
//   node scripts/stt-model.mjs lock  <dir>   rewrite src/local_stt/model.lock.json
//   node scripts/stt-model.mjs verify <dir>  check a directory against the lock
//   node scripts/stt-model.mjs ensure <dir>  verify, and fetch only if it fails
//
// The weights are stored as f16. candle converts them to f32 as it loads, so
// inference is unchanged and the payload halves.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = path.join(ROOT, "src/local_stt/model.lock.json");
const HF_BASE = "https://huggingface.co";

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

// ── f32 -> f16, round to nearest even ────────────────────────────────
const scratch = new Float32Array(1);
const scratchBits = new Uint32Array(scratch.buffer);

function halfBits(value) {
  scratch[0] = value;
  const x = scratchBits[0];
  const sign = (x >>> 16) & 0x8000;
  const exponent = (x >>> 23) & 0xff;
  let mantissa = x & 0x7fffff;

  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 : 0);

  const e = exponent - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mantissa |= 0x800000;
    const shift = 14 - e;
    let half = mantissa >>> shift;
    const remainder = mantissa & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (remainder > halfway || (remainder === halfway && half & 1)) half++;
    return sign | half;
  }

  let half = (e << 10) | (mantissa >>> 13);
  const remainder = mantissa & 0x1fff;
  if (remainder > 0x1000 || (remainder === 0x1000 && half & 1)) half++;
  return sign | half;
}

// ── safetensors ──────────────────────────────────────────────────────
function toF16Safetensors(buf) {
  const headerLength = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.subarray(8, 8 + headerLength).toString("utf8"));
  const dataStart = 8 + headerLength;

  const entries = Object.entries(header)
    .filter(([name]) => name !== "__metadata__")
    .sort((a, b) => a[1].data_offsets[0] - b[1].data_offsets[0]);

  const converted = {};
  if (header.__metadata__) converted.__metadata__ = header.__metadata__;

  const chunks = [];
  let offset = 0;
  for (const [name, info] of entries) {
    const [from, to] = info.data_offsets;
    const raw = buf.subarray(dataStart + from, dataStart + to);
    let out = raw;
    let dtype = info.dtype;
    if (dtype === "F32") {
      const source = new Float32Array(
        raw.buffer,
        raw.byteOffset,
        raw.byteLength / 4,
      );
      out = Buffer.allocUnsafe(source.length * 2);
      for (let i = 0; i < source.length; i++) {
        out.writeUInt16LE(halfBits(source[i]), i * 2);
      }
      dtype = "F16";
    }
    converted[name] = {
      dtype,
      shape: info.shape,
      data_offsets: [offset, offset + out.length],
    };
    chunks.push(out);
    offset += out.length;
  }

  let json = Buffer.from(JSON.stringify(converted), "utf8");
  const padding = (8 - (json.length % 8)) % 8;
  if (padding) json = Buffer.concat([json, Buffer.alloc(padding, 0x20)]);
  const prefix = Buffer.allocUnsafe(8);
  prefix.writeBigUInt64LE(BigInt(json.length));
  return Buffer.concat([prefix, json, ...chunks]);
}

// ── commands ─────────────────────────────────────────────────────────
async function fetchModel(dir) {
  const lock = readLock();
  const base = `${HF_BASE}/${lock.repo}/resolve/${lock.revision}`;
  fs.mkdirSync(dir, { recursive: true });

  for (const name of Object.keys(lock.files)) {
    process.stdout.write(`fetching ${name}\n`);
    const source = name === "model.safetensors" ? lock.weights_source : name;
    let buf = await download(`${base}/${source}`);
    if (name === "model.safetensors" && lock.dtype === "f16") {
      process.stdout.write(`converting ${source} to f16\n`);
      buf = toF16Safetensors(buf);
    }
    fs.writeFileSync(path.join(dir, name), buf);
    process.stdout.write(`  ${sha256(buf)}  ${buf.length} bytes\n`);
  }
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

function lockModel(dir) {
  const next = describe(dir);
  fs.writeFileSync(LOCK_PATH, JSON.stringify(next, null, 2) + "\n");
  process.stdout.write(`wrote ${path.relative(ROOT, LOCK_PATH)}\n`);
}

function verifyModel(dir, { quiet = false } = {}) {
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
  die("usage: stt-model.mjs <fetch|lock|verify|ensure> <dir>");
}

switch (command) {
  case "fetch":
    await fetchModel(dir);
    break;
  case "lock":
    lockModel(dir);
    break;
  case "verify":
    if (!verifyModel(dir)) die(`${dir} does not match the lock`);
    process.stdout.write(`${dir} matches the lock\n`);
    break;
  case "ensure":
    if (verifyModel(dir, { quiet: true })) {
      process.stdout.write(`${dir} matches the lock\n`);
      break;
    }
    await fetchModel(dir);
    if (!verifyModel(dir)) die(`${dir} does not match the lock after fetching`);
    process.stdout.write(`${dir} matches the lock\n`);
    break;
  default:
    die(`unknown command: ${command}`);
}
