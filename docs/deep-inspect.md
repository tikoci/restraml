# Deep-inspect reference

This page is the durable reference for `deep-inspect.*.json`: why it exists,
how the multi-arch pipeline works, and what was learned while shipping it.
Keep `BACKLOG.md` focused on future tasks; put shipped design notes and
postmortems here.

## Purpose

`deep-inspect.ts` enriches RouterOS `/console/inspect` output with
`request=completion` data. The result is a richer schema tree than
`inspect.json`, including argument completion metadata that downstream tooling
can import directly or use to generate richer OpenAPI output.

The published multi-arch pipeline currently produces these files under
`docs/{version}/extra/`:

- `deep-inspect.x86.json`
- `deep-inspect.arm64.json`
- `diff-deep-inspect.json`

`deep-inspect.ts` and `scripts/deep-inspect-multi-arch.ts` can generate
`openapi.<arch>.json` locally, but CI intentionally skips publishing per-arch
OpenAPI files until the replacement path for public `openapi.json` is verified.

## JSON Schema contracts

Two JSON Schemas live at the docs root:

- [`deep-inspect.schema.json`](deep-inspect.schema.json) is the strict contract
  for the current emitted format. It validates the `_meta` envelope, recursive
  inspect nodes, `desc`, and `_completion` maps as they exist in published
  artifacts today. It intentionally rejects future-only metadata such as
  `_source` and `_package`. Retry counters in `_meta.completionStats`
  (`argsTimedOut` and `argsBlankOnRetry`) are optional because the earliest
  published `deep-inspect.json` artifacts predate that instrumentation.
- [`deep-inspect.future.schema.json`](deep-inspect.future.schema.json) is a
  design-target superset for planned backlog work. It keeps the current tree
  shape but allows sparse `_source` annotations for future merged
  multi-arch output, `_meta.mergeStats` conflict counters, an explicit
  `_meta.mergePolicy`, and a provisional package-provenance declaration.

The current schema leaves completion `style` as an open string instead of a
closed enum. Published artifacts currently use styles such as `none`,
`obj-disabled`, `obj-dynamic`, `obj-inactive`, `obj-wildcard`, `arg`, `dir`,
`flag-title`, and `syntax-meta`, but RouterOS can add styles without changing
the deep-inspect container shape.

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
4. ~~Package install via REST `/execute`, avoiding SCP so both KVM and TCG paths
   work.~~
   **Reverted in August 2026 — see the #96 postmortem below.** SCP was never the
   problem, this change was unnecessary, and it later broke the job for three weeks.
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
   all packages. Note quickchr only defaults to 1024 MB for *cross-arch*
   emulation; an arm64 guest on a native arm64 runner gets 512 MB, so pass
   `mem: 1024` explicitly.

## ARM64 package-activation postmortem (#96, August 2026)

The arm64 job failed every run from 2026-07-28 to 2026-08-14 at
`argsTotal < 30000`, blocking publication of 7.24rc3, 7.23.3 and 7.24rc4.

**Root cause:** the package-activation reboot stopped happening. The signal is a
line that stops appearing in the `Wait for package activation reboot` step:

| Run | Version | Down-detected | `argsTotal` |
|---|---|---|---|
| 30334675878 | 7.24rc2 | `REST went down after 21s.` | 36,793 |
| 31670987516 | 7.24rc4 | *(none — loop exhausted)* | 28,748 |
| 31763454996 | 7.23.3 | *(none — loop exhausted)* | short |

Without the reboot the packages stay installed-but-inactive, so `/app`,
`/caps-man`, `/container`, `/dude`, `/iot`, `/openflow`, `/tr069-client` and
`/user-manager` never enter the tree — the entire ~8,000-arg shortfall.

**Why it stopped:** the job depended on `/system/package/apply-changes` to
trigger the reboot, dispatched fire-and-forget through `POST /rest/execute`.
MikroTik's Packages manual documents `apply-changes` as prompting
(`Apply scheduled changes and reboot device? [y/N]:`), defaulting to no. The
workflow file itself was unchanged since May, so this is drift against an
unchanged fragile script, not a regression we introduced. Also confirmed *not*:
licensing (7.23.3 failed with a valid fresh trial), the crawl
(`fetchChild failed for` appears 0x, `argsFailed: 0`), TCG (the last green run
was also TCG), and upstream RouterOS (local quickchr arm64 at 7.24rc4 is
identical to 7.24rc2 — 36,793 args, 0 path delta).

**Why the mechanism existed at all:** it was collateral damage. Commit `6e1dd58`
swapped SCP for `/rest/execute` mid-debugging and deleted the explicit
`POST /system/reboot` in the same change. SCP was never the failing step — in the
SCP-era run 24553141540 the steps read `Install extra packages via SCP: success`,
`Reboot CHR and wait for extra packages: failure`, and that failure was fixed
three commits later by `7052106` (RAM). The fork survived unvalidated for four
months.

**Fix:** both arches now use one mechanism — `all_packages-<arch>` zip, SCP to
flash root, explicit `POST /system/reboot`.

**Why no gate caught it:** the `>=10 packages` check counted 19 *inactive*
packages and passed; `/system/package` lists packages regardless of activation.
The `argsTotal >= 30000` floor was the only thing that fired, ~8,000 args late
and naming nothing. Replaced by `deep-inspect.ts --require-roots`, which reads
`_meta.census` and fails immediately naming the missing roots. The multi-arch
workflow requires `container,iot,dude,user-manager,tr069-client,openflow` — all
six are present in every published versioned artifact back to 7.20.8 on both
arches. Nightly deliberately does not use this list: its NPK set carries no
`dude`, `openflow`, `tr069-client` or `user-manager` (see `absentRoots`).

`diff-deep-inspect.ts` additionally reports root-menu drift between the two
arches. That one is report-only — `/blink` and `/zerotier` are legitimately
arm64-only.

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
