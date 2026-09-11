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
ASSET_ARM64="mobux-aarch64-unknown-linux-gnu.tar.gz"

# The payload stands in for the real binary, so it has to run: the installer
# execs it once installed. A tiny shell script echoing <body> keeps every case
# able to identify which asset it got. The body UNRUNNABLE builds a payload
# that cannot execute at all, standing in for a wrong-arch release binary.
payload_script() {
  if [ "$1" = "UNRUNNABLE" ]; then
    printf '%s\n' "#!/mobux-test/no-such-interpreter"
    return 0
  fi
  printf '%s\n' "#!/bin/sh" "printf '%s' $1"
}

# Build a release-shaped asset dir: the tarball holds a single `mobux` at the
# root, next to a `sha256sum`-format checksum file — exactly what
# scripts/build-release-asset.sh uploads. A release carries one asset per
# architecture, so make_assets writes both unless a case names just one — which
# is how the arch cases prove the installer picks by name.
make_assets() {
  local dir="$1" body="$2" checksum="$3"
  shift 3
  local assets=("$@")
  [ "${#assets[@]}" -gt 0 ] || assets=("$ASSET" "$ASSET_ARM64")
  local pay="$dir/payload" asset
  mkdir -p "$dir" "$pay"
  payload_script "$body" > "$pay/mobux"
  chmod 755 "$pay/mobux"
  for asset in "${assets[@]}"; do
    tar -C "$pay" -czf "$dir/$asset" mobux
    if [ "$checksum" = "good" ]; then
      (cd "$dir" && sha256sum "$asset" > "$asset.sha256")
    else
      printf '%s  %s\n' "$(printf '0%.0s' {1..64})" "$asset" > "$dir/$asset.sha256"
    fi
  done
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

# What the installed binary reports for itself. The installer only leaves a
# binary in place once it has run it, so asking it doubles as the exec check.
installed_body() {
  "$1/mobux" --version 2>/dev/null
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
# The run line must name the port the follow-up URL points at: a bare `mobux`
# listens on 8080, so the quick start only holds together with --port.
contains "happy: quick start runs on the port it links" "$OUT1" "mobux --port 5151"
contains "happy: quick start links that port" "$OUT1" ":5151"
# Boot persistence is the next thing anyone wants; the quick start names the
# subcommand that does it (README's quick start carries the same line).
contains "happy: quick start points at the boot service" "$OUT1" "mobux service install --port 5151"
# TLS is off by default, so the URL is http:// and the opt-in is named.
contains "happy: quick start links a plain-HTTP URL" "$OUT1" "http://"
contains "happy: quick start names the TLS opt-in" "$OUT1" "--tls"

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

# ── Test 4: the running arch decides the asset ─────────────────────────────
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

# Each arch installs from its own asset. Every dir below holds only the one
# tarball, so reaching for the other name cannot pass.
A4X="$WORK/assets-x86_64"; D4X="$WORK/dest4x"
make_assets "$A4X" "MOBUX-BINARY-X86_64" good "$ASSET"
OUT4X="$(run_installer "$A4X" "$D4X" "PATH=$STUB:$PATH" FAKE_ARCH=x86_64)"
rc=$?
check "x86_64: exit 0" test "$rc" -eq 0
check "x86_64: binary installed" test "$(installed_body "$D4X")" = "MOBUX-BINARY-X86_64"
contains "x86_64: downloaded the x86_64 asset" "$OUT4X" "$ASSET"

A4="$WORK/assets-arm64"; D4="$WORK/dest4"
make_assets "$A4" "MOBUX-BINARY-ARM64" good "$ASSET_ARM64"
OUT4="$(run_installer "$A4" "$D4" "PATH=$STUB:$PATH" FAKE_ARCH=aarch64)"
rc=$?
check "arm64: exit 0" test "$rc" -eq 0
check "arm64: binary installed" test "$(installed_body "$D4")" = "MOBUX-BINARY-ARM64"
contains "arm64: downloaded the aarch64 asset" "$OUT4" "$ASSET_ARM64"

# Some hosts spell it arm64; it is the same target triple.
D4B="$WORK/dest4b"
run_installer "$A4" "$D4B" "PATH=$STUB:$PATH" FAKE_ARCH=arm64 >/dev/null
check "arm64 alias: binary installed" test "$(installed_body "$D4B")" = "MOBUX-BINARY-ARM64"

# An architecture with no release asset is refused, not half-installed.
D4C="$WORK/dest4c"
OUT4C="$(run_installer "$A1" "$D4C" "PATH=$STUB:$PATH" FAKE_ARCH=armv7l)"
rc=$?
check "armv7l: non-zero exit" test "$rc" -ne 0
contains "armv7l: pointed at cargo install" "$OUT4C" "cargo install mobux"
check "armv7l: installed nothing" test ! -e "$D4C/mobux"

# A binary that verifies and installs but cannot execute here — wrong arch, or
# a glibc older than the release was built against — is reported, not left
# behind silently for the user to discover on first run.
A4D="$WORK/assets-unrunnable"; D4D="$WORK/dest4d"
make_assets "$A4D" "UNRUNNABLE" good
OUT4D="$(run_installer "$A4D" "$D4D")"
rc=$?
check "unrunnable: non-zero exit" test "$rc" -ne 0
contains "unrunnable: said the binary does not run" "$OUT4D" "does not run on this host"
contains "unrunnable: pointed at cargo install" "$OUT4D" "cargo install mobux"

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
