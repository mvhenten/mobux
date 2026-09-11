#!/usr/bin/env bash
# Build the prebuilt Linux release assets attached to each GitHub release, one
# per supported architecture. Runs inside the Release workflow as a
# semantic-release prepare step (@semantic-release/exec), AFTER
# @semantic-release-cargo/semantic-release-cargo has patched the computed
# version into Cargo.toml — so every binary's CARGO_PKG_VERSION matches the
# tag, which the self-updater's health check relies on (/api/identify must
# report the target version).
#
# aarch64 is cross-compiled from the x86_64 release runner with the
# gcc-aarch64-linux-gnu toolchain the workflow installs; on a native aarch64
# host the same target builds without it.
#
# Output (uploaded by @semantic-release/github, see .releaserc.json):
#   target/dist/mobux-x86_64-unknown-linux-gnu.tar.gz[.sha256]
#   target/dist/mobux-aarch64-unknown-linux-gnu.tar.gz[.sha256]

set -euo pipefail

VERSION="${1:?usage: build-release-asset.sh <version>}"
CRATE="mobux"
TARGETS="x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu"
OUT_DIR="target/dist"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Guard: the cargo plugin must have patched the version before we build, or
# the shipped binaries would identify as the previous version and every
# self-update health check would fail.
if ! grep -q "^version = \"${VERSION}\"" Cargo.toml; then
  die "Cargo.toml is not at version ${VERSION} — build must run after semantic-release-cargo's prepare step"
fi

# Point the C toolchain at the target when it is not the host's own. rusqlite's
# bundled SQLite and aws-lc-sys (rustls' crypto provider) both compile C, so a
# cross build needs a cross compiler, not just a linker.
setup_cross() {
  local target="$1"
  case "$target" in
    aarch64-unknown-linux-gnu)
      if [ "$(uname -m)" = "aarch64" ]; then
        return 0
      fi
      command -v aarch64-linux-gnu-gcc >/dev/null 2>&1 \
        || die "aarch64-linux-gnu-gcc not found — install gcc-aarch64-linux-gnu to cross-build ${target}"
      export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER="aarch64-linux-gnu-gcc"
      export CC_aarch64_unknown_linux_gnu="aarch64-linux-gnu-gcc"
      export CXX_aarch64_unknown_linux_gnu="aarch64-linux-gnu-g++"
      export AR_aarch64_unknown_linux_gnu="aarch64-linux-gnu-ar"
      ;;
  esac
}

mkdir -p "$OUT_DIR"

for target in $TARGETS; do
  setup_cross "$target"
  asset="${CRATE}-${target}.tar.gz"
  cargo build --release --target "$target"
  tar -C "target/${target}/release" -czf "${OUT_DIR}/${asset}" "$CRATE"
  (cd "$OUT_DIR" && sha256sum "$asset" > "${asset}.sha256")
  echo "built ${OUT_DIR}/${asset} (version ${VERSION})"
done
