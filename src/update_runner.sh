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
#   MOBUX_UPDATE_RESULT    optional file the last failure reason is written to,
#                          so the server can show it on the update card instead
#                          of a generic "it didn't come up"
#   MOBUX_UPDATE_CARGO     cargo to run for the fallback (default "cargo",
#                          with a fallback to ~/.cargo/bin/cargo when that's
#                          not on PATH)
#   MOBUX_UPDATE_ASSET_BASE  release-asset base URL (default
#                          https://github.com/mvhenten/mobux/releases/download;
#                          the asset is fetched from
#                          <BASE>/v<VERSION>/<ASSET>). Tests point this at a
#                          file:// dir to stay off the network.
#   MOBUX_UPDATE_ASSET     asset file name (default: the asset for the running
#                          architecture, mobux-<triple>.tar.gz, matching what
#                          scripts/build-release-asset.sh uploads)
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
if [ -n "${MOBUX_UPDATE_ASSET:-}" ]; then
  ASSET="$MOBUX_UPDATE_ASSET"
else
  case "$(uname -m)" in
    aarch64|arm64) ASSET="${CRATE}-aarch64-unknown-linux-gnu.tar.gz" ;;
    *)             ASSET="${CRATE}-x86_64-unknown-linux-gnu.tar.gz" ;;
  esac
fi
RESULT_FILE="${MOBUX_UPDATE_RESULT:-}"

PREV="${BIN}.prev"
# Why the new version was judged unhealthy. Set by health_check, turned into a
# recorded reason by main() once the rollback outcome is known.
HEALTH_FAILURE=""

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

# Record why the run failed, both in the log and in the result file the server
# reads for the update card. Called for terminal failures only.
record_failure() {
  log "FAILURE: $*"
  [ -n "$RESULT_FILE" ] || return 0
  printf '%s\n' "$*" > "$RESULT_FILE" 2>/dev/null || true
}

# Same, but never clobbers a reason already on disk. Used where this run is
# refusing to start because another updater owns the file.
record_failure_if_absent() {
  log "FAILURE: $*"
  [ -n "$RESULT_FILE" ] || return 0
  [ -s "$RESULT_FILE" ] && return 0
  printf '%s\n' "$*" > "$RESULT_FILE" 2>/dev/null || true
}

