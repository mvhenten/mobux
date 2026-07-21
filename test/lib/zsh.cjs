// Resolve a usable `zsh` binary for the OSC 133 zsh coverage in
// test/spa.spec.cjs, without requiring it to be preinstalled.
//
// GitHub's `ubuntu-latest` runner does not ship zsh (checked against
// actions/runner-images' Ubuntu2404-Readme.md — bash, dash, and PowerShell
// are listed, zsh is not), and .github/workflows is off-limits to add an
// install step here. Instead: `apt-get download zsh zsh-common` (no root —
// only needs the local package-list cache, which ci.yml's own
// `sudo apt-get install -y tmux` step leaves populated) fetches the .debs,
// and `dpkg-deb -x` (also no root) unpacks them into a repo-local,
// gitignored cache (.tmp/test-zsh/), reused on every subsequent run.
//
// The extracted binary prints one harmless startup warning ("failed to
// load module `zsh/zle'") because its compiled-in module search path
// points at the real system location zsh would occupy if actually
// installed via dpkg, not this extracted copy — zsh still runs as a full
// interactive shell without it (falls back to a simpler line reader).
// Tests that rely on that stray line being real terminal content (not a
// prompt) can use it as a natural non-prompt fixture.
const { execSync, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const CACHE_DIR = path.join(__dirname, "..", "..", ".tmp", "test-zsh");
const EXTRACTED_DIR = path.join(CACHE_DIR, "extracted");
const BIN_PATH = path.join(EXTRACTED_DIR, "bin", "zsh");

function which(bin) {
  try {
    const found = execFileSync("which", [bin], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return found || null;
  } catch (_) {
    return null;
  }
}

function downloadDebs() {
  execSync("apt-get download zsh zsh-common", {
    cwd: CACHE_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// Memoized: only resolve/download once per test process.
let resolved = null;

function resolveZshBin() {
  if (resolved) return resolved;

  const onPath = which("zsh");
  if (onPath) return (resolved = onPath);

  if (fs.existsSync(BIN_PATH)) return (resolved = BIN_PATH);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  try {
    downloadDebs();
  } catch (_) {
    // Local apt package-list cache missing/stale — refresh once (needs
    // root; the same passwordless-sudo pattern ci.yml's own
    // `sudo apt-get install -y tmux` step already relies on) and retry.
    execSync("sudo apt-get update -qq", { stdio: "inherit" });
    downloadDebs();
  }

  const debs = fs
    .readdirSync(CACHE_DIR)
    .filter((f) => f.endsWith(".deb"))
    .map((f) => path.join(CACHE_DIR, f));
  if (debs.length === 0) {
    throw new Error(
      "zsh test fixture: apt-get download produced no .deb files in " +
        CACHE_DIR,
    );
  }

  fs.mkdirSync(EXTRACTED_DIR, { recursive: true });
  for (const deb of debs) {
    execFileSync("dpkg-deb", ["-x", deb, EXTRACTED_DIR]);
  }

  if (!fs.existsSync(BIN_PATH)) {
    throw new Error(
      `zsh test fixture: expected binary at ${BIN_PATH} after extracting ${debs.join(", ")}`,
    );
  }
  fs.chmodSync(BIN_PATH, 0o755);
  return (resolved = BIN_PATH);
}

module.exports = { resolveZshBin };
