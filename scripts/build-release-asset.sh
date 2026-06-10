#!/usr/bin/env bash
# Build the prebuilt Linux x86_64 release asset attached to each GitHub
# release. Runs inside the Release workflow as a semantic-release prepare step
# (@semantic-release/exec), AFTER @semantic-release-cargo/semantic-release-cargo
# has patched the computed version into Cargo.toml — so the binary's
# CARGO_PKG_VERSION matches the tag, which the self-updater's health check
# relies on (/api/identify must report the target version).
#
# Output (uploaded by @semantic-release/github, see .releaserc.json):
#   target/dist/mobux-x86_64-unknown-linux-gnu.tar.gz
#   target/dist/mobux-x86_64-unknown-linux-gnu.tar.gz.sha256

set -euo pipefail

VERSION="${1:?usage: build-release-asset.sh <version>}"
TARGET="x86_64-unknown-linux-gnu"
ASSET="mobux-${TARGET}.tar.gz"
OUT_DIR="target/dist"

# Guard: the cargo plugin must have patched the version before we build, or
# the shipped binary would identify as the previous version and every
# self-update health check would fail.
if ! grep -q "^version = \"${VERSION}\"" Cargo.toml; then
  echo "ERROR: Cargo.toml is not at version ${VERSION} — build must run after" \
    "semantic-release-cargo's prepare step" >&2
  exit 1
fi

cargo build --release

mkdir -p "$OUT_DIR"
tar -C target/release -czf "${OUT_DIR}/${ASSET}" mobux
(cd "$OUT_DIR" && sha256sum "$ASSET" > "${ASSET}.sha256")

echo "built ${OUT_DIR}/${ASSET} (version ${VERSION})"
