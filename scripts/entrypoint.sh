#!/bin/bash
# Simple QEMU entrypoint for RouterOS CHR in Docker.
# Uses user-mode networking (SLIRP) with port forwarding — no tap/bridge setup required.
# Port mapping is handled by Docker (-p host:container) using the container ports below.
# Uses virtio disk and virtio-net — both supported by MikroTik CHR on x86/amd64.
set -e

# Use KVM hardware acceleration when available (requires --device /dev/kvm)
KVM_OPTS=""
CPU_OPT="qemu64"
if [ -e /dev/kvm ] && grep -q -e vmx -e svm /proc/cpuinfo 2>/dev/null; then
    echo "KVM available — using hardware acceleration."
    KVM_OPTS="-enable-kvm -machine accel=kvm"
    CPU_OPT="host"
else
    echo "KVM not available — running in software emulation mode (may be slow)."
fi

exec qemu-system-x86_64 \
    -serial mon:stdio \
    -nographic \
    -m 256 \
    -cpu "${CPU_OPT}" \
    ${KVM_OPTS} \
    -drive "file=/routeros/${ROUTEROS_IMAGE},format=qcow2,if=virtio" \
    -netdev "user,id=net0,hostfwd=tcp::22-:22,hostfwd=tcp::23-:23,hostfwd=tcp::80-:80,hostfwd=tcp::443-:443,hostfwd=tcp::8728-:8728,hostfwd=tcp::8729-:8729,hostfwd=tcp::8291-:8291,hostfwd=tcp::5900-:5900" \
    -device virtio-net-pci,netdev=net0 \
    "$@"
