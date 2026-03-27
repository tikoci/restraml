#!/bin/sh
# test-with-qemu.sh — Start a mikropkl CHR VM, run integration tests, stop VM
#
# Usage:
#   ./scripts/test-with-qemu.sh                          # auto-find CHR machine
#   ./scripts/test-with-qemu.sh ~/Lab/mikropkl/Machines/chr.x86_64.qemu.7.23beta2.utm
#   PORT=9280 ./scripts/test-with-qemu.sh                # custom port
#
# Prerequisites:
#   - QEMU installed (brew install qemu)
#   - A mikropkl CHR machine at ~/Lab/mikropkl/Machines/chr.x86_64.qemu.*.utm/
#
# The script will:
#   1. Start the CHR VM in background (qemu.sh --background)
#   2. Wait for the REST API to become reachable (up to 2 minutes)
#   3. Run deep-inspect integration tests
#   4. Stop the VM (qemu.sh --stop)
#
# Exit code is the test exit code (0 = pass, nonzero = fail).

set -eu

PORT="${PORT:-9180}"
URLBASE="http://localhost:${PORT}/rest"
BASICAUTH="admin:"
WAIT_TIMEOUT=120  # seconds
WAIT_INTERVAL=5   # seconds

# ── Locate machine directory ──

if [ $# -ge 1 ]; then
  MACHINE_DIR="$1"
else
  # Auto-find: pick the newest mikropkl CHR machine
  MACHINE_DIR=""
  for d in "$HOME"/Lab/mikropkl/Machines/chr.x86_64.qemu.*.utm; do
    if [ -d "$d" ] && [ -x "$d/qemu.sh" ]; then
      MACHINE_DIR="$d"
    fi
  done
fi

if [ -z "$MACHINE_DIR" ] || [ ! -x "$MACHINE_DIR/qemu.sh" ]; then
  echo "ERROR: No mikropkl CHR machine found." >&2
  echo "  Expected: ~/Lab/mikropkl/Machines/chr.x86_64.qemu.*.utm/qemu.sh" >&2
  echo "  Or pass a machine directory as argument: $0 /path/to/machine.utm" >&2
  exit 1
fi

MACHINE_NAME="$(basename "$MACHINE_DIR")"
QEMU_SH="$MACHINE_DIR/qemu.sh"

echo "==> Using machine: $MACHINE_NAME"
echo "    Port: $PORT"

# ── Cleanup on exit ──

cleanup() {
  echo ""
  echo "==> Stopping CHR..."
  "$QEMU_SH" --stop 2>/dev/null || true
}
trap cleanup EXIT

# ── Start CHR ──

echo "==> Starting CHR in background..."
"$QEMU_SH" --background --port "$PORT"

# ── Wait for REST API ──

echo "==> Waiting for REST API at $URLBASE (timeout: ${WAIT_TIMEOUT}s)..."
elapsed=0
while [ "$elapsed" -lt "$WAIT_TIMEOUT" ]; do
  # Try a simple REST call — RouterOS returns JSON on success
  if curl -sf -m 5 -u "$BASICAUTH" "$URLBASE/system/resource" >/dev/null 2>&1; then
    echo "==> REST API is ready (after ${elapsed}s)"
    break
  fi
  sleep "$WAIT_INTERVAL"
  elapsed=$((elapsed + WAIT_INTERVAL))
done

if [ "$elapsed" -ge "$WAIT_TIMEOUT" ]; then
  echo "ERROR: REST API did not become reachable within ${WAIT_TIMEOUT}s" >&2
  echo "  Check QEMU log: /tmp/qemu-${MACHINE_NAME/.utm/}.log" >&2
  exit 1
fi

# ── Fetch version for display ──

VERSION=$(curl -sf -m 5 -u "$BASICAUTH" \
  -X POST -H "Content-Type: application/json" \
  -d '{"value-name":"version"}' \
  "$URLBASE/system/resource/get" 2>/dev/null \
  | grep -o '"ret":"[^"]*"' | head -1 | sed 's/"ret":"//;s/"$//' | cut -d' ' -f1 \
  || echo "unknown")
echo "==> RouterOS version: $VERSION"

# ── Run tests ──

echo "==> Running integration tests..."
echo ""
TEST_EXIT=0
URLBASE="$URLBASE" BASICAUTH="$BASICAUTH" bun test deep-inspect.integration.test.ts || TEST_EXIT=$?

echo ""
if [ "$TEST_EXIT" -eq 0 ]; then
  echo "==> All integration tests passed"
else
  echo "==> Integration tests failed (exit code: $TEST_EXIT)"
fi

# cleanup runs via trap
exit "$TEST_EXIT"
