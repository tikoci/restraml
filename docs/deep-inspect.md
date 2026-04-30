# Deep-inspect reference

This page is the durable reference for `deep-inspect.*.json`: why it exists,
how the multi-arch pipeline works, and what was learned while shipping it.
Keep `BACKLOG.md` focused on future tasks; put shipped design notes and
postmortems here.

## Purpose

`deep-inspect.ts` enriches RouterOS `/console/inspect` output with
`request=completion` data. The result is a richer schema tree than
`inspect.json`, including argument completion metadata and OpenAPI output used
by downstream tooling.

The published multi-arch pipeline produces these files under
`docs/{version}/extra/`:

- `deep-inspect.x86.json`
- `deep-inspect.arm64.json`
- `openapi.x86.json`
- `openapi.arm64.json`
- `diff-deep-inspect.json`

## Non-negotiable design rules

### `inspect.json` is load-bearing and frozen

`docs/{version}/inspect.json` is consumed by many tikoci projects (rosetta,
lsp-routeros-ts, the HTML tools in `docs/`, and potentially external users). Do
not change its shape, rename it, or stop publishing it as a side effect of
deep-inspect work.

### Deep-inspect production builds run their own crawl

The deep-inspect pipeline must perform its own `/console/inspect` crawl against
a live CHR. It must not take `inspect.json` as input in production because crash
paths, error paths, and empty-response paths need to be identified at build time
against the current RouterOS version.

The `--inspect-file` flag remains a developer convenience for offline work, such
as iterating on merge logic without booting a CHR. It is not a production path.

### Crashes and missing paths are signals

The crawl often walks RouterOS paths nobody else exercises on a new release. A
failed crawl should lead to investigation and, when appropriate, a MikroTik bug
report. Do not grow skip lists or accept partial output just to make CI green.

### Per-arch files come before any merge

The pipeline publishes `deep-inspect.x86.json` and `deep-inspect.arm64.json` as
independent, self-consistent outputs. A future `deep-inspect.json` merge is a
separate design task so the two trees remain available for cross-validation.

ARM64 is plausibly the better default source for a future merge because it ships
with more packages (zerotier, blink, wifi-qcom variants, and others), but that
is a downstream decision, not part of the shipped Phase 3 work.

## Native API transport decision

Native API transport was implemented and is measurably faster, but
`/console/inspect request=completion` returns non-deterministic results over the
native API binary protocol. Around 20-30% of calls randomly drop completion
entries. REST is deterministic.

All schema generation and CI enrichment uses REST. `ros-api-protocol.ts` and the
native client remain in the codebase in case MikroTik fixes the bug later.

Full forensic report:
[`docs/mikrotik-bug-native-api-inspect.md`](mikrotik-bug-native-api-inspect.md)

## Phase 3: ARM64 per-arch enrichment

Phase 3 produced `deep-inspect.arm64.json` as a peer to
`deep-inspect.x86.json`, using the same code path, on the same RouterOS version,
with its own fresh `/console/inspect` crawl. Both output files live in
`docs/{version}/extra/`. No merging, fallback, or "enrich ARM64-only paths from
x86" shortcut was part of Phase 3.

### Shipped pieces

| Phase | Result |
|---|---|
| 3.1 | `deep-inspect.ts --arch {x86|arm64}` sets `_meta.architecture`; `--output-suffix <s>` writes suffixed outputs. |
| 3.2 | `scripts/deep-inspect-multi-arch.ts` orchestrates local per-arch crawls through `@tikoci/quickchr`. |
| 3.3 | `scripts/diff-deep-inspect.ts` reports paths only in A/B, completion enum drift, and type mismatches. |
| 3.4 | First full local x86+arm64 run validated that ARM64 exposes materially more schema surface. |
| 3.5 | `.github/workflows/deep-inspect-multi-arch.yaml` publishes per-arch artifacts from CI. |

### Prerequisites now available

- `deep-inspect.ts` supports `--live` crawl and REST enrichment.
- `@tikoci/quickchr` can boot x86 and arm64 CHR instances and install all
  packages.
- `all_packages-arm64-{version}.zip` exists for 7.22+ on MikroTik download/CDN
  hosts.
- ARM64 package conflict behavior was validated: after installing all packages
  and rebooting, `wifi-qcom-be` wins the wireless conflict, and
  `switch-marvell` registers its inspect subtree even without matching hardware.

### Reference local baseline

Local run against 7.23beta5 with all extra packages installed on both arches:

