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

It exists because direct `/console/inspect` → RAML was hard to debug. The
JSON intermediate form turned out to be valuable on its own as a lingua franca
between RouterOS CLI / REST / native API (which share the same path/cmd/attr
model, just different encodings). That value is still intact and worth
preserving.

### 2. `deep-inspect.*.json` is independent — it runs its own crawl

The deep-inspect pipeline must perform its own `/console/inspect` crawl against
a live CHR. It must **not** take `inspect.json` as input in production. Reason:
crash paths, error paths, and empty-response paths need to be identified at the
time of the current build, against the current RouterOS version. A tree
inherited from `inspect.json` launders those signals away — we'd see "the same"
paths that were fine on a different earlier build.

The existing `--inspect-file` flag stays as a developer convenience for offline
work (e.g. iterating on merge logic without booting a CHR). It is not a
production code path.

### 3. Crashes and missing paths are signals, not exceptions

We are building a schema, but the crawl is often the first thing that walks
every corner of a new RouterOS build. `/console/inspect` likely reads internal
TLV structures from many different subsystems, and a crash on a read-only
operation is a hint that something else in that subsystem may have a more
serious defect. The correct reaction is: **stop, investigate, report to
MikroTik**, then resume building.

Specifically:

- **No hardcoded `CRASH_PATHS` skip list growth.** Do not add a path to a skip
  list to "unblock the build". Each new crash must be confirmed reproducible,
  filed upstream, and only then suppressed — with a comment linking the report.
  The existing skip list in `rest2raml.js` is grandfathered; new entries need
  explicit justification.
- **99% is not "done".** A run that loses 14 of 30,000 paths is not an
  acceptable steady state. Track the count per build; any non-zero count is a
  thing to look at, not a thing to tolerate. Recent X86 builds have reached
  zero crash paths — that is the bar.
- **The build failing is not the emergency; the RouterOS bug it surfaced is.**
  The right sequence is: investigate, decide whether it's our client bug or a
  RouterOS bug, file accordingly, then unblock the build. Do not invert that.
- **Rule out our side first.** Before attributing a crash to RouterOS, eliminate
  client-side causes: REST URL encoding, JSON body shape, retry timing, our
  completion filter. Only when the client is clean does the path get attributed
  upstream.

### 4. Per-arch files before any merge

The pipeline produces `deep-inspect.x86.json` and `deep-inspect.arm64.json` as
independent, self-consistent outputs. Merging them into a single
`deep-inspect.json` is deferred. This preserves the ability to diff the two
trees against each other as a cross-validation signal, and keeps each arch
debuggable in isolation. A merged file hides disagreements that are useful to
see.

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
| Phase 2.9 | Native API non-determinism finding | ✅ Resolved |
| Phase 3 | ARM64 per-arch enrichment | 🟡 3.1–3.4 shipped locally; 3.5 (CI) pending |
| Phase 4 | Multi-arch merge + `_source` | 🔲 Deferred |
| Phase 5 | Per-package provenance (`_package`) | 🔲 Deferred |

**Phase 2 / 2.9 one-line summary:** Native API transport was shipped and is
measurably faster per-call, but `/console/inspect request=completion` returns
non-deterministic results over the native API (~20–30% random entry drops).
Confirmed RouterOS bug, see `docs/mikrotik-bug-native-api-inspect.md`. All
schema work uses REST; `--transport rest` is the default. Native API code
(`ros-api-protocol.ts`, `NativeRouterOSClient`) remains in the tree for
potential future use if MikroTik fixes the bug. Reopening this decision
requires new evidence and a well-tested reference — not a casual retry.

---

## Phase 3: ARM64 per-arch enrichment

**Goal:** Produce `deep-inspect.arm64.json` as a peer to `deep-inspect.x86.json`,
using the same code path, on the same RouterOS version, with its own fresh
`/console/inspect` crawl. No merging. No fallback. No "enrich ARM64-only paths
from X86" shortcut. Per principle 2, neither file is derived from `inspect.json`
— both run their own crawl.

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

### Tasks

#### 3.1 — Make `deep-inspect.ts` output arch-aware ✅