clear_failure() {
  [ -n "$RESULT_FILE" ] || return 0
  rm -f "$RESULT_FILE" 2>/dev/null || true
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

other_scheme() {
  if [ "$SCHEME" = "https" ]; then printf 'http'; else printf 'https'; fi
}

# Fetch /api/identify over $1. -k: self-signed leaf certs are expected on the
# local instance. Prints the body; returns non-zero when nothing answers.
identify() {
  curl -fsSk --max-time 5 "${1}://127.0.0.1:${PORT}/api/identify" 2>/dev/null
}

# The new binary is up, just not on the scheme this instance was configured
# for — the one failure mode a generic timeout hides completely. Only
# MOBUX_TLS / --tls decides which scheme mobux serves; --behind-tls-proxy is
# about the auth gate, so it is deliberately not offered as a remedy here.
scheme_mismatch_reason() {
  local served="$1"
  if [ "$served" = "http" ]; then
    printf '%s' "version ${VERSION} serves http, but this instance is configured for https. mobux serves plain HTTP unless TLS is asked for: set MOBUX_TLS=1 or --tls in the systemd unit '${SERVICE}' to keep https, or switch this instance to http, then upgrade again."
    return 0
  fi
  printf '%s' "version ${VERSION} serves https, but this instance is configured for http. Drop MOBUX_TLS / --tls from the systemd unit '${SERVICE}', or switch this instance to https, then upgrade again."
}

# Poll the running instance's /api/identify until it reports VERSION or we
# time out. Returns 0 on the new version showing up, 1 otherwise. When the
# expected scheme stays silent we also probe the other one: the new version
# answering there is a configuration mismatch, not a broken build, and it gets
# its own actionable message. We still roll back — the phone talks to the
# configured scheme.
#
# The reason lands in HEALTH_FAILURE rather than the result file: what the user
# needs to read also depends on whether the rollback then worked, and only
# main() knows that.
health_check() {
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  local other; other="$(other_scheme)"
  log "health-check ${SCHEME}://127.0.0.1:${PORT}/api/identify expecting version ${VERSION} (timeout ${HEALTH_TIMEOUT}s)"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    local body
    if body="$(identify "$SCHEME")"; then
      case "$body" in
        *"\"version\":\"${VERSION}\""*) log "health-check ok: ${VERSION} live"; return 0 ;;
      esac
    else
      if body="$(identify "$other")"; then
        case "$body" in
          *"\"version\":\"${VERSION}\""*)
            HEALTH_FAILURE="$(scheme_mismatch_reason "$other")"
            log "health-check FAILED: ${HEALTH_FAILURE}"
            return 1
            ;;
        esac
      fi
    fi
    sleep 2
  done
  HEALTH_FAILURE="version ${VERSION} did not answer on ${SCHEME}://127.0.0.1:${PORT}/api/identify within ${HEALTH_TIMEOUT}s."
  log "health-check FAILED: ${HEALTH_FAILURE}"
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
  log "self-update start: crate=${CRATE} version=${VERSION} bin=${BIN} root=${ROOT} service=${SERVICE} port=${PORT} scheme=${SCHEME}"

  # Cross-process lock (belt-and-braces with the in-process guard in mobux):
  # even two independently spawned scripts can't race the snapshot/install. The
  # lock fd stays open for the whole run; flock releases it when the process
  # exits. If flock isn't available, proceed (the in-process guard still holds).
  #
  # Nothing is cleared before the lock is ours: a run that refuses to start
  # must not wipe the reason the run that owns the file left behind.
  LOCK_FILE="${ROOT}/mobux-update.lock"
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK_FILE" || {
      record_failure_if_absent "could not open the updater lock file ${LOCK_FILE}; no update was attempted."
      exit 4
    }
    if ! flock -n 9; then
      record_failure_if_absent "another updater already holds ${LOCK_FILE}; this run refused to race it and no update was attempted."
      exit 4
    fi
  else
    log "WARN: flock not found; relying on in-process guard only"
  fi

  clear_failure

  if [ ! -f "$BIN" ]; then
    record_failure "no binary at ${BIN}; the update could not start. Check that the '${SERVICE}' unit runs the cargo-installed mobux."
    exit 1
  fi

  log "snapshot ${BIN} -> ${PREV}"
  if ! cp -f "$BIN" "$PREV"; then
    record_failure "could not snapshot ${BIN} to ${PREV}; the update was abandoned before anything changed. Check the permissions and free space on ${ROOT}."
    exit 1
  fi

  if ! install_from_release; then
    # Fallback: releases without a prebuilt asset install via cargo, the
    # original (slow, 5-10 min compile) path. cargo is only required here.
    if ! resolve_cargo; then
      record_failure "no prebuilt asset for ${VERSION} and cargo was not found on PATH or at \$HOME/.cargo/bin/cargo, so the fallback build could not run. Add ~/.cargo/bin to the '${SERVICE}' unit's PATH or set MOBUX_UPDATE_CARGO. The previous version is untouched."
      exit 1
    fi
    log "cargo install ${CRATE} --locked --version ${VERSION} --root ${ROOT}"
    if ! "$CARGO_BIN" install "$CRATE" --locked --version "$VERSION" --root "$ROOT" --force; then
      record_failure "installing ${VERSION} failed: the prebuilt asset was unusable and cargo install did not complete. The previous version is untouched."
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
    clear_failure
    log "self-update SUCCESS: now running ${VERSION}"
    exit 0
  fi

  log "new version unhealthy; rolling back"
  if ! rollback; then
    record_failure "${HEALTH_FAILURE} The rollback failed: ${BIN} still holds ${VERSION}. Restore the snapshot at ${PREV} by hand and restart the '${SERVICE}' unit."
    log "self-update FAILED and the rollback did not run — manual intervention needed"
    exit 3
  fi
  if ! health_check_prev; then
    record_failure "${HEALTH_FAILURE} The previous binary was restored to ${BIN}, but nothing is answering on port ${PORT}. Restart the '${SERVICE}' unit by hand."
    log "self-update FAILED and rollback may be incomplete — manual intervention needed"
    exit 3
  fi
  record_failure "${HEALTH_FAILURE} Rolled back to the previous version, which is answering again."
  log "self-update rolled back successfully"
  exit 2
}

# After rollback we can't know the prior version string here, so just confirm
# *something* answers on the port (the restored binary is up).
health_check_prev() {
  if [ "$NO_SYSTEMD" = "1" ]; then
    log "skip post-rollback health-check (--no-systemd)"
    return 0
  fi
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  local other; other="$(other_scheme)"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if identify "$SCHEME" >/dev/null; then
      log "post-rollback health-check ok: instance answering on ${SCHEME}://127.0.0.1:${PORT}"
      return 0
    fi
    if identify "$other" >/dev/null; then
      log "post-rollback health-check ok, but on ${other} while this instance is configured for ${SCHEME} — reconcile the unit's TLS setting with ${SCHEME}"
      return 0
    fi
    sleep 2
  done
  log "post-rollback health-check FAILED: nothing answering on ${PORT} over ${SCHEME} or ${other}"
  return 1
}

main
