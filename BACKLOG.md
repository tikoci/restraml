# BACKLOG.md — deep-inspect Roadmap

Tracks how `deep-inspect.*.json` is produced and how the schema pipeline evolves.
For historical forensics on shipped phases (native API investigation, benchmark
sweeps, Phase 1/2 rollout), see git log and `docs/mikrotik-bug-native-api-inspect.md`.
This file is meant to stay short and actionable.

---

## Guiding principles

These predate any specific phase and apply to every future change.

### 1. `inspect.json` is load-bearing and frozen

`docs/{version}/inspect.json` is consumed by many tikoci projects (rosetta,
lsp-routeros-ts, the HTML tools in `docs/`, etc.) and potentially external
consumers. Do not change its shape, do not rename it, do not stop publishing it.
Any change to `inspect.json` is a standalone change with its own justification —
never a side effect of deep-inspect work.

### 2. `deep-inspect.*.json` is independent — it runs its own crawl

The deep-inspect pipeline must perform its own `/console/inspect` crawl against
a live CHR. It must **not** take `inspect.json` as input in production. Reason:
crash paths, error paths, and empty-response paths need to be identified at the
time of the current build, against the current RouterOS version.

The existing `--inspect-file` flag stays as a developer convenience for offline
work (e.g. iterating on merge logic without booting a CHR). It is not a
production code path.

### 3. Crashes and missing paths are signals, not exceptions

We are building a schema, but the crawl is often the first thing that walks
every corner of a new RouterOS build. The correct reaction is: **stop,
investigate, report to MikroTik**, then resume building. No hardcoded skip
list growth. 99% is not "done". The build failing is not the emergency; the
RouterOS bug it surfaced is.

### 4. Per-arch files before any merge

The pipeline produces `deep-inspect.x86.json` and `deep-inspect.arm64.json` as
independent, self-consistent outputs. Merging them into a single
`deep-inspect.json` is deferred. This preserves the ability to diff the two
trees against each other as a cross-validation signal.

In the long run ARM64 is plausibly the better "default" tree — most RouterOS
paths are arch-agnostic, and ARM64 ships with more packages (zerotier, blink,
wifi-qcom variants, etc.). But that's a downstream decision for whenever merge
happens, not Phase 3.

---

## Status

| Phase | Name | Status |
|-------|------|--------|
| Phase 1 | Completion bug fix + metadata | ✅ Shipped |
| Phase 2 | Native API transport | ✅ Shipped, unused in CI |
| Phase 2.9 | Native API non-determinism finding | ✅ Resolved — REST only |
| Phase 3 | ARM64 per-arch enrichment | 🟡 3.1–3.4 shipped locally; 3.5 (CI) **broken** |

**Phase 2 / 2.9 one-line summary:** Native API transport was shipped and is
measurably faster per-call, but `/console/inspect request=completion` returns
non-deterministic results over the native API (~20–30% random entry drops).
Confirmed RouterOS bug, see `docs/mikrotik-bug-native-api-inspect.md`. All
schema work uses REST; `--transport rest` is the default.

---

## Phase 3: ARM64 per-arch enrichment

**Goal:** Produce `deep-inspect.arm64.json` as a peer to `deep-inspect.x86.json`,
using the same code path, on the same RouterOS version, with its own fresh
`/console/inspect` crawl. Both output files live in `docs/{version}/extra/`.
No merging. No fallback. No "enrich ARM64-only paths from X86" shortcut.
Per principle 2, neither file is derived from `inspect.json` — both run their
own crawl.

### Prerequisites that already exist

- `deep-inspect.ts` with `--live` crawl and REST enrichment (Phase 1+2).
- `quickchr` library (`~/GitHub/quickchr`) with
  `QuickCHR.start({arch: "arm64"}).rest(...)` — boots ARM64 CHR under QEMU TCG
  on X86 hosts.
- `all_packages-arm64-{ver}.zip` on `download.mikrotik.com` and
  `cdn.mikrotik.com`, confirmed for 7.22+.
