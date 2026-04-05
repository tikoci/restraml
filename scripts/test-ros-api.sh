#!/bin/sh
# test-ros-api.sh — Start a mikropkl CHR VM, run ros-api-protocol tests, stop VM
#
# Usage:
#   ./scripts/test-ros-api.sh                          # auto-find CHR machine
#   ./scripts/test-ros-api.sh ~/Lab/mikropkl/Machines/chr.x86_64.qemu.7.22.utm
#   PORT=9280 API_PORT=9828 ./scripts/test-ros-api.sh  # custom ports
#
# Prerequisites:
#   - QEMU installed (brew install qemu)
#   - A mikropkl CHR machine at:
#       ~/Lab/mikropkl/Machines/chr.x86_64.qemu.*.utm/  (primary search)
#       ~/GitHub/mikropkl/Machines/chr.x86_64.qemu.*.utm/ (fallback)
#     Or set MIKROPKL_DIR to a custom location.
#
# The script will:
#   1. Start the CHR VM in background with BOTH REST (port 80) and native API
#      (port 8728) forwarded to localhost
#   2. Wait for both APIs to become reachable
#   3. Run ros-api-protocol unit + integration + stress tests
#   4. Stop the VM
#
# Exit code is the test exit code (0 = pass, nonzero = fail).

set -eu

PORT="${PORT:-9180}"
API_PORT="${API_PORT:-8728}"
URLBASE="http://localhost:${PORT}/rest"
BASICAUTH="admin:"
WAIT_TIMEOUT=120  # seconds
WAIT_INTERVAL=5   # seconds

# ── Locate machine directory ──

if [ $# -ge 1 ]; then
  MACHINE_DIR="$1"
else
  MACHINE_DIR=""
  # Try Lab first (same as test-with-qemu.sh), then GitHub, then MIKROPKL_DIR if set
  for candidate in \
      "${MIKROPKL_DIR:-}" \
      "$HOME/Lab/mikropkl" \
      "$HOME/GitHub/mikropkl"; do
    [ -z "$candidate" ] && continue
    for d in "$candidate"/Machines/chr.x86_64.qemu.*.utm; do
      if [ -d "$d" ] && [ -x "$d/qemu.sh" ]; then
        MACHINE_DIR="$d"
      fi
    done
    [ -n "$MACHINE_DIR" ] && break
  done
fi

if [ -z "$MACHINE_DIR" ] || [ ! -x "$MACHINE_DIR/qemu.sh" ]; then
  echo "ERROR: No mikropkl CHR machine found." >&2
  echo "  Searched: ~/Lab/mikropkl/Machines/ and ~/GitHub/mikropkl/Machines/" >&2
  echo "  Or pass a machine directory: $0 /path/to/machine.utm" >&2
  echo "  Or set MIKROPKL_DIR to a custom location." >&2
  exit 1
fi

MACHINE_NAME="$(basename "$MACHINE_DIR")"
QEMU_SH="$MACHINE_DIR/qemu.sh"

echo "==> Using machine: $MACHINE_NAME"
echo "    REST port: $PORT  |  Native API port: $API_PORT"

# ── Cleanup on exit ──

cleanup() {
  echo ""
  echo "==> Stopping CHR..."
  "$QEMU_SH" --stop 2>/dev/null || true
}
trap cleanup EXIT

# ── Start CHR with both REST and native API ports forwarded ──

echo "==> Starting CHR in background..."
QEMU_NETDEV="user,id=net0,hostfwd=tcp::${PORT}-:80,hostfwd=tcp::${API_PORT}-:8728,hostfwd=tcp::9122-:22" \
  "$QEMU_SH" --background --port "$PORT"

# ── Wait for REST API ──

echo "==> Waiting for REST API at $URLBASE (timeout: ${WAIT_TIMEOUT}s)..."
elapsed=0
while [ "$elapsed" -lt "$WAIT_TIMEOUT" ]; do
  if curl -sf -m 5 -u "$BASICAUTH" "$URLBASE/system/resource" >/dev/null 2>&1; then
    echo "==> REST API is ready (after ${elapsed}s)"
    break
  fi
  sleep "$WAIT_INTERVAL"
  elapsed=$((elapsed + WAIT_INTERVAL))
done

if [ "$elapsed" -ge "$WAIT_TIMEOUT" ]; then
  echo "ERROR: REST API did not become reachable within ${WAIT_TIMEOUT}s" >&2
  exit 1
fi

# ── Verify native API port is reachable ──

echo "==> Checking native API on port ${API_PORT}..."
NATIVE_OK=0
for i in $(seq 1 6); do
  if (echo "" | nc -w 2 localhost "$API_PORT") >/dev/null 2>&1; then
    echo "==> Native API port ${API_PORT} reachable"
    NATIVE_OK=1
    break
  fi
  sleep 2
done

if [ "$NATIVE_OK" = "0" ]; then
  echo "ERROR: Native API port $API_PORT not reachable after 12s" >&2
  echo "  Check that the QEMU machine exposes port 8728." >&2
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

echo "==> Running ros-api-protocol tests..."
echo ""
TEST_EXIT=0
URLBASE="$URLBASE" BASICAUTH="$BASICAUTH" API_PORT="$API_PORT" \
  bun test ros-api-protocol.test.ts || TEST_EXIT=$?

echo ""
if [ "$TEST_EXIT" -eq 0 ]; then
  echo "==> All tests passed"
else
  echo "==> Tests failed (exit code: $TEST_EXIT)"
fi

# cleanup runs via trap
exit "$TEST_EXIT"
