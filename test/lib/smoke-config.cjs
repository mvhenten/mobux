// Seed the smoke instance's config.json with what no env var can set:
// `files.listing`, so test/files.spec.cjs can drive the directory listing.
// Merges into an existing file, so a key Settings wrote survives.
//
// Usage: node test/lib/smoke-config.cjs <config dir>

const fs = require("fs");
const path = require("path");

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node test/lib/smoke-config.cjs <config dir>");
  process.exit(2);
}
const file = path.join(dir, "config.json");
fs.mkdirSync(dir, { recursive: true });
const config = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, "utf8"))
  : {};
config.files = { ...config.files, listing: true };
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
