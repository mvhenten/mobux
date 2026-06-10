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
  # ASSET_BASE defaults to a nonexistent file:// dir so the prebuilt-asset
  # download always fails and tests exercise the cargo fallback — hermetic, no
  # network. Download tests override it with a populated file:// dir.
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
    MOBUX_UPDATE_ASSET_BASE="${ASSET_BASE:-file://$WORK/no-assets}" \
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

# ── Test 6: cargo unresolvable → abort with a clear log line ───────────────
# Point CARGO_BIN at a nonexistent command and HOME at a dir without
# .cargo/bin/cargo, so both resolution steps fail. Binary must be untouched.
ROOT6="$WORK/root6"; mkdir -p "$ROOT6/bin"
BIN6="$ROOT6/bin/mobux"
printf 'OLD-V0' > "$BIN6"
OUT6="$(env \
  HOME="$WORK" \
  MOBUX_UPDATE_ASSET_BASE="file://$WORK/no-assets" \
  MOBUX_UPDATE_VERSION="6.0.0" \
  MOBUX_UPDATE_BIN="$BIN6" \
  MOBUX_UPDATE_ROOT="$ROOT6" \
  MOBUX_UPDATE_SERVICE="ignored" \
  MOBUX_UPDATE_PORT="$HC_PORT" \
  MOBUX_UPDATE_SCHEME="http" \
  MOBUX_UPDATE_HEALTH_TIMEOUT="6" \
  MOBUX_UPDATE_CARGO="cargo-definitely-not-installed" \
  MOBUX_UPDATE_CRATE="mobux" \
  MOBUX_UPDATE_LOG="$WORK/update.log" \
  bash "$UPDATER" --no-systemd)"
rc=$?
[ "$rc" -eq 1 ] && ok "no-cargo: exit 1 (abort)" || bad "no-cargo: exit $rc (expected 1)"
case "$OUT6" in
  *"ABORT: cargo not found"*) ok "no-cargo: clear log line" ;;
  *) bad "no-cargo: missing ABORT log line" ;;
esac
[ "$(cat "$BIN6")" = "OLD-V0" ] && ok "no-cargo: binary unchanged" || bad "no-cargo: binary changed"

# ── Test 7: prebuilt release asset → installed without cargo ───────────────
# A valid tar.gz + matching .sha256 served from a file:// "release"; cargo is
# the FAILING stub, proving the prebuilt path never touches it.
ROOT7="$WORK/root7"; mkdir -p "$ROOT7/bin"
BIN7="$ROOT7/bin/mobux"
printf 'OLD-V0' > "$BIN7"
ASSET_NAME="mobux-x86_64-unknown-linux-gnu.tar.gz"
ASSETS7="$WORK/assets/v7.0.0"; mkdir -p "$ASSETS7"
PAYDIR7="$WORK/pay7"; mkdir -p "$PAYDIR7"
printf 'NEW-V7-PREBUILT' > "$PAYDIR7/mobux"
tar -C "$PAYDIR7" -czf "$ASSETS7/$ASSET_NAME" mobux
( cd "$ASSETS7" && sha256sum "$ASSET_NAME" > "$ASSET_NAME.sha256" )
printf '{"app":"mobux","version":"7.0.0"}' > "$WORK/identify.json"
CARGO_FAIL7="$(make_stub_cargo fail "")"

ASSET_BASE="file://$WORK/assets" run_updater "7.0.0" "$BIN7" "$ROOT7" "$CARGO_FAIL7"
rc=$?
[ "$rc" -eq 0 ] && ok "prebuilt: exit 0 (cargo never needed)" || bad "prebuilt: exit $rc"
[ "$(cat "$BIN7")" = "NEW-V7-PREBUILT" ] && ok "prebuilt: binary replaced from asset" || bad "prebuilt: binary not replaced ($(cat "$BIN7"))"
[ "$(cat "$BIN7.prev")" = "OLD-V0" ] && ok "prebuilt: snapshot holds old binary" || bad "prebuilt: snapshot wrong"
ls "$ROOT7"/mobux-update-dl.* >/dev/null 2>&1 && bad "prebuilt: staging dir left behind" || ok "prebuilt: staging dir cleaned up"

# ── Test 8: corrupt asset checksum → falls back to cargo install ───────────
# Same asset layout but the .sha256 doesn't match; the updater must refuse the
# download and complete via the (succeeding) cargo stub instead.
ROOT8="$WORK/root8"; mkdir -p "$ROOT8/bin"
BIN8="$ROOT8/bin/mobux"
printf 'OLD-V0' > "$BIN8"
ASSETS8="$WORK/assets/v8.0.0"; mkdir -p "$ASSETS8"
PAYDIR8="$WORK/pay8"; mkdir -p "$PAYDIR8"
printf 'TAMPERED-V8' > "$PAYDIR8/mobux"
tar -C "$PAYDIR8" -czf "$ASSETS8/$ASSET_NAME" mobux
printf '%s  %s\n' "$(printf 'x%.0s' {1..64})" "$ASSET_NAME" > "$ASSETS8/$ASSET_NAME.sha256"
printf 'NEW-V8-CARGO' > "$WORK/payload-v8"
printf '{"app":"mobux","version":"8.0.0"}' > "$WORK/identify.json"
CARGO_OK8="$(make_stub_cargo success "$WORK/payload-v8")"

OUT8="$(ASSET_BASE="file://$WORK/assets" run_updater "8.0.0" "$BIN8" "$ROOT8" "$CARGO_OK8")"
rc=$?
[ "$rc" -eq 0 ] && ok "bad-sha: exit 0 via cargo fallback" || bad "bad-sha: exit $rc"
case "$OUT8" in
  *"sha256 verification FAILED"*) ok "bad-sha: refused the corrupt asset" ;;
  *) bad "bad-sha: missing verification-failure log line" ;;
esac
[ "$(cat "$BIN8")" = "NEW-V8-CARGO" ] && ok "bad-sha: installed via cargo, not the asset" || bad "bad-sha: wrong binary content ($(cat "$BIN8"))"

# ── Test 9: asset missing → logs the fallback and cargo installs ────────────
ROOT9="$WORK/root9"; mkdir -p "$ROOT9/bin"
BIN9="$ROOT9/bin/mobux"
printf 'OLD-V0' > "$BIN9"
printf 'NEW-V9' > "$WORK/payload-v9"
printf '{"app":"mobux","version":"9.0.0"}' > "$WORK/identify.json"
CARGO_OK9="$(make_stub_cargo success "$WORK/payload-v9")"

OUT9="$(run_updater "9.0.0" "$BIN9" "$ROOT9" "$CARGO_OK9")"
rc=$?
[ "$rc" -eq 0 ] && ok "no-asset: exit 0 via cargo fallback" || bad "no-asset: exit $rc"
case "$OUT9" in
  *"falling back to cargo install"*) ok "no-asset: logged the fallback" ;;
  *) bad "no-asset: missing fallback log line" ;;
esac
[ "$(cat "$BIN9")" = "NEW-V9" ] && ok "no-asset: installed via cargo" || bad "no-asset: wrong binary content"

echo "---"
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