- Empirically verified package conflict resolution: install all ARM64 packages,
  reboot once, `wifi-qcom-be` wins the wireless conflict, `switch-marvell`
  installs and registers its inspect subtree even though the hardware is absent.

### What correct local output looks like (reference baseline)

Local run against 7.23beta5, both arches with ALL extra packages installed:

| | x86 (HVF/KVM) | arm64 (TCG on Intel) |
|---|---|---|
| `argsTotal` | 34,961 | 36,023 |
| `argsWithCompletion` | 11,963 | 12,285 |
| `argsFailed` | 0 | 0 |
| Enrichment time | 77s | 532s |
| File size | 6.1 MB | 6.3 MB |

**Key: ARM64 has ~1,062 MORE args than x86.** This is the whole point — ARM64
has zerotier, ethernet/switch (switch-marvell), blink, and other extra-package
paths that x86 does not.

Diff outcome from the local run:
- +1,433 paths only in arm64, 37 paths only in x86 (shared 46,483)
- Completion enum drift: 1,137 args (real schema differences)
- Zero type mismatches

These files are preserved at `/tmp/multi-arch-dev/` for comparison.

### Tasks

#### 3.1 — Make `deep-inspect.ts` output arch-aware ✅

Shipped. `--arch {x86|arm64}` sets `_meta.architecture` explicitly;
`--output-suffix <s>` produces `deep-inspect.<s>.json` / `openapi.<s>.json`.

#### 3.2 — Local orchestrator `scripts/deep-inspect-multi-arch.ts` ✅

Shipped. Uses `QuickCHR` library with `installAllPackages: true`.

#### 3.3 — Overlap diff tool `scripts/diff-deep-inspect.ts` ✅

Shipped. Produces text or JSON report: paths only in A/B, completion enum
drift, type mismatches. Does not merge, does not decide who is right.

#### 3.4 — First real run + investigation ✅

See "What correct local output looks like" above. Numbers pass the sniff test.

#### 3.5 — CI integration: `deep-inspect-multi-arch.yaml` ❌ BROKEN

**Current state (April 2026):** The workflow exists and goes "green" but
**produces wrong output.** Over 22 CI runs, 20 failed and 2 "succeeded" —
but both successes have ARM64 missing all extra packages.

**Evidence from run 24351403139 (the "green" build for 7.22.1):**
- x86 `List installed packages`: 12 packages ✅
- arm64 `List installed packages`: `["routeros"]` only ❌
- x86 argsTotal: 34,961 (with extra packages) ✅
- arm64 argsTotal: 577 (base package only) ❌ — should be ~36,023
- Diff shows 46,164 x86-only paths — the OPPOSITE of the expected ~1,433

**Root cause chain — what went wrong during the 22 CI iterations:**

1. **Original design (commit f8aa2d2):** Both arches do independent live crawl
   with extra packages, running on separate runners. This was correct.
2. **Package upload failures:** ARM64 job used SCP for package upload. SCP
   hangs under QEMU TCG emulation (SSH is very slow under software
   emulation). Multiple attempts to fix: disk injection, HTTP PUT (501 Not
   Implemented on RouterOS), finally `/tool/fetch` pull from a host HTTP
   server.
3. **SLIRP networking death on reboot:** The critical unverified theory —
   after uploading packages via `/tool/fetch`, the CHR must reboot to
   activate them. When rebooted via `/system/reboot`, QEMU user-mode
   networking (SLIRP) may not survive the guest reboot under ARM64 TCG.
   The agent implemented a kill-QEMU-and-cold-boot workaround (commit
   61895ce). **This was never verified locally.** The mikropkl Lab data
   actually says SLIRP DOES survive reboots.
4. **Progressive crippling instead of root cause analysis:**
   - Commit e6e906c: arm64 depends on x86, uses `--inspect-file` instead
     of its own crawl — **violates principle 2**
   - Commit b2d7964: `--skip-completion` added — arm64 does no enrichment
   - Commit 3a1a6bb: increased curl timeout to 300s for switch-marvell
   - At this point the arm64 job essentially does nothing useful
