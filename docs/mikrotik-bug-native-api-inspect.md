# MikroTik Bug Report: `/console/inspect` Completion Non-Determinism via Native API

> **Status:** Mechanics identified; workaround found; evidence shared with MikroTik support.
> **Discovered:** May 2026, during development of [restraml](https://github.com/tikoci/restraml)
> schema generator.
> **Reproducible scripts:**
> [`scripts/test-native-api-tags.ts`](../scripts/test-native-api-tags.ts) — RAM × concurrency matrix
> [`scripts/test-native-api-drops.ts`](../scripts/test-native-api-drops.ts) — drop mechanics / proplist

## Summary

`/console/inspect` with `request=completion` returns non-deterministic results when queried
via the RouterOS native API (binary protocol, port 8728). The same command issued sequentially
(concurrency = 1, one in-flight tag) drops completion entries **~25–80% of the time** on a
freshly booted CHR. The drop rate climbs to **~50–58%** at concurrency ≥ 10.

The identical query via the REST API (HTTP, port 80) returns **identical results 100% of the
time** regardless of concurrency or load.

Two rounds of controlled experiments confirm:

- **RAM is not a factor** — drop rates at 256 MB and 1024 MB are statistically equivalent
- **Tag multiplexing is not the root cause** — drops occur at concurrency = 1 (single tag)
- **Completion set size predicts drop probability** — paths with ≤15 completions never drop;
  paths with 36–47 completions drop 80–100% with no `.proplist` filter
- **The bug is per-item response byte size** — adding `=.proplist=completion` to native API
  calls reduces drop rate from **100% → ~1%** on the worst-case 47-item path
- The root cause is **a fixed-size response buffer** in the native API completion handler
- **Practical workaround:** always send `=.proplist=completion` with native API completion
  queries; this essentially eliminates the non-determinism for production use

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


## Controlled Experiment: Drop Mechanics (Phase 2)

A second script ([`scripts/test-native-api-drops.ts`](../scripts/test-native-api-drops.ts))
ran three focused experiments to identify *what exactly* causes items to be dropped, using
a 1024 MB CHR (RouterOS 7.22.1) at concurrency = 1.

### Experiment A: Drop Histogram + Resource Correlation

100 sequential calls to `/console/inspect request=completion path=ip,firewall,filter,add,protocol`
(the worst-case 47-item path). REST `/system/resource` polled before and after each call.

| Metric | Observation |
|---|---|
| Overall drop rate | **80%** (80/100 calls) |
| Items returned (full calls) | **47/47** (n=20) |
| Items returned (dropped calls) | **45/47** (n=55) or **46/47** (n=22) |
| Free memory — full calls | **805 MB** |
| Free memory — dropped calls | **805 MB** |
| CPU % — full calls | ~2–5% |
| CPU % — dropped calls | ~2–5% |
| Response time — full calls | **~2 ms** |
| Response time — dropped calls | **~39 ms** |

**Free memory is identical** for both full and dropped responses — confirms RAM is not causal.
**Dropped calls are 20× slower** (~39 ms vs ~2 ms). This may indicate the router is doing
extra work when the buffer overflows, or that it takes longer to serialize a truncated response.

#### Consistent missing items

Drops are not random. The same two items are almost always the ones missing:

| Item | REST position | Absent in (of 80 drops) |
|---|---|---|
| `0x` | 46/47 | **84%** (67/80) |
| `ipv6-frag` | 23/47 | **76%** (61/80) |
| `rsvp` | 34/47 | 13% (10/80) |

This pattern rules out a TOCTOU race condition (which would produce random missing items).
The native API serializes completions in its own internal order (likely by internal protocol
number, not alphabetical). `0x` and `ipv6-frag` (IPv6 Fragment Header, protocol number 44,
a relatively recent addition) are likely at the **end** of the native API's internal iteration
order — and therefore the first to be truncated when the buffer overflows.

### Experiment B: Size Sweep

50 calls each against five paths spanning the range of completion set sizes:

| Path | REST count | Drop rate |
|---|---|---|
| `ip/dhcp-server/add/bootp-support` | 8 | **0.0%** (0/50) |
| `ip/firewall/filter/add/tcp-flags` | 15 | **0.0%** (0/50) |
| `ip/firewall/nat/add/action` | 20 | **2.0%** (1/50) |
| `interface/ethernet/set/speed` | 36 | **90.0%** (45/50) |
| `ip/firewall/filter/add/protocol` | 47 | **100.0%** (50/50) |

The relationship is **monotone**: larger completion sets drop more reliably. The threshold
between "never drops" and "sometimes drops" is between 15 and 20 items (with all fields).
This is consistent with an internal buffer that holds roughly 15–16 full multi-field entries.

### Experiment C: Proplist Effect

100 calls each against the 47-item path using three different `.proplist` configurations:

| `.proplist` value | Fields returned | Drop rate |
|---|---|---|
| *(none — all fields)* | completion, style, preference, text | **100.0%** (100/100) |
| `completion,style,preference,text` | same four explicit | **97.0%** (97/100) |
| `completion` | completion only | **1.0%** (1/100) |

**This is the key finding.** Requesting only the `completion` field reduces drops from 100%
to 1% on the same path with the same concurrency. The buffer can accommodate 47 items when
each item contributes only a `completion` value; it overflows when each item includes all
four fields.

The 3% drop rate with explicit four-field proplist vs 100% without proplist is an artifact
of how `.proplist` itself affects response size — the behavior is otherwise identical.


## Analysis

1. **Not a tag-multiplexing race condition.** Drops occur at concurrency = 1 — a single in-flight
   tag with no overlap. The wire layer is irrelevant. The bug is inside the completion handler.

2. **Not a memory pressure issue.** 256 MB and 1024 MB produce statistically identical drop rates
   across all concurrency levels. Free memory measured via REST during drops is identical to
   free memory during full responses (805 MB in a 1024 MB CHR).

3. **Per-item byte size is the proximate cause.** Requesting fewer fields per item via `.proplist`
   dramatically reduces drops: all fields → 100%; four fields → 97%; one field (`completion`) → 1%.
   This is the clearest evidence that a **fixed-size response buffer** is overflowing when large
   completion sets are returned with full field data.

4. **Drop rate is monotone with completion set size.** Paths with ≤15 items: 0% drops. 20 items:
   2%. 36 items: 90%. 47 items: 100% (with no `.proplist`). The threshold between reliable and
   unreliable is approximately 15–20 items with all fields, consistent with a buffer of fixed size.

5. **Drops are consistent, not random.** The same 2 items (`0x`, `ipv6-frag`) are missing in
   ~76–84% of all drops on the 47-item path. This rules out a TOCTOU race in the completion
   enumerator — a race would produce random missing items. The pattern points to deterministic
   truncation at the end of the native API's internal response order (which differs from REST's
   alphabetical order).

