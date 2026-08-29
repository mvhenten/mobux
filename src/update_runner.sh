#!/usr/bin/env bash
# mobux self-updater (issue #130). Embedded in the mobux binary, written to
# MOBUX_DATA_DIR and spawned fully detached so it outlives the server it
# restarts. Everything is parameterized — it NEVER hardcodes a port or unit.
#
# Steps:
#   1. snapshot the current binary  (cp mobux mobux.prev)
#   2. install the new version: download the prebuilt release asset from
#      GitHub releases (curl + sha256 verify + atomic rename over <BIN>);
#      when the asset is missing (older releases) or fails verification,
#      fall back to `cargo install mobux --locked --version <VERSION>`
#   3. restart the systemd unit     (systemctl --user restart <SERVICE>)
#   4. health-check /api/identify on <PORT> for the new version, up to N s
#   5. on failure: restore mobux.prev, restart again, log the rollback
#
# Required env/args (set by the spawning Rust code):
#   MOBUX_UPDATE_VERSION   target version (e.g. 0.1.5)
#   MOBUX_UPDATE_BIN       path to the live binary (~/.cargo/bin/mobux)
#   MOBUX_UPDATE_ROOT      cargo --root (parent of bin/, e.g. ~/.cargo)
#   MOBUX_UPDATE_SERVICE   systemd --user unit name (e.g. mobux)
#   MOBUX_UPDATE_PORT      port the instance serves on (for health check)
#   MOBUX_UPDATE_SCHEME    http|https (default https)
#   MOBUX_UPDATE_LOG       log file path
#   MOBUX_UPDATE_CARGO     cargo to run for the fallback (default "cargo",
#                          with a fallback to ~/.cargo/bin/cargo when that's
#                          not on PATH)
#   MOBUX_UPDATE_ASSET_BASE  release-asset base URL (default
#                          https://github.com/mvhenten/mobux/releases/download;
#                          the asset is fetched from
#                          <BASE>/v<VERSION>/<ASSET>). Tests point this at a
#                          file:// dir to stay off the network.
#   MOBUX_UPDATE_ASSET     asset file name (default
#                          mobux-x86_64-unknown-linux-gnu.tar.gz, matching
#                          what scripts/build-release-asset.sh uploads)
#
# Flags:
#   --no-systemd    skip all systemctl calls (test mode); steps 1,2,4,5 only,
#                   and the "restart" is a no-op the test harness stands in for.
#   --install-only  stop after step 2. `mobux update` drives this: the CLI owns
#                   the restart (there may be no service at all) and there is no
#                   server to health-check, so the script only snapshots and
#                   installs. Exit 0 installed, 1 failed, 4 lock held.

set -uo pipefail

NO_SYSTEMD=0
INSTALL_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --no-systemd) NO_SYSTEMD=1 ;;
    --install-only) INSTALL_ONLY=1 ;;
  esac
done

VERSION="${MOBUX_UPDATE_VERSION:?MOBUX_UPDATE_VERSION required}"
BIN="${MOBUX_UPDATE_BIN:?MOBUX_UPDATE_BIN required}"
ROOT="${MOBUX_UPDATE_ROOT:?MOBUX_UPDATE_ROOT required}"
SERVICE="${MOBUX_UPDATE_SERVICE:-mobux}"
PORT="${MOBUX_UPDATE_PORT:-5151}"
SCHEME="${MOBUX_UPDATE_SCHEME:-https}"
HEALTH_TIMEOUT="${MOBUX_UPDATE_HEALTH_TIMEOUT:-90}"
CARGO_BIN="${MOBUX_UPDATE_CARGO:-cargo}"
CRATE="${MOBUX_UPDATE_CRATE:-mobux}"
ASSET_BASE="${MOBUX_UPDATE_ASSET_BASE:-https://github.com/mvhenten/mobux/releases/download}"
ASSET="${MOBUX_UPDATE_ASSET:-${CRATE}-x86_64-unknown-linux-gnu.tar.gz}"

PREV="${BIN}.prev"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

# Resolve a usable cargo. Under systemd the unit PATH usually lacks
# ~/.cargo/bin, so a bare `cargo` fails instantly — fall back to the rustup
# default install location before giving up with a clear log line.
resolve_cargo() {
  if command -v "$CARGO_BIN" >/dev/null 2>&1; then
    return 0
  fi
  if [ -x "$HOME/.cargo/bin/cargo" ]; then
    log "cargo not on PATH; falling back to $HOME/.cargo/bin/cargo"
    CARGO_BIN="$HOME/.cargo/bin/cargo"
    return 0
  fi
  log "ABORT: cargo not found on PATH or at $HOME/.cargo/bin/cargo — set MOBUX_UPDATE_CARGO or add ~/.cargo/bin to the unit's PATH"
  return 1
}

