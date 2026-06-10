#!/usr/bin/env bash
# mobux self-updater (issue #130). Embedded in the mobux binary, written to
# MOBUX_DATA_DIR and spawned fully detached so it outlives the server it
# restarts. Everything is parameterized — it NEVER hardcodes a port or unit.
#
# Steps:
#   1. snapshot the current binary  (cp mobux mobux.prev)
#   2. cargo install mobux --locked --version <VERSION> --root <ROOT>
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
#   MOBUX_UPDATE_CARGO     cargo to run (default "cargo", with a fallback to
#                          ~/.cargo/bin/cargo when that's not on PATH)
#
# Flags:
#   --no-systemd   skip all systemctl calls (test mode); steps 1,2,4,5 only,
#                  and the "restart" is a no-op the test harness stands in for.

set -uo pipefail

NO_SYSTEMD=0
for arg in "$@"; do
  case "$arg" in
    --no-systemd) NO_SYSTEMD=1 ;;
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

  resolve_cargo || exit 1

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

  log "cargo install ${CRATE} --locked --version ${VERSION} --root ${ROOT}"
  if ! "$CARGO_BIN" install "$CRATE" --locked --version "$VERSION" --root "$ROOT" --force; then
    log "ERROR: cargo install failed; binary unchanged, no restart needed"
    # cargo install is atomic-ish: a failed build leaves the old binary. No
    # rollback needed, but make sure the snapshot is in place anyway.
    cp -f "$PREV" "$BIN" 2>/dev/null || true
    exit 1
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
