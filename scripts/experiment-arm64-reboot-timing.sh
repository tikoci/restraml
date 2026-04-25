#!/usr/bin/env bash

# Local timing experiment for arm64 CHR package-install reboot behavior.
# Mirrors .github/workflows/deep-inspect-multi-arch.yaml arm64 steps.

set -euo pipefail

VERSION="7.23beta5"
REST_PORT="9180"
SSH_PORT="9122"
FETCH_PORT="8888"
BOOT_ATTEMPTS="48"
REBOOT_ATTEMPTS="120"
WORKDIR=""
KEEP_WORKDIR=0

usage() {
  cat <<'EOF'
Usage: scripts/experiment-arm64-reboot-timing.sh [options]

Options:
  --version <ver>          RouterOS version (default: 7.23beta5)
  --rest-port <port>       Host port forwarded to guest :80 (default: 9180)
  --ssh-port <port>        Host port forwarded to guest :22 (default: 9122)
  --fetch-port <port>      Host HTTP port for /tool/fetch (default: 8888)
  --boot-attempts <n>      Initial boot readiness attempts (default: 48)
  --reboot-attempts <n>    Reboot readiness attempts (default: 120)
  --workdir <dir>          Working directory (default: mktemp)
  --keep-workdir           Keep workdir on exit
  --help                   Show this help

This script measures:
  1) Cold boot to REST-ready
  2) Reboot without package changes
  3) Extra package upload time (/tool/fetch)
  4) Reboot with package activation
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      VERSION="$2"
      shift 2
      ;;
    --rest-port)
      REST_PORT="$2"
      shift 2
      ;;
    --ssh-port)
      SSH_PORT="$2"
      shift 2
      ;;
    --fetch-port)
      FETCH_PORT="$2"
      shift 2
      ;;
    --boot-attempts)
      BOOT_ATTEMPTS="$2"
      shift 2
      ;;
    --reboot-attempts)
      REBOOT_ATTEMPTS="$2"
      shift 2
      ;;
    --workdir)
      WORKDIR="$2"
      shift 2
      ;;
    --keep-workdir)
      KEEP_WORKDIR=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

for required in curl unzip python3 jq qemu-system-aarch64; do
  if ! command -v "$required" >/dev/null 2>&1; then
    echo "Missing required command: $required" >&2
    exit 1
  fi
done

SCRIPT_START_TS="$(date +%s)"

if [[ -z "$WORKDIR" ]]; then
  WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/routeros-arm64-exp.XXXXXX")"
fi

QEMU_PID=""
HTTP_PID=""

cleanup() {
  set +e
  if [[ -n "$HTTP_PID" ]]; then
    kill "$HTTP_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$QEMU_PID" ]]; then
    kill "$QEMU_PID" >/dev/null 2>&1 || true
  fi
  if [[ "$KEEP_WORKDIR" -eq 0 ]]; then
    rm -rf "$WORKDIR"
  else
    echo "Keeping workdir: $WORKDIR"
  fi
}
trap cleanup EXIT

echo "[info] workdir: $WORKDIR"
mkdir -p "$WORKDIR/extra"
cd "$WORKDIR"

resolve_firmware_paths() {
  local code_candidates=(
    "/usr/local/share/qemu/edk2-aarch64-code.fd"
    "/opt/homebrew/share/qemu/edk2-aarch64-code.fd"
    "/usr/share/AAVMF/AAVMF_CODE.fd"
  )
  local vars_candidates=(
    "/usr/local/share/qemu/edk2-arm-vars.fd"
    "/opt/homebrew/share/qemu/edk2-arm-vars.fd"
    "/usr/share/AAVMF/AAVMF_VARS.fd"
  )

  AAVMF_CODE=""
  AAVMF_VARS=""

  for p in "${code_candidates[@]}"; do
    if [[ -f "$p" ]]; then
      AAVMF_CODE="$p"
      break
    fi
  done
  for p in "${vars_candidates[@]}"; do
    if [[ -f "$p" ]]; then
      AAVMF_VARS="$p"
      break
    fi
  done

  if [[ -z "$AAVMF_CODE" || -z "$AAVMF_VARS" ]]; then
    echo "Failed to locate ARM64 UEFI firmware files." >&2
    echo "Looked for code in: ${code_candidates[*]}" >&2
    echo "Looked for vars in: ${vars_candidates[*]}" >&2
    exit 1
  fi
}

download_with_fallback() {
  local primary="$1"
  local fallback="$2"
  local output="$3"
  if ! curl -fsSL "$primary" -o "$output"; then
    curl -fsSL "$fallback" -o "$output"
  fi
}

