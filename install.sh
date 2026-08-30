#!/usr/bin/env bash
# One-line installer for the prebuilt mobux binary:
#
#   curl -fsSL https://raw.githubusercontent.com/mvhenten/mobux/main/install.sh | bash
#
# Downloads the latest GitHub release asset built by
# scripts/build-release-asset.sh, verifies its sha256, and drops the binary in
# ~/.local/bin. User-local only: no sudo, no writes outside $HOME, no stdin.
#
# Overridable for tests and mirrors:
#   MOBUX_INSTALL_BASE_URL  where to fetch <asset> and <asset>.sha256 from
#                           (default: the GitHub "latest release" download URL;
#                           tests point this at a file:// directory)
#   MOBUX_INSTALL_DIR       install destination (default ~/.local/bin)

set -euo pipefail

CRATE="mobux"
TARGET="x86_64-unknown-linux-gnu"
ASSET="${CRATE}-${TARGET}.tar.gz"
BASE_URL="${MOBUX_INSTALL_BASE_URL:-https://github.com/mvhenten/mobux/releases/latest/download}"
INSTALL_DIR="${MOBUX_INSTALL_DIR:-$HOME/.local/bin}"

say()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

os="$(uname -s)"
arch="$(uname -m)"
if [ "$os" != "Linux" ] || [ "$arch" != "x86_64" ]; then
  die "no prebuilt binary for ${os}/${arch} — mobux ships one only for Linux x86_64.
Build from source instead: cargo install ${CRATE}"
fi

for tool in curl tar sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required but not installed"
done

CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}"
mkdir -p "$CACHE_DIR"
WORK="$(mktemp -d "${CACHE_DIR}/mobux-install.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

say "downloading ${BASE_URL}/${ASSET}"
curl -fsSL --retry 2 --max-time 300 -o "${WORK}/${ASSET}" "${BASE_URL}/${ASSET}" \
  || die "could not download ${ASSET} from ${BASE_URL}"
curl -fsSL --retry 2 --max-time 60 -o "${WORK}/${ASSET}.sha256" "${BASE_URL}/${ASSET}.sha256" \
  || die "could not download ${ASSET}.sha256 from ${BASE_URL}"

if ! (cd "$WORK" && sha256sum -c "${ASSET}.sha256" >/dev/null 2>&1); then
  die "sha256 verification failed for ${ASSET} — refusing to install"
fi
say "sha256 verified"

tar -xzf "${WORK}/${ASSET}" -C "$WORK" "$CRATE" \
  || die "could not extract ${CRATE} from ${ASSET}"

mkdir -p "$INSTALL_DIR"
# Stage inside the destination dir so the final move is an atomic rename and
# never leaves a half-written binary behind.
mv -f "${WORK}/${CRATE}" "${INSTALL_DIR}/.${CRATE}.new" \
  || die "could not write to ${INSTALL_DIR}"
chmod 755 "${INSTALL_DIR}/.${CRATE}.new"
mv -f "${INSTALL_DIR}/.${CRATE}.new" "${INSTALL_DIR}/${CRATE}"
say "installed ${INSTALL_DIR}/${CRATE}"

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) warn "${INSTALL_DIR} is not on your PATH — add it: export PATH=\"${INSTALL_DIR}:\$PATH\"" ;;
esac

command -v tmux >/dev/null 2>&1 || warn "tmux is not installed; mobux needs it at runtime"

host="$(hostname 2>/dev/null || echo your-host)"
cat <<EOF

Quick start:

  export MOBUX_AUTH_USER=me
  export MOBUX_PIN=12345
  ${CRATE} --port 5151
  ${CRATE} service install --port 5151   # or keep it running across reboots

Then open http://${host}:5151 from a phone on the same network.

mobux serves plain HTTP. Add --tls (or MOBUX_TLS=1) to serve HTTPS with a
generated certificate — recommended on any network you do not trust, and
unnecessary behind a TLS proxy.
EOF
