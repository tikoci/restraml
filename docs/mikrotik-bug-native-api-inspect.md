# MikroTik Bug Report: `/console/inspect` Completion Non-Determinism via Native API

> **Status:** Not yet filed with MikroTik. This document captures the evidence for filing.
> **Discovered:** May 2026, during development of [restraml](https://github.com/tikoci/restraml)
> schema generator.

## Summary

`/console/inspect` with `request=completion` returns non-deterministic results when queried
via the RouterOS native API (binary protocol, port 8728). The same command issued repeatedly
on the same TCP connection randomly drops completion entries approximately 20-30% of the time.
The identical query via the REST API (HTTP, port 80) returns identical results 100% of the time.

## Affected Version

- RouterOS **7.22.1** (stable, CHR x86_64)
- Likely affects all 7.x versions with native API support (not tested on other versions)

## Reproduction Steps

### Prerequisites

- RouterOS CHR 7.22.1 (any license level)
- Native API access on port 8728
- REST API access on port 80
- A tool that can send native API commands (e.g., `tikoci/tiktui` protocol library, or
  MikroTik's own API client)

### Test 1: REST Determinism (control)

Send the following REST request 20 times:

```
POST /rest/console/inspect
Content-Type: application/json
Authorization: Basic YWRtaW46  (admin:)

{"request": "completion", "path": ["ip", "address", "add"]}
```

**Expected result (observed):** All 20 responses return exactly 14 completion entries.
100% deterministic.

### Test 2: Native API Non-Determinism (bug)

Send the equivalent native API command 20 times on a single TCP connection:

```
/console/inspect
=request=completion
=.proplist=completion,style,preference,text
=path=ip
=path=address
=path=add
.tag=1
```

(Increment `.tag` for each subsequent command on the same connection.)

**Expected result:** All 20 responses should return exactly 14 completion entries (same as REST).

**Actual result (observed):** Approximately 16/20 responses return 14 entries. The remaining
~4/20 responses return only 13 entries (one entry randomly missing). Which entry is dropped
varies between calls. The pattern is:

| Run # | Entries | Match REST? |
|-------|---------|-------------|
| 1-8   | 14      | ✓           |
| 9     | 13      | ✗ (1 missing) |
| 10-12 | 14      | ✓           |
| 13    | 13      | ✗           |
| ...   | varies  | ~20-30% drop rate |

### Test 3: Scale Verification

Query all ~9300 completion-bearing paths via both transports:

| Metric | REST | Native |
|--------|------|--------|
| Paths with completions | 9,357 | 9,302 |
| Total individual entries | 55,730 | 53,935 |
| Entry-level delta | — | **1,795 entries missing** |
| Entries unique to native | — | **0** |

Native is always a strict subset of REST. No completion entry has ever appeared in native
that was absent from REST.

### Test 4: Not a Concurrency Issue

The non-determinism occurs even with fully sequential queries (one command at a time, waiting
for the complete response before sending the next). Testing 1,279 paths that differed between
bulk REST and bulk native runs:

- 911 paths (71.2%) matched when tested one-at-a-time — proving the bulk/concurrent execution
  is not the sole cause
- 368 paths still differed even under sequential access

### Test 5: Not Session Degradation

Monitoring a single path over 500 consecutive queries on one connection:

- Drops are non-monotonic (fluctuate randomly, not progressive)
- Fresh connections do NOT consistently recover (drops happen on new connections too)
- Reconnecting every N queries does NOT eliminate drops

## Analysis

The non-determinism appears to be in RouterOS's internal `/console/inspect` completion
enumeration engine when accessed via the native API binary protocol. Key observations:

1. **REST creates independent sessions**: Each HTTP request to `/rest/console/inspect` creates
   a fresh internal API session. The completion enumeration runs in isolation.

2. **Native API reuses a persistent session**: The TCP connection maintains state across
   commands. The completion enumeration appears to have a race condition or timing-dependent
   code path that occasionally skips entries.

3. **Only `request=completion` is affected**: `request=child` and `request=syntax` appear
   fully deterministic on both transports (verified over thousands of calls).

4. **The issue is per-call random, not cumulative**: It's not that the connection degrades
   over time — any individual call can randomly drop an entry, regardless of connection age
   or number of prior queries.

## Impact

For schema generation tools that depend on complete `/console/inspect` output, this bug means
the native API cannot be relied upon for `request=completion` queries. REST must be used
instead, at a ~2× per-call latency penalty.

The native API remains reliable and significantly faster for `request=child` (tree walking)
and `request=syntax` queries — only `request=completion` is affected.

## Additional Bugs Found During Investigation

### 1. `do` keyword deadlock on RouterOS ≤7.21

`POST /rest/console/inspect {"request":"syntax", "path":"do"}` hangs the entire HTTP server
for ~30 seconds on RouterOS 7.20.8 (long-term stable). Same hang with `request=completion`.
Only the bare `"do"` path causes this — nested paths like `["do", "command"]` are safe, and
`request=child` with `"do"` is safe.

This bug is **fixed** in RouterOS 7.22+ (returns HTTP 200 immediately). Not tested on 7.21.

### 2. CONNRESET under concurrent native API load (CI-specific)

On Linux/KVM (GitHub Actions CI), sending 50 concurrent `/console/inspect` commands via the
native API protocol occasionally causes a TCP connection reset (CONNRESET), killing all
in-flight commands simultaneously. This was observed as 52 CONNRESETs in a 25ms window,
all in `system/reset-configuration/*` and `system/resource/*` paths.

This was NOT reproduced on macOS/HVF with the same RouterOS version and identical test
methodology. May be environment-specific (Linux KVM vs macOS HVF) or related to TCP
connection handling differences in QEMU networking modes.

## Environment

- RouterOS: 7.22.1 (stable) CHR, x86_64
- Host: macOS, Apple Silicon (M-series), QEMU with HVF acceleration
- Client: Bun runtime, custom native API protocol implementation (`ros-api-protocol.ts`)
- Network: QEMU user-mode networking (host port → VM port forwarding)

## Suggested Fix

The completion enumeration in `/console/inspect` should be made deterministic regardless of
the API transport used. Since REST is deterministic, the internal enumeration logic is
clearly capable of returning consistent results — the issue likely lies in how the native
API session dispatches or serializes the completion query relative to session state.