wait_for_rest_ready() {
  local attempts="$1"
  local consecutive=0
  local i
  for i in $(seq 1 "$attempts"); do
    if curl -sS -m 3 --fail "http://admin:@localhost:${REST_PORT}/rest/system/resource" 2>/dev/null \
      | python3 -c 'import json, sys; body = json.load(sys.stdin); sys.exit(0 if isinstance(body, dict) and "board-name" in body else 1)' \
      >/dev/null 2>&1; then
      consecutive=$((consecutive + 1))
      if [[ "$consecutive" -ge 2 ]]; then
        echo "[ok] REST ready after ${i} attempt(s)"
        return 0
      fi
    else
      consecutive=0
    fi

    if [[ $((i % 6)) -eq 0 ]]; then
      echo "[wait] REST not fully ready yet (${i}/${attempts})"
    fi
    sleep 5
  done
  return 1
}

wait_for_rest_down() {
  local attempts="$1"
  local i
  for i in $(seq 1 "$attempts"); do
    if ! curl -sS -m 3 --fail "http://localhost:${REST_PORT}/" >/dev/null 2>&1; then
      echo "[ok] REST went down after ${i} attempt(s)"
      return 0
    fi
    sleep 2
  done
  echo "[warn] REST did not visibly go down in ${attempts} attempts"
  return 1
}

timed_reboot() {
  local label="$1"
  local attempts="$2"

  local start_ts end_ts
  start_ts="$(date +%s)"

  curl -sS -m 10 -X POST "http://admin:@localhost:${REST_PORT}/rest/system/reboot" \
    -H 'Content-Type: application/json' >/dev/null 2>&1 || true

  wait_for_rest_down 20 || true

  if ! wait_for_rest_ready "$attempts"; then
    echo "[error] ${label}: REST did not become ready" >&2
    return 1
  fi

  end_ts="$(date +%s)"
  local elapsed=$((end_ts - start_ts))
  echo "[time] ${label}: ${elapsed}s"
  REBOOT_ELAPSED="$elapsed"
  return 0
}

echo "[step] Resolve firmware paths"
resolve_firmware_paths
echo "[info] code firmware: $AAVMF_CODE"
echo "[info] vars template: $AAVMF_VARS"

echo "[step] Download CHR arm64 image for ${VERSION}"
download_with_fallback \
  "https://download.mikrotik.com/routeros/${VERSION}/chr-${VERSION}-arm64.img.zip" \
  "https://cdn.mikrotik.com/routeros/${VERSION}/chr-${VERSION}-arm64.img.zip" \
  "chr-arm64.img.zip"
unzip -q chr-arm64.img.zip
mv chr-*-arm64.img chr-arm64.img
rm -f chr-arm64.img.zip

echo "[step] Download arm64 extra packages for ${VERSION}"
download_with_fallback \
  "https://download.mikrotik.com/routeros/${VERSION}/all_packages-arm64-${VERSION}.zip" \
  "https://cdn.mikrotik.com/routeros/${VERSION}/all_packages-arm64-${VERSION}.zip" \
  "all_packages-arm64.zip"
unzip -q all_packages-arm64.zip -d extra
rm -f all_packages-arm64.zip

TOTAL_PACKAGES="$(find extra -maxdepth 1 -type f -name '*.npk' | wc -l | tr -d ' ')"
echo "[info] extra package files: ${TOTAL_PACKAGES}"

echo "[step] Prepare writable UEFI vars and start QEMU (tcg)"
cp "$AAVMF_VARS" aavmf-vars.fd
CODE_SIZE="$(stat -f %z "$AAVMF_CODE" 2>/dev/null || stat -c%s "$AAVMF_CODE")"
truncate -s "$CODE_SIZE" aavmf-vars.fd

qemu-system-aarch64 \
  -M virt -accel tcg -cpu cortex-a72 -m 256 -nographic \
  -drive if=pflash,format=raw,readonly=on,unit=0,file="$AAVMF_CODE" \
  -drive if=pflash,format=raw,unit=1,file="$WORKDIR/aavmf-vars.fd" \
  -drive file="$WORKDIR/chr-arm64.img",format=raw,if=none,id=drive0 \
  -device virtio-blk-pci,drive=drive0 \
  -netdev "user,id=net0,hostfwd=tcp::${REST_PORT}-:80,hostfwd=tcp::${SSH_PORT}-:22" \
  -device virtio-net-pci,netdev=net0 \
  >"$WORKDIR/qemu.log" 2>&1 &
QEMU_PID="$!"
echo "[info] qemu pid: $QEMU_PID"

echo "[step] Wait for cold boot REST readiness"
COLD_BOOT_START_TS="$(date +%s)"
if ! wait_for_rest_ready "$BOOT_ATTEMPTS"; then
  echo "[error] cold boot readiness timeout" >&2
  tail -80 "$WORKDIR/qemu.log" || true
  exit 1
fi
COLD_BOOT_END_TS="$(date +%s)"
COLD_BOOT_SECONDS=$((COLD_BOOT_END_TS - COLD_BOOT_START_TS))
echo "[time] cold boot: ${COLD_BOOT_SECONDS}s"

echo "[step] Baseline reboot with no package changes"
timed_reboot "baseline reboot" "$REBOOT_ATTEMPTS"
BASELINE_REBOOT_SECONDS="$REBOOT_ELAPSED"

