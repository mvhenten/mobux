#!/usr/bin/env bash
# Tests for the embedded self-updater (src/update_runner.sh).
#
# Runs the updater in --no-systemd mode against a dummy binary and a stub
# "cargo" so nothing real is installed and no systemctl is invoked. Health
# checks are pointed at a throwaway local HTTP server whose /api/identify
# response the test controls, so we can drive both the success and the
# rollback paths deterministically. No network, no prod anything.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPDATER="$SCRIPT_DIR/src/update_runner.sh"

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); printf 'ok   - %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL - %s\n' "$1"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; [ -n "${HC_PID:-}" ] && kill "$HC_PID" 2>/dev/null' EXIT

# Build a stub cargo whose `install` copies a payload (the "new binary") over
# the target binary, simulating a successful or failing build.
make_stub_cargo() {
  local mode="$1"  # success|fail
  local payload="$2"
  local stub="$WORK/cargo"
  cat > "$stub" <<EOF
#!/usr/bin/env bash
# args: install <crate> --locked --version <v> --root <root> --force
if [ "$mode" = "fail" ]; then
  echo "stub cargo: build failed" >&2
  exit 1
fi
# Find --root <root>; install to <root>/bin/<crate-name-from-BIN-basename>
root=""
prev=""
for a in "\$@"; do
  if [ "\$prev" = "--root" ]; then root="\$a"; fi
  prev="\$a"
done
mkdir -p "\$root/bin"
# The live binary path is passed via env in the real flow; here we just
# overwrite whatever MOBUX_UPDATE_BIN points at.
cp "$payload" "\$MOBUX_UPDATE_BIN"
exit 0
EOF
  chmod +x "$stub"
  echo "$stub"
}

# Start the health-check server, capturing its assigned port from stdout.
PORTFILE="$WORK/port"
python3 - "$WORK" >"$PORTFILE" 2>/dev/null <<'PY' &
import http.server, socketserver, sys, os
work = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            with open(os.path.join(work, "identify.json"), "rb") as f:
                body = f.read()
        except FileNotFoundError:
            self.send_response(503); self.end_headers(); return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass
with socketserver.TCPServer(("127.0.0.1", 0), H) as s:
    print(s.server_address[1], flush=True)
    s.serve_forever()
PY
HC_PID=$!
for _ in $(seq 1 50); do
  HC_PORT="$(cat "$PORTFILE" 2>/dev/null)"
  [ -n "$HC_PORT" ] && break
  sleep 0.1
done
if [ -z "${HC_PORT:-}" ]; then echo "could not start health server"; exit 1; fi

run_updater() {
  # shellcheck disable=SC2086
  env \
    MOBUX_UPDATE_VERSION="$1" \
    MOBUX_UPDATE_BIN="$2" \
    MOBUX_UPDATE_ROOT="$3" \
    MOBUX_UPDATE_SERVICE="ignored" \
    MOBUX_UPDATE_PORT="$HC_PORT" \
    MOBUX_UPDATE_SCHEME="http" \
    MOBUX_UPDATE_HEALTH_TIMEOUT="6" \
    MOBUX_UPDATE_CARGO="$4" \
    MOBUX_UPDATE_CRATE="mobux" \
    MOBUX_UPDATE_LOG="$WORK/update.log" \
    bash "$UPDATER" --no-systemd
}

# ── Test 1: successful update ──────────────────────────────────────────────
# Old binary says v0, new payload says v1, health server reports v1.
ROOT1="$WORK/root1"; mkdir -p "$ROOT1/bin"
BIN1="$ROOT1/bin/mobux"
printf 'OLD-V0' > "$BIN1"
printf 'NEW-V1' > "$WORK/payload-v1"
printf '{"app":"mobux","version":"1.0.0"}' > "$WORK/identify.json"
CARGO_OK="$(make_stub_cargo success "$WORK/payload-v1")"

run_updater "1.0.0" "$BIN1" "$ROOT1" "$CARGO_OK"
rc=$?
[ "$rc" -eq 0 ] && ok "success: exit 0" || bad "success: exit $rc"
[ "$(cat "$BIN1")" = "NEW-V1" ] && ok "success: binary replaced with new payload" || bad "success: binary not replaced"
[ "$(cat "$BIN1.prev")" = "OLD-V0" ] && ok "success: snapshot holds old binary" || bad "success: snapshot wrong"

