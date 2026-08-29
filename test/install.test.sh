#!/usr/bin/env bash
# Tests for the curl|bash installer (install.sh).
#
# Every case points MOBUX_INSTALL_BASE_URL at a local file:// directory holding
# a fake release asset, and MOBUX_INSTALL_DIR at a throwaway dir, so nothing
# touches the network or a real install.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="$REPO_DIR/install.sh"

PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); printf 'ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL - %s\n' "$1"; }

# check <description> <command...> — the command's exit status is the verdict.
check() {
  local desc="$1"
  shift
  if "$@"; then ok "$desc"; else bad "$desc"; fi
}

# contains <description> <haystack> <needle>
contains() {
  case "$2" in
    *"$3"*) ok "$1" ;;
    *) bad "$1" ;;
  esac
}

TEST_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}"
mkdir -p "$TEST_CACHE"
WORK="$(mktemp -d "${TEST_CACHE}/mobux-install-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

ASSET="mobux-x86_64-unknown-linux-gnu.tar.gz"

# Build a release-shaped asset dir: the tarball holds a single `mobux` at the
# root, next to a `sha256sum`-format checksum file — exactly what
# scripts/build-release-asset.sh uploads.
make_assets() {
  local dir="$1" body="$2" checksum="$3"  # checksum: good|bad
  local pay="$dir/payload"
  mkdir -p "$dir" "$pay"
  printf '%s' "$body" > "$pay/mobux"
  tar -C "$pay" -czf "$dir/$ASSET" mobux
  if [ "$checksum" = "good" ]; then
    (cd "$dir" && sha256sum "$ASSET" > "$ASSET.sha256")
  else
    printf '%s  %s\n' "$(printf '0%.0s' {1..64})" "$ASSET" > "$dir/$ASSET.sha256"
  fi
  rm -rf "$pay"
}

run_installer() {
  local assets="$1" dest="$2"
  shift 2
  env "$@" \
    MOBUX_INSTALL_BASE_URL="file://$assets" \
    MOBUX_INSTALL_DIR="$dest" \
    bash "$INSTALLER" 2>&1
}

installed_body() {
  cat "$1/mobux" 2>/dev/null
}

# ── Test 1: happy path installs the binary and reports the checksum ─────────
A1="$WORK/assets-ok"; D1="$WORK/dest1"
make_assets "$A1" "MOBUX-BINARY-V1" good
OUT1="$(run_installer "$A1" "$D1")"
rc=$?
check "happy: exit 0" test "$rc" -eq 0
check "happy: binary installed" test "$(installed_body "$D1")" = "MOBUX-BINARY-V1"
check "happy: binary is executable" test -x "$D1/mobux"
contains "happy: verified the checksum" "$OUT1" "sha256 verified"
contains "happy: printed the quick start" "$OUT1" "export MOBUX_AUTH_USER"

# ── Test 2: a tampered asset is refused and nothing is installed ────────────
A2="$WORK/assets-bad"; D2="$WORK/dest2"
make_assets "$A2" "TAMPERED" bad
OUT2="$(run_installer "$A2" "$D2")"
rc=$?
check "bad-sha: non-zero exit" test "$rc" -ne 0
contains "bad-sha: reported the failure" "$OUT2" "sha256 verification failed"
check "bad-sha: installed nothing" test ! -e "$D2/mobux"

# ── Test 3: a missing asset fails loudly ───────────────────────────────────
D3="$WORK/dest3"
OUT3="$(run_installer "$WORK/assets-absent" "$D3")"
rc=$?
check "no-asset: non-zero exit" test "$rc" -ne 0
contains "no-asset: reported the download failure" "$OUT3" "could not download"

# ── Test 4: unsupported OS/arch points at cargo install ────────────────────
STUB="$WORK/stub-bin"; mkdir -p "$STUB"
cat > "$STUB/uname" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  -s) echo "${FAKE_OS:-Linux}" ;;
  -m) echo "${FAKE_ARCH:-x86_64}" ;;
  *)  echo "${FAKE_OS:-Linux}" ;;
esac
EOF
chmod +x "$STUB/uname"

D4="$WORK/dest4"
OUT4="$(run_installer "$A1" "$D4" "PATH=$STUB:$PATH" FAKE_ARCH=aarch64)"
rc=$?
check "arm64: non-zero exit" test "$rc" -ne 0
contains "arm64: pointed at cargo install" "$OUT4" "cargo install mobux"
check "arm64: installed nothing" test ! -e "$D4/mobux"

D5="$WORK/dest5"
OUT5="$(run_installer "$A1" "$D5" "PATH=$STUB:$PATH" FAKE_OS=Darwin)"
rc=$?
check "macos: non-zero exit" test "$rc" -ne 0
contains "macos: named the unsupported platform" "$OUT5" "Darwin"

# ── Test 5: safe under curl | bash — no stdin reads, no script path ─────────
D6="$WORK/dest6"
OUT6="$(MOBUX_INSTALL_BASE_URL="file://$A1" MOBUX_INSTALL_DIR="$D6" bash < "$INSTALLER" 2>&1)"
rc=$?
check "piped: exit 0 when read from stdin" test "$rc" -eq 0
contains "piped: printed the quick start" "$OUT6" "export MOBUX_AUTH_USER"
check "piped: binary installed" test "$(installed_body "$D6")" = "MOBUX-BINARY-V1"

# ── Test 6: an existing install is replaced, not corrupted ─────────────────
D7="$WORK/dest7"; mkdir -p "$D7"
printf 'MOBUX-BINARY-V0' > "$D7/mobux"; chmod 755 "$D7/mobux"
run_installer "$A1" "$D7" >/dev/null
check "upgrade: replaced the old binary" test "$(installed_body "$D7")" = "MOBUX-BINARY-V1"
check "upgrade: left no staging file" test -z "$(find "$D7" -name '.mobux.new*' 2>/dev/null)"

# ── Test 7: the workdir is cleaned up and never lands in /tmp ──────────────
count_staging() { find "$TEST_CACHE" -maxdepth 1 -name 'mobux-install.*' 2>/dev/null | wc -l; }
before="$(count_staging)"
D8="$WORK/dest8"
run_installer "$A1" "$D8" >/dev/null
check "cleanup: no staging dir left in the cache" test "$before" = "$(count_staging)"
absent_in_file() { ! grep -q -e "$1" "$2"; }
check "cleanup: installer never writes to /tmp" absent_in_file '/tmp' "$INSTALLER"

echo "---"
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
