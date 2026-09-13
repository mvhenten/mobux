#!/usr/bin/env node
// Maintainer tool for the speech models mobux publishes.
//
// This is the ONLY place Hugging Face appears. mobux never contacts it at
// runtime: the default model rides in the per-platform release tarball, the
// other checkpoints are their own release assets, and every file is checked
// against src/local_stt/model.lock.json before it is loaded.
//
//   node scripts/stt-model.mjs models              list the catalog, in order
//   node scripts/stt-model.mjs vendored            the model the tarball carries
//   node scripts/stt-model.mjs fetch  <dir> [model]  download + convert to f16
//   node scripts/stt-model.mjs lock   <dir> [model]  record hashes in the lock
//   node scripts/stt-model.mjs verify <dir> [model]  check a directory
//   node scripts/stt-model.mjs ensure <dir> [model]  verify, fetch only if it fails
//
// Weights are stored f16. candle converts them to f32 as it loads, so
// inference is unchanged and every payload halves.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = path.join(ROOT, "src/local_stt/model.lock.json");
const HF_BASE = "https://huggingface.co";

const die = (msg) => {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
};

const readLock = () => JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));

function entryFor(lock, id) {
  const wanted = id || lock.default;
  const entry = lock.models.find((m) => m.id === wanted);
  if (!entry) die(`no such model: ${wanted}`);
  return entry;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function downloadTo(url, file) {
  const resp = await fetch(url);
  if (!resp.ok) die(`GET ${url} -> ${resp.status} ${resp.statusText}`);
  await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(file));
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
// Rewritten tensor by tensor straight from one file to the other, so a
// half-gigabyte checkpoint never has to sit in memory whole.
function convertToF16(sourceFile, targetFile) {
  const src = fs.openSync(sourceFile, "r");
  try {
    const prefix = Buffer.allocUnsafe(8);
    fs.readSync(src, prefix, 0, 8, 0);
    const headerLength = Number(prefix.readBigUInt64LE(0));
    const headerBuf = Buffer.allocUnsafe(headerLength);
    fs.readSync(src, headerBuf, 0, headerLength, 8);
    const header = JSON.parse(headerBuf.toString("utf8"));
    const dataStart = 8 + headerLength;

    const entries = Object.entries(header)
      .filter(([name]) => name !== "__metadata__")
      .sort((a, b) => a[1].data_offsets[0] - b[1].data_offsets[0]);

    const converted = {};
    if (header.__metadata__) converted.__metadata__ = header.__metadata__;
    let offset = 0;
    for (const [name, info] of entries) {
      const [from, to] = info.data_offsets;
      const size = info.dtype === "F32" ? (to - from) / 2 : to - from;
      converted[name] = {
        dtype: info.dtype === "F32" ? "F16" : info.dtype,
        shape: info.shape,
        data_offsets: [offset, offset + size],
      };
      offset += size;
    }

    let json = Buffer.from(JSON.stringify(converted), "utf8");
    const padding = (8 - (json.length % 8)) % 8;
    if (padding) json = Buffer.concat([json, Buffer.alloc(padding, 0x20)]);
    const outPrefix = Buffer.allocUnsafe(8);
    outPrefix.writeBigUInt64LE(BigInt(json.length));

    const hash = createHash("sha256");
    let bytes = 0;
    const out = fs.openSync(targetFile, "w");
    const write = (buf) => {
      fs.writeSync(out, buf);
      hash.update(buf);
      bytes += buf.length;
    };
    try {
      write(outPrefix);
      write(json);
      for (const [name, info] of entries) {
        const [from, to] = info.data_offsets;
        const raw = Buffer.allocUnsafe(to - from);
        fs.readSync(src, raw, 0, raw.length, dataStart + from);
        if (header[name].dtype !== "F32") {
          write(raw);
          continue;
        }
        const source = new Float32Array(
          raw.buffer,
          raw.byteOffset,
          raw.byteLength / 4,
        );
        const half = Buffer.allocUnsafe(source.length * 2);
        for (let i = 0; i < source.length; i++) {
          half.writeUInt16LE(halfBits(source[i]), i * 2);
        }
        write(half);
      }
    } finally {
      fs.closeSync(out);
    }
    return { sha256: hash.digest("hex"), bytes };
  } finally {
    fs.closeSync(src);
  }
}

// ── commands ─────────────────────────────────────────────────────────
async function fetchModel(dir, id) {
  const lock = readLock();
  const entry = entryFor(lock, id);
  const base = `${HF_BASE}/${entry.repo}/resolve/${entry.revision}`;
  fs.mkdirSync(dir, { recursive: true });

  for (const name of Object.keys(entry.files)) {
    process.stdout.write(`fetching ${entry.id}/${name}\n`);
    const target = path.join(dir, name);
    if (name !== "model.safetensors") {
      await downloadTo(`${base}/${name}`, target);
      const buf = fs.readFileSync(target);
      process.stdout.write(`  ${sha256(buf)}  ${buf.length} bytes\n`);
      continue;
    }
    const staging = `${target}.f32`;
    await downloadTo(`${base}/${name}`, staging);
    process.stdout.write(`  converting to f16\n`);
    const { sha256: digest, bytes } = convertToF16(staging, target);
    fs.rmSync(staging);
    process.stdout.write(`  ${digest}  ${bytes} bytes\n`);
  }
}

function describe(dir, id) {
  const lock = readLock();
  const entry = entryFor(lock, id);
  const files = {};
  for (const name of Object.keys(entry.files)) {
    const buf = fs.readFileSync(path.join(dir, name));
    files[name] = { sha256: sha256(buf), bytes: buf.length };
  }
  return { lock, entry, files };
}

function lockModel(dir, id) {
  const { lock, entry, files } = describe(dir, id);
  entry.files = files;
  fs.writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + "\n");
  process.stdout.write(
    `wrote ${entry.id} into ${path.relative(ROOT, LOCK_PATH)}\n`,
  );
}