# Primary install path: download the prebuilt release asset + its .sha256,
# verify, and atomically rename the extracted binary over $BIN (the staging
# dir lives under $ROOT, same filesystem as $BIN, so mv is an atomic rename).
# Any failure returns 1 and the caller falls back to `cargo install` — the
# asset is simply missing on releases that predate prebuilt binaries.
install_from_release() {
  local url="${ASSET_BASE}/v${VERSION}/${ASSET}"
  local work
  work="$(mktemp -d "${ROOT}/mobux-update-dl.XXXXXX")" || {
    log "could not create staging dir under ${ROOT}"
    return 1
  }
  log "downloading prebuilt binary ${url}"
  if ! curl -fsSL --retry 2 --max-time 300 -o "${work}/${ASSET}" "$url"; then
    log "prebuilt asset unavailable for ${VERSION}; falling back to cargo install"
    rm -rf "$work"
    return 1
  fi
  if ! curl -fsSL --retry 2 --max-time 60 -o "${work}/${ASSET}.sha256" "${url}.sha256"; then
    log "checksum file unavailable for ${VERSION}; falling back to cargo install"
    rm -rf "$work"
    return 1
  fi
  if ! (cd "$work" && sha256sum -c "${ASSET}.sha256" >/dev/null 2>&1); then
    log "sha256 verification FAILED for ${ASSET}; falling back to cargo install"
    rm -rf "$work"
    return 1
  fi
  if ! tar -xzf "${work}/${ASSET}" -C "$work" "$CRATE"; then
    log "could not extract ${CRATE} from ${ASSET}; falling back to cargo install"
    rm -rf "$work"
    return 1
  fi
  chmod +x "${work}/${CRATE}"
  if ! mv -f "${work}/${CRATE}" "$BIN"; then
    log "could not move new binary into place at ${BIN}; falling back to cargo install"
    rm -rf "$work"
    return 1
  fi
  rm -rf "$work"
  log "installed prebuilt binary ${VERSION} -> ${BIN} (sha256 verified)"
}

restart_service() {
  if [ "$NO_SYSTEMD" = "1" ]; then
    log "skip restart (--no-systemd): would restart unit '$SERVICE'"
    return 0
  fi
  log "restarting systemd --user unit '$SERVICE'"
  systemctl --user restart "$SERVICE"
}

# Poll the running instance's /api/identify until it reports VERSION or we
# time out. Returns 0 on the new version showing up, 1 otherwise.
health_check() {
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  local url="${SCHEME}://127.0.0.1:${PORT}/api/identify"
  log "health-check ${url} expecting version ${VERSION} (timeout ${HEALTH_TIMEOUT}s)"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    # -k: self-signed leaf certs are expected on the local instance.
    local body
    body="$(curl -fsSk --max-time 5 "$url" 2>/dev/null)" || { sleep 2; continue; }
    case "$body" in
      *"\"version\":\"${VERSION}\""*) log "health-check ok: ${VERSION} live"; return 0 ;;
    esac
    sleep 2
  done
  log "health-check FAILED: ${VERSION} did not come up within ${HEALTH_TIMEOUT}s"
  return 1
}

rollback() {
  log "ROLLBACK: restoring previous binary from ${PREV}"
  if [ ! -f "$PREV" ]; then
    log "ROLLBACK FAILED: no snapshot at ${PREV}"
    return 1
  fi
  cp -f "$PREV" "$BIN" || { log "ROLLBACK FAILED: could not restore ${BIN}"; return 1; }
  restart_service
  log "ROLLBACK complete; restored prior binary"
}

main() {
  log "self-update start: crate=${CRATE} version=${VERSION} bin=${BIN} root=${ROOT} service=${SERVICE} port=${PORT}"

  # Cross-process lock (belt-and-braces with the in-process guard in mobux):
  # even two independently spawned scripts can't race the snapshot/install. The
  # lock fd stays open for the whole run; flock releases it when the process
  # exits. If flock isn't available, proceed (the in-process guard still holds).
  LOCK_FILE="${ROOT}/mobux-update.lock"
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK_FILE" || { log "ABORT: could not open lock file ${LOCK_FILE}"; exit 4; }
    if ! flock -n 9; then
      log "ABORT: another updater holds the lock (${LOCK_FILE}); refusing to race"
      exit 4
    fi
  else
    log "WARN: flock not found; relying on in-process guard only"
  fi

  if [ ! -f "$BIN" ]; then
    log "ABORT: binary not found at ${BIN}"
    exit 1
  fi

  log "snapshot ${BIN} -> ${PREV}"
  if ! cp -f "$BIN" "$PREV"; then
    log "ABORT: could not snapshot current binary"
    exit 1
  fi

  if ! install_from_release; then
    # Fallback: releases without a prebuilt asset install via cargo, the
    # original (slow, 5-10 min compile) path. cargo is only required here.
    resolve_cargo || exit 1
    log "cargo install ${CRATE} --locked --version ${VERSION} --root ${ROOT}"
    if ! "$CARGO_BIN" install "$CRATE" --locked --version "$VERSION" --root "$ROOT" --force; then
      log "ERROR: cargo install failed; binary unchanged, no restart needed"
      # cargo install is atomic-ish: a failed build leaves the old binary. No
      # rollback needed, but make sure the snapshot is in place anyway.
      cp -f "$PREV" "$BIN" 2>/dev/null || true
      exit 1
    fi
  fi

  if [ "$INSTALL_ONLY" = "1" ]; then
    log "install-only: ${VERSION} is in place at ${BIN} (previous binary kept at ${PREV})"
    exit 0
  fi

  restart_service

  if health_check; then
    log "self-update SUCCESS: now running ${VERSION}"
    exit 0
  fi

  log "new version unhealthy; rolling back"
  if rollback && health_check_prev; then
    log "self-update rolled back successfully"
    exit 2
  fi
  log "self-update FAILED and rollback may be incomplete — manual intervention needed"
  exit 3
}

# After rollback we can't know the prior version string here, so just confirm
# *something* answers on the port (the restored binary is up).
health_check_prev() {
  if [ "$NO_SYSTEMD" = "1" ]; then
    log "skip post-rollback health-check (--no-systemd)"
    return 0
  fi
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  local url="${SCHEME}://127.0.0.1:${PORT}/api/identify"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsSk --max-time 5 "$url" >/dev/null 2>&1; then
      log "post-rollback health-check ok: instance answering on ${PORT}"
      return 0
    fi
    sleep 2
  done
  log "post-rollback health-check FAILED: nothing answering on ${PORT}"
  return 1
}

main
