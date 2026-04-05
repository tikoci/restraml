#!/bin/sh
# benchmark-qemu.sh — Start RouterOS CHR in QEMU, run benchmark suite, output results
#
# Usage:
#   ./scripts/benchmark-qemu.sh                              # auto-find machine
#   ./scripts/benchmark-qemu.sh --machine ~/GitHub/mikropkl/Machines/chr.x86_64.qemu.7.23beta5.utm
#   ./scripts/benchmark-qemu.sh --arch x86_64                # prefer x86_64 machine
#   ./scripts/benchmark-qemu.sh --arch aarch64               # prefer aarch64 machine
#   ./scripts/benchmark-qemu.sh --results-dir /tmp/bench     # save results JSON
#   ./scripts/benchmark-qemu.sh --test "Test 1"              # run only matching tests
#   ./scripts/benchmark-qemu.sh --skip-full-tree             # skip slow full-tree tests
#
# Prerequisites:
#   - QEMU installed (brew install qemu)
#   - A mikropkl CHR machine in ~/GitHub/mikropkl/Machines/
#     OR set --machine to a .utm directory with qemu.sh
#
# This script:
#   1. Starts CHR with REST API (port 80) + native API (port 8728) forwarded
#   2. Waits for both APIs to become reachable
#   3. Records controlled variables (license, version, architecture)
#   4. Runs the benchmark test suite
#   5. Saves results to a JSON file
#   6. Stops the CHR
#
# Exit code: 0 = benchmarks completed, nonzero = error

set -eu

# ── Defaults ──
REST_PORT="${REST_PORT:-9180}"
API_PORT="${API_PORT:-9728}"
WAIT_TIMEOUT=120
WAIT_INTERVAL=5
MACHINE_DIR=""
PREFERRED_ARCH=""
RESULTS_DIR=""
TEST_FILTER=""
SKIP_FULL_TREE=0
MIKROPKL_DIR="${MIKROPKL_DIR:-$HOME/GitHub/mikropkl}"

# ── Parse arguments ──
while [ $# -gt 0 ]; do
  case "$1" in
    --machine)       MACHINE_DIR="$2"; shift 2 ;;
    --arch)          PREFERRED_ARCH="$2"; shift 2 ;;
    --results-dir)   RESULTS_DIR="$2"; shift 2 ;;
    --test)          TEST_FILTER="$2"; shift 2 ;;
    --skip-full-tree) SKIP_FULL_TREE=1; shift ;;
    --rest-port)     REST_PORT="$2"; shift 2 ;;
    --api-port)      API_PORT="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,/^$/{ s/^# //; s/^#$//; p }' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# ── Locate machine ──
if [ -z "$MACHINE_DIR" ]; then
  # Auto-find from mikropkl, preferring specified arch or x86_64
  SEARCH_ARCH="${PREFERRED_ARCH:-x86_64}"
  MACHINE_DIR=""

  # Try preferred arch first
  for d in "$MIKROPKL_DIR"/Machines/chr."$SEARCH_ARCH".qemu.*.utm; do
    if [ -d "$d" ] && [ -x "$d/qemu.sh" ]; then
      MACHINE_DIR="$d"
    fi
  done

  # If preferred arch not found, try the other
  if [ -z "$MACHINE_DIR" ]; then
    if [ "$SEARCH_ARCH" = "x86_64" ]; then
      OTHER_ARCH="aarch64"
    else
      OTHER_ARCH="x86_64"
    fi
    for d in "$MIKROPKL_DIR"/Machines/chr."$OTHER_ARCH".qemu.*.utm; do
      if [ -d "$d" ] && [ -x "$d/qemu.sh" ]; then
        MACHINE_DIR="$d"
      fi
    done
  fi
fi

if [ -z "$MACHINE_DIR" ] || [ ! -x "$MACHINE_DIR/qemu.sh" ]; then
  echo "ERROR: No CHR machine found." >&2
  echo "  Searched: $MIKROPKL_DIR/Machines/chr.*.qemu.*.utm/" >&2
  echo "  Set --machine /path/to/machine.utm or ensure mikropkl is at ~/GitHub/mikropkl" >&2
  exit 1
fi

MACHINE_NAME="$(basename "$MACHINE_DIR")"
QEMU_SH="$MACHINE_DIR/qemu.sh"

echo "═══════════════════════════════════════════════════════"
echo "  RouterOS API Benchmark Runner"
echo "═══════════════════════════════════════════════════════"
echo "  Machine:   $MACHINE_NAME"
echo "  REST port: $REST_PORT"
echo "  API port:  $API_PORT"
echo "  Results:   ${RESULTS_DIR:-stdout only}"
echo "═══════════════════════════════════════════════════════"
echo ""