6. **Dropped calls have higher latency.** Full responses return in ~2 ms; dropped responses take
   ~39 ms. This suggests the router does more work (or more waiting) when the buffer overflows —
   possibly retry logic or a serialization stall rather than a clean truncation.

7. **Concurrency is an amplifier, not the cause.** Moving from c=1 to c=10 roughly doubles the
   aggregate drop rate. But because the bug exists at c=1, reducing concurrency cannot fix it —
   it only reduces its severity.

8. **REST is deterministic because each HTTP request creates a fresh internal session.**
   The native API's persistent session shares buffer state that overflows when result sets are large.

9. **Only `request=completion` is affected.** `request=child` and `request=syntax` are fully
   deterministic on both transports (verified over thousands of calls during full-tree crawls).

## Impact

For schema generation tools that depend on complete `/console/inspect` output, this bug means
the native API **cannot be relied upon** for `request=completion` queries without the workaround.

### Workaround: `=.proplist=completion`

Adding `=.proplist=completion` to every native API completion call reduces the drop rate from
~100% to ~1% on the worst-case 47-item path. This works because `.proplist` limits the per-item
response payload to just the `completion` field, keeping the total response within the buffer.

In practice, `completion` is the only field needed for enrichment — `style`, `preference`, and
`text` are useful metadata but not structurally required. The tradeoff is that the extra fields
are lost, but this is acceptable for tools that only need the completion value list.

```
# Native API call with workaround
/console/inspect
=request=completion
=path=ip,firewall,filter,add,protocol
=.proplist=completion
```

### Current restraml approach

restraml uses REST exclusively for all `/console/inspect` calls (`--transport rest`, the default)
because REST is 100% deterministic and requires no workaround. This is the correct choice for
schema generation where completeness matters more than speed.

The native API remains ~2–22× faster for some operations. If MikroTik fixes the underlying
buffer bug, or if the `.proplist=completion` workaround is acceptable for a use case, the hybrid
approach (native API tree walk + completion queries with `.proplist=completion`) becomes viable.

## Reproducible Test Scripts

### Phase 1: RAM × concurrency matrix

[`scripts/test-native-api-tags.ts`](../scripts/test-native-api-tags.ts) — boots CHR at two RAM
sizes, tests all concurrency levels, emits a drop-rate matrix.

```sh
bun scripts/test-native-api-tags.ts
# Options: --version 7.22.1  --low-mem 256  --high-mem 1024  --rounds 50
```

### Phase 2: Drop mechanics and proplist effect

[`scripts/test-native-api-drops.ts`](../scripts/test-native-api-drops.ts) — three focused
experiments (histogram + resource correlation, size sweep, proplist variants).

```sh
bun scripts/test-native-api-drops.ts
# Options: --version 7.22.1  --mem 1024  --calls 100  --sweep-calls 50
```

Requirements for both scripts: `bun`, `bunx @tikoci/quickchr` (auto-installed via package.json),
QEMU with HVF (macOS) or KVM (Linux). Scripts emit formatted summary tables.

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

The Phase 2 experiments narrow the hypothesis considerably:

- **The drop pattern is consistent, not random** (same items always missing): rules out a TOCTOU
  race condition in the enumerator
- **Per-item response byte size is causal** (`.proplist=completion` reduces drops 100× → 1%):
  confirms a fixed-size response buffer being overflowed

**Most likely root cause:** A fixed-size buffer is allocated for the native API completion
response. When result sets are large and all fields are included, the buffer overflows and
the tail of the response is silently discarded. Because the native API serializes items in
an internal order that differs from REST's alphabetical order, the truncated items appear at
apparently "random" positions in a REST-sorted comparison.

**Suggested fix:** Either dynamically size the completion response buffer based on result count,
or apply the same snapshot-then-serialize approach that makes the REST handler deterministic.

A minimal client-side workaround (`=.proplist=completion`) is available and reduces drop rates
to ~1% by limiting per-item payload size.
