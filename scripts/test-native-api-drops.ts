#!/usr/bin/env bun
/**
 * test-native-api-drops.ts — Mechanics of request=completion drops in RouterOS native API
 *
 * Background:
 *   test-native-api-tags.ts established that native API request=completion drops are NOT
 *   caused by tag-multiplexing (concurrent in-flight requests) or RAM size. This script
 *   investigates the *mechanics* of individual drops:
 *     - What fraction of expected items is returned? (total failure vs truncation)
 *     - Which specific items are dropped? (end-of-list pattern vs random)
 *     - Does drop rate scale with completion set size? (buffer-size hypothesis)
 *     - Does .proplist (fewer fields per item) change the drop rate? (byte-size hypothesis)
 *     - Does CPU/memory at query time correlate with drops?
 *
 * Three experiments (all serial, c=1, configurable RAM):
 *
 *   A. DROP MECHANICS + RESOURCE CORRELATION (--calls N, default 100)
 *      Focus path: ip/firewall/filter/add/protocol (47 items — high drop rate at c=1)
 *      For each call:
 *        1. Send native API completion request; record returned items
 *        2. Immediately poll REST /system/resource for cpu-load + free-memory
 *      Outputs:
 *        - Histogram: how many items returned per call?
 *        - Missing item frequency: which completions absent most often?
 *        - Truncation test: REST position of missing items (end-of-list = truncation)
 *        - Resource correlation: mean CPU/mem when dropped vs full response
 *        - Latency comparison: dropped calls slower or faster?
 *
 *   B. SIZE SWEEP (--sweep-calls N, default 50 per path)
 *      ~8 paths spanning 2–47 completions; 50 serial calls each.
 *      Is drop rate monotonically increasing with completion set size?
 *      Paths discovered and verified via REST at runtime.
 *
 *   C. PROPLIST EFFECT (--calls N, default 100 per variant)
 *      Same 47-item focus path, 3 .proplist variants:
 *        (1) No .proplist → all fields (largest response bytes)
 *        (2) =.proplist=completion,style,preference,text → 4 fields
 *        (3) =.proplist=completion → 1 field (smallest response bytes)
 *      Does requesting fewer fields reduce drops?
 *
 * Run:
 *   bun scripts/test-native-api-drops.ts
 *   bun scripts/test-native-api-drops.ts --version 7.22.1
 *   bun scripts/test-native-api-drops.ts --calls 200 --sweep-calls 100
 *   bun scripts/test-native-api-drops.ts --help
 */

import { parseArgs } from "node:util";
import { QuickCHR } from "@tikoci/quickchr";
import { RosAPI, RosErrorCode, type Sentence } from "../ros-api-protocol.ts";
import { RouterOSClient } from "../deep-inspect.ts";

// ── CLI ───────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    version: { type: "string", default: "7.22.1" },
    mem: { type: "string", default: "1024" },
    calls: { type: "string", default: "100" },
    "sweep-calls": { type: "string", default: "50" },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(`
Usage: bun scripts/test-native-api-drops.ts [options]

Options:
  --version <ver>      RouterOS version (default: 7.22.1)
  --mem <mb>           CHR RAM in MB — note: prior tests confirmed RAM is NOT a factor (default: 1024)
  --calls <n>          Calls per variant in Exp A and C (default: 100)
  --sweep-calls <n>    Calls per path in Exp B size sweep (default: 50)
  --help               Show this help
`);
  process.exit(0);
}

const ROS_VERSION = values.version as string;
const MEM_MB = parseInt(values.mem as string, 10);
const CALLS = parseInt(values.calls as string, 10);
const SWEEP_CALLS = parseInt(values["sweep-calls"] as string, 10);

// Per-call timeout: the API hangs indefinitely on macOS/HVF (no TCP close, just silence).
const CALL_TIMEOUT_MS = 30_000;

// ── Focus path for Exp A and C ────────────────────────────────────────────────
// Chosen for its high drop rate (~62-64% at c=1 in test-native-api-tags) and large
// completion set (47 items). This is the canonical high-drop probe for mechanics work.
const FOCUS_PATH = ["ip", "firewall", "filter", "add", "protocol"];

