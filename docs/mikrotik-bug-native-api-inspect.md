# MikroTik Bug Report: `/console/inspect` Completion Non-Determinism via Native API

> **Status:** Evidence gathered; shared with MikroTik support.
> **Discovered:** May 2026, during development of [restraml](https://github.com/tikoci/restraml)
> schema generator.
> **Reproducible script:** [`scripts/test-native-api-tags.ts`](../scripts/test-native-api-tags.ts)

## Summary

`/console/inspect` with `request=completion` returns non-deterministic results when queried
via the RouterOS native API (binary protocol, port 8728). The same command issued sequentially
(concurrency = 1, one in-flight tag) drops completion entries **~25–34% of the time** on a
freshly booted CHR. The drop rate climbs to **~50–58%** at concurrency ≥ 10.

The identical query via the REST API (HTTP, port 80) returns **identical results 100% of the
time** regardless of concurrency or load.

Systematic testing across two RAM sizes (256 MB and 1024 MB) and four concurrency levels
(1, 10, 25, 50 simultaneous in-flight tags) confirms:

- **RAM is not a factor** — drop rates at 256 MB and 1024 MB are statistically equivalent
- **Tag multiplexing is not the root cause** — drops occur at concurrency = 1 (single tag)
- **Completion set size predicts drop probability** — paths with few completions (8 items)
  rarely drop; paths with many completions (36–47 items) drop 60–98% of the time
- The bug is therefore **intrinsic to the `request=completion` handler itself**, not the
  tag-multiplexing wire layer

## Affected Version

- RouterOS **7.22.1** (stable, CHR x86_64)
- Likely affects all 7.x versions (tested: 7.22.1; confirmed not affecting REST transport)

## Controlled Experiment: RAM × Concurrency Matrix

### Setup

Five argument-level paths were probed. REST baselines were established first (3 reads each,
all identical) and used as the expected counts for drop detection:

| Probe path | REST count (baseline) |
|---|---|
| `ip/address/add/interface` | 8 |
| `ip/firewall/filter/add/chain` | 8 |
| `ip/firewall/filter/add/action` | 16 |
| `ip/firewall/filter/add/protocol` | 47 |
| `interface/ethernet/set/speed` | 36 |

Each cell: 50 rounds × 5 paths = 250 native API calls per concurrency level.
A "drop" is any call that returns fewer items than the REST baseline.
A "hang" is any call that produces no response within 30 s (TCP connection recycled).

### Drop Rate Matrix (RouterOS 7.22.1)

| Concurrency | 256 MB | 1024 MB |
|---|---|---|
| **1 tag** (serial) | **25.8%** (63/244) | **33.7%** (83/246) |
| **10 tags** | **51.5%** (1284/2493) | **52.5%** (1307/2491) |
| **25 tags** | **58.5%** (3648/6236) | **56.0%** (3492/6234) |
| **50 tags** | **51.1%** (6365/12464) | **51.3%** (6389/12457) |

→ **256 MB ≈ 1024 MB across all concurrency levels. RAM is not a factor.**

### Hang Count Matrix

| Concurrency | 256 MB | 1024 MB |
|---|---|---|
| 1 tag | 6 hangs | 4 hangs |
| 10 tags | 7 hangs | 9 hangs |
| 25 tags | 14 hangs | 16 hangs |
| 50 tags | 36 hangs | 43 hangs |

Hangs are TCP-level: the router keeps the connection open but sends no response.
On macOS/HVF this manifests as a silent hang (vs. CONNRESET seen on Linux/KVM in CI).
After a hang, reconnecting and retrying succeeds — drop rates do not change.

### Per-Path Drop Rates (concurrency = 1, serial)

| Path | REST count | 256 MB drop rate | 1024 MB drop rate |
|---|---|---|---|
| `ip/address/add/interface` | 8 | **0.0%** (0/50) | **0.0%** (0/50) |
| `ip/firewall/filter/add/chain` | 8 | **4.0%** (2/50) | **2.0%** (1/50) |
| `ip/firewall/filter/add/action` | 16 | **6.0%** (3/50) | **42.0%** (21/50) |
| `ip/firewall/filter/add/protocol` | 47 | **64.0%** (32/50) | **62.0%** (31/50) |
| `interface/ethernet/set/speed` | 36 | **59.1%** (26/44) | **65.2%** (30/46) |

→ **Paths returning 8 completions almost never drop. Paths returning 36–47 completions drop
~60–65% even with a single in-flight tag.** This strongly suggests the completion handler
truncates or mis-enumerates large result sets regardless of tag concurrency or memory pressure.

### Per-Path Drop Rates (concurrency = 50)

| Path | REST count | 256 MB drop rate | 1024 MB drop rate |
|---|---|---|---|
| `ip/address/add/interface` | 8 | 17.2% | 17.6% |
| `ip/firewall/filter/add/chain` | 8 | 15.9% | 16.0% |
| `ip/firewall/filter/add/action` | 16 | 28.8% | 29.5% |
| `ip/firewall/filter/add/protocol` | 47 | 94.8% | 94.6% |
| `interface/ethernet/set/speed` | 36 | 98.8% | 98.9% |

At c=50 the 47-item and 36-item paths approach **near-total drop** (95–99%). The 8-item paths
still drop ~16%, suggesting concurrency adds a secondary pressure on top of the size-dependent
truncation.

### Mean Response Time

| Concurrency | 256 MB | 1024 MB |
|---|---|---|
| 1 tag | ~740 ms/query | ~490 ms/query |
| 10 tags | ~100 ms/query | ~124 ms/query |
| 25 tags | ~78 ms/query | ~87 ms/query |
| 50 tags | ~86 ms/query | ~86 ms/query |

Latency is similar at both RAM sizes. The lower serial latency at 1024 MB (490 ms vs 740 ms)
is within normal QEMU variance; completion times plateau around 80–130 ms/query under load.

## Scale Verification (full tree crawl)

Querying all ~9300 completion-bearing paths via both transports in parallel:

| Metric | REST | Native |
|---|---|---|
| Paths with completions | 9,357 | 9,302 |
| Total individual entries | 55,730 | 53,935 |
| Entry-level delta | — | **1,795 entries missing** |
| Entries unique to native | — | **0** |

Native is always a **strict subset** of REST. No completion entry has ever appeared in native
that was absent from REST.

## Analysis

1. **Not a tag-multiplexing race condition.** Drops occur at concurrency = 1 — a single in-flight
   tag with no overlap. The wire layer is irrelevant. The bug is inside the completion handler.

2. **Not a memory pressure issue.** 256 MB and 1024 MB produce statistically identical drop rates
   across all concurrency levels. Allocating more RAM to the CHR does not help.

3. **Strongly size-dependent.** Paths with 8 completions drop at ~0–4%; paths with 36–47
   completions drop at ~60–65% even serially. This is consistent with a response buffer that
   is either sized incorrectly, truncated early, or enumerated non-deterministically when the
   result set exceeds some internal threshold.

4. **Concurrency is an amplifier, not the cause.** Moving from c=1 to c=10 roughly doubles
   the aggregate drop rate (25% → 51%). But because the bug exists at c=1, reducing concurrency
   cannot fix it — it only reduces its severity.

5. **REST is deterministic because each HTTP request creates a fresh internal session.**
   The native API's persistent session shares some state that the completion handler accesses
   non-deterministically.

6. **Only `request=completion` is affected.** `request=child` and `request=syntax` are fully
   deterministic on both transports (verified over thousands of calls during full-tree crawls).

## Impact

For schema generation tools that depend on complete `/console/inspect` output, this bug means
the native API **cannot be relied upon** for `request=completion` queries. REST must be used
instead.

The native API is significantly faster for `request=child` (tree walking) and `request=syntax`
queries, which are both unaffected. A hypothetical hybrid approach — native API for tree crawl,
REST for completion enrichment — remains viable if the tree-walking performance matters.

## Reproducible Test Script

A complete Bun test script is available at [`scripts/test-native-api-tags.ts`](../scripts/test-native-api-tags.ts).

```sh
# Run from repo root — boots CHR at 256 MB and 1024 MB via quickchr, tests all cells
bun scripts/test-native-api-tags.ts
```

Requirements: `bun`, `bunx @tikoci/quickchr` (auto-installed), QEMU with HVF or KVM.
The script emits a formatted summary table plus JSON for further analysis.

## Additional Bugs Found During Investigation

### 1. `/console/inspect` REST deadlock on RouterOS ≤7.21.3

`POST /rest/console/inspect {"request":"syntax", "path":"do"}` hangs the **entire REST/HTTP
server** for ~30 seconds on RouterOS 7.20.8 (long-term stable). Same hang with `request=completion`.
Only the bare `"do"` path triggers this — nested paths like `["do", "command"]` are safe, and
`request=child` on `"do"` is safe. Other keywords (`where`, `else`, `rule`, `command`,
`on-error`) cause similar hangs.

This is tracked separately as the "crash path" set in the restraml codebase and is the reason
`rest2raml.js` explicitly skips those paths during schema generation.

This bug is **fixed in RouterOS 7.21.4+** (returns HTTP 200 immediately).

Reproduction (curl):
```sh
# Against RouterOS ≤7.21.3 — hangs ~30 s
curl -u admin: -X POST http://192.168.88.1/rest/console/inspect \
  -H 'Content-Type: application/json' \
  -d '{"request":"syntax","path":"do"}'
```

### 2. Connection hang vs CONNRESET under concurrent native API load

Sending ≥25 concurrent `/console/inspect` commands via native API causes the router to
**stop responding** on the TCP connection (hang) rather than returning results. Behavior
observed:

- **macOS/HVF (local QEMU):** TCP stays open but router sends nothing; client must time out
  and reconnect. Observed as ~1 hang per 3–7 rounds at c=25, ~1 hang per round at c=50.
- **Linux/KVM (GitHub Actions CI):** Previously observed as TCP CONNRESET (52 resets in a
  25 ms window), killing all in-flight commands simultaneously.

The hang/CONNRESET dichotomy is likely a difference in how QEMU user-mode networking handles
TCP half-close under HVF vs KVM, not a RouterOS behavior difference. The underlying trigger
is the same: the router's native API handler stops servicing the connection under sustained
concurrent load.

After reconnect, drop rates return to baseline — no permanent session degradation.

## Environment

- RouterOS: 7.22.1 (stable) CHR, x86_64
- Host: macOS (Intel x86_64), QEMU 9.x with HVF acceleration
- Client: Bun runtime, `ros-api-protocol.ts` (custom native API binary protocol implementation)
- Network: QEMU user-mode networking (host port → VM port forwarding)
- RAM tested: 256 MB and 1024 MB (CHR minimum is 128 MB)

## Suggested Fix

The completion enumeration in `/console/inspect` should produce identical output regardless of
API transport. Since REST is deterministic, the internal logic is capable of consistent results.
The issue likely lies in how the persistent native API session dispatches or serializes the
completion query when result sets are large (≥16 items). Two likely hypotheses:

1. **Buffer sizing bug**: a fixed-size response buffer is used for completion data; large result
   sets overflow and entries are silently dropped.
2. **Non-atomic enumeration**: the completion list is built lazily from session state that can
   change while the response is being serialized — a TOCTOU race.

In either case the fix is: ensure the completion list is fully captured before serialization
begins, using the same snapshot approach that makes REST deterministic.