function verifyModel(dir, id, { quiet = false } = {}) {
  const entry = entryFor(readLock(), id);
  for (const [name, want] of Object.entries(entry.files)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      if (!quiet) process.stderr.write(`missing: ${file}\n`);
      return false;
    }
    const got = sha256(fs.readFileSync(file));
    if (got !== want.sha256) {
      if (!quiet) {
        process.stderr.write(`sha256 mismatch for ${entry.id}/${name}\n`);
        process.stderr.write(`  want ${want.sha256}\n  got  ${got}\n`);
      }
      return false;
    }
  }
  return true;
}

const [command, ...rest] = process.argv.slice(2);

if (command === "models") {
  process.stdout.write(
    readLock()
      .models.map((m) => m.id)
      .join("\n") + "\n",
  );
  process.exit(0);
}
if (command === "vendored") {
  process.stdout.write(readLock().vendored + "\n");
  process.exit(0);
}

const [dir, id] = rest;
if (!command || !dir) {
  die("usage: stt-model.mjs <fetch|lock|verify|ensure> <dir> [model]");
}

switch (command) {
  case "fetch":
    await fetchModel(dir, id);
    break;
  case "lock":
    lockModel(dir, id);
    break;
  case "verify":
    if (!verifyModel(dir, id)) die(`${dir} does not match the lock`);
    process.stdout.write(`${dir} matches the lock\n`);
    break;
  case "ensure":
    if (verifyModel(dir, id, { quiet: true })) {
      process.stdout.write(`${dir} matches the lock\n`);
      break;
    }
    await fetchModel(dir, id);
    if (!verifyModel(dir, id)) {
      die(`${dir} does not match the lock after fetching`);
    }
    process.stdout.write(`${dir} matches the lock\n`);
    break;
  default:
    die(`unknown command: ${command}`);
}