# ── Cleanup on exit ──
cleanup() {
  echo ""
  echo "==> Stopping CHR..."
  "$QEMU_SH" --stop 2>/dev/null || true
}
trap cleanup EXIT

# ── Start CHR with both REST and native API ports forwarded ──
echo "==> Starting CHR..."
QEMU_NETDEV="user,id=net0,hostfwd=tcp::${REST_PORT}-:80,hostfwd=tcp::${API_PORT}-:8728,hostfwd=tcp::9122-:22" \
  "$QEMU_SH" --background --port "$REST_PORT"

# ── Wait for REST API ──
echo "==> Waiting for REST API at http://localhost:${REST_PORT}/rest (timeout: ${WAIT_TIMEOUT}s)..."
URLBASE="http://localhost:${REST_PORT}/rest"
BASICAUTH="admin:"
elapsed=0
while [ "$elapsed" -lt "$WAIT_TIMEOUT" ]; do
  if curl -sf -m 5 -u "$BASICAUTH" "$URLBASE/system/resource" >/dev/null 2>&1; then
    echo "==> REST API ready (${elapsed}s)"
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
  # Simple TCP connectivity check
  if (echo "" | nc -w 2 localhost "$API_PORT") >/dev/null 2>&1; then
    echo "==> Native API port reachable"
    NATIVE_OK=1
    break
  fi
  sleep 2
done
if [ "$NATIVE_OK" = "0" ]; then
  echo "WARNING: Native API port $API_PORT not reachable — native tests will be skipped" >&2
fi

# ── Record environment ──
VERSION=$(curl -sf -m 5 -u "$BASICAUTH" \
  -X POST -H "Content-Type: application/json" \
  -d '{"value-name":"version"}' \
  "$URLBASE/system/resource/get" 2>/dev/null \
  | grep -o '"ret":"[^"]*"' | head -1 | sed 's/"ret":"//;s/"$//' | cut -d' ' -f1 \
  || echo "unknown")

LICENSE=$(curl -sf -m 5 -u "$BASICAUTH" \
  -X POST -H "Content-Type: application/json" \
  -d '{"value-name":"level"}' \
  "$URLBASE/system/license/get" 2>/dev/null \
  | grep -o '"ret":"[^"]*"' | head -1 | sed 's/"ret":"//;s/"$//' \
  || echo "unknown")

ARCH_NAME=$(curl -sf -m 5 -u "$BASICAUTH" \
  -X POST -H "Content-Type: application/json" \
  -d '{"value-name":"architecture-name"}' \
  "$URLBASE/system/resource/get" 2>/dev/null \
  | grep -o '"ret":"[^"]*"' | head -1 | sed 's/"ret":"//;s/"$//' \
  || echo "unknown")

echo ""
echo "  RouterOS version: $VERSION"
echo "  License level:    $LICENSE"
echo "  Architecture:     $ARCH_NAME"
echo "  Host:             $(uname -m) / $(uname -s)"
echo ""

# ── Run benchmarks ──
echo "==> Running benchmark suite..."
echo ""

TEST_EXIT=0
TEST_NAME_FILTER=""
if [ -n "$TEST_FILTER" ]; then
  TEST_NAME_FILTER="--testNamePattern $TEST_FILTER"
fi

# If skipping full tree, only run tests 1-4
if [ "$SKIP_FULL_TREE" = "1" ]; then
  TEST_NAME_FILTER="--testNamePattern 'Test [1234]'"
fi

URLBASE="$URLBASE" \
BASICAUTH="$BASICAUTH" \
API_PORT="$API_PORT" \
  bun test benchmark.test.ts $TEST_NAME_FILTER 2>&1 | tee /tmp/benchmark-output.log || TEST_EXIT=$?

# ── Extract and save results ──
if [ -n "$RESULTS_DIR" ]; then
  mkdir -p "$RESULTS_DIR"
  RESULTS_FILE="$RESULTS_DIR/benchmark-${VERSION}-$(date +%Y%m%d-%H%M%S).json"

  # Extract the JSON summary block from the output
  sed -n '/BENCHMARK SUMMARY/,/═══════════════════════════════════════════════════════/{/═/d;p}' \
    /tmp/benchmark-output.log > "$RESULTS_FILE" 2>/dev/null || true

  if [ -s "$RESULTS_FILE" ]; then
    echo ""
    echo "==> Results saved to: $RESULTS_FILE"
  else
    echo "==> Warning: Could not extract structured results"
    rm -f "$RESULTS_FILE"
  fi
fi

echo ""
if [ "$TEST_EXIT" -eq 0 ]; then
  echo "==> Benchmarks completed successfully"
else
  echo "==> Benchmarks completed with errors (exit code: $TEST_EXIT)"
fi

# cleanup runs via trap
exit "$TEST_EXIT"