# ── Test 2: new version unhealthy → rollback ───────────────────────────────
# cargo "succeeds" installing v2 payload, but the health server keeps reporting
# the OLD version, so the new version never comes up → rollback restores prev.
ROOT2="$WORK/root2"; mkdir -p "$ROOT2/bin"
BIN2="$ROOT2/bin/mobux"
printf 'OLD-V0' > "$BIN2"
printf 'BROKEN-V2' > "$WORK/payload-v2"
# Health server reports the OLD version → target 2.0.0 never appears.
printf '{"app":"mobux","version":"0.0.0"}' > "$WORK/identify.json"
CARGO_OK2="$(make_stub_cargo success "$WORK/payload-v2")"

run_updater "2.0.0" "$BIN2" "$ROOT2" "$CARGO_OK2"
rc=$?
[ "$rc" -eq 2 ] && ok "rollback: exit 2 (rolled back)" || bad "rollback: exit $rc (expected 2)"
[ "$(cat "$BIN2")" = "OLD-V0" ] && ok "rollback: binary restored to old" || bad "rollback: binary not restored ($(cat "$BIN2"))"

# ── Test 3: cargo install fails → old binary intact, no rollback churn ──────
ROOT3="$WORK/root3"; mkdir -p "$ROOT3/bin"
BIN3="$ROOT3/bin/mobux"
printf 'OLD-V0' > "$BIN3"
CARGO_FAIL="$(make_stub_cargo fail "")"

run_updater "3.0.0" "$BIN3" "$ROOT3" "$CARGO_FAIL"
rc=$?
[ "$rc" -eq 1 ] && ok "cargo-fail: exit 1" || bad "cargo-fail: exit $rc (expected 1)"
[ "$(cat "$BIN3")" = "OLD-V0" ] && ok "cargo-fail: binary unchanged" || bad "cargo-fail: binary changed"

# ── Test 4: missing binary → abort ─────────────────────────────────────────
ROOT4="$WORK/root4"; mkdir -p "$ROOT4/bin"
BIN4="$ROOT4/bin/mobux"  # not created
run_updater "4.0.0" "$BIN4" "$ROOT4" "$CARGO_OK"
rc=$?
[ "$rc" -eq 1 ] && ok "missing-bin: exit 1 (abort)" || bad "missing-bin: exit $rc (expected 1)"

# ── Test 5: flock backstop → a second updater refuses to race ──────────────
# Hold the lock from the test, then run the updater against the same ROOT. With
# flock present it must refuse (exit 4) and leave the binary untouched.
if command -v flock >/dev/null 2>&1; then
  ROOT5="$WORK/root5"; mkdir -p "$ROOT5/bin"
  BIN5="$ROOT5/bin/mobux"
  printf 'OLD-V0' > "$BIN5"
  printf 'NEW-V5' > "$WORK/payload-v5"
  printf '{"app":"mobux","version":"5.0.0"}' > "$WORK/identify.json"
  CARGO_OK5="$(make_stub_cargo success "$WORK/payload-v5")"

  # Acquire the lock in a background holder that sleeps while we run the updater.
  ( exec 8>"$ROOT5/mobux-update.lock"; flock 8; sleep 5 ) &
  HOLDER=$!
  sleep 0.5  # let the holder grab the lock first

  run_updater "5.0.0" "$BIN5" "$ROOT5" "$CARGO_OK5"
  rc=$?
  kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null

  [ "$rc" -eq 4 ] && ok "flock: second updater refused (exit 4)" || bad "flock: exit $rc (expected 4)"
  [ "$(cat "$BIN5")" = "OLD-V0" ] && ok "flock: binary untouched while locked" || bad "flock: binary changed under lock"

  # Sanity: with the lock free again, the same run now succeeds.
  run_updater "5.0.0" "$BIN5" "$ROOT5" "$CARGO_OK5"
  rc=$?
  [ "$rc" -eq 0 ] && ok "flock: succeeds once lock is free" || bad "flock: exit $rc after unlock (expected 0)"