Shipped. `--arch {x86|arm64}` sets `_meta.architecture` explicitly;
`--output-suffix <s>` produces `deep-inspect.<s>.json` / `openapi.<s>.json`.
Crawl and enrichment code paths unchanged — same REST, same retry logic.

#### 3.2 — Local orchestrator `scripts/deep-inspect-multi-arch.ts` ✅

Shipped. Uses the `QuickCHR` library (`@tikoci/quickchr`) rather than
hand-rolling SCP + reboot: `installAllPackages: true` handles the extra
package install, reboot, and post-reboot wait. Empirically reproduces the
conflict resolution we previously verified by hand (wifi-qcom-be wins,
switch-marvell registers its subtree, etc.). Licensing via
`getStoredCredentials()` from quickchr's barrel — reads
`MIKROTIK_WEB_ACCOUNT`/`MIKROTIK_WEB_PASSWORD` (CI) or Bun.secrets (local).

Per principle 3, exits nonzero on `crashPathsCrashed > 0` or `argsFailed > 0`
after retries, with the full path list.

#### 3.3 — Overlap diff tool `scripts/diff-deep-inspect.ts` ✅

Shipped. Produces a text or JSON report:

- `_meta` side-by-side (versions, transports, completion stats).
- Paths only in A / only in B, grouped by top-level segment.
- Completion enum drift — args on both arches with different `_completion`
  keysets, sorted by total delta size. This is the bucket that surfaces
  genuine schema gaps.
- Type mismatches (same path, different `_type`) — flagged separately as
  structural surprises worth investigating.

**Does not merge, does not decide who is right.** Exit code is 0 regardless
of diff size — a difference is not a failure. Gating on this report is a CI
concern (3.5), not the tool's concern.

#### 3.4 — First real run + investigation ✅

Run: `bun scripts/deep-inspect-multi-arch.ts --channel stable --output-dir /tmp/multi-arch`
against 7.22.1 (x86 + arm64, all extra packages). Both arches: 0 crash paths,
0 failed args, ~0.7% batch-timeout retries with 175/176 blank-on-retry.

Diff outcome — numbers pass the sniff test:

- **+1433 paths only in arm64, 37 paths only in x86** (shared 46,483).
- The ~1.4K arm64-only set is concentrated in `/zerotier` (427),
  `/interface/ethernet/switch/**` (switch-marvell), wifi/routing extras —
  exactly the extra-package surface we expected ARM64 to have.
- The 37 x86-only paths (`/system/console/screen/*`,
  `/system/health/set/state-after-reboot`, `/interface/ethernet/*/cable-settings`)
  are the legacy-CHR tail. CHR began as the x86-only form of RouterOS before
  MikroTik shipped hardware; ARM64 is the reverse — it started on hardware
  and was later packaged as stock aarch64 Linux. That asymmetry matching our
  expectations is a positive signal that the pipeline is seeing real
  RouterOS, not a bug.
- Completion enum drift: 1,137 args. One legitimate schema gap — `/ip/cloud/get/value-name`
  exposes `back-to-home-vpn` and 9 `vpn-*` fields only on arm64. The rest are
  noise categories (VM hardware sensors/PCI IDs, filesystem `skins/`,
  package-name enum) that a future filter can suppress.
- Zero type mismatches. Nothing to investigate upstream.

**Takeaway:** the per-arch pipeline is producing usable output and the arm64
view does meaningfully more than x86. Ready to proceed to 3.5.

#### 3.5 — CI integration (pending)

- New job that boots ARM64 CHR via QEMU TCG on an X86 runner. Boot time is
  empirically ~5 min for install + post-reboot ready; measure on the real
  runner before committing to a timeout. Enrichment is ~4× slower than x86
  (325s vs 76s on the local run — TCG emulation tax).
- Runs crawl + enrich, publishes `docs/{version}/deep-inspect.arm64.json`
  (and `docs/{version}/extra/deep-inspect.arm64.json`).
- **`@tikoci/quickchr` is currently a `file:../quickchr` local dependency.**
  For CI, it must be published to npm or vendored. Resolve before this step.