| Metric | x86 (HVF/KVM) | arm64 (TCG on Intel) |
|---|---:|---:|
| `argsTotal` | 34,961 | 36,023 |
| `argsWithCompletion` | 11,963 | 12,285 |
| `argsFailed` | 0 | 0 |
| Enrichment time | 77s | 532s |
| File size | 6.1 MB | 6.3 MB |

ARM64 had about 1,062 more args than x86. That is expected: ARM64 includes
zerotier, ethernet/switch (`switch-marvell`), blink, and other extra-package
paths that x86 does not.

Diff outcome from that local run:

- 1,433 paths only in arm64
- 37 paths only in x86
- 46,483 shared paths
- 1,137 completion enum drift args
- 0 type mismatches

Use checked-in workflow assertions and published `docs/{version}/extra/`
artifacts for durable comparisons. Local `/tmp` experiment directories are
disposable.

## ARM64 CI postmortem

The arm64 CI job now works under both KVM (when available) and TCG. Earlier
failures were caused by insufficient RAM, not by TCG being inherently too slow.

**Root cause:** 256 MB RAM caused memory pressure with 17 extra packages under
TCG emulation. REST calls inflated from about 70 ms to 10s+ and the REST server
eventually crashed. Increasing RAM to 1024 MB, matching quickchr's cross-arch
default, resolved the failures.

**Verified in CI run #24583323420:**

- x86 `argsTotal`: 34,548 (KVM, about 2 min)
- arm64 `argsTotal`: 35,594 (TCG, about 11 min)
- Diff and publish passed

**Key fixes in commit 7052106:**

1. RAM: 256 MB to 1024 MB.
2. Prefer KVM with TCG fallback instead of KVM-or-bust.
3. Adaptive timeouts: curl 3s/15s, sleep 5s/10s, boot 120s/300s based on KVM/TCG.
4. Package install via REST `/execute`, avoiding SCP so both KVM and TCG paths work.
5. `--request-timeout` of 30s for KVM and 120s for TCG deep-inspect calls.

### CI anti-patterns learned

These rules are duplicated in shorter form in `CLAUDE.md` because future agents
must see them before changing workflows.

1. **"TCG is glacially slow" is not a diagnosis.** ARM64 CHR on x86_64 TCG
   boots in about 20s. If something takes 600s, investigate the actual failure.
2. **Increasing timeouts is almost never the fix.** If a step takes 10x longer
   than baseline, waiting longer masks the root cause.
3. **Verify locally before pushing to CI.** CI attempts are expensive; local
   QEMU experiments are faster.
4. **Check output, not just exit code.** A green job with identical x86/arm64
   output is wrong if ARM64 packages were supposed to be installed.
5. **Do not violate design rules to work around bugs.** The fix for a slow ARM64
   crawl is not `--inspect-file`, `--skip-completion`, or deriving ARM64 output
   from x86.
6. **Give extra-package jobs enough RAM.** Use 1024 MB for any job that installs
   all packages.

### Boot timing reference

| Host to guest | Accelerator | Boot time |
|---|---|---|
| x86_64 to x86_64 | KVM | <5s |
| x86_64 to aarch64 | TCG | ~20s |
| aarch64 to aarch64 | KVM/TCG | <5s / ~25s |
| x86_64 Mac to x86_64 | HVF | ~5s |
| x86_64 Mac to x86_64 | TCG | ~25s |
| aarch64 host to x86_64 | TCG | >300s — not viable |

Rule of thumb: if a boot timeout exceeds 120s, something is wrong. Do not
increase it without understanding why the boot is slow and verifying that theory
locally.

## Explicitly deferred

- **No merge yet.** No `mergeInspectTrees()`, `_source` annotation, or merged
  `deep-inspect.json` until the merge policy is designed.
- **No package provenance yet.** `_package` annotations require package-by-package
  install/diff experiments.
- **No `inspect.json` changes.** Deep-inspect remains additive.
- **No `inspect.json` input in CI deep-inspect.** Live crawl remains the
  production path.

## Downstream consumers

- **tikoci/rosetta:** expects `deep-inspect.x86.json` and
  `deep-inspect.arm64.json` under `docs/{version}/extra/` for SQL/RAG import.
- **docs/*.html pages:** currently use `inspect.json`; future task cards decide
  whether individual pages should migrate to richer deep-inspect data.
- **openapi.html:** already consumes `openapi.json`; any switch to per-arch or
  merged OpenAPI output needs an equivalence review first.