// ── Candidate paths for Exp B size sweep ─────────────────────────────────────
// Ordered roughly by expected completion count (small → large).
// REST count is verified at runtime; paths returning 0 are skipped.
// Near-duplicate counts are deduplicated (kept first in list that passes).
const SWEEP_CANDIDATES: string[][] = [
  ["ip", "dhcp-server", "add", "bootp-support"],            // ~3 items: none, static, dynamic
  ["interface", "bridge", "add", "protocol-mode"],          // ~4 items: none, rstp, mstp, stp
  ["ip", "firewall", "filter", "add", "connection-state"],  // ~5-6 items
  ["ip", "firewall", "filter", "add", "chain"],             // ~8 items (known: forward, input, output)
  ["ip", "address", "add", "interface"],                    // ~8 items (known: ether1..n, lo)
  ["ip", "firewall", "filter", "add", "tcp-flags"],         // ~8-10 items
  ["ip", "firewall", "nat", "add", "action"],               // ~8-12 items
  ["ip", "firewall", "filter", "add", "action"],            // ~16 items (known)
  ["interface", "ethernet", "set", "speed"],                // ~36 items (known)
  ["ip", "firewall", "filter", "add", "protocol"],          // ~47 items (known)
];

// ── Types ─────────────────────────────────────────────────────────────────────

interface ResourceSample {
  cpuLoad: number;    // 0–100 %
  freeMemMb: number;  // free memory in MB
  totalMemMb: number; // total memory in MB (constant across run)
}

interface DropCallDetail {
  returned: string[];              // completion values returned by native API
  expected: string[];              // REST baseline (in REST-returned order)
  ms: number;                      // native call latency in ms
  timedOut: boolean;               // true if call exceeded CALL_TIMEOUT_MS
  resource: ResourceSample | null; // /system/resource sampled immediately after native call
}

// ── REST helpers ──────────────────────────────────────────────────────────────