echo "[step] Upload extra packages via /tool/fetch"
UPLOAD_START_TS="$(date +%s)"
python3 -m http.server "$FETCH_PORT" --bind 0.0.0.0 --directory "$WORKDIR/extra" >"$WORKDIR/http.log" 2>&1 &
HTTP_PID="$!"
sleep 1

COUNT=0
for npk in extra/*.npk; do
  COUNT=$((COUNT + 1))
  NAME="$(basename "$npk")"
  echo "  [fetch ${COUNT}/${TOTAL_PACKAGES}] ${NAME}"
  RESULT="$(curl -sS -m 120 -X POST "http://admin:@localhost:${REST_PORT}/rest/tool/fetch" \
    -H 'Content-Type: application/json' \
    -d "{\"url\":\"http://10.0.2.2:${FETCH_PORT}/${NAME}\",\"dst-path\":\"${NAME}\"}" 2>&1 || true)"
  if echo "$RESULT" | grep -qiE 'error|failure'; then
    echo "[warn] fetch response for ${NAME}: $RESULT"
  fi
  sleep 1
done

kill "$HTTP_PID" >/dev/null 2>&1 || true
HTTP_PID=""

echo "[step] Wait for fetch completion settle"
sleep 15

FILES_ON_ROUTER="$(curl -sS --fail "http://admin:@localhost:${REST_PORT}/rest/file" \
  | jq '[.[] | select(.name | endswith(".npk"))] | length')"

UPLOAD_END_TS="$(date +%s)"
UPLOAD_SECONDS=$((UPLOAD_END_TS - UPLOAD_START_TS))
echo "[time] package upload+settle: ${UPLOAD_SECONDS}s"
echo "[info] router .npk file count: ${FILES_ON_ROUTER}"

echo "[step] Reboot to activate extra packages"
timed_reboot "package activation reboot" "$REBOOT_ATTEMPTS"
PACKAGE_REBOOT_SECONDS="$REBOOT_ELAPSED"

echo "[step] List installed packages"
INSTALLED_PACKAGES_JSON="$(curl -sS --fail "http://admin:@localhost:${REST_PORT}/rest/system/package")"
INSTALLED_PACKAGE_COUNT="$(echo "$INSTALLED_PACKAGES_JSON" | jq 'length')"

SCRIPT_END_TS="$(date +%s)"
TOTAL_SECONDS=$((SCRIPT_END_TS - SCRIPT_START_TS))

RESULT_JSON_PATH="$WORKDIR/result.json"
jq -n \
  --arg version "$VERSION" \
  --arg host_arch "$(uname -m)" \
  --arg host_os "$(uname -s)" \
  --arg rest_port "$REST_PORT" \
  --arg ssh_port "$SSH_PORT" \
  --argjson extra_packages_downloaded "$TOTAL_PACKAGES" \
  --argjson router_npk_files "$FILES_ON_ROUTER" \
  --argjson installed_packages "$INSTALLED_PACKAGE_COUNT" \
  --argjson cold_boot_seconds "$COLD_BOOT_SECONDS" \
  --argjson baseline_reboot_seconds "$BASELINE_REBOOT_SECONDS" \
  --argjson package_upload_seconds "$UPLOAD_SECONDS" \
  --argjson package_reboot_seconds "$PACKAGE_REBOOT_SECONDS" \
  --argjson total_seconds "$TOTAL_SECONDS" \
  '{
    version: $version,
    host: { os: $host_os, arch: $host_arch },
    qemu_guest: { arch: "arm64", accel: "tcg" },
    ports: { rest: $rest_port, ssh: $ssh_port },
    counts: {
      extra_packages_downloaded: $extra_packages_downloaded,
      router_npk_files: $router_npk_files,
      installed_packages_after_reboot: $installed_packages
    },
    timings_seconds: {
      cold_boot: $cold_boot_seconds,
      baseline_reboot_without_changes: $baseline_reboot_seconds,
      package_upload_and_settle: $package_upload_seconds,
      package_activation_reboot: $package_reboot_seconds,
      total_script_runtime: $total_seconds
    }
  }' > "$RESULT_JSON_PATH"

echo ""
echo "════════════════ Experiment Summary ════════════════"
echo "Version:                    $VERSION"
echo "Host:                       $(uname -s) $(uname -m)"
echo "QEMU guest:                 arm64 (tcg)"
echo "Extra package files:        $TOTAL_PACKAGES"
echo "Router .npk files after fetch: $FILES_ON_ROUTER"
echo "Installed packages:         $INSTALLED_PACKAGE_COUNT"
echo "Cold boot:                  ${COLD_BOOT_SECONDS}s"
echo "Baseline reboot (no change): ${BASELINE_REBOOT_SECONDS}s"
echo "Package upload+settle:      ${UPLOAD_SECONDS}s"
echo "Package activation reboot:  ${PACKAGE_REBOOT_SECONDS}s"
echo "Total runtime:              ${TOTAL_SECONDS}s"
echo "Result JSON:                $RESULT_JSON_PATH"
echo "QEMU log:                   $WORKDIR/qemu.log"
echo "════════════════════════════════════════════════════"