else
  echo "ok   - flock: SKIP (flock not installed)"
fi

# ── Test 6: cargo not on PATH → ~/.cargo/bin fallback resolves it ──────────
# Simulate the stripped systemd --user env: MOBUX_UPDATE_CARGO names a bare
# `cargo` that isn't on PATH, but a working stub lives in $HOME/.cargo/bin. The
# script's fallback must find it and complete the install.
ROOT6="$WORK/root6"; mkdir -p "$ROOT6/bin"
BIN6="$ROOT6/bin/mobux"
printf 'OLD-V0' > "$BIN6"
printf 'NEW-V6' > "$WORK/payload-v6"
printf '{"app":"mobux","version":"6.0.0"}' > "$WORK/identify.json"
FAKE_HOME="$WORK/home6"; mkdir -p "$FAKE_HOME/.cargo/bin"
# Put a working stub cargo at $HOME/.cargo/bin/cargo (the fallback location).
CARGO_HOME_STUB="$(make_stub_cargo success "$WORK/payload-v6")"
cp "$CARGO_HOME_STUB" "$FAKE_HOME/.cargo/bin/cargo"
chmod +x "$FAKE_HOME/.cargo/bin/cargo"

# Run with a PATH that does NOT include the fallback, and CARGO=bare `cargo`.
rc=0
env \
  MOBUX_UPDATE_VERSION="6.0.0" \
  MOBUX_UPDATE_BIN="$BIN6" \
  MOBUX_UPDATE_ROOT="$ROOT6" \
  MOBUX_UPDATE_SERVICE="ignored" \
  MOBUX_UPDATE_PORT="$HC_PORT" \
  MOBUX_UPDATE_SCHEME="http" \
  MOBUX_UPDATE_HEALTH_TIMEOUT="6" \
  MOBUX_UPDATE_CARGO="cargo" \
  MOBUX_UPDATE_CRATE="mobux" \
  MOBUX_UPDATE_LOG="$WORK/update.log" \
  HOME="$FAKE_HOME" \
  PATH="/usr/bin:/bin" \
  bash "$UPDATER" --no-systemd || rc=$?
[ "$rc" -eq 0 ] && ok "cargo-fallback: exit 0 via ~/.cargo/bin" || bad "cargo-fallback: exit $rc (expected 0)"
[ "$(cat "$BIN6")" = "NEW-V6" ] && ok "cargo-fallback: binary replaced" || bad "cargo-fallback: binary not replaced"

# ── Test 7: cargo nowhere → clear error, binary unchanged ──────────────────
ROOT7="$WORK/root7"; mkdir -p "$ROOT7/bin"
BIN7="$ROOT7/bin/mobux"
printf 'OLD-V0' > "$BIN7"
FAKE_HOME7="$WORK/home7"; mkdir -p "$FAKE_HOME7"  # no .cargo at all
rc=0
env \
  MOBUX_UPDATE_VERSION="7.0.0" \
  MOBUX_UPDATE_BIN="$BIN7" \
  MOBUX_UPDATE_ROOT="$ROOT7" \
  MOBUX_UPDATE_SERVICE="ignored" \
  MOBUX_UPDATE_PORT="$HC_PORT" \
  MOBUX_UPDATE_SCHEME="http" \
  MOBUX_UPDATE_HEALTH_TIMEOUT="6" \
  MOBUX_UPDATE_CARGO="definitely-not-cargo-xyz" \
  MOBUX_UPDATE_CRATE="mobux" \
  MOBUX_UPDATE_LOG="$WORK/update.log" \
  HOME="$FAKE_HOME7" \
  PATH="/usr/bin:/bin" \
  bash "$UPDATER" --no-systemd || rc=$?
[ "$rc" -eq 1 ] && ok "cargo-missing: exit 1 (clear error)" || bad "cargo-missing: exit $rc (expected 1)"
[ "$(cat "$BIN7")" = "OLD-V0" ] && ok "cargo-missing: binary unchanged" || bad "cargo-missing: binary changed"

echo "---"
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