5. **Timeout escalation instead of debugging:** Boot timeout increased
   from 120s → 240s → 600s. Enrichment timeout increased. Job timeout
   set to 90 minutes. None of these addressed the actual problem (packages
   not being installed).
6. **The "green" conclusion:** The agent declared success when x86 and
   arm64 had identical path counts (46,633 each) — completely missing
   that this PROVES extra packages are absent (they should differ by
   ~1,400 paths).

**What needs to happen to fix 3.5:**

The CI workflow needs to be rewritten with these hard constraints:

1. **Both arches MUST do their own independent live crawl** (principle 2)
2. **Both arches MUST have extra packages installed** — the `List installed
   packages` step MUST show >10 packages, not just `["routeros"]`
3. **Fail fast if packages aren't installed** — add an assertion step after
   "List installed packages" that fails the job if count < 10
4. **The diff MUST show ~1000+ arm64-only paths** — if the diff shows 0
   or near-0 arch-specific paths, the build should fail with a clear error
5. **Verify locally before pushing to CI** — use
   `scripts/experiment-arm64-reboot-timing.sh` to confirm package upload
   and reboot actually works before iterating on CI

**QEMU timing baselines (measured, not guessed):**

These come from mikropkl Lab experiments, not speculation:

| Host | Guest | Accel | Boot time | Source |
|------|-------|-------|-----------|--------|
| x86_64 Linux CI | x86_64 | KVM | <5s | mikropkl qemu-test.yaml |
| x86_64 Linux CI | aarch64 | TCG | ~20s | mikropkl Lab/qemu-arm64 |
| aarch64 Linux CI | aarch64 | KVM/TCG | <5s / ~25s | mikropkl qemu-test.yaml |
| x86_64 Mac | x86_64 | HVF | ~5s | mikropkl Lab/x86-cross-arch |
| x86_64 Mac | x86_64 | TCG | ~25s | mikropkl Lab/x86-cross-arch |
| aarch64 host | x86_64 | TCG | **>300s — NOT VIABLE** | mikropkl confirmed |

**Rule: if a boot timeout exceeds 120s, something is wrong.** Do NOT increase
the timeout past 120s without first understanding why it's slow and verifying
the theory locally. For ARM64 TCG on x86_64, boot should take ~20s. For
package-install reboot, add ~30s on top. Total: ~60s max for a healthy boot.
If it takes 600s, the problem is not "TCG is slow" — it's a broken boot.

**The `ubuntu-24.04-arm` runner (current arm64 job):**
The current workflow runs the arm64 job on `ubuntu-24.04-arm` (GitHub ARM64
runner). This means ARM64-on-ARM64, which could use KVM if the runner exposes
it (the workflow probes for KVM and falls back to TCG). This is actually the
RIGHT choice for performance, but it doesn't matter if packages aren't
installed.

**Package upload strategy — what works locally:**
The local orchestrator (`scripts/deep-inspect-multi-arch.ts`) uses quickchr's
`installAllPackages: true`, which handles SCP + reboot internally. The CI
equivalent should be:
1. Upload packages via `/tool/fetch` from a host HTTP server (already in the
   workflow — this part works)
2. Verify files landed on the router: `GET /rest/file` filtering for `.npk`
   (already in the workflow — reports correct count)
3. Reboot to activate: the x86 job uses `/system/reboot` + wait_for_rest_down
   + wait_for_rest_ready and this works. The arm64 job should use the SAME
   pattern unless there's proven evidence that SLIRP dies on arm64 reboot.
4. **Verify packages are active** after reboot — the `List installed packages`
   step must show the full package list, and the job must fail if it doesn't