/** Fetch /system/resource via REST. Returns null on any error. */
async function pollResource(
  urlBase: string,
  authHeader: string,
): Promise<ResourceSample | null> {
  try {
    const resp = await fetch(`${urlBase}/system/resource`, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const d = (await resp.json()) as Record<string, unknown>;
    // RouterOS REST returns all resource fields as strings even for numeric properties
    return {
      cpuLoad: Number(d["cpu-load"]) || 0,
      freeMemMb: Math.round((Number(d["free-memory"]) || 0) / 1024 / 1024),
      totalMemMb: Math.round((Number(d["total-memory"]) || 0) / 1024 / 1024),
    };
  } catch {
    return null;
  }
}

/** Fetch the ordered list of completion strings for a path via REST. */
async function restCompletionItems(
  restClient: RouterOSClient,
  path: string[],
): Promise<string[]> {
  const items = await restClient.fetchCompletion(path);
  return items.map((r) => r.completion);
}

// ── Native API helpers ────────────────────────────────────────────────────────

/**
 * One native API completion call. Returns the actual completion strings from
 * each !re sentence. On CONNRESET, re-throws so caller can reconnect.
 * On hang (> CALL_TIMEOUT_MS), returns { timedOut: true }.
 *
 * proplist: if defined, appended as "=.proplist=<value>". Omit for all fields.
 */
async function nativeCompletionCall(
  api: RosAPI,
  path: string[],
  proplist?: string,
): Promise<{ items: string[]; ms: number; timedOut: boolean }> {
  const t0 = Date.now();
  const words: string[] = [
    "/console/inspect",
    "=request=completion",
    `=path=${path.join(",")}`,
  ];
  if (proplist !== undefined) {
    words.push(`=.proplist=${proplist}`);
  }

  const queryP = api
    .write(...words)
    .then(
      (sentences: Sentence[]): { items: string[]; ms: number; timedOut: false } => ({
        items: sentences
          .map((s) => s.data.completion ?? "")
          .filter((v) => v !== ""),
        ms: Date.now() - t0,
        timedOut: false,
      }),
    )
    .catch(
      (err: unknown): { items: string[]; ms: number; timedOut: false } => {
        const code = (err as { code?: string }).code ?? "";
        if (code === RosErrorCode.CONNRESET || code === "CONNRESET") {
          throw err; // propagate: caller must reconnect
        }
        return { items: [], ms: Date.now() - t0, timedOut: false };
      },
    );

  const timeoutP = new Promise<{ items: string[]; ms: number; timedOut: true }>(
    (resolve) =>
      setTimeout(
        () => resolve({ items: [], ms: CALL_TIMEOUT_MS, timedOut: true }),
        CALL_TIMEOUT_MS,
      ),
  );

  return Promise.race([queryP, timeoutP]);
}

/** Open a fresh native API connection. */
async function connectNative(host: string, port: number): Promise<RosAPI> {
  const api = new RosAPI(host, port, "admin", "");
  await api.connect();
  return api;
}

// ── Experiment A: Drop mechanics + resource correlation ───────────────────────

async function experimentA(
  restClient: RouterOSClient,
  apiHost: string,
  apiPort: number,
  urlBase: string,
  authHeader: string,
  calls: number,
): Promise<void> {
  console.log(`\n${"═".repeat(72)}`);
  console.log("EXPERIMENT A: Drop Mechanics + Resource Correlation");
  console.log(`  Path:  ${FOCUS_PATH.join("/")}`);
  console.log(`  Calls: ${calls} serial (c=1), REST /system/resource polled after each`);
  console.log(`${"─".repeat(72)}`);

  // Establish REST baseline: get ordered item list
  const restItems = await restCompletionItems(restClient, FOCUS_PATH);
  console.log(`\n  REST baseline: ${restItems.length} items`);
  console.log(
    `  Items: ${restItems.slice(0, 12).join(", ")}${restItems.length > 12 ? ` ... (+${restItems.length - 12} more)` : ""}`,
  );

  if (restItems.length === 0) {
    console.log("  ⚠ REST returned 0 items — skipping Experiment A");
    return;
  }

  const details: DropCallDetail[] = [];
  let api = await connectNative(apiHost, apiPort);
  let connResets = 0;
  let hangs = 0;

  for (let i = 0; i < calls; i++) {
    let result: { items: string[]; ms: number; timedOut: boolean };

    try {
      result = await nativeCompletionCall(api, FOCUS_PATH);
    } catch {
      connResets++;
      try {
        api.close();
      } catch {}
      api = await connectNative(apiHost, apiPort);
      result = { items: [], ms: 0, timedOut: false };
    }

    if (result.timedOut) {
      hangs++;
      try {
        api.close();
      } catch {}
      api = await connectNative(apiHost, apiPort);
    }

    const resource = await pollResource(urlBase, authHeader);

    details.push({
      returned: result.items,
      expected: restItems,
      ms: result.ms,
      timedOut: result.timedOut,
      resource,
    });

    if ((i + 1) % 25 === 0) {
      const drops = details.filter(
        (d) => !d.timedOut && d.returned.length < restItems.length,
      ).length;
      process.stdout.write(`  ... ${i + 1}/${calls} calls, drops so far: ${drops}\n`);
    }
  }

  try {
    api.close();
  } catch {}

  // ── Analysis ──────────────────────────────────────────────────────────────

  const completed = details.filter((d) => !d.timedOut);
  const dropped = completed.filter((d) => d.returned.length < restItems.length);
  const full = completed.filter((d) => d.returned.length === restItems.length);
  const dropRate =
    completed.length > 0 ? ((dropped.length / completed.length) * 100).toFixed(1) : "N/A";

  console.log(`\n  ── Summary ──`);
  console.log(
    `  Calls: ${calls} total  completed=${completed.length}  hangs=${hangs}  CONNRESET=${connResets}`,
  );
  console.log(
    `  Drop rate: ${dropped.length}/${completed.length} = ${dropRate}%  full=${full.length}`,
  );

  // Histogram: count of returned items per call
  console.log(`\n  ── Histogram: returned item count (${restItems.length} expected) ──`);
  const histogram = new Map<number, number>();
  for (const d of completed) {
    const n = d.returned.length;
    histogram.set(n, (histogram.get(n) ?? 0) + 1);
  }
  const barWidth = 40;
  for (const [count, freq] of [...histogram.entries()].sort((a, b) => a[0] - b[0])) {
    const bar = "█".repeat(Math.round((freq / completed.length) * barWidth));
    const pct = ((freq / completed.length) * 100).toFixed(1).padStart(5);
    const fullMark = count === restItems.length ? " ✓" : "  ";
    console.log(`  ${String(count).padStart(3)}${fullMark}: ${bar.padEnd(barWidth)} ${freq.toString().padStart(4)} (${pct}%)`);
  }

  // Missing item frequency and truncation test
  if (dropped.length > 0) {
    console.log(`\n  ── Missing item frequency ──`);
    console.log(`  (items absent in ≥1 dropped call; REST position indicates where in the list)`);

    const missingFreq = new Map<string, number>();
    for (const d of dropped) {
      for (const item of restItems.filter((v) => !d.returned.includes(v))) {
        missingFreq.set(item, (missingFreq.get(item) ?? 0) + 1);
      }
    }

    const sorted = [...missingFreq.entries()].sort((a, b) => b[1] - a[1]);
    for (const [item, freq] of sorted.slice(0, 25)) {
      const restPos = restItems.indexOf(item);
      const pct = ((freq / dropped.length) * 100).toFixed(0).padStart(4);
      const posLabel = `${restPos + 1}/${restItems.length}`;
      console.log(
        `  ${item.padEnd(30)} absent in ${String(freq).padStart(3)}/${dropped.length} drops (${pct}%) — REST pos: ${posLabel}`,
      );
    }
    if (sorted.length > 25) {
      console.log(`  ... and ${sorted.length - 25} more items with lower absence rates`);
    }

    // Truncation test: where in the REST-ordered list do drops cluster?
    console.log(`\n  ── Truncation test: REST position of missing items ──`);
    const allMissingPositions: number[] = [];
    for (const d of dropped) {
      for (const item of restItems.filter((v) => !d.returned.includes(v))) {
        allMissingPositions.push(restItems.indexOf(item));
      }
    }

    if (allMissingPositions.length > 0) {
      const sorted2 = [...allMissingPositions].sort((a, b) => a - b);
      const mean =
        allMissingPositions.reduce((a, b) => a + b, 0) / allMissingPositions.length;
      const median = sorted2[Math.floor(sorted2.length / 2)];
      const min = sorted2[0];
      const max = sorted2[sorted2.length - 1];
      const backHalf = allMissingPositions.filter(
        (p) => p >= restItems.length / 2,
      ).length;
      const backPct = ((backHalf / allMissingPositions.length) * 100).toFixed(0);

      console.log(`  Missing item REST positions:`);
      console.log(`    min=${min + 1}  max=${max + 1}  mean=${mean.toFixed(1)}  median=${median + 1}`);
      console.log(`    list length: ${restItems.length}`);
      console.log(
        `    in back half (pos ≥${Math.floor(restItems.length / 2) + 1}): ${backHalf}/${allMissingPositions.length} = ${backPct}%`,
      );

      // Position distribution — show quartile buckets
      const q = restItems.length / 4;
      const buckets = [0, 0, 0, 0];
      for (const p of allMissingPositions) {
        buckets[Math.min(3, Math.floor(p / q))]++;
      }
      console.log(`    Quartile distribution: Q1=${buckets[0]}  Q2=${buckets[1]}  Q3=${buckets[2]}  Q4=${buckets[3]}`);

      if (mean > restItems.length * 0.75) {
        console.log("  → STRONG TRUNCATION: drops heavily concentrated at end of list");
      } else if (mean > restItems.length * 0.5) {
        console.log("  → PARTIAL PATTERN: drops skew toward end but not exclusively");
      } else if (mean < restItems.length * 0.25) {
        console.log("  → INVERSE PATTERN: drops skew toward start of list");
      } else {
        console.log("  → NO TRUNCATION: drops distributed across full list — not simple truncation");
      }
    }
  }

  // Resource correlation
  const withResource = completed.filter((d) => d.resource !== null);
  if (withResource.length > 0) {
    const droppedR = withResource.filter((d) => d.returned.length < restItems.length);
    const fullR = withResource.filter((d) => d.returned.length === restItems.length);

    console.log(`\n  ── Resource correlation (${withResource.length}/${completed.length} calls with resource data) ──`);

    if (fullR.length > 0 && droppedR.length > 0) {
      const avg = (arr: number[]) =>
        arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

      const cpuFull = avg(fullR.map((d) => d.resource?.cpuLoad ?? 0));
      const cpuDrop = avg(droppedR.map((d) => d.resource?.cpuLoad ?? 0));
      const memFull = avg(fullR.map((d) => d.resource?.freeMemMb ?? 0));
      const memDrop = avg(droppedR.map((d) => d.resource?.freeMemMb ?? 0));
      const msFull = avg(fullR.map((d) => d.ms));
      const msDrop = avg(droppedR.map((d) => d.ms));

      const sample = withResource[0].resource;
      const totalMemLabel = sample ? `${sample.totalMemMb} MB` : "unknown";

      console.log(`  Total memory: ${totalMemLabel}`);
      console.log(`  Metric              Full (n=${fullR.length})   Dropped (n=${droppedR.length})`);
      console.log(`  CPU load %          ${cpuFull.toFixed(1).padEnd(20)} ${cpuDrop.toFixed(1)}`);
      console.log(`  Free memory (MB)    ${memFull.toFixed(0).padEnd(20)} ${memDrop.toFixed(0)}`);
      console.log(`  Latency (ms)        ${msFull.toFixed(0).padEnd(20)} ${msDrop.toFixed(0)}`);

      const cpuDiff = Math.abs(cpuFull - cpuDrop);
      const memDiff = Math.abs(memFull - memDrop);
      const msDiff = Math.abs(msFull - msDrop);

      if (cpuDiff < 5 && memDiff < 50 && msDiff < 100) {
        console.log(
          "  → No significant resource difference: drops appear unrelated to CPU/memory state",
        );
      } else {
        if (cpuDiff >= 5) {
          console.log(
            `  → CPU CORRELATION: ${cpuDrop > cpuFull ? "higher" : "lower"} CPU when dropped (Δ${cpuDiff.toFixed(1)}%)`,
          );
        }
        if (memDiff >= 50) {
          console.log(
            `  → MEMORY CORRELATION: ${memDrop < memFull ? "less" : "more"} free memory when dropped (Δ${memDiff.toFixed(0)} MB)`,
          );
        }
        if (msDiff >= 100) {
          console.log(
            `  → LATENCY CORRELATION: dropped calls are ${msDrop > msFull ? "slower" : "faster"} (Δ${msDiff.toFixed(0)} ms)`,
          );
        }
      }
    } else if (droppedR.length === 0) {
      console.log("  ✓ No drops in this run — cannot compare resource state");
    } else {
      console.log("  ✗ All calls dropped — cannot compare resource state");
    }
  }
}

// ── Experiment B: Size sweep ──────────────────────────────────────────────────

async function experimentB(
  restClient: RouterOSClient,
  apiHost: string,
  apiPort: number,
  callsPerPath: number,
): Promise<void> {
  console.log(`\n${"═".repeat(72)}`);
  console.log("EXPERIMENT B: Size Sweep — drop rate vs completion set size");
  console.log(`  Paths: up to ${SWEEP_CANDIDATES.length} candidates (REST-verified at runtime)`);
  console.log(`  Calls: ${callsPerPath} serial per path`);
  console.log(`${"─".repeat(72)}`);

  // Discover actual REST counts, deduplicating paths with very similar item counts
  console.log("\n  Verifying REST counts...");
  const validPaths: Array<{ path: string[]; restItems: string[] }> = [];

  for (const path of SWEEP_CANDIDATES) {
    const items = await restCompletionItems(restClient, path);
    const label = path.join("/");
    if (items.length === 0) {
      console.log(`  ?  ${label}: 0 items — skipping`);
      continue;
    }
    // Skip if there's already a path within ±2 items (avoid cluttered near-duplicates)
    const similar = validPaths.find(
      (p) => Math.abs(p.restItems.length - items.length) <= 2,
    );
    if (similar) {
      console.log(
        `  ~  ${label}: ${items.length} items — close to ${similar.path.join("/")} (${similar.restItems.length}) — skipping`,
      );
      continue;
    }
    console.log(`  ✓  ${label}: ${items.length} items`);
    validPaths.push({ path, restItems: items });
  }

  // Sort by REST count ascending for a clean sweep display
  validPaths.sort((a, b) => a.restItems.length - b.restItems.length);

  if (validPaths.length === 0) {
    console.log("\n  ⚠ No valid paths found — skipping Experiment B");
    return;
  }

  console.log(`\n  Running sweep (${validPaths.length} paths × ${callsPerPath} calls)...\n`);

  interface SweepRow {
    path: string;
    restCount: number;
    drops: number;
    completed: number;
    minReturned: number;
    maxReturned: number;
    meanReturned: number;
    hangs: number;
  }

  const rows: SweepRow[] = [];

  for (const { path, restItems } of validPaths) {
    let api = await connectNative(apiHost, apiPort);
    let drops = 0;
    let completed = 0;
    let minReturned = Number.POSITIVE_INFINITY;
    let maxReturned = 0;
    let totalReturned = 0;
    let hangs = 0;

    for (let i = 0; i < callsPerPath; i++) {
      let result: { items: string[]; ms: number; timedOut: boolean };

      try {
        result = await nativeCompletionCall(api, path);
      } catch {
        try {
          api.close();
        } catch {}
        api = await connectNative(apiHost, apiPort);
        result = { items: [], ms: 0, timedOut: false };
      }

      if (result.timedOut) {
        hangs++;
        try {
          api.close();
        } catch {}
        api = await connectNative(apiHost, apiPort);
        continue; // don't count timed-out calls in stats
      }

      completed++;
      const n = result.items.length;
      if (n < restItems.length) drops++;
      if (n < minReturned) minReturned = n;
      if (n > maxReturned) maxReturned = n;
      totalReturned += n;
    }

    try {
      api.close();
    } catch {}

    const row: SweepRow = {
      path: path.join("/"),
      restCount: restItems.length,
      drops,
      completed,
      minReturned: completed > 0 ? minReturned : 0,
      maxReturned: completed > 0 ? maxReturned : 0,
      meanReturned: completed > 0 ? totalReturned / completed : 0,
      hangs,
    };
    rows.push(row);

    const dropPct =
      completed > 0 ? `${((drops / completed) * 100).toFixed(1)}%` : "N/A";
    console.log(
      `  ${path.join("/").padEnd(48)} ${String(restItems.length).padStart(3)} → ${dropPct.padStart(6)} drops`,
    );
  }

  // Summary table
  console.log(`\n  ── Size Sweep Results ──`);
  const h = (s: string, w: number) => s.padEnd(w);
  const r = (s: string, w: number) => s.padStart(w);
  console.log(
    `  ${h("Path", 48)} ${r("REST", 4)}  ${r("Drops%", 7)}  ${r("Min", 4)}  ${r("Max", 4)}  ${r("Mean", 5)}  ${r("Hangs", 5)}`,
  );
  console.log(`  ${"─".repeat(82)}`);
  for (const row of rows) {
    const rate =
      row.completed > 0 ? ((row.drops / row.completed) * 100).toFixed(1) : "N/A";
    console.log(
      `  ${h(row.path, 48)} ${r(String(row.restCount), 4)}  ` +
        `${r(rate, 7)}  ${r(String(row.minReturned), 4)}  ` +
        `${r(String(row.maxReturned), 4)}  ${r(row.meanReturned.toFixed(1), 5)}  ` +
        `${r(String(row.hangs), 5)}`,
    );
  }

  // Monotonicity check: does drop rate increase with REST count?
  if (rows.length >= 3) {
    const rates = rows.map((r2) =>
      r2.completed > 0 ? r2.drops / r2.completed : 0,
    );
    let monotone = true;
    for (let i = 1; i < rates.length; i++) {
      if (rates[i] < rates[i - 1] - 0.05) {
        // allow ±5% tolerance
        monotone = false;
        break;
      }
    }
    if (monotone) {
      console.log(
        "\n  → MONOTONE: drop rate increases with set size — consistent with buffer-size hypothesis",
      );
    } else {
      console.log(
        "\n  → NOT MONOTONE: drop rate does not consistently increase with set size",
      );
    }
    // Find approximate threshold
    const firstDrop = rows.find((row2) => row2.drops > 0);
    const firstNoDrop = rows.slice().reverse().find((row2) => row2.drops === 0);
    if (firstDrop && firstNoDrop) {
      console.log(
        `  → Threshold appears between ${firstNoDrop.restCount} items (0% drops) and ${firstDrop.restCount} items (>0% drops)`,
      );
    }
  }
}

// ── Experiment C: Proplist effect ─────────────────────────────────────────────

async function experimentC(
  restClient: RouterOSClient,
  apiHost: string,
  apiPort: number,
  calls: number,
): Promise<void> {
  console.log(`\n${"═".repeat(72)}`);
  console.log("EXPERIMENT C: Proplist Effect — does requesting fewer fields reduce drops?");
  console.log(`  Path:  ${FOCUS_PATH.join("/")}`);
  console.log(`  Calls: ${calls} serial per variant`);
  console.log(`${"─".repeat(72)}`);

  const restItems = await restCompletionItems(restClient, FOCUS_PATH);
  console.log(`\n  REST baseline: ${restItems.length} items`);

  if (restItems.length === 0) {
    console.log("  ⚠ REST returned 0 items — skipping Experiment C");
    return;
  }

  // Three variants: no proplist → 4-field → 1-field (largest to smallest per-item payload)
  const variants: Array<{ label: string; proplist: string | undefined; desc: string }> = [
    {
      label: "(none)",
      proplist: undefined,
      desc: "all fields — largest per-item payload",
    },
    {
      label: "completion,style,preference,text",
      proplist: "completion,style,preference,text",
      desc: "4 fields — current production usage in deep-inspect.ts",
    },
    {
      label: "completion",
      proplist: "completion",
      desc: "1 field — minimum possible per-item payload",
    },
  ];

  interface VariantResult {
    label: string;
    desc: string;
    drops: number;
    completed: number;
    minReturned: number;
    maxReturned: number;
    meanMs: number;
    hangs: number;
  }

  const results: VariantResult[] = [];

  for (const variant of variants) {
    console.log(`\n  Variant: .proplist=${variant.label}`);
    console.log(`  Note:    ${variant.desc}`);

    let api = await connectNative(apiHost, apiPort);
    let drops = 0;
    let completed = 0;
    let minR = Number.POSITIVE_INFINITY;
    let maxR = 0;
    let totalMs = 0;
    let hangs = 0;

    for (let i = 0; i < calls; i++) {
      let result: { items: string[]; ms: number; timedOut: boolean };

      try {
        result = await nativeCompletionCall(api, FOCUS_PATH, variant.proplist);
      } catch {
        try {
          api.close();
        } catch {}
        api = await connectNative(apiHost, apiPort);
        result = { items: [], ms: 0, timedOut: false };
      }

      if (result.timedOut) {
        hangs++;
        try {
          api.close();
        } catch {}
        api = await connectNative(apiHost, apiPort);
        continue;
      }

      completed++;
      const n = result.items.length;
      if (n < restItems.length) drops++;
      if (n < minR) minR = n;
      if (n > maxR) maxR = n;
      totalMs += result.ms;
    }

    try {
      api.close();
    } catch {}

    const dropPct =
      completed > 0 ? `${((drops / completed) * 100).toFixed(1)}%` : "N/A";
    const meanMs = completed > 0 ? totalMs / completed : 0;

    results.push({
      label: variant.label,
      desc: variant.desc,
      drops,
      completed,
      minReturned: completed > 0 ? minR : 0,
      maxReturned: completed > 0 ? maxR : 0,
      meanMs,
      hangs,
    });

    console.log(
      `  Result: ${drops}/${completed} drops = ${dropPct}  min=${minR === Infinity ? 0 : minR}  max=${maxR}  mean=${meanMs.toFixed(0)}ms  hangs=${hangs}`,
    );
  }

  // Summary table
  console.log(`\n  ── Proplist Results ──`);
  console.log(
    `  ${"Proplist".padEnd(40)} ${"REST".padStart(4)}  ${"Drops%".padStart(7)}  ${"Min".padStart(4)}  ${"Max".padStart(4)}  ${"Ms".padStart(5)}`,
  );
  console.log(`  ${"─".repeat(70)}`);
  for (const r2 of results) {
    const rate =
      r2.completed > 0 ? ((r2.drops / r2.completed) * 100).toFixed(1) : "N/A";
    console.log(
      `  ${r2.label.padEnd(40)} ${String(restItems.length).padStart(4)}  ` +
        `${rate.padStart(7)}  ${String(r2.minReturned).padStart(4)}  ` +
        `${String(r2.maxReturned).padStart(4)}  ${r2.meanMs.toFixed(0).padStart(5)}`,
    );
  }

  // Interpretation
  if (results.length === 3 && results[0].completed > 0 && results[2].completed > 0) {
    const noPlRate = results[0].drops / results[0].completed;
    const minPlRate = results[2].drops / results[2].completed;
    const diff = ((noPlRate - minPlRate) * 100).toFixed(1);

    if (Math.abs(noPlRate - minPlRate) < 0.05) {
      console.log(
        `\n  → PROPLIST: no significant effect (Δ${diff}%) — drop rate is field-count independent`,
      );
      console.log(
        "     The bug is NOT caused by response byte-size per item, but by total response size",
      );
    } else if (noPlRate > minPlRate) {
      console.log(
        `\n  → PROPLIST HELPS: fewer fields → fewer drops (Δ${diff}%)`,
      );
      console.log("     Consistent with a per-item or per-byte response buffer overflow");
    } else {
      console.log(
        `\n  → UNEXPECTED: minimal proplist has MORE drops (Δ${diff}%)`,
      );
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log("RouterOS Native API: Drop Mechanics Investigation");
console.log(
  `Version: ${ROS_VERSION}   RAM: ${MEM_MB} MB   Calls: ${CALLS}   SweepCalls: ${SWEEP_CALLS}`,
);
console.log();

const chr = await QuickCHR.start({
  arch: "x86",
  version: ROS_VERSION,
  mem: MEM_MB,
  secureLogin: false,
  background: true,
});

console.log(`CHR ready: ${chr.restUrl}`);
console.log(
  `Ports: http=${chr.ports.http}  api=${chr.ports.api}  ssh=${chr.ports.ssh}`,
);

const env = await chr.subprocessEnv();
const urlBase = env.URLBASE;
const authHeader = `Basic ${btoa(env.BASICAUTH)}`;
const restClient = new RouterOSClient(urlBase, env.BASICAUTH);
const apiHost = "127.0.0.1";
const apiPort = chr.ports.api;

try {
  const version = await restClient.fetchVersion().catch(() => ROS_VERSION);
  console.log(`RouterOS version: ${version}`);

  // Warmup: discard first REST completion (sometimes slow on fresh CHR)
  await restCompletionItems(restClient, FOCUS_PATH).catch(() => []);

  await experimentA(restClient, apiHost, apiPort, urlBase, authHeader, CALLS);
  await experimentB(restClient, apiHost, apiPort, SWEEP_CALLS);
  await experimentC(restClient, apiHost, apiPort, CALLS);

  console.log(`\n${"═".repeat(72)}`);
  console.log("All experiments complete.");
} finally {
  await chr.stop();
  console.log("CHR stopped.");
}