- **Runs `scripts/diff-deep-inspect.ts` against the x86 and arm64 outputs and
  publishes the text report as a build artifact** (step summary + uploaded
  file). Initially informational — no hard gate until we have a baseline
  across multiple versions. The report is the point: it's the human-readable
  record of what each build surfaced.
- `auto.yaml` extended to check for missing `deep-inspect.arm64.json`
  alongside existing artifacts.

### Explicitly not in Phase 3

- **No merge.** No `mergeInspectTrees()`, no `_source` annotation, no merged
  `deep-inspect.json`. Phase 4.
- **No `_package` annotation.** Phase 5.
- **No change to `inspect.json`** at any step. Phase 3 adds files, it does not
  modify existing ones.
- **No hybrid enrichment.** Each arch crawls and enriches on its own CHR.
- **No use of `inspect.json` as a deep-inspect input in CI.** Per principle 2.

---

## Phase 4: Multi-arch merge (deferred)

Deferred until Phase 3 ships and the overlap diff is understood in practice.

Likely shape:

- `mergeInspectTrees()` combining the two per-arch files into
  `deep-inspect.json`.
- Sparse `_source: "x86" | "arm64"` annotation, only on arch-unique nodes
  (absent = present in both).
- `--merge` CLI mode taking both arch files and writing the merged output.
- `_meta.mergeStats` fields.
- Conflict policy for shared-node `_completion` disagreements — TBD, depends
  on what Phase 3.4 actually surfaces.

Reason for deferral: nothing currently consumes a merged file, merge policy
depends on real diff data we don't have yet, and a merged file hides the
cross-arch disagreements that are useful to see. Ship the per-arch files
first.

---

## Phase 5: Per-package provenance (deferred)

Identifying which extra package provides which command is hard. No RouterOS
API exposes a package→command mapping. The accurate approach: install packages
one at a time, crawl after each install, diff. Many reboots, inherently slow.

`@tikoci/quickchr` is the intended lever — its `installAllPackages` and
per-package install operations can automate the boot/install/crawl/diff cycle.
Once quickchr has enough independent test coverage for conflict cases (some
packages conflict: `wifi-qcom` vs `wifi-qcom-be`, etc.), this becomes
tractable. Track demand before investing.

---

## Future: Web tool alignment + deep-inspect consumption

Not a numbered phase yet — collecting scope. These items emerge once a "final"
`deep-inspect.json` exists (post-Phase 4 merge or arm64-as-default decision):

- **Web tools migration**: `docs/lookup.html`, `diff.html`, `index.html`
  currently fetch `inspect.json`. Migrating to deep-inspect adds completion
  data but the files are significantly larger (~10–50 MB with completions).
  Options: a "light" variant without `_completion`, on-demand field loading,
  or keeping inspect.json as the web-tool source and deep-inspect as the
  "full" download.
- **Schema downloads**: `docs/index.html` should surface deep-inspect files
  alongside existing schema.raml / openapi.json downloads.
- **CI rebuild of older versions**: Once the pipeline stabilizes, backfill
  deep-inspect for already-published versions (7.20+, at least).
- **deep-inspect format documentation**: A lightweight schema or doc describing
  the structure — `_meta` fields, `_type` enum, `_completion` shape, `_source`
  (Phase 4). Useful for external consumers and for the web tools.
- **Deeper /console/inspect mining**: Investigate whether `/console/inspect`
  exposes information beyond `child`, `syntax`, and `completion` requests.
  `request=help`? Undocumented request types? This is speculative but the
  goal is `deep-inspect.json` as the richest possible form of the inspect data.

---

## Other open items

### Deep-inspect backfill for stable versions

Once Phase 3 is clean, regenerate `deep-inspect.x86.json` and
`deep-inspect.arm64.json` for all current release channels, back to at least
the current long-term. Priority order: development → stable → long-term →
testing.

Nothing in the HTML tools consumes `deep-inspect.*.json` yet, so a few hours
of broken state during backfill is acceptable. `openapi.json` IS consumed by
`openapi.html` and must continue to regenerate correctly — verify against the
existing version first.