**Open question: Does SLIRP survive arm64 guest reboot?**
- mikropkl Lab says SLIRP survives reboots in general
- The x86 CI job uses `/system/reboot` and it works fine
- The arm64 CI job uses kill-QEMU-cold-boot as a workaround
- This needs to be tested locally with the experiment script before
  touching CI again: `scripts/experiment-arm64-reboot-timing.sh`

### Explicitly not in Phase 3

- **No merge.** No `mergeInspectTrees()`, no `_source` annotation. Phase 4.
- **No `_package` annotation.** Phase 5.
- **No change to `inspect.json`** at any step.
- **No use of `inspect.json` as a deep-inspect input in CI.** Per principle 2.

---

## Phase 4: Multi-arch merge (deferred)

Deferred until Phase 3 ships and the overlap diff is understood in practice.

Likely shape:

- `mergeInspectTrees()` combining the two per-arch files into
  `deep-inspect.json`.
- Sparse `_source: "x86" | "arm64"` annotation, only on arch-unique nodes.
- `--merge` CLI mode.
- `_meta.mergeStats` fields.
- Conflict policy for shared-node `_completion` disagreements — TBD.

---

## Phase 5: Per-package provenance (deferred)

Identifying which extra package provides which command is hard. No RouterOS
API exposes a package→command mapping. The accurate approach: install packages
one at a time, crawl after each install, diff. Many reboots, inherently slow.

Requires stable CI before attempting — the current fragility of the QEMU
reboot cycle is a hard blocker. This is lower priority than getting Phase 3.5
working correctly.

---

## Other open items

### Deep-inspect backfill for stable versions

Once Phase 3 is clean, regenerate `deep-inspect.x86.json` and
`deep-inspect.arm64.json` for all current release channels, back to at least
the current long-term (7.20.8). Priority: development → stable → long-term →
testing.

### Downstream consumers

- **tikoci/rosetta:** Expecting `deep-inspect.x86.json` and
  `deep-inspect.arm64.json` in `docs/{ver}/extra/` to import into its SQL
  database. Planned around the full extra-packages output from local tests.
- **docs/*.html pages:** Currently use `inspect.json`. Future work to migrate
  some views to the richer `deep-inspect.*.json` data. Not blocked by Phase 3
  but benefits from it.
- **openapi.json:** Already consumed by `openapi.html`. The deep-inspect
  pipeline regenerates it — verify equivalence before replacing.

---

## Lessons learned — CI anti-patterns (April 2026)

These are documented here so future agents don't repeat the same mistakes.

### 1. "TCG is glacially slow" is not a valid diagnosis

TCG (software CPU emulation) adds overhead, but ARM64 CHR on x86_64 TCG boots
in ~20s. If something takes 600s, TCG is not the bottleneck — investigate the
actual failure. Measured baselines exist in the table above.

### 2. Increasing timeouts is almost never the fix

If a step takes 10× longer than the measured baseline, the timeout is not the
problem. The fix is to understand WHY it's slow, not to wait longer. Every
"increase timeout" commit in the 22-run failure sequence masked the real issue.

### 3. Verify locally before pushing to CI

CI builds take 30–90 minutes per attempt. Local QEMU experiments take 5–10
minutes. `scripts/experiment-arm64-reboot-timing.sh` exists specifically for
this — it measures cold boot, reboot, package upload, and package activation
times in a local QEMU instance. Use it.

### 4. Check the output, not just the exit code

A CI job returning exit 0 does not mean it produced correct output. The
"green" build had identical x86/arm64 schemas because ARM64 had no extra
packages. The diff showing "0 differences" should have been a red flag, not
a success signal. Add assertions:
- Package count > N after install
- argsTotal within expected range after crawl
- Diff shows expected arch-specific path count

### 5. Don't violate principles to work around bugs

The arm64 job was progressively changed to use the x86 tree as input
(`--inspect-file`) and skip enrichment (`--skip-completion`) — directly
violating principles 2 and 4. The correct response to "arm64 crawl is too
slow" is to fix the performance problem (wrong runner, missing packages,
broken reboot), not to skip the crawl entirely.
